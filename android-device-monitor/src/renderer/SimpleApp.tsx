import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { ActivityStackEntry, AdbStatus, DeviceInfo, ProcessInfo, PerformanceMetrics, PerformanceRecording, PerformanceSample, PerformanceSnapshot, LogEntry, NetworkRequest } from '../shared/types';
import { NetworkPanel } from './components/NetworkPanel';
import { PerformancePanel } from './components/PerformancePanel';
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

type TabType = 'devices' | 'logs' | 'performance' | 'processes' | 'activity' | 'network';
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
  const [logVersion, setLogVersion] = useState(0);
  const [logViewport, setLogViewport] = useState({ scrollTop: 0, height: 320 });
  const [performanceByDeviceId, setPerformanceByDeviceId] = useState<Record<string, PerformanceMetrics>>({});
  const [performanceSamplesByDeviceId, setPerformanceSamplesByDeviceId] = useState<Record<string, PerformanceSample[]>>({});
  const [performanceSessionStartedAtByDeviceId, setPerformanceSessionStartedAtByDeviceId] = useState<Record<string, Date>>({});
  const [performanceEnabledDeviceIds, setPerformanceEnabledDeviceIds] = useState<Set<string>>(() => new Set());
  const [performanceSnapshots, setPerformanceSnapshots] = useState<PerformanceSnapshot[]>([]);
  const [performanceRecordings, setPerformanceRecordings] = useState<PerformanceRecording[]>([]);
  const [recordingDeviceIds, setRecordingDeviceIds] = useState<Set<string>>(() => new Set());
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [activities, setActivities] = useState<ActivityStackEntry[]>([]);
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [selectedNetworkRequestId, setSelectedNetworkRequestId] = useState<string | null>(null);
  const [runningLogDeviceIds, setRunningLogDeviceIds] = useState<Set<string>>(() => new Set());
  const [wifiIp, setWifiIp] = useState('');
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
  const [maxLogEntries, setMaxLogEntries] = useState(MAX_LOG_ENTRIES);
  const [batchUpdateSize, setBatchUpdateSize] = useState(BATCH_UPDATE_SIZE);
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const [isCapturingSnapshot, setIsCapturingSnapshot] = useState(false);
  const [apkInstallStates, setApkInstallStates] = useState<Record<string, DeviceApkInstallState>>({});
  const [isDeviceMoreMenuOpen, setIsDeviceMoreMenuOpen] = useState(false);
  
  const logStatesRef = useRef(new Map<string, DeviceLogState>());
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const selectedDeviceRef = useRef<DeviceInfo | null>(null);
  const maxLogEntriesRef = useRef(MAX_LOG_ENTRIES);
  const batchUpdateSizeRef = useRef(BATCH_UPDATE_SIZE);
  const performanceRequestInFlightRef = useRef(new Set<string>());
  const installingApkDeviceIdsRef = useRef(new Set<string>());
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
    setIsDeviceMoreMenuOpen(false);
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

        return () => {
          unsubscribeAdbStatusChanged();
          unsubscribeDeviceListChanged();
          unsubscribeDeviceConnected();
          unsubscribeDeviceDisconnected();
          unsubscribeLogEntry();
          unsubscribeLogBatch();
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

  useEffect(() => {
    if (selectedDevice && activeTab === 'processes') {
      loadProcesses();
    }
  }, [selectedDevice, activeTab]);

  useEffect(() => {
    if (selectedDevice && activeTab === 'activity') {
      loadActivityStack();
    }
  }, [selectedDevice, activeTab]);

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
    if (!selectedDevice || !hasElectronAPI()) {
      setError('Electron 接口不可用');
      return;
    }

    try {
      const result = await window.electronAPI!.selectApkFiles();
      if (!result.success || !result.data) {
        setError(formatOperationError(result, '选择安装包失败'));
        return;
      }

      if (result.data.length === 0) {
        return;
      }

      const deviceId = selectedDevice.id;
      const existingPaths = new Set(getDeviceApkInstallState(deviceId).queue.map(item => item.path));
      const nextItems = result.data
        .filter(filePath => filePath.toLowerCase().endsWith('.apk'))
        .filter(filePath => !existingPaths.has(filePath))
        .map(filePath => ({
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path: filePath,
          fileName: filePath.split(/[\\/]/).pop() || filePath,
          status: 'queued' as ApkInstallStatus,
          progress: 0,
        }));

      if (nextItems.length > 0) {
        updateDeviceApkInstallState(deviceId, previousState => ({
          ...previousState,
          queue: [...previousState.queue, ...nextItems],
        }));
        setError('');
      }
    } catch (err) {
      setError('选择安装包失败：' + (err as Error).message);
    }
  };

  const installQueuedApks = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    if (installingApkDeviceIdsRef.current.has(deviceId)) return;
    const queuedItems = getDeviceApkInstallState(deviceId).queue.filter(item => item.status === 'queued' || item.status === 'failed');
    if (queuedItems.length === 0) return;

    installingApkDeviceIdsRef.current.add(deviceId);
    updateDeviceApkInstallState(deviceId, previousState => ({ ...previousState, isInstalling: true }));
    setError('');

    try {
      for (const item of queuedItems) {
        updateDeviceApkInstallState(deviceId, previousState => ({
          ...previousState,
          queue: previousState.queue.map(queueItem =>
            queueItem.id === item.id
              ? { ...queueItem, status: 'installing', progress: Math.max(queueItem.progress, 8), error: undefined, output: undefined }
              : queueItem
          ),
        }));
        startApkInstallProgressTimer(deviceId, item.id);

        try {
          const result = await window.electronAPI!.installApk(deviceId, item.path);
          stopApkInstallProgressTimer(item.id);
          updateDeviceApkInstallState(deviceId, previousState => ({
            ...previousState,
            queue: previousState.queue.map(queueItem =>
              queueItem.id === item.id
                ? {
                    ...queueItem,
                    status: result.success ? 'success' : 'failed',
                    progress: 100,
                    output: result.data?.output,
                    error: result.success ? undefined : formatOperationError(result, '安装失败'),
                  }
                : queueItem
            ),
          }));
        } catch (err) {
          stopApkInstallProgressTimer(item.id);
          updateDeviceApkInstallState(deviceId, previousState => ({
            ...previousState,
            queue: previousState.queue.map(queueItem =>
              queueItem.id === item.id
                ? { ...queueItem, status: 'failed', progress: 100, error: (err as Error).message }
                : queueItem
            ),
          }));
        }
      }
    } finally {
      installingApkDeviceIdsRef.current.delete(deviceId);
      updateDeviceApkInstallState(deviceId, previousState => ({ ...previousState, isInstalling: false }));
    }
  };

  const clearCompletedApkInstalls = () => {
    if (!selectedDevice) return;
    updateDeviceApkInstallState(selectedDevice.id, previousState => ({
      ...previousState,
      queue: previousState.queue.filter(item => item.status !== 'success'),
    }));
  };

  const removeApkInstallItem = (itemId: string) => {
    if (!selectedDevice) return;
    updateDeviceApkInstallState(selectedDevice.id, previousState => ({
      ...previousState,
      queue: previousState.queue.filter(item => item.id !== itemId || item.status === 'installing'),
    }));
  };

  const loadProcesses = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.getProcesses(selectedDevice.id);
      if (result.success && result.data) {
        setProcesses(result.data);
      }
    } catch (err) {
      console.error('Load processes error:', err);
    }
  };

  const sleepSelectedDevice = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    setIsDeviceMoreMenuOpen(false);
    try {
      const result = await window.electronAPI!.sleepDevice(selectedDevice.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备息屏失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备息屏失败: ' + (err as Error).message);
    }
  };

  const rebootSelectedDevice = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    setIsDeviceMoreMenuOpen(false);
    try {
      const result = await window.electronAPI!.rebootDevice(selectedDevice.id);
      if (!result.success) {
        setError(formatOperationError(result, '设备重启失败'));
        return;
      }
      setError('');
    } catch (err) {
      setError('设备重启失败: ' + (err as Error).message);
    }
  };

  const loadActivityStack = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.getActivityStack(selectedDevice.id, packageFilter.trim() || undefined);
      if (result.success && result.data) {
        setActivities(result.data);
        setError('');
      } else {
        setActivities([]);
        setError(result.error || '\u52a0\u8f7d Activity \u6808\u5931\u8d25');
      }
    } catch (err) {
      setActivities([]);
      setError('\u52a0\u8f7d Activity \u6808\u5931\u8d25\uff1a' + (err as Error).message);
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
  const currentApkInstallState = selectedDeviceId ? getDeviceApkInstallState(selectedDeviceId) : { queue: [], isInstalling: false };
  const currentApkInstallQueue = currentApkInstallState.queue;
  const isInstallingApks = currentApkInstallState.isInstalling;

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

  const renderApkInstallPanel = () => {
    const hasInstallableItems = currentApkInstallQueue.some(item => item.status === 'queued' || item.status === 'failed');
    const successCount = currentApkInstallQueue.filter(item => item.status === 'success').length;
    const finishedCount = currentApkInstallQueue.filter(item => item.status === 'success' || item.status === 'failed').length;
    const overallProgress = currentApkInstallQueue.length > 0
      ? Math.round((finishedCount / currentApkInstallQueue.length) * 100)
      : 0;

    return (
      <section style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '16px', minHeight: '420px', flex: 1, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: '12px', color: '#9ca3af', minWidth: 0 }}>
            {selectedDevice ? `目标设备：${getDeviceDisplayName(selectedDevice)}` : '未选择设备'}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, justifyContent: 'flex-end' }}>
            <button
              onClick={selectApkFiles}
              disabled={isInstallingApks}
              style={{ padding: '8px 12px', backgroundColor: isInstallingApks ? '#4b5563' : '#4a90d9', border: 'none', borderRadius: '6px', color: '#fff', cursor: isInstallingApks ? 'not-allowed' : 'pointer', fontSize: '13px', fontWeight: 600 }}
            >
              选择 APK
            </button>
            <button
              onClick={installQueuedApks}
              disabled={!hasInstallableItems || isInstallingApks || !selectedDevice}
              style={{ padding: '8px 14px', backgroundColor: hasInstallableItems && !isInstallingApks ? '#4a90d9' : '#4b5563', border: 'none', borderRadius: '6px', color: '#fff', cursor: hasInstallableItems && !isInstallingApks ? 'pointer' : 'not-allowed', fontSize: '13px', fontWeight: 600 }}
            >
              {isInstallingApks ? '安装中...' : '开始安装'}
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', color: '#9ca3af', fontSize: '12px' }}>
          <span>{`队列 ${currentApkInstallQueue.length}`}</span>
          <span>{`成功 ${successCount}`}</span>
          {currentApkInstallQueue.length > 0 && <span>{`进度 ${finishedCount}/${currentApkInstallQueue.length}`}</span>}
          {successCount > 0 && (
            <button onClick={clearCompletedApkInstalls} disabled={isInstallingApks} style={{ background: 'transparent', border: 'none', color: '#60a5fa', cursor: isInstallingApks ? 'not-allowed' : 'pointer', padding: 0, fontSize: '12px' }}>
              清空成功项
            </button>
          )}
        </div>

        {currentApkInstallQueue.length > 0 && (
          <div style={{ height: '6px', backgroundColor: '#353550', borderRadius: '999px', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${overallProgress}%`, backgroundColor: '#4a90d9', transition: 'width 220ms ease' }} />
          </div>
        )}

        {currentApkInstallQueue.length === 0 ? (
          <div style={{ flex: 1, minHeight: '260px', border: '1px dashed #454560', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', textAlign: 'center', padding: '24px' }}>
            <div>
              <div style={{ color: '#cbd5e1', fontSize: '15px', marginBottom: '6px' }}>还没有待安装文件</div>
              <div style={{ fontSize: '13px' }}>选择一个或多个 APK 后，按队列顺序推送安装到当前设备。</div>
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', overflow: 'auto', paddingRight: '4px' }}>
            {currentApkInstallQueue.map(item => {
              const statusMeta = getApkInstallStatusMeta(item.status);
              const canRemove = item.status !== 'installing';
              return (
                <div key={item.id} style={{ backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '12px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ color: '#fff', fontSize: '14px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.fileName}>{item.fileName}</div>
                      <div style={{ color: '#7b8197', fontSize: '11px', marginTop: '5px', wordBreak: 'break-all' }}>{item.path}</div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0 }}>
                      <span style={{ color: statusMeta.color, backgroundColor: statusMeta.background, borderRadius: '999px', padding: '3px 8px', fontSize: '12px' }}>
                        {statusMeta.label}
                      </span>
                      <button
                        onClick={() => removeApkInstallItem(item.id)}
                        disabled={!canRemove}
                        style={{ padding: '3px 8px', backgroundColor: 'transparent', border: '1px solid #454560', borderRadius: '6px', color: canRemove ? '#d1d5db' : '#6b7280', cursor: canRemove ? 'pointer' : 'not-allowed', fontSize: '12px' }}
                      >
                        删除
                      </button>
                    </div>
                  </div>
                  <div style={{ marginTop: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: '#9ca3af', fontSize: '11px', marginBottom: '5px' }}>
                      <span>{item.status === 'installing' ? '正在推送并安装' : statusMeta.label}</span>
                      <span>{`${Math.round(item.progress)}%`}</span>
                    </div>
                    <div style={{ height: '5px', backgroundColor: '#353550', borderRadius: '999px', overflow: 'hidden' }}>
                      <div
                        style={{
                          height: '100%',
                          width: `${item.progress}%`,
                          backgroundColor: item.status === 'failed' ? '#ef4444' : item.status === 'success' ? '#22c55e' : '#60a5fa',
                          transition: 'width 260ms ease',
                        }}
                      />
                    </div>
                  </div>
                  {(item.error || item.output) && (
                    <div style={{ marginTop: '8px', color: item.error ? '#fca5a5' : '#86efac', fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                      {item.error || item.output}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
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
        <button 
          onClick={loadDevices}
          style={{ 
            padding: '6px 12px', 
            backgroundColor: '#353550', 
            border: 'none', 
            borderRadius: '6px', 
            color: 'white', 
            cursor: 'pointer',
            fontSize: '14px'
          }}
        >{'\u5237\u65b0\u8bbe\u5907'}</button>
        <button 
          onClick={connectUSBDevice}
          style={{ 
            padding: '6px 12px', 
            backgroundColor: '#353550', 
            border: 'none', 
            borderRadius: '6px', 
            color: 'white', 
            cursor: 'pointer',
            fontSize: '14px',
            marginLeft: '8px'
          }}
        >
          USB
        </button>
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
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      disconnectDevice(device);
                    }}
                    style={{ 
                      marginTop: '8px', 
                      padding: '4px 8px', 
                      backgroundColor: '#555', 
                      border: 'none', 
                      borderRadius: '4px', 
                      color: '#ff6b6b', 
                      cursor: 'pointer',
                      fontSize: '12px'
                    }}
                  >{'\u65ad\u5f00'}</button>
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
                  { key: 'processes' as TabType, label: '\u8fdb\u7a0b' },
                  { key: 'activity' as TabType, label: 'Activity \u6808' },
                  { key: 'network' as TabType, label: '\u7f51\u7edc' },
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
                  <div style={{ display: 'grid', gridTemplateColumns: 'minmax(420px, 600px) minmax(420px, 1fr)', gap: '20px', alignItems: 'stretch' }}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <h2 style={{ fontSize: '20px', fontWeight: '600', margin: '0 0 16px 0' }}>{'\u8bbe\u5907\u8be6\u60c5'}</h2>
                    <div style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '16px', flex: 1, boxSizing: 'border-box' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px' }}>
                        <div>
                          <h3 style={{ fontSize: '16px', fontWeight: '600', margin: '0 0 4px 0' }}>{getDeviceDisplayName(selectedDevice)}</h3>
                          {customDeviceNames[selectedDevice.id]?.trim() && (
                            <p style={{ fontSize: '12px', color: '#888', margin: '0 0 4px 0' }}>{'\u539f\u59cb\u540d\u79f0'}: {selectedDevice.name || selectedDevice.model || '--'}</p>
                          )}
                          <p style={{ fontSize: '14px', color: '#888' }}>{selectedDevice.id}</p>
                        </div>
                      </div>
                      <div style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
                        <input
                          value={customDeviceNames[selectedDevice.id] || ''}
                          onChange={(e) => updateCustomDeviceName(selectedDevice.id, e.target.value)}
                          placeholder={'\u81ea\u5b9a\u4e49\u8bbe\u5907\u540d'}
                          style={{ flex: 1, padding: '8px 10px', backgroundColor: '#353550', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }}
                        />
                        <button
                          onClick={() => updateCustomDeviceName(selectedDevice.id, '')}
                          style={{ padding: '0 12px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: '#d1d5db', cursor: 'pointer', fontSize: '13px' }}
                        >{'\u6062\u590d\u9ed8\u8ba4'}</button>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '12px' }}>
                        <div style={{ backgroundColor: '#353550', borderRadius: '6px', padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'\u5382\u5546'}</div>
                          <div style={{ fontSize: '14px' }}>{selectedDevice.manufacturer}</div>
                        </div>
                        <div style={{ backgroundColor: '#353550', borderRadius: '6px', padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'\u578b\u53f7'}</div>
                          <div style={{ fontSize: '14px' }}>{selectedDevice.model}</div>
                        </div>
                        <div style={{ backgroundColor: '#353550', borderRadius: '6px', padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'Android \u7248\u672c'}</div>
                          <div style={{ fontSize: '14px' }}>{selectedDevice.androidVersion}</div>
                        </div>
                        <div style={{ backgroundColor: '#353550', borderRadius: '6px', padding: '12px' }}>
                          <div style={{ fontSize: '12px', color: '#888', marginBottom: '4px' }}>{'API \u7b49\u7ea7'}</div>
                          <div style={{ fontSize: '14px' }}>{selectedDevice.apiLevel}</div>
                        </div>
                      </div>
                      <div style={{ marginTop: '16px', display: 'flex', gap: '8px', position: 'relative' }}>
                        <button
                          onClick={toggleLogcat}
                          style={{
                            flex: 1,
                            padding: '10px',
                            backgroundColor: isSelectedLogcatRunning ? '#ef4444' : '#4a90d9',
                            border: 'none',
                            borderRadius: '6px',
                            color: 'white',
                            fontSize: '14px',
                            fontWeight: '500',
                            cursor: 'pointer'
                          }}
                        >
                          {isSelectedLogcatRunning ? '\u505c\u6b62\u65e5\u5fd7' : '\u5f00\u59cb\u65e5\u5fd7'}
                        </button>
                        <button
                          onClick={() => setIsDeviceMoreMenuOpen(open => !open)}
                          style={{
                            padding: '10px 20px',
                            backgroundColor: '#353550',
                            border: 'none',
                            borderRadius: '6px',
                            color: 'white',
                            fontSize: '14px',
                            cursor: 'pointer'
                          }}
                        >更多</button>
                        {isDeviceMoreMenuOpen && (
                          <div style={{ position: 'absolute', right: 0, top: '44px', minWidth: '120px', backgroundColor: '#202038', border: '1px solid #454560', borderRadius: '8px', padding: '6px', zIndex: 5, boxShadow: '0 10px 24px rgba(0,0,0,0.28)' }}>
                            <button
                              onClick={sleepSelectedDevice}
                              style={{ width: '100%', padding: '8px 10px', backgroundColor: 'transparent', border: 'none', borderRadius: '6px', color: '#d1d5db', textAlign: 'left', cursor: 'pointer', fontSize: '13px' }}
                            >息屏</button>
                            <button
                              onClick={rebootSelectedDevice}
                              style={{ width: '100%', padding: '8px 10px', backgroundColor: 'transparent', border: 'none', borderRadius: '6px', color: '#fca5a5', textAlign: 'left', cursor: 'pointer', fontSize: '13px' }}
                            >重启</button>
                          </div>
                        )}
                      </div>
                    </div>
                    </div>
                    <div style={{ marginTop: '40px', display: 'flex' }}>
                      {renderApkInstallPanel()}
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

                {activeTab === 'processes' && (
                  <div style={{ backgroundColor: '#252540', borderRadius: '8px', overflow: 'hidden' }}>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ backgroundColor: '#353550' }}>
                          <tr>
                            <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: '600', color: '#888' }}>PID</th>
                            <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: '600', color: '#888' }}>PPID</th>
                            <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: '600', color: '#888' }}>{'\u540d\u79f0'}</th>
                            <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: '600', color: '#888' }}>CPU</th>
                            <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: '600', color: '#888' }}>{'\u5185\u5b58'}</th>
                            <th style={{ padding: '12px', textAlign: 'left', fontSize: '14px', fontWeight: '600', color: '#888' }}>{'\u72b6\u6001'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {processes.length === 0 ? (
                            <tr>
                              <td colSpan={6} style={{ padding: '32px', textAlign: 'center', color: '#666' }}>{'\u6682\u65e0\u8fdb\u7a0b\u6570\u636e'}</td>
                            </tr>
                          ) : (
                            processes.slice(0, 50).map((proc) => (
                              <tr key={proc.pid} style={{ borderBottom: '1px solid #353550' }}>
                                <td style={{ padding: '10px 12px', fontSize: '14px', color: '#fff' }}>{proc.pid}</td>
                                <td style={{ padding: '10px 12px', fontSize: '14px', color: '#888' }}>{proc.ppid}</td>
                                <td style={{ padding: '10px 12px', fontSize: '14px', color: '#fff', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={proc.name}>{proc.name}</td>
                                <td style={{ padding: '10px 12px', fontSize: '14px', color: '#3b82f6' }}>{proc.cpuUsage}%</td>
                                <td style={{ padding: '10px 12px', fontSize: '14px', color: '#22c55e' }}>{proc.memoryUsage}%</td>
                                <td style={{ padding: '10px 12px' }}>
                                  <span style={{ 
                                    padding: '2px 8px', 
                                    borderRadius: '4px', 
                                    fontSize: '12px',
                                    backgroundColor: proc.status === 'running' ? '#22c55e22' : proc.status === 'sleeping' ? '#eab30822' : '#ef444422',
                                    color: proc.status === 'running' ? '#22c55e' : proc.status === 'sleeping' ? '#eab308' : '#ef4444'
                                  }}>
                                    {proc.status}
                                  </span>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

                {activeTab === 'activity' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input
                        type="text"
                        placeholder={'\u5305\u540d\u8fc7\u6ee4\uff0c\u4f8b\u5982 com.example.app'}
                        value={packageFilter}
                        onChange={(e) => setPackageFilter(e.target.value)}
                        style={{ flex: 1, padding: '8px 12px', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '6px', color: 'white', fontSize: '14px', outline: 'none' }}
                      />
                      <button onClick={loadActivityStack} style={{ padding: '8px 16px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: 'white', cursor: 'pointer' }}>{'\u5237\u65b0'}</button>
                    </div>
                    <div style={{ backgroundColor: '#252540', borderRadius: '8px', overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead style={{ backgroundColor: '#353550' }}>
                          <tr>
                            <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'\u4efb\u52a1'}</th>
                            <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'\u5305\u540d'}</th>
                            <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>Activity</th>
                            <th style={{ padding: '12px', textAlign: 'left', color: '#888' }}>{'\u72b6\u6001'}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activities.length === 0 ? (
                            <tr><td colSpan={4} style={{ padding: '32px', textAlign: 'center', color: '#666' }}>{'\u6682\u65e0 Activity \u6808\u6570\u636e'}</td></tr>
                          ) : activities.map(activity => (
                            <tr key={activity.id} style={{ borderBottom: '1px solid #353550' }}>
                              <td style={{ padding: '10px 12px', color: '#888' }}>{activity.taskId || '--'}</td>
                              <td style={{ padding: '10px 12px', color: '#60a5fa' }}>{activity.packageName}</td>
                              <td style={{ padding: '10px 12px', color: '#fff' }}>{activity.activityName}</td>
                              <td style={{ padding: '10px 12px', color: '#22c55e' }}>{activity.state}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
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
    </div>
  );
}

export default SimpleApp;

