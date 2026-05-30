import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { AdbStatus, DeviceInfo, MirrorSession, PerformanceMetrics, PerformanceRecording, PerformanceSample, PerformanceSnapshot, LogEntry, NetworkRequest } from '../shared/types';
import { NetworkPanel } from './components/NetworkPanel';
import { PerformancePanel } from './components/PerformancePanel';
import { MirrorPanel } from './components/MirrorPanel';
import { ElectronResult, hasElectronAPI } from './lib/electronApi';
import {
  BATCH_UPDATE_DELAY,
  BATCH_UPDATE_SIZE,
  createDeviceLogState,
  createLogCounts,
  DeviceLogState,
  LOG_OVERSCAN_ROWS,
  LOG_ROW_HEIGHT,
  MAX_LOG_ENTRIES,
  MAX_PENDING_LOG_BUFFER,
} from './lib/logStore';

const isLikelyPicoDevice = (device: DeviceInfo | null): boolean => {
  const identity = [device?.manufacturer, device?.name, device?.model, device?.id]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return identity.includes('pico') || identity.includes('a9210') || identity.includes('sparrow');
};

type TabType = 'devices' | 'logs' | 'performance' | 'network' | 'mirror';
type LogLevelFilter = LogEntry['level'] | 'all';
type ApkInstallStatus = 'queued' | 'installing' | 'success' | 'failed';

type ApkInstallQueueItem = {
  id: string;
  path: string;
  fileName: string;
  status: ApkInstallStatus;
  progress: number;
  output?: string;
  error?: string;
};

type DeviceApkInstallState = {
  queue: ApkInstallQueueItem[];
  isInstalling: boolean;
};

const DEVICE_NAME_STORAGE_KEY = 'android-device-monitor.custom-device-names';

const loadStoredDeviceNames = (): Record<string, string> => {
  if (typeof window === 'undefined') return {};
  try {
    const rawValue = window.localStorage.getItem(DEVICE_NAME_STORAGE_KEY);
    if (!rawValue) return {};
    const parsedValue = JSON.parse(rawValue);
    return parsedValue && typeof parsedValue === 'object' ? parsedValue : {};
  } catch {
    return {};
  }
};

const saveStoredDeviceNames = (names: Record<string, string>) => {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEVICE_NAME_STORAGE_KEY, JSON.stringify(names));
};

const formatOperationError = <T,>(result: ElectronResult<T>, fallbackMessage: string) => {
  const baseMessage = result.error || fallbackMessage;
  return result.hint ? `${baseMessage} ${result.hint}` : baseMessage;
};

const getDeviceStatusMeta = (status: DeviceInfo['status']) => {
  switch (status) {
    case 'connected':
      return { label: '已连接', color: '#22c55e', background: '#22c55e22' };
    case 'offline':
      return { label: '离线', color: '#f59e0b', background: '#f59e0b22' };
    case 'unauthorized':
      return { label: '未授权', color: '#ef4444', background: '#ef444422' };
    default:
      return { label: '已断开', color: '#9ca3af', background: '#9ca3af22' };
  }
};

const getWifiLatencyLabel = (device: DeviceInfo) => {
  if (device.connectionType !== 'wifi') return null;
  if (device.latencyStatus === 'ok' && device.latencyMs !== undefined) {
    return `延迟 ${device.latencyMs}ms`;
  }
  if (device.latencyStatus === 'timeout') {
    return '连接不稳';
  }
  return '延迟 --';
};

const getBatteryColor = (batteryLevel?: number) => {
  if (batteryLevel === undefined) return '#9ca3af';
  if (batteryLevel <= 20) return '#ef4444';
  if (batteryLevel <= 40) return '#f59e0b';
  return '#22c55e';
};

const renderBatteryBadge = (device: DeviceInfo) => {
  const batteryLevel = device.batteryLevel;
  const batteryColor = getBatteryColor(batteryLevel);
  const batteryFill = batteryLevel === undefined ? 0 : batteryLevel;

  return (
    <div title={batteryLevel === undefined ? '电量未知' : `电量 ${batteryLevel}%`} style={{ display: 'flex', alignItems: 'center', gap: '5px', color: batteryColor, fontSize: '12px', lineHeight: 1 }}>
      <div style={{ width: '22px', height: '11px', border: `1px solid ${batteryColor}`, borderRadius: '3px', padding: '1px', position: 'relative', boxSizing: 'border-box' }}>
        <div style={{ width: `${batteryFill}%`, height: '100%', backgroundColor: batteryColor, borderRadius: '1px' }} />
        <div style={{ position: 'absolute', right: '-4px', top: '3px', width: '2px', height: '5px', backgroundColor: batteryColor, borderRadius: '0 2px 2px 0' }} />
      </div>
      <span>{batteryLevel === undefined ? '--%' : `${batteryLevel}%`}</span>
    </div>
  );
};

function SimpleApp() {
  const [adbStatus, setAdbStatus] = useState<AdbStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [customDeviceNames, setCustomDeviceNames] = useState<Record<string, string>>(() => loadStoredDeviceNames());
  const [activeTab, setActiveTab] = useState<TabType>('devices');
  const [mirrorSessionsByDeviceId, setMirrorSessionsByDeviceId] = useState<Record<string, MirrorSession>>({});
  const [mirrorStartingDeviceIds, setMirrorStartingDeviceIds] = useState<Set<string>>(new Set());
  const [logVersion, setLogVersion] = useState(0);
  const [logViewport, setLogViewport] = useState({ scrollTop: 0, height: 320 });
  const [performanceByDeviceId, setPerformanceByDeviceId] = useState<Record<string, PerformanceMetrics>>({});
  const [performanceSamplesByDeviceId, setPerformanceSamplesByDeviceId] = useState<Record<string, PerformanceSample[]>>({});
  const [performanceSessionStartedAtByDeviceId, setPerformanceSessionStartedAtByDeviceId] = useState<Record<string, Date>>({});
  const [performanceEnabledDeviceIds, setPerformanceEnabledDeviceIds] = useState<Set<string>>(() => new Set());
  const [performanceSnapshots, setPerformanceSnapshots] = useState<PerformanceSnapshot[]>([]);
  const [performanceRecordings, setPerformanceRecordings] = useState<PerformanceRecording[]>([]);
  const [recordingDeviceIds, setRecordingDeviceIds] = useState<Set<string>>(() => new Set());
  const [installedPackages, setInstalledPackages] = useState<string[]>([]);
  const [installedPackagesLoading, setInstalledPackagesLoading] = useState(false);
  const [appFilter, setAppFilter] = useState('');
  const [busyPackage, setBusyPackage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'launch' | 'stop' | 'uninstall' | null>(null);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [selectedNetworkRequestId, setSelectedNetworkRequestId] = useState<string | null>(null);
  const [runningLogDeviceIds, setRunningLogDeviceIds] = useState<Set<string>>(() => new Set());
  const [wifiIp, setWifiIp] = useState('');
  const [showPairForm, setShowPairForm] = useState(false);
  const [pairAddress, setPairAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [packageFilter, setPackageFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [filterLevel, setFilterLevel] = useState<LogLevelFilter>('all');
  const [logTagFilter, setLogTagFilter] = useState('');
  const [logPackageFilter, setLogPackageFilter] = useState('');
  const [logPidFilter, setLogPidFilter] = useState('');
  const [useRegexSearch, setUseRegexSearch] = useState(false);
  const [pausedLogDeviceIds, setPausedLogDeviceIds] = useState<Set<string>>(() => new Set());
  const [selectedLogEntry, setSelectedLogEntry] = useState<LogEntry | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [maxLogEntries, setMaxLogEntries] = useState(MAX_LOG_ENTRIES);
  const [batchUpdateSize, setBatchUpdateSize] = useState(BATCH_UPDATE_SIZE);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [isCapturingSnapshot, setIsCapturingSnapshot] = useState(false);
  const [apkInstallStates, setApkInstallStates] = useState<Record<string, DeviceApkInstallState>>({});
  const [pendingApks, setPendingApks] = useState<{ path: string; fileName: string }[]>([]);
  const [installTargets, setInstallTargets] = useState<Set<string>>(new Set());
  const [installConcurrency, setInstallConcurrency] = useState(4);
  const [installAllowDowngrade, setInstallAllowDowngrade] = useState(false);
  const [isUnifiedInstalling, setIsUnifiedInstalling] = useState(false);
  const [busyDeviceAction, setBusyDeviceAction] = useState<{ id: string; action: 'sleep' | 'wake' | 'unlock' | 'reboot' } | null>(null);
  
  const logStatesRef = useRef(new Map<string, DeviceLogState>());
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const selectedDeviceRef = useRef<DeviceInfo | null>(null);
  const maxLogEntriesRef = useRef(MAX_LOG_ENTRIES);
  const batchUpdateSizeRef = useRef(BATCH_UPDATE_SIZE);
  const performanceRequestInFlightRef = useRef(new Set<string>());
  const apkInstallProgressTimersRef = useRef(new Map<string, number>());

  const resetDeviceRuntimeState = useCallback(() => {
    setSelectedDevice(null);
    logStatesRef.current.forEach(state => {
      state.running = false;
      state.paused = false;
    });
    setRunningLogDeviceIds(new Set());
    setPausedLogDeviceIds(new Set());
    setLogVersion(version => version + 1);
  }, []);

  const getDeviceDisplayName = useCallback((device: DeviceInfo) => {
    const customName = customDeviceNames[device.id]?.trim();
    return customName || device.name || device.model || device.id;
  }, [customDeviceNames]);

  const updateCustomDeviceName = useCallback((deviceId: string, value: string) => {
    setCustomDeviceNames(prev => {
      const next = { ...prev };
      if (value.trim()) {
        next[deviceId] = value;
      } else {
        delete next[deviceId];
      }
      saveStoredDeviceNames(next);
      return next;
    });
  }, []);

  const getDeviceApkInstallState = useCallback((deviceId: string): DeviceApkInstallState => {
    return apkInstallStates[deviceId] || { queue: [], isInstalling: false };
  }, [apkInstallStates]);

  const updateDeviceApkInstallState = useCallback((deviceId: string, updater: (state: DeviceApkInstallState) => DeviceApkInstallState) => {
    setApkInstallStates(previousStates => ({
      ...previousStates,
      [deviceId]: updater(previousStates[deviceId] || { queue: [], isInstalling: false }),
    }));
  }, []);

  const stopApkInstallProgressTimer = useCallback((itemId: string) => {
    const timerId = apkInstallProgressTimersRef.current.get(itemId);
    if (timerId !== undefined) {
      window.clearInterval(timerId);
      apkInstallProgressTimersRef.current.delete(itemId);
    }
  }, []);

  const startApkInstallProgressTimer = useCallback((deviceId: string, itemId: string) => {
    stopApkInstallProgressTimer(itemId);
    const timerId = window.setInterval(() => {
      updateDeviceApkInstallState(deviceId, previousState => ({
        ...previousState,
        queue: previousState.queue.map(item => {
          if (item.id !== itemId || item.status !== 'installing') return item;
          const nextProgress = item.progress < 70
            ? item.progress + 6
            : item.progress < 90
              ? item.progress + 2
              : item.progress < 96
                ? item.progress + 0.5
                : item.progress;
          return { ...item, progress: Math.min(nextProgress, 96) };
        }),
      }));
    }, 800);
    apkInstallProgressTimersRef.current.set(itemId, timerId);
  }, [stopApkInstallProgressTimer, updateDeviceApkInstallState]);

  const getLogState = useCallback((deviceId: string) => {
    let state = logStatesRef.current.get(deviceId);
    if (!state) {
      state = createDeviceLogState(maxLogEntriesRef.current);
      logStatesRef.current.set(deviceId, state);
    }
    return state;
  }, []);

  const clearDeviceLogs = useCallback((deviceId: string) => {
    const state = getLogState(deviceId);
    if (state.flushTimer !== null) {
      window.clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    state.store.clear();
    state.buffer = [];
    state.updateScheduled = false;
    setSelectedLogEntry(current => current?.deviceId === deviceId ? null : current);
    setLogVersion(version => version + 1);
  }, [getLogState]);

  const removeDeviceLogState = useCallback((deviceId: string) => {
    const state = logStatesRef.current.get(deviceId);
    if (state?.flushTimer !== null && state?.flushTimer !== undefined) {
      window.clearTimeout(state.flushTimer);
    }
    logStatesRef.current.delete(deviceId);
    setRunningLogDeviceIds(prev => {
      const next = new Set(prev);
      next.delete(deviceId);
      return next;
    });
    setPausedLogDeviceIds(prev => {
      const next = new Set(prev);
      next.delete(deviceId);
      return next;
    });
    setSelectedLogEntry(current => current?.deviceId === deviceId ? null : current);
    setLogVersion(version => version + 1);
  }, []);

  const reconcileLogStatesWithDevices = useCallback((nextDevices: DeviceInfo[]) => {
    const nextDeviceIds = new Set(nextDevices.map(device => device.id));
    for (const deviceId of logStatesRef.current.keys()) {
      if (!nextDeviceIds.has(deviceId)) {
        const state = logStatesRef.current.get(deviceId);
        if (state?.flushTimer !== null && state?.flushTimer !== undefined) {
          window.clearTimeout(state.flushTimer);
        }
        logStatesRef.current.delete(deviceId);
      }
    }

    setRunningLogDeviceIds(prev => {
      const next = new Set<string>();
      prev.forEach(deviceId => {
        if (nextDeviceIds.has(deviceId)) next.add(deviceId);
      });
      return next;
    });
    setPausedLogDeviceIds(prev => {
      const next = new Set<string>();
      prev.forEach(deviceId => {
        if (nextDeviceIds.has(deviceId)) next.add(deviceId);
      });
      return next;
    });
    setSelectedLogEntry(current => current && nextDeviceIds.has(current.deviceId) ? current : null);
    setLogVersion(version => version + 1);
  }, []);

  const applyDeviceList = useCallback((nextDevices: DeviceInfo[]) => {
    setDevices(nextDevices);
    reconcileLogStatesWithDevices(nextDevices);
    if (nextDevices.length > 0) {
      setSelectedDevice(currentSelectedDevice => {
        if (currentSelectedDevice && nextDevices.find(device => device.id === currentSelectedDevice.id)) {
          return nextDevices.find(device => device.id === currentSelectedDevice.id) || currentSelectedDevice;
        }
        return nextDevices[0];
      });
      return;
    }

    resetDeviceRuntimeState();
  }, [reconcileLogStatesWithDevices, resetDeviceRuntimeState]);

  useEffect(() => {
    selectedDeviceRef.current = selectedDevice;
  }, [selectedDevice]);

  useEffect(() => {
    maxLogEntriesRef.current = maxLogEntries;
    logStatesRef.current.forEach(state => state.store.setLimit(maxLogEntries));
    setLogVersion(version => version + 1);
  }, [maxLogEntries]);

  useEffect(() => {
    batchUpdateSizeRef.current = batchUpdateSize;
  }, [batchUpdateSize]);

  const flushDeviceLogBuffer = useCallback((deviceId: string) => {
    const state = logStatesRef.current.get(deviceId);
    if (!state) return;
    const buffer = state.buffer;
    if (buffer.length === 0) {
      state.updateScheduled = false;
      state.flushTimer = null;
      return;
    }
    
    state.store.append(buffer);
    setLogVersion(version => version + 1);
    
    state.buffer = [];
    state.updateScheduled = false;
    state.flushTimer = null;
  }, []);

  const enqueueLogEntries = useCallback((entries: LogEntry[]) => {
    if (entries.length === 0) {
      return;
    }

    const entriesByDevice = new Map<string, LogEntry[]>();
    for (const entry of entries) {
      if (!entry.deviceId) continue;
      const deviceEntries = entriesByDevice.get(entry.deviceId) || [];
      deviceEntries.push(entry);
      entriesByDevice.set(entry.deviceId, deviceEntries);
    }

    entriesByDevice.forEach((deviceEntries, deviceId) => {
      const state = getLogState(deviceId);
      if (state.paused) return;

      state.buffer = [...state.buffer, ...deviceEntries].slice(-MAX_PENDING_LOG_BUFFER);

      if (state.buffer.length >= batchUpdateSizeRef.current) {
        if (state.flushTimer !== null) {
          window.clearTimeout(state.flushTimer);
          state.flushTimer = null;
        }
        flushDeviceLogBuffer(deviceId);
        return;
      }

      if (!state.updateScheduled) {
        state.updateScheduled = true;
        state.flushTimer = window.setTimeout(() => flushDeviceLogBuffer(deviceId), BATCH_UPDATE_DELAY);
      }
    });
  }, [flushDeviceLogBuffer, getLogState]);

  useEffect(() => {
    const initApp = async () => {
      await Promise.all([loadAdbStatus(), loadDevices()]);
      
      if (hasElectronAPI()) {
        const unsubscribeAdbStatusChanged = window.electronAPI!.onAdbStatusChanged((status) => {
          setAdbStatus(status);
        });
        const unsubscribeDeviceListChanged = window.electronAPI!.onDeviceListChanged((nextDevices) => {
          applyDeviceList(nextDevices);
        });
        const unsubscribeDeviceConnected = window.electronAPI!.onDeviceConnected((device) => {
          setDevices(prev => {
            if (prev.some(existingDevice => existingDevice.id === device.id)) {
              return prev;
            }
            return [...prev, device];
          });
        });
        
        const unsubscribeDeviceDisconnected = window.electronAPI!.onDeviceDisconnected((deviceId) => {
          setDevices(prev => {
            const nextDevices = prev.filter(d => d.id !== deviceId);
            if (selectedDeviceRef.current?.id === deviceId) {
              setSelectedDevice(nextDevices[0] || null);
            }
            return nextDevices;
          });
          removeDeviceLogState(deviceId);
        });
        
        const unsubscribeLogEntry = window.electronAPI!.onLogEntry((entry) => {
          enqueueLogEntries([entry]);
        });
        const unsubscribeLogBatch = window.electronAPI!.onLogBatch((entries) => {
          enqueueLogEntries(entries);
        });
        const unsubscribeMirrorStatus = window.electronAPI!.onMirrorStatus((session) => {
          setMirrorSessionsByDeviceId(prev => ({ ...prev, [session.deviceId]: session }));
          setMirrorStartingDeviceIds(prev => {
            if (!prev.has(session.deviceId)) return prev;
            const next = new Set(prev);
            next.delete(session.deviceId);
            return next;
          });
        });

        return () => {
          unsubscribeAdbStatusChanged();
          unsubscribeDeviceListChanged();
          unsubscribeDeviceConnected();
          unsubscribeDeviceDisconnected();
          unsubscribeLogEntry();
          unsubscribeLogBatch();
          unsubscribeMirrorStatus();
          logStatesRef.current.forEach(state => {
            if (state.flushTimer !== null) {
              window.clearTimeout(state.flushTimer);
            }
          });
          apkInstallProgressTimersRef.current.forEach(timerId => window.clearInterval(timerId));
          apkInstallProgressTimersRef.current.clear();
        };
      }
    };

    const cleanupPromise = initApp();
    return () => {
      cleanupPromise.then((cleanup) => {
        if (cleanup) cleanup();
      });
    };
  }, [applyDeviceList, enqueueLogEntries, removeDeviceLogState]);

  

  useEffect(() => {
    if (selectedDevice && activeTab === 'performance' && performanceEnabledDeviceIds.has(selectedDevice.id)) {
      void loadPerformance(selectedDevice.id, true);
      const interval = setInterval(() => {
        loadPerformance(selectedDevice.id, true);
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [selectedDevice, activeTab, performanceEnabledDeviceIds]);

  // 已安装应用列表只在设备连接（id 变化）时获取一次，避免设备轮询导致的频繁刷新；
  // 卸载 / 安装完成后单独触发刷新，其余情况由用户手动点刷新。
  useEffect(() => {
    if (selectedDevice?.id) {
      setInstalledPackages([]);
      setAppFilter('');
      loadInstalledPackages();
      // 默认把当前设备加入安装目标（仅当尚未选择任何目标时）
      setInstallTargets((prev) => (prev.size === 0 ? new Set([selectedDevice.id]) : prev));
    } else {
      setInstalledPackages([]);
      setAppFilter('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id]);

  useEffect(() => {
    setSelectedNetworkRequestId(null);
    if (!selectedDevice) {
      setNetworkRequests([]);
    }
  }, [selectedDevice]);

  

  const loadAdbStatus = async () => {
    if (!hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.getAdbStatus();
      if (result.success && result.data) {
        setAdbStatus(result.data);
        if (result.data.available && error.includes('ADB')) {
          setError('');
        }
      } else {
        setAdbStatus({
          available: false,
          version: null,
          path: null,
          message: formatOperationError(result, '获取 ADB 状态失败'),
          checkedAt: Date.now(),
          code: result.code,
          hint: result.hint,
        });
      }
    } catch (err) {
      setAdbStatus({
        available: false,
        version: null,
        path: null,
        message: '获取 ADB 状态失败',
        checkedAt: Date.now(),
      });
    }
  };

  const loadDevices = async () => {
    if (!hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.getDevices();
      if (result.success && result.data) {
        applyDeviceList(result.data);
        setError('');
      } else {
        setDevices([]);
        resetDeviceRuntimeState();
        setError(formatOperationError(result, '\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25'));
        await loadAdbStatus();
      }
    } catch (err) {
      setDevices([]);
      resetDeviceRuntimeState();
      setError('\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25');
      await loadAdbStatus();
    }
  };

  const connectUSBDevice = async () => {
    if (!hasElectronAPI()) {
      setError('Electron \u63a5\u53e3\u4e0d\u53ef\u7528');
      return;
    }
    try {
      setError('\u6b63\u5728\u5237\u65b0 USB \u8bbe\u5907...');
      const result = await window.electronAPI!.connectUSB();
      if (result.success && result.data) {
        applyDeviceList(result.data);
        setError('');
        await loadAdbStatus();
      } else {
        setError(formatOperationError(result, 'USB \u8bbe\u5907\u5237\u65b0\u5931\u8d25'));
        await loadAdbStatus();
      }
    } catch (err) {
      setError('USB \u8bbe\u5907\u5237\u65b0\u5931\u8d25\uff1a' + (err as Error).message);
      await loadAdbStatus();
    }
  };

  const connectWiFiDevice = async () => {
    console.log('connectWiFiDevice called');
    console.log('wifiIp:', wifiIp);
    console.log('hasElectronAPI:', hasElectronAPI());
    console.log('electronAPI:', window.electronAPI);
    
    if (!wifiIp.trim()) {
      setError('\u8bf7\u8f93\u5165\u8bbe\u5907 IP \u5730\u5740');
      return;
    }
    
    if (!hasElectronAPI()) {
      setError('Electron \u63a5\u53e3\u4e0d\u53ef\u7528');
      return;
    }
    
    try {
      setError('\u6b63\u5728\u8fde\u63a5...');
      const result = await window.electronAPI!.connectWiFi(wifiIp);
      console.log('connectWiFi result:', result);
      if (result.success) {
        setWifiIp('');
        setError('');
        await loadAdbStatus();
        await loadDevices();
      } else {
        setError(formatOperationError(result, 'WiFi \u8fde\u63a5\u5931\u8d25'));
        await loadAdbStatus();
      }
    } catch (err) {
      console.error('connectWiFi error:', err);
      setError('WiFi \u8fde\u63a5\u5931\u8d25\uff1a' + (err as Error).message);
      await loadAdbStatus();
    }
  };

  const pairWiFiDevice = async () => {
    if (!pairAddress.trim()) {
      setError('\u8bf7\u8f93\u5165\u914d\u5bf9\u5730\u5740 IP:\u7aef\u53e3');
      return;
    }
    if (!pairCode.trim()) {
      setError('\u8bf7\u8f93\u5165 6 \u4f4d\u914d\u5bf9\u7801');
      return;
    }
    if (!hasElectronAPI()) {
      setError('Electron \u63a5\u53e3\u4e0d\u53ef\u7528');
      return;
    }

    setPairing(true);
    try {
      setError('\u6b63\u5728\u914d\u5bf9...');
      const result = await window.electronAPI!.pairWiFi(pairAddress, pairCode);
      if (result.success) {
        setError('');
        setPairCode('');
        if (result.data?.alreadyPaired) {
          // \u5df2\u914d\u5bf9\u8fc7\uff1a\u63d0\u793a\u5e76\u628a\u5df2\u8fde\u63a5\u7684 IP:\u7aef\u53e3\u586b\u5165\u4e0a\u65b9 WiFi \u8fde\u63a5\u6846\uff0c\u65b9\u4fbf\u7528\u6237\u76f4\u63a5\u8fde\u63a5
          setSuccess(result.data.message || '\u8be5\u8bbe\u5907\u5df2\u914d\u5bf9\u8fc7');
          if (result.data.device) {
            setWifiIp(result.data.device.id);
          } else {
            const ipPart = pairAddress.trim().split(':')[0];
            if (ipPart) {
              setWifiIp(ipPart + ':');
            }
          }
          await loadAdbStatus();
          await loadDevices();
        } else if (result.data?.device) {
          // \u914d\u5bf9\u540e\u5df2\u81ea\u52a8\u8fde\u4e0a\uff0c\u76f4\u63a5\u5237\u65b0\u8bbe\u5907\u5217\u8868\uff0c\u65e0\u9700\u7528\u6237\u518d\u586b IP:\u7aef\u53e3
          setSuccess(result.data.message || '\u914d\u5bf9\u5e76\u8fde\u63a5\u6210\u529f');
          setShowPairForm(false);
          setPairAddress('');
          await loadAdbStatus();
          await loadDevices();
        } else {
          // \u81ea\u52a8\u8fde\u63a5\u5931\u8d25\uff08\u5c11\u6570\u73af\u5883\uff09\uff0c\u9000\u56de\u624b\u52a8\uff1a\u628a IP \u586b\u5230\u8fde\u63a5\u6846\u8ba9\u7528\u6237\u8865\u7aef\u53e3
          setSuccess(result.data?.message || '\u914d\u5bf9\u6210\u529f\uff0c\u8bf7\u5728\u4e0a\u65b9\u586b\u5199 IP:\u8fde\u63a5\u7aef\u53e3\u70b9\u300c\u8fde\u63a5\u300d');
          const ipPart = pairAddress.trim().split(':')[0];
          if (ipPart) {
            setWifiIp(ipPart + ':');
          }
        }
      } else {
        setError(formatOperationError(result, 'WiFi \u914d\u5bf9\u5931\u8d25'));
      }
    } catch (err) {
      console.error('pairWiFi error:', err);
      setError('WiFi \u914d\u5bf9\u5931\u8d25\uff1a' + (err as Error).message);
    } finally {
      setPairing(false);
    }
  };

  const disconnectDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI()) return;
    const deviceId = device.id;
    try {
      if (device.connectionType === 'usb') {
        await window.electronAPI!.stopLogcat(deviceId).catch(() => undefined);
        removeDeviceLogState(deviceId);
        setDevices(prev => {
          const nextDevices = prev.filter(item => item.id !== deviceId);
          if (selectedDeviceRef.current?.id === deviceId) {
            setSelectedDevice(nextDevices[0] || null);
          }
          return nextDevices;
        });
        setError('');
        return;
      }

      const result = await window.electronAPI!.disconnect(deviceId);
      if (!result.success) {
        setError(formatOperationError(result, '\u65ad\u5f00\u8bbe\u5907\u5931\u8d25'));
        return;
      }
      removeDeviceLogState(deviceId);
      await loadAdbStatus();
      await loadDevices();
    } catch (err) {
      setError('\u65ad\u5f00\u8bbe\u5907\u5931\u8d25\uff1a' + (err as Error).message);
    }
  };

  const toggleLogcat = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    
    const state = getLogState(selectedDevice.id);
    if (state.running) {
      await window.electronAPI!.stopLogcat(selectedDevice.id);
      state.running = false;
      state.paused = false;
      setRunningLogDeviceIds(prev => {
        const next = new Set(prev);
        next.delete(selectedDevice.id);
        return next;
      });
      setPausedLogDeviceIds(prev => {
        const next = new Set(prev);
        next.delete(selectedDevice.id);
        return next;
      });
    } else {
      const sourcePackage = logPackageFilter.trim() || packageFilter.trim() || undefined;
      const sourcePid = logPidFilter.trim() || undefined;
      const sourceLevel: LogEntry['level'] = filterLevel === 'all' ? 'V' : filterLevel;
      const result = await window.electronAPI!.startLogcat(selectedDevice.id, sourceLevel, sourcePackage, sourcePid);
      if (result.success) {
        state.running = true;
        state.paused = false;
        clearDeviceLogs(selectedDevice.id);
        setRunningLogDeviceIds(prev => new Set(prev).add(selectedDevice.id));
        setPausedLogDeviceIds(prev => {
          const next = new Set(prev);
          next.delete(selectedDevice.id);
          return next;
        });
      } else {
        setError(result.error || '\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25');
      }
    }
  };

  const toggleSelectedDevicePause = () => {
    if (!selectedDevice) return;
    const state = getLogState(selectedDevice.id);
    state.paused = !state.paused;
    setPausedLogDeviceIds(prev => {
      const next = new Set(prev);
      if (state.paused) {
        next.add(selectedDevice.id);
      } else {
        next.delete(selectedDevice.id);
      }
      return next;
    });
    setLogVersion(version => version + 1);
  };

  const loadPerformance = async (deviceId = selectedDevice?.id, recordSample = false) => {
    if (!deviceId || !hasElectronAPI()) return;
    if (performanceRequestInFlightRef.current.has(deviceId)) return;
    performanceRequestInFlightRef.current.add(deviceId);
    try {
      const result = await window.electronAPI!.getPerformance(deviceId);
      if (result.success && result.data) {
        setPerformanceByDeviceId((previous) => ({ ...previous, [deviceId]: result.data! }));
        if (recordSample) {
          const capturedAt = new Date();
          setPerformanceSamplesByDeviceId((previous) => ({
            ...previous,
            [deviceId]: [
              ...(previous[deviceId] || []),
              { id: `${deviceId}-${capturedAt.getTime()}`, deviceId, capturedAt, metrics: result.data! },
            ].slice(-3600),
          }));
        }
      }
    } catch (err) {
      console.error('Load performance error:', err);
    } finally {
      performanceRequestInFlightRef.current.delete(deviceId);
    }
  };

  const togglePerformanceMonitoring = () => {
    if (!selectedDevice) return;
    const deviceId = selectedDevice.id;
    setPerformanceEnabledDeviceIds((previous) => {
      const next = new Set(previous);
      if (next.has(deviceId)) {
        next.delete(deviceId);
      } else {
        next.add(deviceId);
        setPerformanceSamplesByDeviceId((previous) => ({ ...previous, [deviceId]: [] }));
        setPerformanceSessionStartedAtByDeviceId((previous) => ({ ...previous, [deviceId]: new Date() }));
        void loadPerformance(deviceId, true);
      }
      return next;
    });
  };

  const capturePerformanceSnapshot = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    const currentPerformance = performanceByDeviceId[deviceId];
    if (!performanceEnabledDeviceIds.has(deviceId)) {
      setPerformanceEnabledDeviceIds((previous) => new Set(previous).add(deviceId));
      setPerformanceSamplesByDeviceId((previous) => ({ ...previous, [deviceId]: previous[deviceId] || [] }));
      setPerformanceSessionStartedAtByDeviceId((previous) => ({ ...previous, [deviceId]: previous[deviceId] || new Date() }));
    }

    setIsCapturingSnapshot(true);
    try {
      const result = await window.electronAPI!.capturePerformanceSnapshot(deviceId, currentPerformance);
      if (result.success && result.data) {
        setPerformanceByDeviceId((previous) => ({ ...previous, [deviceId]: result.data!.metrics }));
        setPerformanceSamplesByDeviceId((previous) => ({
          ...previous,
          [deviceId]: [
            ...(previous[deviceId] || []),
            { id: `${deviceId}-${new Date(result.data!.capturedAt).getTime()}-snapshot`, deviceId, capturedAt: result.data!.capturedAt, metrics: result.data!.metrics },
          ].slice(-3600),
        }));
        setPerformanceSnapshots((previousSnapshots) => [result.data!, ...previousSnapshots].slice(0, 20));
        setError('');
      } else {
        setError(result.error || '抓取性能快照失败');
      }
    } catch (err) {
      setError('抓取性能快照失败：' + (err as Error).message);
    } finally {
      setIsCapturingSnapshot(false);
    }
  };

  const startPerformanceRecording = async (durationSeconds: 10 | 30 | 60) => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    if (recordingDeviceIds.has(deviceId)) {
      setError('当前设备正在录制性能片段。');
      return;
    }

    setRecordingDeviceIds((previous) => new Set(previous).add(deviceId));
    if (!performanceEnabledDeviceIds.has(deviceId)) {
      setPerformanceEnabledDeviceIds((previous) => new Set(previous).add(deviceId));
      setPerformanceSamplesByDeviceId((previous) => ({ ...previous, [deviceId]: previous[deviceId] || [] }));
      setPerformanceSessionStartedAtByDeviceId((previous) => ({ ...previous, [deviceId]: previous[deviceId] || new Date() }));
    }

    try {
      const result = await window.electronAPI!.startPerformanceRecording(deviceId, { durationSeconds, bitRateMbps: 8 });
      if (result.success && result.data) {
        setPerformanceRecordings((previous) => [result.data!, ...previous].slice(0, 12));
        if (result.data.samples.length > 0) {
          setPerformanceSamplesByDeviceId((previous) => ({
            ...previous,
            [deviceId]: [...(previous[deviceId] || []), ...result.data!.samples].slice(-300),
          }));
          const lastSample = result.data.samples[result.data.samples.length - 1];
          setPerformanceByDeviceId((previous) => ({ ...previous, [deviceId]: lastSample.metrics }));
        }
        setError('');
      } else {
        setError(result.error || '性能录制失败');
      }
    } catch (err) {
      setError('性能录制失败：' + (err as Error).message);
    } finally {
      setRecordingDeviceIds((previous) => {
        const next = new Set(previous);
        next.delete(deviceId);
        return next;
      });
    }
  };

  const exportPerformanceSession = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const samples = performanceSamplesByDeviceId[selectedDevice.id] || [];
    if (samples.length === 0) {
      setError('当前设备还没有性能采样数据，请先开启采集。');
      return;
    }

    const result = await window.electronAPI!.exportPerformanceSession({
      device: selectedDevice,
      startedAt: performanceSessionStartedAtByDeviceId[selectedDevice.id] || samples[0].capturedAt,
      endedAt: new Date(),
      samples,
      snapshots: visibleSessionSnapshots,
    });

    if (result.success) {
      setError('');
    } else {
      setError(result.error || '导出性能采集报告失败');
    }
  };

  const selectApkFiles = async () => {
    if (!hasElectronAPI()) {
      setError('Electron 接口不可用');
      return;
    }
    try {
      const result = await window.electronAPI!.selectApkFiles();
      if (!result.success || !result.data) {
        setError(formatOperationError(result, '选择安装包失败'));
        return;
      }
      if (result.data.length === 0) return;
      setPendingApks((prev) => {
        const existing = new Set(prev.map((a) => a.path));
        const added = result.data!
          .filter((p) => p.toLowerCase().endsWith('.apk') && !existing.has(p))
          .map((p) => ({ path: p, fileName: p.split(/[\\/]/).pop() || p }));
        return [...prev, ...added];
      });
      setError('');
    } catch (err) {
      setError('选择安装包失败：' + (err as Error).message);
    }
  };

  const removePendingApk = (path: string) => {
    setPendingApks((prev) => prev.filter((a) => a.path !== path));
  };

  const toggleInstallTarget = (deviceId: string) => {
    if (isUnifiedInstalling) return;
    setInstallTargets((prev) => {
      const next = new Set(prev);
      if (next.has(deviceId)) next.delete(deviceId);
      else next.add(deviceId);
      return next;
    });
  };

  // 给指定设备安装一组 items（items 直接传入，避免读取尚未刷新的队列状态）。
  const installItemsOnDevice = async (deviceId: string, items: ApkInstallQueueItem[]) => {
    for (const item of items) {
      updateDeviceApkInstallState(deviceId, (previousState) => ({
        ...previousState,
        queue: previousState.queue.map((q) =>
          q.id === item.id ? { ...q, status: 'installing', progress: Math.max(q.progress, 8), error: undefined, output: undefined } : q
        ),
      }));
      startApkInstallProgressTimer(deviceId, item.id);
      try {
        const result = await window.electronAPI!.installApk(deviceId, item.path, { allowDowngrade: installAllowDowngrade });
        stopApkInstallProgressTimer(item.id);
        updateDeviceApkInstallState(deviceId, (previousState) => ({
          ...previousState,
          queue: previousState.queue.map((q) =>
            q.id === item.id
              ? { ...q, status: result.success ? 'success' : 'failed', progress: 100, output: result.data?.output, error: result.success ? undefined : formatOperationError(result, '安装失败') }
              : q
          ),
        }));
      } catch (err) {
        stopApkInstallProgressTimer(item.id);
        updateDeviceApkInstallState(deviceId, (previousState) => ({
          ...previousState,
          queue: previousState.queue.map((q) => (q.id === item.id ? { ...q, status: 'failed', progress: 100, error: (err as Error).message } : q)),
        }));
      }
    }
    updateDeviceApkInstallState(deviceId, (previousState) => ({ ...previousState, isInstalling: false }));
    if (selectedDeviceRef.current?.id === deviceId) {
      void loadInstalledPackages();
    }
  };

  // 统一安装：把待装 APK 入队到所选在线设备，按并发上限并行安装。
  const startUnifiedInstall = async () => {
    if (isUnifiedInstalling || !hasElectronAPI()) return;
    const targetIds = Array.from(installTargets).filter((id) => devices.find((d) => d.id === id)?.status === 'connected');
    if (pendingApks.length === 0 || targetIds.length === 0) return;

    const perDeviceItems: Record<string, ApkInstallQueueItem[]> = {};
    targetIds.forEach((id) => {
      perDeviceItems[id] = pendingApks.map((a) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${id}`,
        path: a.path,
        fileName: a.fileName,
        status: 'queued' as ApkInstallStatus,
        progress: 0,
      }));
    });
    setApkInstallStates((prev) => {
      const next = { ...prev };
      targetIds.forEach((id) => {
        const existing = next[id]?.queue.filter((it) => it.status !== 'success') || [];
        next[id] = { queue: [...existing, ...perDeviceItems[id]], isInstalling: true };
      });
      return next;
    });
    setError('');
    setIsUnifiedInstalling(true);

    const limit = installConcurrency > 0 ? installConcurrency : targetIds.length;
    let index = 0;
    const worker = async () => {
      while (index < targetIds.length) {
        const deviceId = targetIds[index];
        index += 1;
        await installItemsOnDevice(deviceId, perDeviceItems[deviceId]);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(limit, targetIds.length) || 1 }, () => worker()));
    } finally {
      setIsUnifiedInstalling(false);
    }
  };

  const retryDeviceInstall = async (deviceId: string) => {
    if (isUnifiedInstalling || !hasElectronAPI()) return;
    if (devices.find((d) => d.id === deviceId)?.status !== 'connected') {
      updateDeviceApkInstallState(deviceId, (previousState) => ({
        ...previousState,
        queue: previousState.queue.map((q) => (q.status === 'failed' ? { ...q, error: '设备已离线' } : q)),
      }));
      return;
    }
    const failed = getDeviceApkInstallState(deviceId).queue.filter((it) => it.status === 'failed');
    if (failed.length === 0) return;
    setIsUnifiedInstalling(true);
    updateDeviceApkInstallState(deviceId, (s) => ({ ...s, isInstalling: true }));
    try {
      await installItemsOnDevice(deviceId, failed);
    } finally {
      setIsUnifiedInstalling(false);
    }
  };

  const clearCompletedApkInstalls = (deviceId: string) => {
    updateDeviceApkInstallState(deviceId, (previousState) => ({
      ...previousState,
      queue: previousState.queue.filter((item) => item.status !== 'success'),
    }));
  };

  const removeApkInstallItem = (deviceId: string, itemId: string) => {
    updateDeviceApkInstallState(deviceId, (previousState) => ({
      ...previousState,
      queue: previousState.queue.filter((item) => item.id !== itemId || item.status === 'installing'),
    }));
  };

  // 保证按钮冷却至少 minMs，让点击有可见反馈（即使 adb 指令秒回）。
  const withMinCooldown = async (startedAt: number, minMs: number) => {
    const elapsed = Date.now() - startedAt;
    if (elapsed < minMs) {
      await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
    }
  };

  const handleSleepDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'sleep' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.sleepDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备息屏失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备息屏失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const handleWakeDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'wake' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.wakeDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备唤醒失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备唤醒失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const handleUnlockDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'unlock' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.unlockDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备解锁失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备解锁失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const handleRebootDevice = async (device: DeviceInfo) => {
    if (!hasElectronAPI() || busyDeviceAction) return;
    setBusyDeviceAction({ id: device.id, action: 'reboot' });
    const startedAt = Date.now();
    try {
      const result = await window.electronAPI!.rebootDevice(device.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备重启失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备重启失败: ' + (err as Error).message);
    } finally {
      await withMinCooldown(startedAt, 500);
      setBusyDeviceAction(null);
    }
  };

  const loadNetworkRequests = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      setError('');
      const result = await window.electronAPI!.getNetworkRequests(selectedDevice.id, packageFilter.trim() || undefined);
      if (result.success && result.data) {
        setNetworkRequests(result.data);
        setSelectedNetworkRequestId(result.data[0]?.id || null);
        setError('');
      } else {
        setNetworkRequests([]);
        setSelectedNetworkRequestId(null);
        setError(result.error || '\u52a0\u8f7d\u8bbe\u5907\u5931\u8d25');
      }
    } catch (err) {
      setNetworkRequests([]);
      setSelectedNetworkRequestId(null);
      setError('\u7f51\u7edc\u6293\u53d6\u5931\u8d25\uff1a' + (err as Error).message);
    }
  };

  const handleStartMirror = async (params: { maxSize?: number; bitRate?: string }) => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    setError('');
    setMirrorStartingDeviceIds(prev => new Set(prev).add(deviceId));
    try {
      const result = await window.electronAPI!.startMirror(deviceId, {
        isPico: isLikelyPicoDevice(selectedDevice),
        maxSize: params.maxSize,
        bitRate: params.bitRate,
      });
      if (!result.success) {
        setMirrorStartingDeviceIds(prev => {
          const next = new Set(prev);
          next.delete(deviceId);
          return next;
        });
        setMirrorSessionsByDeviceId(prev => ({
          ...prev,
          [deviceId]: { deviceId, status: 'failed', error: result.error || '启动投屏失败' },
        }));
        setError(result.error || '启动投屏失败');
      }
    } catch (err) {
      setMirrorStartingDeviceIds(prev => {
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
      setError('启动投屏失败：' + (err as Error).message);
    }
  };

  const handleStopMirror = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      await window.electronAPI!.stopMirror(selectedDevice.id);
    } catch (err) {
      setError('停止投屏失败：' + (err as Error).message);
    }
  };

  const loadInstalledPackages = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const targetDeviceId = selectedDevice.id;
    setInstalledPackagesLoading(true);
    try {
      const result = await window.electronAPI!.listInstalledPackages(targetDeviceId);
      if (selectedDeviceRef.current?.id !== targetDeviceId) return; // 设备已切换，丢弃过期结果
      if (result.success && result.data) {
        setInstalledPackages(result.data);
        setError('');
      } else {
        setInstalledPackages([]);
        setError(result.error || '获取已安装应用失败');
      }
    } catch (err) {
      if (selectedDeviceRef.current?.id !== targetDeviceId) return;
      setInstalledPackages([]);
      setError('获取已安装应用失败：' + (err as Error).message);
    } finally {
      if (selectedDeviceRef.current?.id === targetDeviceId) {
        setInstalledPackagesLoading(false);
      }
    }
  };

  const handleLaunchApp = async (packageName: string) => {
    if (!selectedDevice || !hasElectronAPI() || busyPackage) return;
    setBusyPackage(packageName);
    setBusyAction('launch');
    try {
      setError('');
      const result = await window.electronAPI!.launchApp(selectedDevice.id, packageName);
      if (!result.success) {
        setError(result.error || '启动应用失败');
      }
    } catch (err) {
      setError('启动应用失败：' + (err as Error).message);
    } finally {
      setBusyPackage(null);
      setBusyAction(null);
    }
  };

  const handleForceStopApp = async (packageName: string) => {
    if (!selectedDevice || !hasElectronAPI() || busyPackage) return;
    setBusyPackage(packageName);
    setBusyAction('stop');
    try {
      setError('');
      const result = await window.electronAPI!.forceStopApp(selectedDevice.id, packageName);
      if (!result.success) {
        setError(result.error || '关闭应用失败');
      }
    } catch (err) {
      setError('关闭应用失败：' + (err as Error).message);
    } finally {
      setBusyPackage(null);
      setBusyAction(null);
    }
  };

  const handleUninstallApp = async (packageName: string) => {
    if (!selectedDevice || !hasElectronAPI() || busyPackage) return;
    if (!window.confirm(`确定卸载应用「${packageName}」？此操作不可撤销。`)) return;
    setBusyPackage(packageName);
    setBusyAction('uninstall');
    try {
      setError('');
      const result = await window.electronAPI!.uninstallApp(selectedDevice.id, packageName);
      if (result.success) {
        await loadInstalledPackages();
      } else {
        setError(result.error || '卸载失败');
      }
    } catch (err) {
      setError('卸载失败：' + (err as Error).message);
    } finally {
      setBusyPackage(null);
      setBusyAction(null);
    }
  };

  const exportVisibleLogs = async () => {
    if (!hasElectronAPI()) return;
    const logs = hasActiveLogFilter ? filteredLogs : (currentLogState?.store.toArray() || []);
    if (logs.length === 0) {
      setError('\u6ca1\u6709\u53ef\u5bfc\u51fa\u7684\u65e5\u5fd7');
      return;
    }
    const result = await window.electronAPI!.exportLogs(logs);
    if (result.success) {
      setError('');
    } else if (result.error !== '\u53d6\u6d88\u5bfc\u51fa') {
      setError(result.error || '\u65e5\u5fd7\u5bfc\u51fa\u5931\u8d25');
    }
  };

  const showCrashAndAnrLogs = () => {
    setFilterLevel('E');
    setUseRegexSearch(false);
    setSearchTerm('crash anr fatal exception');
  };

  const levelPriority: Record<LogEntry['level'], number> = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };
  const selectedDeviceId = selectedDevice?.id || '';
  const currentLogState = selectedDeviceId ? getLogState(selectedDeviceId) : null;
  const isSelectedLogcatRunning = Boolean(selectedDeviceId && runningLogDeviceIds.has(selectedDeviceId));
  const isSelectedLogPaused = Boolean(selectedDeviceId && pausedLogDeviceIds.has(selectedDeviceId));
  const selectedPerformance = selectedDeviceId ? performanceByDeviceId[selectedDeviceId] || null : null;
  const selectedPerformanceSamples = selectedDeviceId ? performanceSamplesByDeviceId[selectedDeviceId] || [] : [];
  const isSelectedPerformanceEnabled = Boolean(selectedDeviceId && performanceEnabledDeviceIds.has(selectedDeviceId));
  const visiblePerformanceSnapshots = useMemo(
    () => performanceSnapshots.filter((snapshot) => snapshot.deviceId === selectedDeviceId),
    [performanceSnapshots, selectedDeviceId]
  );
  const visiblePerformanceRecordings = useMemo(
    () => performanceRecordings.filter((recording) => recording.deviceId === selectedDeviceId),
    [performanceRecordings, selectedDeviceId]
  );
  const visibleSessionSnapshots = useMemo(() => {
    const sessionStartedAt = selectedDeviceId ? performanceSessionStartedAtByDeviceId[selectedDeviceId] : undefined;
    if (!sessionStartedAt) return [];
    const sessionStartTime = new Date(sessionStartedAt).getTime();
    return visiblePerformanceSnapshots.filter((snapshot) => new Date(snapshot.capturedAt).getTime() >= sessionStartTime);
  }, [performanceSessionStartedAtByDeviceId, selectedDeviceId, visiblePerformanceSnapshots]);
  const getApkInstallStatusMeta = (status: ApkInstallStatus) => {
    switch (status) {
      case 'installing':
        return { label: '安装中', color: '#60a5fa', background: '#1d4ed822' };
      case 'success':
        return { label: '成功', color: '#22c55e', background: '#22c55e22' };
      case 'failed':
        return { label: '失败', color: '#ef4444', background: '#ef444422' };
      default:
        return { label: '等待中', color: '#9ca3af', background: '#4b556322' };
    }
  };

  const renderUnifiedInstallPanel = () => {
    const onlineDevices = devices.filter((d) => d.status === 'connected');
    const selectedOnlineCount = Array.from(installTargets).filter((id) => onlineDevices.some((d) => d.id === id)).length;
    const canStart = pendingApks.length > 0 && selectedOnlineCount > 0 && !isUnifiedInstalling;
    const activeDeviceIds = devices.map((d) => d.id).filter((id) => (apkInstallStates[id]?.queue.length || 0) > 0);

    return (
      <section style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{'应用安装'}</h2>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button onClick={selectApkFiles} disabled={isUnifiedInstalling} style={{ padding: '8px 14px', backgroundColor: isUnifiedInstalling ? '#4b5563' : '#4a90d9', border: 'none', borderRadius: '6px', color: '#fff', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: 600 }}>选择 APK</button>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#cbd5e1' }}>并发数
            <select value={installConcurrency} disabled={isUnifiedInstalling} onChange={(e) => setInstallConcurrency(Number(e.target.value))} style={{ padding: '6px 10px', fontSize: '13px', color: '#e5e7eb', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>
              <option value={2}>2</option><option value={4}>4</option><option value={8}>8</option><option value={0}>不限</option>
            </select>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#cbd5e1' }}>
            <input type="checkbox" checked={installAllowDowngrade} disabled={isUnifiedInstalling} onChange={(e) => setInstallAllowDowngrade(e.target.checked)} />允许降级覆盖
          </label>
        </div>

        {pendingApks.length > 0 ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {pendingApks.map((a) => (
              <span key={a.path} title={a.path} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '999px', fontSize: '12px', color: '#e5e7eb' }}>
                {a.fileName}
                <button onClick={() => removePendingApk(a.path)} disabled={isUnifiedInstalling} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer', padding: 0, fontSize: '13px' }}>✕</button>
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontSize: '13px', color: '#6b7280' }}>还没有待安装文件，点「选择 APK」添加（可多选）</div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <span style={{ fontSize: '13px', color: '#9ca3af' }}>目标设备（{selectedOnlineCount}/{onlineDevices.length}）</span>
            <button onClick={() => { if (!isUnifiedInstalling) setInstallTargets(new Set(onlineDevices.map((d) => d.id))); }} disabled={isUnifiedInstalling} style={{ fontSize: '12px', color: '#60a5fa', background: 'none', border: 'none', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>全选</button>
            <button onClick={() => { if (!isUnifiedInstalling) setInstallTargets(new Set()); }} disabled={isUnifiedInstalling} style={{ fontSize: '12px', color: '#9ca3af', background: 'none', border: 'none', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>清空</button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
            {devices.length === 0 ? (
              <div style={{ padding: '8px', color: '#666', fontSize: '13px' }}>暂无已连接设备</div>
            ) : devices.map((d) => {
              const online = d.status === 'connected';
              return (
                <label key={d.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 12px', backgroundColor: '#1f1f33', borderRadius: '6px', cursor: online && !isUnifiedInstalling ? 'pointer' : 'not-allowed', opacity: online ? 1 : 0.5 }}>
                  <input type="checkbox" checked={installTargets.has(d.id)} disabled={!online || isUnifiedInstalling} onChange={() => toggleInstallTarget(d.id)} />
                  <span style={{ fontSize: '13px', color: '#e5e7eb' }}>{getDeviceDisplayName(d)}</span>
                  <span style={{ fontSize: '12px', color: d.connectionType === 'wifi' ? '#4ade80' : '#60a5fa' }}>{d.connectionType === 'wifi' ? 'WiFi' : 'USB'}</span>
                  {!online && <span style={{ fontSize: '12px', color: '#9ca3af' }}>离线</span>}
                </label>
              );
            })}
          </div>
        </div>

        <button onClick={startUnifiedInstall} disabled={!canStart} style={{ alignSelf: 'flex-start', padding: '10px 24px', fontSize: '14px', fontWeight: 600, color: '#fff', backgroundColor: canStart ? '#4a90d9' : '#3a3a55', border: 'none', borderRadius: '8px', cursor: canStart ? 'pointer' : 'not-allowed' }}>
          {isUnifiedInstalling ? '安装中…' : `安装到所选设备${selectedOnlineCount > 0 ? `（${selectedOnlineCount}）` : ''}`}
        </button>

        {activeDeviceIds.map((deviceId) => {
          const device = devices.find((d) => d.id === deviceId);
          const queue = apkInstallStates[deviceId]?.queue || [];
          const finished = queue.filter((it) => it.status === 'success' || it.status === 'failed').length;
          const hasFailed = queue.some((it) => it.status === 'failed');
          const hasSuccess = queue.some((it) => it.status === 'success');
          return (
            <div key={deviceId} style={{ border: '1px solid #353550', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{device ? getDeviceDisplayName(device) : deviceId}</span>
                <span style={{ fontSize: '12px', color: '#9ca3af' }}>{finished}/{queue.length} 完成</span>
                {hasFailed && <button onClick={() => retryDeviceInstall(deviceId)} disabled={isUnifiedInstalling} style={{ fontSize: '12px', color: '#93c5fd', background: 'none', border: 'none', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>重试失败</button>}
                {hasSuccess && <button onClick={() => clearCompletedApkInstalls(deviceId)} disabled={isUnifiedInstalling} style={{ fontSize: '12px', color: '#60a5fa', background: 'none', border: 'none', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer', marginLeft: 'auto' }}>清空成功项</button>}
              </div>
              {queue.map((item) => {
                const statusMeta = getApkInstallStatusMeta(item.status);
                const canRemove = item.status !== 'installing';
                return (
                  <div key={item.id} style={{ backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'center' }}>
                      <span style={{ color: '#fff', fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.fileName}>{item.fileName}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                        <span style={{ color: statusMeta.color, backgroundColor: statusMeta.background, borderRadius: '999px', padding: '2px 8px', fontSize: '12px' }}>{statusMeta.label}</span>
                        <button onClick={() => removeApkInstallItem(deviceId, item.id)} disabled={!canRemove} style={{ padding: '2px 8px', backgroundColor: 'transparent', border: '1px solid #454560', borderRadius: '6px', color: canRemove ? '#d1d5db' : '#6b7280', cursor: canRemove ? 'pointer' : 'not-allowed', fontSize: '12px' }}>删除</button>
                      </div>
                    </div>
                    <div style={{ marginTop: '8px' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9ca3af', fontSize: '11px', marginBottom: '4px' }}>
                        <span>{item.status === 'installing' ? '正在推送并安装' : statusMeta.label}</span>
                        <span>{`${Math.round(item.progress)}%`}</span>
                      </div>
                      <div style={{ height: '5px', backgroundColor: '#353550', borderRadius: '999px', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${item.progress}%`, backgroundColor: item.status === 'failed' ? '#ef4444' : item.status === 'success' ? '#22c55e' : '#60a5fa', transition: 'width 260ms ease' }} />
                      </div>
                    </div>
                    {(item.error || item.output) && (
                      <div style={{ marginTop: '6px', color: item.error ? '#fca5a5' : '#86efac', fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.error || item.output}</div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
      </section>
    );
  };

  const hasActiveLogFilter = Boolean(
    searchTerm.trim() ||
    filterLevel !== 'all' ||
    logTagFilter.trim() ||
    logPackageFilter.trim() ||
    logPidFilter.trim()
  );
  const allLogCount = currentLogState?.store.count || 0;

  const logLevelCounts = useMemo(() => {
    void logVersion;
    return currentLogState?.store.getCounts() || createLogCounts();
  }, [logVersion, currentLogState, selectedDeviceId]);

  const filteredLogs = useMemo(() => {
    if (!hasActiveLogFilter || !currentLogState || currentLogState.store.count === 0) return [];

    const logs = currentLogState.store.toArray();
    const searchTokens = searchTerm.toLowerCase().split(/\s+/).filter(Boolean);
    const hasSearch = searchTokens.length > 0;
    const hasLevelFilter = filterLevel !== 'all';
    const tagFilter = logTagFilter.trim().toLowerCase();
    const packageFilter = logPackageFilter.trim().toLowerCase();
    const pidFilter = logPidFilter.trim();
    let searchRegex: RegExp | null = null;

    if (useRegexSearch && searchTerm.trim()) {
      try {
        searchRegex = new RegExp(searchTerm.trim(), 'i');
      } catch {
        searchRegex = null;
      }
    }
    
    return logs.filter(log => {
      if (hasLevelFilter) {
        const filterPriority = levelPriority[filterLevel as LogEntry['level']];
        const entryPriority = levelPriority[log.level];
        if (entryPriority < filterPriority) {
          return false;
        }
      }

      if (tagFilter && !log.tag.toLowerCase().includes(tagFilter)) {
        return false;
      }

      if (packageFilter && !(log.packageName || '').toLowerCase().includes(packageFilter)) {
        return false;
      }

      if (pidFilter && String(log.processId) !== pidFilter) {
        return false;
      }

      if (!hasSearch && !searchRegex) {
        return true;
      }
      
      const haystack = `${log.message} ${log.tag} ${log.packageName || ''} ${log.processId}`.toLowerCase();
      return searchRegex ? searchRegex.test(haystack) : searchTokens.some(token => haystack.includes(token));
    });
  }, [logVersion, currentLogState, hasActiveLogFilter, searchTerm, filterLevel, logTagFilter, logPackageFilter, logPidFilter, useRegexSearch]);

  const displayedLogCount = hasActiveLogFilter ? filteredLogs.length : allLogCount;
  const visibleStartIndex = Math.max(0, Math.floor(logViewport.scrollTop / LOG_ROW_HEIGHT) - LOG_OVERSCAN_ROWS);
  const visibleRowCount = Math.ceil(logViewport.height / LOG_ROW_HEIGHT) + LOG_OVERSCAN_ROWS * 2;
  const visibleEndIndex = Math.min(displayedLogCount, visibleStartIndex + visibleRowCount);
  const visibleLogs = useMemo(() => {
    const rows: Array<{ log: LogEntry; index: number }> = [];
    for (let index = visibleStartIndex; index < visibleEndIndex; index++) {
      const log = hasActiveLogFilter ? filteredLogs[index] : currentLogState?.store.get(index);
      if (log) {
        rows.push({ log, index });
      }
    }
    return rows;
  }, [logVersion, currentLogState, hasActiveLogFilter, filteredLogs, visibleStartIndex, visibleEndIndex]);
  const virtualTopPadding = visibleStartIndex * LOG_ROW_HEIGHT;
  const virtualBottomPadding = Math.max(0, (displayedLogCount - visibleEndIndex) * LOG_ROW_HEIGHT);

  const scrollToBottom = useCallback(() => {
    if (logsContainerRef.current) {
      logsContainerRef.current.scrollTop = logsContainerRef.current.scrollHeight;
      setIsUserScrolling(false);
    }
  }, []);

  useEffect(() => {
    if (autoScrollEnabled && !isUserScrolling && displayedLogCount > 0) {
      const container = logsContainerRef.current;
      if (container) {
        const scroll = () => {
          container.scrollTop = container.scrollHeight;
          setLogViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
        };
        requestAnimationFrame(() => {
          requestAnimationFrame(scroll);
        });
      }
    }
  }, [logVersion, displayedLogCount, autoScrollEnabled, isUserScrolling]);

  const handleScroll = useCallback(() => {
    const container = logsContainerRef.current;
    if (!container) return;
    setLogViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
    if (!autoScrollEnabled) return;
    
    const isAtBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
    
    if (isAtBottom) {
      setIsUserScrolling(false);
    } else {
      setIsUserScrolling(true);
    }
  }, [autoScrollEnabled]);

  useLayoutEffect(() => {
    if (activeTab !== 'logs' || !logsContainerRef.current) return;
    const container = logsContainerRef.current;
    setLogViewport({ scrollTop: container.scrollTop, height: container.clientHeight });
  }, [activeTab, displayedLogCount]);

  const getLevelLabel = (level: LogEntry['level']) => {
    const labels: Record<LogEntry['level'], string> = {
      V: 'Verbose',
      D: 'Debug',
      I: 'Info',
      W: 'Warn',
      E: 'Error',
      F: 'Fatal',
    };
    return labels[level];
  };

  const getLevelColor = (level: LogEntry['level']) => {
    const colors: Record<LogEntry['level'], string> = {
      V: '#6b7280',
      D: '#3b82f6',
      I: '#22c55e',
      W: '#eab308',
      E: '#ef4444',
      F: '#dc2626',
    };
    return colors[level];
  };

  const renderLogcatPanel = () => (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '10px', backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px' }}>
        <button
          onClick={toggleLogcat}
          style={{ padding: '8px 12px', backgroundColor: isSelectedLogcatRunning ? '#7f1d1d' : '#166534', border: 'none', borderRadius: '6px', color: 'white', cursor: 'pointer', fontSize: '13px' }}
        >
          {isSelectedLogcatRunning ? '\u505c\u6b62' : '\u5f00\u59cb'}
        </button>
        <button
          onClick={toggleSelectedDevicePause}
          disabled={!isSelectedLogcatRunning}
          style={{ padding: '8px 12px', backgroundColor: isSelectedLogPaused ? '#ca8a04' : '#353550', border: 'none', borderRadius: '6px', color: 'white', cursor: isSelectedLogcatRunning ? 'pointer' : 'not-allowed', fontSize: '13px', opacity: isSelectedLogcatRunning ? 1 : 0.5 }}
        >
          {isSelectedLogPaused ? '\u7ee7\u7eed' : '\u6682\u505c'}
        </button>
        <button
          onClick={() => {
            if (selectedDeviceId) {
              clearDeviceLogs(selectedDeviceId);
            }
          }}
          style={{ padding: '8px 12px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: '#d1d5db', fontSize: '13px', cursor: 'pointer' }}
        >{'\u6e05\u7a7a'}</button>
        <button onClick={exportVisibleLogs} style={{ padding: '8px 12px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>{'\u5bfc\u51fa'}</button>
        <button onClick={showCrashAndAnrLogs} style={{ padding: '8px 12px', backgroundColor: '#7f1d1d', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>{'\u5d29\u6e83/ANR'}</button>
        <button onClick={scrollToBottom} style={{ padding: '8px 12px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>{'\u5230\u5e95\u90e8'}</button>
        <button onClick={() => setAutoScrollEnabled(!autoScrollEnabled)} style={{ padding: '8px 12px', backgroundColor: autoScrollEnabled ? '#166534' : '#4b5563', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>
          {autoScrollEnabled ? '\u81ea\u52a8\u6eda\u52a8' : '\u624b\u52a8\u6eda\u52a8'}
        </button>
        <div style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: '12px' }}>
          {isSelectedLogcatRunning ? (isSelectedLogPaused ? '\u5df2\u6682\u505c' : '\u91c7\u96c6\u4e2d') : '\u5df2\u505c\u6b62'} · {'\u8fd0\u884c\u8bbe\u5907'} {runningLogDeviceIds.size} · {displayedLogCount}/{allLogCount} {'\u6761\u65e5\u5fd7'}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '140px 150px 150px minmax(220px, 1fr) 90px 90px', gap: '8px', padding: '10px', backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px' }}>
        <select value={filterLevel} onChange={(e) => setFilterLevel(e.target.value as LogLevelFilter)} style={{ padding: '8px 10px', backgroundColor: '#252540', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }}>
          <option value="all">All levels</option>
          <option value="V">Verbose+</option>
          <option value="D">Debug+</option>
          <option value="I">Info+</option>
          <option value="W">Warn+</option>
          <option value="E">Error+</option>
          <option value="F">Fatal</option>
        </select>
        <input value={logPackageFilter} onChange={(e) => setLogPackageFilter(e.target.value)} placeholder={'\u5e94\u7528/\u5305\u540d'} style={{ padding: '8px 10px', backgroundColor: '#252540', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }} />
        <input value={logTagFilter} onChange={(e) => setLogTagFilter(e.target.value)} placeholder={'\u6807\u7b7e'} style={{ padding: '8px 10px', backgroundColor: '#252540', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }} />
        <input type="text" placeholder={useRegexSearch ? '\u6b63\u5219\u641c\u7d22' : '\u641c\u7d22\u65e5\u5fd7'} value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} style={{ padding: '8px 10px', backgroundColor: '#252540', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }} />
        <input value={logPidFilter} onChange={(e) => setLogPidFilter(e.target.value.replace(/\D/g, ''))} placeholder={'\u8fdb\u7a0b PID'} style={{ padding: '8px 10px', backgroundColor: '#252540', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }} />
        <button onClick={() => setUseRegexSearch(!useRegexSearch)} style={{ padding: '8px 10px', backgroundColor: useRegexSearch ? '#4a90d9' : '#353550', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>{'\u6b63\u5219'}</button>
      </div>

      <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: '#9ca3af', fontSize: '12px' }}>
        {(['V', 'D', 'I', 'W', 'E', 'F'] as LogEntry['level'][]).map(level => (
          <span key={level} style={{ color: getLevelColor(level), backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '6px', padding: '4px 8px' }}>
            {level} {logLevelCounts[level]}
          </span>
        ))}
        <span style={{ marginLeft: 'auto' }}>{'\u4fdd\u7559'} {maxLogEntries} · {'\u6279\u91cf'} {batchUpdateSize}</span>
      </div>

      <div ref={logsContainerRef} onScroll={handleScroll} style={{ flex: 1, backgroundColor: '#111827', border: '1px solid #353550', borderRadius: '8px', overflow: 'auto', fontFamily: 'Consolas, monospace', fontSize: '12px', minHeight: '260px' }}>
        {allLogCount === 0 && !isSelectedLogcatRunning ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#6b7280' }}>
            <div style={{ fontSize: '42px', marginBottom: '12px' }}>{'\u65e5\u5fd7'}</div>
            <button onClick={toggleLogcat} style={{ padding: '10px 18px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: 'white', fontSize: '14px', cursor: 'pointer' }}>{'\u5f00\u59cb\u65e5\u5fd7'}</button>
          </div>
        ) : displayedLogCount === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#6b7280' }}>{'\u6ca1\u6709\u5339\u914d\u7684\u65e5\u5fd7'}</div>
        ) : (
          <div style={{ minHeight: displayedLogCount * LOG_ROW_HEIGHT }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 1, display: 'grid', gridTemplateColumns: '96px 64px 70px 130px 140px minmax(280px, 1fr)', backgroundColor: '#1f2937', color: '#9ca3af', fontWeight: 700 }}>
              <div style={{ padding: '8px' }}>{'\u65f6\u95f4'}</div>
              <div style={{ padding: '8px' }}>Level</div>
              <div style={{ padding: '8px' }}>PID</div>
              <div style={{ padding: '8px' }}>{'\u5305\u540d'}</div>
              <div style={{ padding: '8px' }}>{'\u6807\u7b7e'}</div>
              <div style={{ padding: '8px' }}>{'\u6d88\u606f'}</div>
            </div>
            <div style={{ height: virtualTopPadding }} />
            {visibleLogs.map(({ log, index }) => (
              <div
                key={`${index}-${log.id}`}
                onClick={() => setSelectedLogEntry(log)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '96px 64px 70px 130px 140px minmax(280px, 1fr)',
                  height: `${LOG_ROW_HEIGHT}px`,
                  lineHeight: `${LOG_ROW_HEIGHT - 1}px`,
                  borderBottom: '1px solid #1f2937',
                  backgroundColor: selectedLogEntry?.id === log.id ? '#1e3a5f' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ padding: '0 8px', color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden' }}>{new Date(log.timestamp).toLocaleTimeString('zh-CN', { hour12: false })}</div>
                <div style={{ padding: '0 8px', color: getLevelColor(log.level), fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden' }}>{getLevelLabel(log.level)}</div>
                <div style={{ padding: '0 8px', color: '#9ca3af', whiteSpace: 'nowrap', overflow: 'hidden' }}>{log.processId || '--'}</div>
                <div style={{ padding: '0 8px', color: '#60a5fa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.packageName || '--'}</div>
                <div style={{ padding: '0 8px', color: '#93c5fd', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.tag}</div>
                <div style={{ padding: '0 8px', color: '#e5e7eb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{log.message}</div>
              </div>
            ))}
            <div style={{ height: virtualBottomPadding }} />
          </div>
        )}
      </div>

      {selectedLogEntry && (
        <div style={{ backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '10px', color: '#d1d5db', fontFamily: 'Consolas, monospace', fontSize: '12px', maxHeight: '140px', overflow: 'auto' }}>
          <div style={{ marginBottom: '6px', color: getLevelColor(selectedLogEntry.level), fontWeight: 700 }}>
            {getLevelLabel(selectedLogEntry.level)} / {selectedLogEntry.tag} / PID {selectedLogEntry.processId || '--'}
          </div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{selectedLogEntry.message}</div>
        </div>
      )}
    </div>
  );

  return (
    <div style={{ 
      width: '100%', 
      height: '100vh', 
      display: 'flex', 
      flexDirection: 'column', 
      backgroundColor: '#1a1a2e',
      color: 'white',
      overflow: 'hidden'
    }}>
      <header style={{ height: '56px', backgroundColor: '#252540', borderBottom: '1px solid #353550', display: 'flex', alignItems: 'center', padding: '0 16px', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>{'\u5b89\u5353\u8bbe\u5907\u76d1\u63a7'}</h1>
      </header>
      
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        <aside style={{ width: '288px', backgroundColor: '#252540', borderRight: '1px solid #353550', padding: '16px', overflowY: 'auto' }}>
          {adbStatus && (
            <div
              style={{
                marginBottom: '16px',
                padding: '12px',
                borderRadius: '8px',
                backgroundColor: adbStatus.available ? '#1f3b2d' : '#3f1d24',
                border: `1px solid ${adbStatus.available ? '#2f855a' : '#7f1d1d'}`,
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 600, color: adbStatus.available ? '#86efac' : '#fda4af', marginBottom: '4px' }}>
                {adbStatus.available
                  ? `${adbStatus.source === 'bundled' ? '内置' : '系统'} ADB 已就绪${adbStatus.version ? ` · ${adbStatus.version}` : ''}`
                  : 'ADB 不可用'}
              </div>
              <div style={{ fontSize: '12px', color: '#d1d5db', lineHeight: 1.5 }}>{adbStatus.message}</div>
              {adbStatus.hint && !adbStatus.available && (
                <div style={{ marginTop: '6px', fontSize: '12px', color: '#fecdd3', lineHeight: 1.5 }}>{adbStatus.hint}</div>
              )}
              {adbStatus.path && (
                <div style={{ marginTop: '6px', fontSize: '11px', color: '#94a3b8', wordBreak: 'break-all' }}>{adbStatus.path}</div>
              )}
            </div>
          )}

          <h2 style={{ fontSize: '14px', fontWeight: '500', color: '#888', margin: '0 0 12px 0' }}>{'\u8bbe\u5907\u5217\u8868'}</h2>
          <div style={{ display: 'flex', gap: '8px', margin: '0 0 12px 0' }}>
            <button onClick={loadDevices} style={{ flex: 1, padding: '6px 10px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: 'white', cursor: 'pointer', fontSize: '13px' }}>刷新设备</button>
            <button onClick={connectUSBDevice} style={{ flex: 1, padding: '6px 10px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: 'white', cursor: 'pointer', fontSize: '13px' }}>连接 USB</button>
          </div>
          
          {devices.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '32px 0', color: '#666' }}>
              <p style={{ fontSize: '14px' }}>
                {adbStatus && !adbStatus.available ? 'ADB 不可用，暂时无法读取设备' : '\u672a\u8fde\u63a5\u8bbe\u5907'}
              </p>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {devices.map(device => {
                const statusMeta = getDeviceStatusMeta(device.status);
                const wifiLatencyLabel = getWifiLatencyLabel(device);
                return (
                <div
                  key={device.id}
                  style={{ 
                    padding: '12px', 
                    borderRadius: '8px', 
                    cursor: 'pointer',
                    backgroundColor: selectedDevice?.id === device.id ? '#4a90d9' : '#353550',
                    border: selectedDevice?.id === device.id ? '1px solid #60a5fa' : 'none'
                  }}
                  onClick={() => setSelectedDevice(device)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                    <span>{device.connectionType === 'wifi' ? 'WiFi' : 'USB'}</span>
                    <span style={{ fontWeight: '500', fontSize: '14px' }}>{getDeviceDisplayName(device)}</span>
                    </div>
                    <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '11px', backgroundColor: statusMeta.background, color: statusMeta.color, flexShrink: 0 }}>
                      {statusMeta.label}
                    </span>
                  </div>
                  {customDeviceNames[device.id]?.trim() && (
                    <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '2px' }}>
                      {'\u539f\u59cb\u540d\u79f0'}: {device.name || device.model || '--'}
                    </div>
                  )}
                  <div style={{ fontSize: '12px', color: '#aaa' }}>{device.id}</div>
                  <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    {renderBatteryBadge(device)}
                    {wifiLatencyLabel && (
                      <span style={{ fontSize: '12px', color: device.latencyStatus === 'timeout' ? '#fbbf24' : '#93c5fd' }}>
                        {wifiLatencyLabel}
                      </span>
                    )}
                  </div>
                  {runningLogDeviceIds.has(device.id) && (
                    <div style={{ marginTop: '6px', fontSize: '12px', color: '#86efac' }}>
                      {pausedLogDeviceIds.has(device.id) ? '\u65e5\u5fd7\u5df2\u6682\u505c' : '\u65e5\u5fd7\u91c7\u96c6\u4e2d'}
                    </div>
                  )}
                  <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleSleepDevice(device); }}
                      disabled={Boolean(busyDeviceAction)}
                      style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#d1d5db', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                    >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'sleep' ? '息屏中…' : '息屏'}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleWakeDevice(device); }}
                      disabled={Boolean(busyDeviceAction)}
                      style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#86efac', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                    >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'wake' ? '唤醒中…' : '唤醒'}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleUnlockDevice(device); }}
                      disabled={Boolean(busyDeviceAction)}
                      title="唤醒并上滑解锁；有 PIN/密码/手势的设备请在设备上手动输入"
                      style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#93c5fd', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                    >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'unlock' ? '解锁中…' : '解锁'}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleRebootDevice(device); }}
                      disabled={Boolean(busyDeviceAction)}
                      style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#fca5a5', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                    >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'reboot' ? '重启中…' : '重启'}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); disconnectDevice(device); }}
                      style={{ padding: '4px 8px', backgroundColor: '#555', border: 'none', borderRadius: '4px', color: '#ff6b6b', cursor: 'pointer', fontSize: '12px' }}
                    >断开设备</button>
                  </div>
                </div>
              )})}
            </div>
          )}
          
          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #353550' }}>
            <h2 style={{ fontSize: '14px', fontWeight: '500', color: '#888', margin: '0 0 12px 0' }}>{'WiFi \u8fde\u63a5'}</h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                type="text"
                placeholder={'\u8bbe\u5907 IP \u5730\u5740:\u7aef\u53e3'}
                value={wifiIp}
                onChange={(e) => setWifiIp(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    connectWiFiDevice();
                  }
                }}
                style={{ 
                  flex: 1, 
                  padding: '8px 12px', 
                  backgroundColor: '#353550', 
                  border: '1px solid #454560', 
                  borderRadius: '8px', 
                  color: 'white', 
                  fontSize: '14px',
                  outline: 'none'
                }}
              />
              <button 
                onClick={connectWiFiDevice}
                style={{ 
                  padding: '0 16px', 
                  backgroundColor: '#4a90d9', 
                  border: 'none', 
                  borderRadius: '8px', 
                  color: 'white', 
                  cursor: 'pointer'
                }}
              >{'\u8fde\u63a5'}</button>
            </div>

            <div style={{ marginTop: '8px' }}>
              <button
                onClick={() => setShowPairForm((v) => !v)}
                style={{ background: 'none', border: 'none', color: '#93c5fd', cursor: 'pointer', fontSize: '12px', padding: 0 }}
              >{showPairForm ? '\u6536\u8d77\u914d\u5bf9' : 'Android 11+ \u65e0\u7ebf\u8c03\u8bd5\uff1f\u70b9\u6b64\u914d\u5bf9'}</button>
            </div>

            {showPairForm && (
              <div style={{ marginTop: '8px', padding: '10px', backgroundColor: '#2a2a40', borderRadius: '8px' }}>
                <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: '1.6', marginBottom: '8px' }}>
                  {'\u8bbe\u5907\uff1a\u8bbe\u7f6e \u2192 \u5f00\u53d1\u8005\u9009\u9879 \u2192 \u65e0\u7ebf\u8c03\u8bd5 \u2192 \u300c\u4f7f\u7528\u914d\u5bf9\u7801\u914d\u5bf9\u8bbe\u5907\u300d\uff0c\u586b\u4e0b\u65b9\u5f39\u7a97\u91cc\u7684\u914d\u5bf9\u5730\u5740\uff08IP:\u7aef\u53e3\uff09\u548c 6 \u4f4d\u914d\u5bf9\u7801\u3002\u914d\u5bf9\u6210\u529f\u540e\u4f1a\u81ea\u52a8\u8fde\u63a5\u8bbe\u5907\uff0c\u65e0\u9700\u518d\u624b\u52a8\u586b\u7aef\u53e3\u3002'}
                </div>
                <input
                  type="text"
                  placeholder={'\u914d\u5bf9\u5730\u5740 IP:\u7aef\u53e3\uff08\u5982 192.168.1.75:37123\uff09'}
                  value={pairAddress}
                  onChange={(e) => setPairAddress(e.target.value)}
                  style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', backgroundColor: '#353550', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none', marginBottom: '8px' }}
                />
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    inputMode="numeric"
                    placeholder={'6 \u4f4d\u914d\u5bf9\u7801'}
                    value={pairCode}
                    onChange={(e) => setPairCode(e.target.value)}
                    onKeyPress={(e) => { if (e.key === 'Enter') { pairWiFiDevice(); } }}
                    style={{ flex: 1, padding: '8px 10px', backgroundColor: '#353550', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }}
                  />
                  <button
                    onClick={pairWiFiDevice}
                    disabled={pairing}
                    style={{ padding: '0 16px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: 'white', cursor: pairing ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: pairing ? 0.6 : 1 }}
                  >{pairing ? '\u914d\u5bf9\u4e2d\u2026' : '\u914d\u5bf9'}</button>
                </div>
              </div>
            )}
          </div>

          {selectedDevice && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #353550' }}>
              <h2 style={{ fontSize: '14px', fontWeight: '500', color: '#888', margin: '0 0 12px 0' }}>{'\u8bbe\u5907\u4fe1\u606f'}</h2>
              <div style={{ fontSize: '12px', color: '#888' }}>
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ marginBottom: '6px' }}>{'\u81ea\u5b9a\u4e49\u540d\u79f0'}</div>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      value={customDeviceNames[selectedDevice.id] || ''}
                      onChange={(e) => updateCustomDeviceName(selectedDevice.id, e.target.value)}
                      placeholder={selectedDevice.name || selectedDevice.model || selectedDevice.id}
                      style={{ flex: 1, padding: '8px 10px', backgroundColor: '#353550', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }}
                    />
                    <button
                      onClick={() => updateCustomDeviceName(selectedDevice.id, '')}
                      style={{ padding: '0 10px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: '#d1d5db', cursor: 'pointer', fontSize: '12px' }}
                    >{'\u6062\u590d\u9ed8\u8ba4'}</button>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>{'\u578b\u53f7'}</span>
                  <span style={{ color: '#fff' }}>{selectedDevice.model}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>{'\u5382\u5546'}</span>
                  <span style={{ color: '#fff' }}>{selectedDevice.manufacturer}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>{'Android \u7248\u672c'}</span>
                  <span style={{ color: '#fff' }}>{selectedDevice.androidVersion}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>{'API \u7b49\u7ea7'}</span>
                  <span style={{ color: '#fff' }}>{selectedDevice.apiLevel}</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>{'\u8fde\u63a5\u65b9\u5f0f'}</span>
                  <span style={{ color: selectedDevice.connectionType === 'wifi' ? '#4ade80' : '#60a5fa' }}>
                    {selectedDevice.connectionType === 'wifi' ? 'WiFi' : 'USB'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </aside>
        
        <main style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', height: '100%' }}>
          {selectedDevice ? (
            <>
              <nav style={{ display: 'flex', borderBottom: '1px solid #353550' }}>
                {[
                  { key: 'devices' as TabType, label: '\u8bbe\u5907' },
                  { key: 'logs' as TabType, label: '\u65e5\u5fd7' },
                  { key: 'performance' as TabType, label: '\u6027\u80fd' },
                  { key: 'network' as TabType, label: '\u7f51\u7edc' },
                  { key: 'mirror' as TabType, label: '\u6295\u5c4f' },
                ].map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveTab(tab.key)}
                    style={{
                      padding: '12px 24px',
                      fontSize: '14px',
                      fontWeight: '500',
                      backgroundColor: activeTab === tab.key ? '#353550' : 'transparent',
                      color: activeTab === tab.key ? '#fff' : '#888',
                      border: 'none',
                      cursor: 'pointer',
                      borderBottom: activeTab === tab.key ? '2px solid #4a90d9' : 'none'
                    }}
                  >
                    {tab.label}
                  </button>
                ))}
              </nav>

              <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
                {activeTab === 'devices' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                    {renderUnifiedInstallPanel()}

                  <div style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '16px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '12px' }}>
                      <h2 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>
                        {'已安装应用'}
                        <span style={{ fontSize: '13px', color: '#888', marginLeft: '8px', fontWeight: 400 }}>
                          {installedPackagesLoading ? '加载中…' : `共 ${installedPackages.length} 个`}
                        </span>
                      </h2>
                      <div style={{ display: 'flex', gap: '8px', flex: 1, maxWidth: '420px' }}>
                        <input
                          type="text"
                          placeholder={'搜索包名'}
                          value={appFilter}
                          onChange={(e) => setAppFilter(e.target.value)}
                          style={{ flex: 1, padding: '8px 12px', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }}
                        />
                        <button
                          onClick={loadInstalledPackages}
                          disabled={installedPackagesLoading}
                          style={{ padding: '8px 16px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: installedPackagesLoading ? 'not-allowed' : 'pointer', opacity: installedPackagesLoading ? 0.7 : 1 }}
                        >{'刷新'}</button>
                      </div>
                    </div>

                    {(() => {
                      const keyword = appFilter.trim().toLowerCase();
                      const filtered = keyword ? installedPackages.filter(pkg => pkg.toLowerCase().includes(keyword)) : installedPackages;
                      if (installedPackagesLoading && installedPackages.length === 0) {
                        return <div style={{ padding: '24px', textAlign: 'center', color: '#888', fontSize: '13px' }}>{'正在读取已安装应用…'}</div>;
                      }
                      if (installedPackages.length === 0) {
                        return <div style={{ padding: '24px', textAlign: 'center', color: '#666', fontSize: '13px' }}>{'未获取到第三方应用，点击刷新重试'}</div>;
                      }
                      if (filtered.length === 0) {
                        return <div style={{ padding: '24px', textAlign: 'center', color: '#666', fontSize: '13px' }}>{'没有匹配的应用'}</div>;
                      }
                      return (
                        <div style={{ maxHeight: '420px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {filtered.map(pkg => (
                            <div
                              key={pkg}
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: '#1f1f33', borderRadius: '6px', gap: '12px' }}
                            >
                              <span style={{ fontSize: '13px', color: '#e5e7eb', fontFamily: 'monospace', wordBreak: 'break-all' }}>{pkg}</span>
                              {(() => {
                                const isBusy = busyPackage === pkg;
                                const busyStyle = (base: React.CSSProperties): React.CSSProperties => ({
                                  ...base,
                                  cursor: isBusy ? 'not-allowed' : 'pointer',
                                  opacity: isBusy ? 0.5 : 1,
                                });
                                return (
                                  <div style={{ flexShrink: 0, display: 'flex', gap: '6px' }}>
                                    <button
                                      onClick={() => handleLaunchApp(pkg)}
                                      disabled={isBusy}
                                      style={busyStyle({ padding: '5px 12px', fontSize: '12px', color: '#86efac', backgroundColor: '#22c55e22', border: '1px solid #22c55e55', borderRadius: '6px' })}
                                    >
                                      {isBusy && busyAction === 'launch' ? '启动中…' : '启动'}
                                    </button>
                                    <button
                                      onClick={() => handleForceStopApp(pkg)}
                                      disabled={isBusy}
                                      style={busyStyle({ padding: '5px 12px', fontSize: '12px', color: '#fcd34d', backgroundColor: '#f59e0b22', border: '1px solid #f59e0b55', borderRadius: '6px' })}
                                    >
                                      {isBusy && busyAction === 'stop' ? '关闭中…' : '关闭'}
                                    </button>
                                    <button
                                      onClick={() => handleUninstallApp(pkg)}
                                      disabled={isBusy}
                                      style={busyStyle({ padding: '5px 12px', fontSize: '12px', color: '#fca5a5', backgroundColor: '#ef444422', border: '1px solid #ef444455', borderRadius: '6px' })}
                                    >
                                      {isBusy && busyAction === 'uninstall' ? '卸载中…' : '卸载'}
                                    </button>
                                  </div>
                                );
                              })()}
                            </div>
                          ))}
                        </div>
                      );
                    })()}
                  </div>

                  </div>
                )}

                {activeTab === 'logs' && renderLogcatPanel()}
                {activeTab === 'performance' && (
                  <PerformancePanel
                    device={selectedDevice}
                    performance={selectedPerformance}
                    samples={selectedPerformanceSamples}
                    snapshots={visiblePerformanceSnapshots}
                    sessionSnapshots={visibleSessionSnapshots}
                    isMonitoringPerformance={isSelectedPerformanceEnabled}
                    isCapturingSnapshot={isCapturingSnapshot}
                    isRecording={Boolean(selectedDeviceId && recordingDeviceIds.has(selectedDeviceId))}
                    recordings={visiblePerformanceRecordings}
                    onToggleMonitoring={togglePerformanceMonitoring}
                    onCaptureSnapshot={capturePerformanceSnapshot}
                    onStartRecording={startPerformanceRecording}
                    onExportSession={exportPerformanceSession}
                  />
                )}

                {activeTab === 'network' && (
                  <NetworkPanel
                    packageFilter={packageFilter}
                    onPackageFilterChange={setPackageFilter}
                    networkRequests={networkRequests}
                    selectedNetworkRequestId={selectedNetworkRequestId}
                    onSelectNetworkRequest={setSelectedNetworkRequestId}
                    onCaptureRequests={loadNetworkRequests}
                  />
                )}

                {activeTab === 'mirror' && selectedDevice && (
                  <MirrorPanel
                    deviceName={customDeviceNames[selectedDevice.id] || selectedDevice.name || selectedDevice.id}
                    isPico={isLikelyPicoDevice(selectedDevice)}
                    session={mirrorSessionsByDeviceId[selectedDevice.id] || null}
                    starting={mirrorStartingDeviceIds.has(selectedDevice.id)}
                    onStart={handleStartMirror}
                    onStop={handleStopMirror}
                  />
                )}
              </div>
            </>
          ) : (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666' }}>
            <div style={{ textAlign: 'center' }}>
              <h2 style={{ fontSize: '24px', fontWeight: '600', color: 'white', margin: '0 0 8px 0' }}>{'\u8bf7\u9009\u62e9\u8bbe\u5907'}</h2>
              <p style={{ fontSize: '14px' }}>{'\u4ece\u5de6\u4fa7\u5217\u8868\u9009\u62e9\u5df2\u8fde\u63a5\u7684 Android \u8bbe\u5907'}</p>
              </div>
            </div>
          )}
        </main>
      </div>

      {error && (
        <div style={{ 
          position: 'fixed', 
          bottom: '16px', 
          right: '16px', 
          padding: '12px 16px', 
          backgroundColor: '#ef4444', 
          color: 'white', 
          borderRadius: '8px',
          fontSize: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          {error}
          <button onClick={() => setError('')} style={{ cursor: 'pointer' }}>{'\u5173\u95ed'}</button>
        </div>
      )}

      {success && (
        <div style={{
          position: 'fixed',
          bottom: error ? '72px' : '16px',
          right: '16px',
          maxWidth: '420px',
          padding: '12px 16px',
          backgroundColor: '#22c55e',
          color: 'white',
          borderRadius: '8px',
          fontSize: '14px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          {success}
          <button onClick={() => setSuccess('')} style={{ cursor: 'pointer' }}>{'\u5173\u95ed'}</button>
        </div>
      )}

    </div>
  );
}

export default SimpleApp;

