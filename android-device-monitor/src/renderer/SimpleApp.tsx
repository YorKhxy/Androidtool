import { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { AdbStatus, DeviceInfo, HistoryDevice, MirrorSession, PerformanceMetrics, PerformanceCaptureSession, PerformanceCaptureMarker, PerformanceSample, LogEntry, NetworkRequest, UpdateStatus } from '../shared/types';
import { NetworkPanel } from './components/NetworkPanel';
import { PerformancePanel } from './components/PerformancePanel';
import { MirrorPanel } from './components/MirrorPanel';
import { FilesPanel } from './components/FilesPanel';
import { ElectronResult, hasElectronAPI } from './lib/electronApi';
import {
  buildHistoryEntryFromDevice,
  formatHistoryTime,
  loadHistoryDevices,
  removeHistoryDevice,
  saveHistoryDevices,
  upsertHistoryDevice,
} from './lib/historyDeviceStore';
import {
  addSearchHistory,
  loadSearchHistory,
  removeSearchHistory,
  saveSearchHistory,
} from './lib/searchHistoryStore';
import { isTransferActive } from './lib/fileTransferManager';
import {
  BATCH_UPDATE_DELAY,
  BATCH_UPDATE_SIZE,
  createDeviceLogState,
  createLogCounts,
  DeviceLogState,
  LOG_LINE_HEIGHT,
  LOG_OVERSCAN_ROWS,
  LOG_ROW_HEIGHT,
  MAX_LOG_ENTRIES,
  MAX_PENDING_LOG_BUFFER,
} from './lib/logStore';

// 多行日志（异常堆栈等）在列表里整条铺开，每条高度 = 文本行数 × LOG_LINE_HEIGHT + 垂直内边距。
// 行数按 message 的换行数确定性计算（WeakMap 缓存，条目不可变，避免重复计算），
// 供变高虚拟滚动用——高度可预测，无需测量 DOM。
const logEntryLineCounts = new WeakMap<LogEntry, number>();
const getLogEntryLineCount = (log: LogEntry): number => {
  const cached = logEntryLineCounts.get(log);
  if (cached !== undefined) return cached;
  let lines = 1;
  const message = log.message;
  for (let i = 0; i < message.length; i++) {
    if (message.charCodeAt(i) === 10) lines++;
  }
  logEntryLineCounts.set(log, lines);
  return lines;
};
const getLogRowHeight = (log: LogEntry): number =>
  getLogEntryLineCount(log) * LOG_LINE_HEIGHT + (LOG_ROW_HEIGHT - LOG_LINE_HEIGHT);

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

// 屏幕状态徽标：唤醒（亮绿点）/息屏（暗灰点）/未知。仅已连接且拿到状态时显示。
const renderScreenStateBadge = (device: DeviceInfo) => {
  if (device.status !== 'connected' || !device.screenState) return null;
  const meta =
    device.screenState === 'on'
      ? { label: '唤醒', color: '#22c55e', dot: '#22c55e', glow: true }
      : device.screenState === 'off'
        ? { label: '息屏', color: '#9ca3af', dot: '#6b7280', glow: false }
        : { label: '未知', color: '#9ca3af', dot: '#6b7280', glow: false };
  return (
    <span title={`屏幕状态：${meta.label}`} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: meta.color, lineHeight: 1 }}>
      <span style={{ width: '7px', height: '7px', borderRadius: '50%', backgroundColor: meta.dot, boxShadow: meta.glow ? '0 0 5px #22c55e' : 'none', flexShrink: 0 }} />
      {meta.label}
    </span>
  );
};

// 复用的空集合：作为「该设备暂无 NEW」的稳定默认值，避免每次渲染新建 Set。
const EMPTY_PACKAGE_SET: Set<string> = new Set();

function SimpleApp() {
  const [adbStatus, setAdbStatus] = useState<AdbStatus | null>(null);
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  // 工具是否初始化完成（IPC 就绪 + 初始数据加载 + 事件订阅完毕）。未就绪时全屏「启动中」遮罩挡住所有操作。
  const [appReady, setAppReady] = useState(false);
  // 应用版本号（显示在标题栏，便于确认是否已更新到最新版）。
  const [appVersion, setAppVersion] = useState<string>('');
  // 更新日志弹窗：点版本号查看本版本更新内容（来自打进安装包的 release-notes.md）。
  const [showReleaseNotes, setShowReleaseNotes] = useState(false);
  const [releaseNotesText, setReleaseNotesText] = useState<string>('');
  // 手动「检查更新」：ref 标记本次为手动触发（后台检查静默，手动检查要给「已是最新/失败」反馈）。
  const manualCheckRef = useRef(false);
  const [checkResult, setCheckResult] = useState<string>('');
  const lastCheckAtRef = useRef(0); // 上次点检查更新的时间戳，做 0.5s 冷却防狂点刷爆服务器
  // 自动更新状态（来自主进程 electron-updater 事件），驱动右下角更新提示条。
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  // 点「安装并重启」后显示全屏「正在安装…」遮罩，随后退出安装（文件被锁需退出后由 NSIS 替换）。
  const [installing, setInstalling] = useState(false);
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
  // —— Phase 14 采集会话状态（按设备）——
  // 进行中的采集会话（点开始采集时设入，关闭后移除）；停止后 finalize 的报告会话；start/stop 异步进行中集合。
  const [activeCaptureByDeviceId, setActiveCaptureByDeviceId] = useState<Record<string, PerformanceCaptureSession>>({});
  const [reportSessionByDeviceId, setReportSessionByDeviceId] = useState<Record<string, PerformanceCaptureSession>>({});
  const [captureBusyDeviceIds, setCaptureBusyDeviceIds] = useState<Set<string>>(() => new Set());
  const [captureElapsedByDeviceId, setCaptureElapsedByDeviceId] = useState<Record<string, number>>({});
  const [softLimitNoticeByDeviceId, setSoftLimitNoticeByDeviceId] = useState<Record<string, string>>({});
  const [installedPackages, setInstalledPackages] = useState<string[]>([]);
  const [installedPackagesLoading, setInstalledPackagesLoading] = useState(false);
  const [appFilter, setAppFilter] = useState('');
  // 当前设备上在运行的应用包名集合：用于已安装列表标「运行中」并禁止重复启动。轮询刷新，反映真实状态。
  const [runningPackages, setRunningPackages] = useState<Set<string>>(new Set());
  // 刚通过工具新装上的包名，按设备分别存（批量装多台时切设备查看各自的 NEW，互不清除）。
  // 每台设备在自己安装前后各拉一次包列表 diff 得到，与「当前选中设备」无关。
  const [newlyInstalledByDevice, setNewlyInstalledByDevice] = useState<Record<string, Set<string>>>({});
  const [busyPackage, setBusyPackage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'launch' | 'stop' | 'uninstall' | null>(null);
  // 应用内确认弹窗：取代原生 window.confirm —— 后者在 Electron 渲染层关闭后会让网页文档丢键盘焦点，
  // 导致弹窗取消/确认后输入框（如「搜索包名」）点进去敲不了字。用受控 React 弹窗彻底规避。
  const [confirmDialog, setConfirmDialog] = useState<{
    message: string;
    confirmText: string;
    danger: boolean;
    onConfirm: () => void;
  } | null>(null);
  const requestConfirm = useCallback(
    (opts: { message: string; confirmText?: string; danger?: boolean; onConfirm: () => void }) => {
      setConfirmDialog({
        message: opts.message,
        confirmText: opts.confirmText || '确定',
        danger: opts.danger ?? false,
        onConfirm: opts.onConfirm,
      });
    },
    []
  );
  const [networkRequests, setNetworkRequests] = useState<NetworkRequest[]>([]);
  const [selectedNetworkRequestId, setSelectedNetworkRequestId] = useState<string | null>(null);
  const [runningLogDeviceIds, setRunningLogDeviceIds] = useState<Set<string>>(() => new Set());
  const [wifiIp, setWifiIp] = useState('');
  // 历史 WiFi 设备（快速重连）。初始从 localStorage 读取，已按最近连接时间倒序。
  const [historyDevices, setHistoryDevices] = useState<HistoryDevice[]>(() => loadHistoryDevices());
  // 正在快速连接的历史卡片 serialNo（连接中按钮禁用 + 即时反馈）。
  const [quickConnectingSerial, setQuickConnectingSerial] = useState<string | null>(null);
  // 快速连接失败（IP 变更）时，就地展开 IP 输入框的卡片 serialNo 及其输入值。
  const [inlineEditSerial, setInlineEditSerial] = useState<string | null>(null);
  const [inlineEditValue, setInlineEditValue] = useState('');
  // 历史卡片的失败提示，按 serialNo 区分，避免污染顶部全局错误条。
  const [historyErrorBySerial, setHistoryErrorBySerial] = useState<Record<string, string>>({});
  // 移除历史的行内二次确认态（与设备卡片断开/重启确认同款交互）。
  const [confirmRemoveSerial, setConfirmRemoveSerial] = useState<string | null>(null);
  const [showPairForm, setShowPairForm] = useState(false);
  const [pairAddress, setPairAddress] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const [packageFilter, setPackageFilter] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  // 日志搜索关键字历史：重启工具仍在，可在搜索框下拉直接选。
  const [searchHistory, setSearchHistory] = useState<string[]>(() => loadSearchHistory());
  // 自定义历史下拉的显隐（不用原生 datalist，以统一暗色 UI 风格）。
  const [showSearchHistory, setShowSearchHistory] = useState(false);
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
  const [apkInstallStates, setApkInstallStates] = useState<Record<string, DeviceApkInstallState>>({});
  const [pendingApks, setPendingApks] = useState<{ path: string; fileName: string }[]>([]);
  const [isApkDragOver, setIsApkDragOver] = useState(false); // 拖拽 APK 到待安装区时高亮
  // 安装过程日志：每条带时间戳，最新在上。展示在「安装详情」模块里。
  const [installLog, setInstallLog] = useState<{ text: string; level: 'info' | 'success' | 'error' }[]>([]);
  const [installTargets, setInstallTargets] = useState<Set<string>>(new Set());
  const [installConcurrency, setInstallConcurrency] = useState(4);
  const [installAllowDowngrade, setInstallAllowDowngrade] = useState(false);
  const [isUnifiedInstalling, setIsUnifiedInstalling] = useState(false);
  const [busyDeviceAction, setBusyDeviceAction] = useState<{ id: string; action: 'sleep' | 'wake' | 'unlock' | 'reboot' } | null>(null);
  const [fileBrowserDevice, setFileBrowserDevice] = useState<DeviceInfo | null>(null);
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null);
  // 重启是高风险操作，点击后进入行内二次确认态（与断开确认互斥，避免同卡片同时弹两个确认）
  const [confirmRebootId, setConfirmRebootId] = useState<string | null>(null);
  // 最近一次导出日志保存到 PC 的路径，用于「打开所在文件夹」快捷按钮
  const [lastExportedLogPath, setLastExportedLogPath] = useState<string | null>(null);
  
  const logStatesRef = useRef(new Map<string, DeviceLogState>());
  const logsContainerRef = useRef<HTMLDivElement>(null);
  const selectedDeviceRef = useRef<DeviceInfo | null>(null);
  const maxLogEntriesRef = useRef(MAX_LOG_ENTRIES);
  const batchUpdateSizeRef = useRef(BATCH_UPDATE_SIZE);
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

  // 列表/日志里用的显示名：基名相同（如两台都改成同一自定义名）时补区分符，避免分不清是哪台。
  // WiFi 用 IP，USB 用 SN 尾号；都取不到就退回设备 id。
  const getDeviceLabel = useCallback((device: DeviceInfo) => {
    const base = getDeviceDisplayName(device);
    const collision = devices.some((d) => d.id !== device.id && getDeviceDisplayName(d) === base);
    if (!collision) return base;
    const snTail = device.serialNo && device.serialNo !== 'Unknown' ? device.serialNo.slice(-4) : '';
    const distinguisher = device.connectionType === 'wifi'
      ? ((device.id || '').split(':')[0] || snTail || device.id)
      : (snTail || device.id);
    return `${base}（${distinguisher}）`;
  }, [getDeviceDisplayName, devices]);

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
    // 稳定排序：避免后端数据源（Map values / Promise.all resolve 顺序）变化导致卡片位置跳动。
    // 规则：USB 在前、WiFi 在后，同类按设备 id 字典序。
    const sortedDevices = [...nextDevices].sort((a, b) => {
      if (a.connectionType !== b.connectionType) {
        return a.connectionType === 'usb' ? -1 : 1;
      }
      return a.id.localeCompare(b.id);
    });
    setDevices(sortedDevices);
    reconcileLogStatesWithDevices(sortedDevices);
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
          // 设备断开：清掉它的「NEW」记录（设备没了，标识也无意义，顺便不留过期数据）。
          setNewlyInstalledByDevice((prev) => {
            if (!(deviceId in prev)) return prev;
            const next = { ...prev };
            delete next[deviceId];
            return next;
          });
        });
        
        const unsubscribeLogEntry = window.electronAPI!.onLogEntry((entry) => {
          enqueueLogEntries([entry]);
        });
        const unsubscribeLogBatch = window.electronAPI!.onLogBatch((entries) => {
          enqueueLogEntries(entries);
        });
        const unsubscribeUpdateStatus = window.electronAPI!.onUpdateStatus((status) => {
          setUpdateStatus(status);
          if (status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded') {
            setUpdateDismissed(false); // 有实质更新动作时重新弹出提示
          }
          // 手动检查时给按钮旁文字反馈（后台检查不反馈，保持静默）。
          if (manualCheckRef.current) {
            if (status.state === 'checking') {
              setCheckResult('检查中…');
            } else if (status.state === 'not-available') {
              manualCheckRef.current = false;
              setCheckResult('已是最新版本');
              window.setTimeout(() => setCheckResult(''), 4000);
            } else if (status.state === 'error') {
              manualCheckRef.current = false;
              setCheckResult('检查失败，请确认更新服务器');
              window.setTimeout(() => setCheckResult(''), 5000);
            } else {
              manualCheckRef.current = false;
              setCheckResult(''); // available/downloading/downloaded → 交给提示框展示
            }
          }
        });
        // 启动即拉取主进程已知的最近更新状态：补回 whenReady 那次自动检查因 push 早于本订阅而丢失的提示，
        // 实现「打开工具就自动提示有新版本」，无需手动点「检查更新」。后台拉取，不走手动反馈（不弹「已是最新」）。
        void window.electronAPI!.getUpdateStatus?.().then((res) => {
          const status = res?.success ? res.data : null;
          if (!status) return;
          setUpdateStatus(status);
          if (status.state === 'available' || status.state === 'downloading' || status.state === 'downloaded') {
            setUpdateDismissed(false);
          }
        }).catch(() => undefined);
        const unsubscribeMirrorStatus = window.electronAPI!.onMirrorStatus((session) => {
          setMirrorSessionsByDeviceId(prev => ({ ...prev, [session.deviceId]: session }));
          setMirrorStartingDeviceIds(prev => {
            if (!prev.has(session.deviceId)) return prev;
            const next = new Set(prev);
            next.delete(session.deviceId);
            return next;
          });
        });
        // 采集中实时样本：主进程每秒推一条，累积到该设备样本缓冲（供实时曲线 + 关闭后报告），
        // 同时刷新指标卡与已用时长。上限 7200 条（约 2 小时）防长采集内存膨胀。
        const unsubscribeCaptureSample = window.electronAPI!.onCaptureSample((payload) => {
          setPerformanceByDeviceId(prev => ({ ...prev, [payload.deviceId]: payload.sample.metrics }));
          setPerformanceSamplesByDeviceId(prev => ({
            ...prev,
            [payload.deviceId]: [
              ...(prev[payload.deviceId] || []),
              { ...payload.sample, capturedAt: new Date(payload.sample.capturedAt) },
            ].slice(-7200),
          }));
          setCaptureElapsedByDeviceId(prev => ({ ...prev, [payload.deviceId]: payload.elapsedMs }));
        });
        const unsubscribeCaptureSizeLimit = window.electronAPI!.onCaptureSizeLimit((payload) => {
          const text = payload.reason === 'duration'
            ? '本次采集已录制 30 分钟，可继续，也可手动关闭采集。'
            : '本次采集录屏已达 2GB，可继续，也可手动关闭采集。';
          setSoftLimitNoticeByDeviceId(prev => ({ ...prev, [payload.deviceId]: text }));
        });

        // 初始数据加载完、所有 IPC 事件订阅就绪 → 标记 app 就绪，撤掉「启动中」遮罩，放开操作。
        setAppReady(true);

        return () => {
          unsubscribeAdbStatusChanged();
          unsubscribeDeviceListChanged();
          unsubscribeDeviceConnected();
          unsubscribeDeviceDisconnected();
          unsubscribeLogEntry();
          unsubscribeLogBatch();
          unsubscribeMirrorStatus();
          unsubscribeCaptureSample();
          unsubscribeCaptureSizeLimit();
          unsubscribeUpdateStatus();
          logStatesRef.current.forEach(state => {
            if (state.flushTimer !== null) {
              window.clearTimeout(state.flushTimer);
            }
          });
          apkInstallProgressTimersRef.current.forEach(timerId => window.clearInterval(timerId));
          apkInstallProgressTimersRef.current.clear();
        };
      }
      setAppReady(true); // 无 Electron（纯网页环境）也放开操作
    };

    const cleanupPromise = initApp();
    return () => {
      cleanupPromise.then((cleanup) => {
        if (cleanup) cleanup();
      });
    };
  }, [applyDeviceList, enqueueLogEntries, removeDeviceLogState]);

  // 启动时取一次应用版本号，显示在标题栏，便于确认是否已更新到最新版。
  useEffect(() => {
    if (!hasElectronAPI() || !window.electronAPI?.getAppVersion) return;
    void window.electronAPI.getAppVersion().then((result) => {
      if (result.success && result.data) setAppVersion(result.data);
    });
  }, []);

  // 全局拖拽守卫：拦掉窗口默认的「拖入文件即导航到 file://」行为——否则把 APK 拖偏到拖放区之外，
  // 整个界面会被替换成该文件，体验崩坏。真正的接收逻辑在待安装拖放区里单独处理。
  useEffect(() => {
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  // 安全兜底：万一初始化某步卡住，最多 15 秒后也撤掉「启动中」遮罩，避免永久锁死。
  useEffect(() => {
    const timer = window.setTimeout(() => setAppReady(true), 15000);
    return () => window.clearTimeout(timer);
  }, []);

  // 手动检查更新：标记为手动触发并显示「检查中…」，结果由 onUpdateStatus 回调据 manualCheckRef 给反馈。
  const handleCheckUpdate = async () => {
    if (!hasElectronAPI() || !window.electronAPI?.checkForUpdate) return;
    // 0.5s 冷却 + 上次检查未出结果时忽略：防止狂点把更新服务器刷爆。
    const now = Date.now();
    if (now - lastCheckAtRef.current < 500 || manualCheckRef.current) return;
    lastCheckAtRef.current = now;
    manualCheckRef.current = true;
    setCheckResult('检查中…');
    setUpdateDismissed(false);
    try {
      await window.electronAPI.checkForUpdate();
    } catch {
      manualCheckRef.current = false;
      setCheckResult('检查失败');
    }
  };

  // 点版本号：读取本版本更新日志（打进安装包的 release-notes.md）并弹窗展示。
  const openReleaseNotes = async () => {
    if (hasElectronAPI() && window.electronAPI?.getReleaseNotes) {
      const result = await window.electronAPI.getReleaseNotes();
      setReleaseNotesText(result.success && result.data ? result.data : '');
    }
    setShowReleaseNotes(true);
  };



  // 采集中的指标采样由主进程编排（PerformanceCaptureController 每秒一次），经 onCaptureSample
  // 实时推送到渲染层，渲染层不再自行轮询 getPerformance。

  // 已安装应用列表只在设备连接（id 变化）时获取一次，避免设备轮询导致的频繁刷新；
  // 卸载 / 安装完成后单独触发刷新，其余情况由用户手动点刷新。
  useEffect(() => {
    // 切设备只是切换显示哪台，NEW 按设备存（newlyInstalledByDevice），不清除——否则批量装多台后切看就丢标识。
    if (selectedDevice?.id) {
      setInstalledPackages([]);
      setAppFilter('');
      loadInstalledPackages();
    } else {
      setInstalledPackages([]);
      setAppFilter('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id]);

  // 轮询当前设备「运行中」应用：仅设备页 + 设备已连接时，每 4s 刷新，让运行标识反映真实状态
  //（不管谁启动的）。离开设备页 / 切设备 / 断开即清空，避免显示过期运行态。
  useEffect(() => {
    const deviceId = selectedDevice?.id;
    if (!deviceId || selectedDevice?.status !== 'connected' || activeTab !== 'devices') {
      setRunningPackages(new Set());
      return;
    }
    void loadRunningPackages();
    const timer = window.setInterval(() => { void loadRunningPackages(); }, 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDevice?.id, selectedDevice?.status, activeTab]);

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

  // \u4ec5 WiFi \u6210\u529f\u8fde\u63a5\u624d\u5199\u5386\u53f2\uff1a\u4ece DeviceInfo \u6784\u9020\u8bb0\u5f55\uff0c\u6309 serialNo \u53bb\u91cd upsert \u5e76\u6301\u4e45\u5316\u3002
  // USB \u8bbe\u5907\uff08buildHistoryEntryFromDevice \u8fd4\u56de null\uff09\u548c\u65e0 serialNo \u7684\u8bbe\u5907\u4e0d\u5199\u5165\u3002
  const persistHistoryFromDevice = useCallback((device: DeviceInfo) => {
    const entry = buildHistoryEntryFromDevice(device, getDeviceDisplayName(device), Date.now());
    if (!entry) return;
    setHistoryDevices(prev => {
      const next = upsertHistoryDevice(prev, entry);
      saveHistoryDevices(next);
      return next;
    });
  }, [getDeviceDisplayName]);

  // WiFi \u8fde\u63a5\u6838\u5fc3\uff0c\u4f9b\u9876\u90e8\u8fde\u63a5\u6846\u4e0e\u5386\u53f2\u5361\u7247\u5feb\u901f\u8fde\u63a5/\u5c31\u5730\u91cd\u8fde\u590d\u7528\u3002
  // \u6210\u529f\u65f6\u5199\u5386\u53f2\u5e76\u5237\u65b0\u8bbe\u5907\u5217\u8868\uff0c\u8fd4\u56de\u7ed3\u6784\u5316\u7ed3\u679c\u8ba9\u8c03\u7528\u65b9\u51b3\u5b9a\u63d0\u793a\u4f4d\u7f6e\uff08\u5168\u5c40\u9519\u8bef\u6761 / \u5361\u7247\u5185\uff09\u3002
  const performWifiConnect = useCallback(
    async (address: string): Promise<{ success: boolean; errorMessage?: string }> => {
      if (!hasElectronAPI()) {
        return { success: false, errorMessage: 'Electron \u63a5\u53e3\u4e0d\u53ef\u7528' };
      }
      try {
        const result = await window.electronAPI!.connectWiFi(address);
        if (result.success) {
          if (result.data) persistHistoryFromDevice(result.data);
          await loadAdbStatus();
          await loadDevices();
          return { success: true };
        }
        await loadAdbStatus();
        return { success: false, errorMessage: formatOperationError(result, 'WiFi \u8fde\u63a5\u5931\u8d25') };
      } catch (err) {
        await loadAdbStatus();
        return { success: false, errorMessage: 'WiFi \u8fde\u63a5\u5931\u8d25\uff1a' + (err as Error).message };
      }
    },
    [persistHistoryFromDevice]
  );

  const connectWiFiDevice = async () => {
    if (!wifiIp.trim()) {
      setError('\u8bf7\u8f93\u5165\u8bbe\u5907 IP \u5730\u5740');
      return;
    }
    setError('\u6b63\u5728\u8fde\u63a5...');
    const res = await performWifiConnect(wifiIp.trim());
    if (res.success) {
      setWifiIp('');
      setError('');
    } else {
      setError(res.errorMessage || 'WiFi \u8fde\u63a5\u5931\u8d25');
    }
  };

  const clearHistoryError = useCallback((serialNo: string) => {
    setHistoryErrorBySerial(prev => {
      if (!(serialNo in prev)) return prev;
      const next = { ...prev };
      delete next[serialNo];
      return next;
    });
  }, []);

  // 记录一次搜索关键字到历史（去重置顶 + 持久化）。在搜索框回车或失焦时调用。
  const recordSearchHistory = useCallback((keyword: string) => {
    if (!keyword.trim()) return;
    setSearchHistory(prev => {
      const next = addSearchHistory(prev, keyword);
      saveSearchHistory(next);
      return next;
    });
  }, []);

  // 关闭文件管理：若该设备有文件传输进行中，先确认（关闭后传输仍在后台继续，重开可看回进度）。
  const closeFileBrowser = useCallback(() => {
    if (fileBrowserDevice && isTransferActive(fileBrowserDevice.id)) {
      requestConfirm({
        message: '正在传输文件，确定关闭文件管理吗？\n关闭后传输会在后台继续，重新打开可看到进度。',
        confirmText: '关闭',
        onConfirm: () => setFileBrowserDevice(null),
      });
      return;
    }
    setFileBrowserDevice(null);
  }, [fileBrowserDevice, requestConfirm]);

  // 从历史移除一条关键字。
  const removeOneSearchHistory = useCallback((keyword: string) => {
    setSearchHistory(prev => {
      const next = removeSearchHistory(prev, keyword);
      saveSearchHistory(next);
      return next;
    });
  }, []);

  // 历史下拉里展示的条目：按当前输入做前缀联想（输入为空则全部），排除与输入完全相同的项。
  const visibleSearchHistory = useMemo(() => {
    const query = searchTerm.trim().toLowerCase();
    if (!query) return searchHistory;
    return searchHistory.filter(item => {
      const lower = item.toLowerCase();
      return lower.includes(query) && lower !== query;
    });
  }, [searchHistory, searchTerm]);

  // \u5386\u53f2\u5361\u7247\u300c\u5feb\u901f\u8fde\u63a5\u300d\uff1a\u7528\u8bb0\u5f55\u7684 lastAddress \u76f4\u63a5\u8fde\u3002\u5931\u8d25\u591a\u534a\u662f\u8bbe\u5907 IP \u53d8\u4e86\uff0c
  // \u5c31\u5730\u5c55\u5f00\u8f93\u5165\u6846\u5e76\u9884\u586b\u4e0a\u6b21\u5730\u5740\u4f9b\u7528\u6237\u4fee\u6539\u540e\u91cd\u8fde\uff0c\u4e0d\u5220\u9664\u5386\u53f2\u8bb0\u5f55\u3002
  const handleQuickConnectHistory = async (item: HistoryDevice) => {
    setQuickConnectingSerial(item.serialNo);
    clearHistoryError(item.serialNo);
    const res = await performWifiConnect(item.lastAddress.trim());
    setQuickConnectingSerial(null);
    if (res.success) {
      setInlineEditSerial(null);
      setInlineEditValue('');
    } else {
      setInlineEditSerial(item.serialNo);
      setInlineEditValue(item.lastAddress);
      setHistoryErrorBySerial(prev => ({
        ...prev,
        [item.serialNo]: res.errorMessage || '\u5feb\u901f\u8fde\u63a5\u5931\u8d25\uff0c\u8bbe\u5907 IP \u53ef\u80fd\u5df2\u53d8\uff0c\u8bf7\u4fee\u6539\u540e\u91cd\u8fde',
      }));
    }
  };

  // \u5c31\u5730\u8f93\u5165\u65b0 IP \u540e\u786e\u8ba4\u91cd\u8fde\uff1a\u6210\u529f\u7528\u65b0\u5730\u5740\u8986\u76d6\u5386\u53f2\uff08performWifiConnect \u5185\u5df2 upsert\uff09\uff0c
  // \u5931\u8d25\u4fdd\u7559\u8f93\u5165\u6846\u4e0e\u5386\u53f2\u8bb0\u5f55\uff0c\u4ec5\u66f4\u65b0\u5361\u7247\u5185\u5931\u8d25\u63d0\u793a\u3002
  const handleInlineReconnectHistory = async (item: HistoryDevice) => {
    const address = inlineEditValue.trim();
    if (!address) {
      setHistoryErrorBySerial(prev => ({ ...prev, [item.serialNo]: '\u8bf7\u8f93\u5165 IP:\u7aef\u53e3' }));
      return;
    }
    setQuickConnectingSerial(item.serialNo);
    clearHistoryError(item.serialNo);
    const res = await performWifiConnect(address);
    setQuickConnectingSerial(null);
    if (res.success) {
      setInlineEditSerial(null);
      setInlineEditValue('');
    } else {
      setHistoryErrorBySerial(prev => ({
        ...prev,
        [item.serialNo]: res.errorMessage || '\u91cd\u8fde\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 IP:\u7aef\u53e3',
      }));
    }
  };

  // \u79fb\u9664\u5386\u53f2\uff1a\u4ec5\u5220\u672c\u5730\u5386\u53f2\u8bb0\u5fc6\uff0c\u4e0d\u5f71\u54cd\u5f53\u524d\u5df2\u5efa\u7acb\u7684\u8fde\u63a5\u3002
  const handleRemoveHistory = (serialNo: string) => {
    setHistoryDevices(prev => {
      const next = removeHistoryDevice(prev, serialNo);
      saveHistoryDevices(next);
      return next;
    });
    setConfirmRemoveSerial(null);
    clearHistoryError(serialNo);
    if (inlineEditSerial === serialNo) {
      setInlineEditSerial(null);
      setInlineEditValue('');
    }
  };

  // 历史卡片在线状态为运行时态，不持久化：用当前已连接设备列表按 serialNo 实时匹配计算。
  const onlineHistorySerials = useMemo(() => {
    const set = new Set<string>();
    devices.forEach(device => {
      const serialNo = device.serialNo?.trim();
      if (serialNo && device.status === 'connected') set.add(serialNo);
    });
    return set;
  }, [devices]);

  // 历史列表只展示当前未连接的设备：已连接的设备上方实时设备卡已呈现，无需在历史里重复。
  // 连接中（尚未进入 devices 已连接态）仍保留在列表，展示「连接中…」；连上后从历史消失，断开/重启后回来。
  const offlineHistoryDevices = useMemo(
    () => historyDevices.filter(item => !onlineHistorySerials.has(item.serialNo)),
    [historyDevices, onlineHistorySerials]
  );

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
      // 抓取恒定按 all levels（*:V），不受日志等级下拉框限制——等级只做显示筛选（见 filteredLogs）。
      // 这样切换等级无需重新采集，也不会因选了高等级而漏抓低等级日志。
      const sourceLevel: LogEntry['level'] = 'V';
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

  // 开始/关闭采集单一开关：点开始 → startCaptureSession（主进程同启采样循环 + 持续分段录制）；
  // 点关闭 → stopCaptureSession（停采样停录制 + finalize），把 finalize 的会话留作报告渲染。
  const toggleCaptureSession = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    if (captureBusyDeviceIds.has(deviceId)) return;
    const isActive = Boolean(activeCaptureByDeviceId[deviceId]);
    setCaptureBusyDeviceIds((prev) => new Set(prev).add(deviceId));
    try {
      if (isActive) {
        const result = await window.electronAPI!.stopCaptureSession(deviceId);
        if (result.success && result.data) {
          const finalized = result.data;
          setActiveCaptureByDeviceId((prev) => {
            const next = { ...prev };
            delete next[deviceId];
            return next;
          });
          setReportSessionByDeviceId((prev) => ({ ...prev, [deviceId]: finalized }));
          setError('');
        } else {
          setError(result.error || '关闭采集失败');
        }
      } else {
        // 开始前清空上次缓冲、报告与提醒，避免新旧会话数据串味。
        setPerformanceSamplesByDeviceId((prev) => ({ ...prev, [deviceId]: [] }));
        setReportSessionByDeviceId((prev) => {
          const next = { ...prev };
          delete next[deviceId];
          return next;
        });
        setCaptureElapsedByDeviceId((prev) => ({ ...prev, [deviceId]: 0 }));
        setSoftLimitNoticeByDeviceId((prev) => {
          const next = { ...prev };
          delete next[deviceId];
          return next;
        });
        const result = await window.electronAPI!.startCaptureSession(deviceId);
        if (result.success && result.data) {
          const session = result.data;
          setActiveCaptureByDeviceId((prev) => ({ ...prev, [deviceId]: session }));
          setPerformanceSessionStartedAtByDeviceId((prev) => ({ ...prev, [deviceId]: new Date(session.startedAt) }));
          setError('');
        } else {
          setError(result.error || '开始采集失败');
        }
      }
    } catch (err) {
      setError((isActive ? '关闭采集失败：' : '开始采集失败：') + (err as Error).message);
    } finally {
      setCaptureBusyDeviceIds((prev) => {
        const next = new Set(prev);
        next.delete(deviceId);
        return next;
      });
    }
  };

  const dismissSoftLimit = (deviceId: string) =>
    setSoftLimitNoticeByDeviceId((prev) => {
      const next = { ...prev };
      delete next[deviceId];
      return next;
    });

  // 过滤标记持久化到会话（写 data/markers.json），失败给错误提示，不阻塞 UI。
  const saveCaptureMarkers = async (sessionId: string, markers: PerformanceCaptureMarker[]) => {
    if (!hasElectronAPI()) return;
    try {
      const result = await window.electronAPI!.saveCaptureMarkers(sessionId, markers);
      if (!result.success) setError(result.error || '保存过滤标记失败');
    } catch (err) {
      setError('保存过滤标记失败：' + (err as Error).message);
    }
  };

  const exportPerformanceSession = async () => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const samples = performanceSamplesByDeviceId[selectedDevice.id] || [];
    if (samples.length === 0) {
      setError('当前设备还没有性能采样数据，请先开始采集。');
      return;
    }

    const result = await window.electronAPI!.exportPerformanceSession({
      device: selectedDevice,
      startedAt: performanceSessionStartedAtByDeviceId[selectedDevice.id] || samples[0].capturedAt,
      endedAt: new Date(),
      samples,
    });

    if (result.success) {
      setError('');
    } else {
      setError(result.error || '导出性能采集报告失败');
    }
  };

  // 把一批宿主路径加入待安装列表：仅留 .apk、按路径去重。供「选择 APK」与拖拽共用。
  const addApkFilesByPath = (paths: string[]) => {
    setPendingApks((prev) => {
      const existing = new Set(prev.map((a) => a.path));
      const added = paths
        .filter((p) => p.toLowerCase().endsWith('.apk') && !existing.has(p))
        .map((p) => ({ path: p, fileName: p.split(/[\\/]/).pop() || p }));
      return [...prev, ...added];
    });
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
      addApkFilesByPath(result.data);
      setError('');
    } catch (err) {
      setError('选择安装包失败：' + (err as Error).message);
    }
  };

  // 拖拽 APK 到待安装区：Electron 28 的 drop File 仍带 .path（宿主绝对路径），直接取用。
  const handleApkDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsApkDragOver(false);
    if (isUnifiedInstalling) return;
    const files = Array.from(e.dataTransfer.files || []);
    const paths = files
      .map((f) => (f as File & { path?: string }).path || '')
      .filter(Boolean);
    const apks = paths.filter((p) => p.toLowerCase().endsWith('.apk'));
    if (apks.length === 0) {
      if (files.length > 0) setError('只能拖入 .apk 安装包');
      return;
    }
    addApkFilesByPath(apks);
    setError('');
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
  // 往安装日志追加一条（带本地时间戳，最新在最上面，最多留 200 条）。
  const appendInstallLog = (text: string, level: 'info' | 'success' | 'error' = 'info') => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const ts = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    setInstallLog((prev) => [{ text: `[${ts}] ${text}`, level }, ...prev].slice(0, 200));
  };

  const installItemsOnDevice = async (deviceId: string, items: ApkInstallQueueItem[]) => {
    const deviceLabel = (() => {
      const d = devices.find((x) => x.id === deviceId);
      return d ? getDeviceLabel(d) : deviceId;
    })();
    const installFlags = installAllowDowngrade ? '-r -d' : '-r';
    // 安装前快照本设备的包集合，用于装完后 diff 出新增的包标「NEW」（每台设备各自算，与当前选中无关）。
    const beforeRes = await window.electronAPI!.listInstalledPackages(deviceId).catch(() => null);
    const baseline = new Set(beforeRes && beforeRes.success && beforeRes.data ? beforeRes.data : []);
    for (const item of items) {
      const startedAt = Date.now();
      appendInstallLog(
        `${deviceLabel} ▶ 开始安装 ${item.fileName}\n    命令: adb install ${installFlags}\n    源文件: ${item.path}`
      );
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
        const failMsg = result.success ? undefined : formatOperationError(result, '安装失败');
        // 进度卡只存「一句话原因」（result.error 的标题，不含建议/adb 原文）；完整详情交给下方安装日志，避免两处重复。
        updateDeviceApkInstallState(deviceId, (previousState) => ({
          ...previousState,
          queue: previousState.queue.map((q) =>
            q.id === item.id
              ? { ...q, status: result.success ? 'success' : 'failed', progress: 100, output: undefined, error: result.success ? undefined : (result.error || '安装失败') }
              : q
          ),
        }));
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const indent = (text: string) => text.trim().split(/\r?\n/).filter(Boolean).map((l) => `    ${l}`).join('\n');
        if (result.success) {
          const out = (result.data?.output || '').trim();
          appendInstallLog(
            `${deviceLabel} ✓ ${item.fileName} 安装成功 · 耗时 ${elapsed}s` + (out ? `\n${indent(out)}` : ''),
            'success'
          );
        } else {
          const details = (result.details || '').trim();
          appendInstallLog(
            `${deviceLabel} ✗ ${item.fileName} 安装失败 · 耗时 ${elapsed}s\n    ${failMsg}` + (details ? `\n    ── adb 原始输出 ──\n${indent(details)}` : ''),
            'error'
          );
        }
      } catch (err) {
        stopApkInstallProgressTimer(item.id);
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        const msg = (err as Error).message;
        updateDeviceApkInstallState(deviceId, (previousState) => ({
          ...previousState,
          queue: previousState.queue.map((q) => (q.id === item.id ? { ...q, status: 'failed', progress: 100, error: msg } : q)),
        }));
        appendInstallLog(`${deviceLabel} ✗ ${item.fileName} 安装异常 · 耗时 ${elapsed}s\n    ${msg}`, 'error');
      }
    }
    updateDeviceApkInstallState(deviceId, (previousState) => ({ ...previousState, isInstalling: false }));
    // 装完再拉一次本设备包列表：diff 出新增的包记成该设备的「NEW」（累加，按设备存）；顺便刷新可见列表。
    const afterRes = await window.electronAPI!.listInstalledPackages(deviceId).catch(() => null);
    if (afterRes && afterRes.success && afterRes.data) {
      const after = afterRes.data;
      const newly = after.filter((p) => !baseline.has(p));
      if (newly.length > 0) {
        setNewlyInstalledByDevice((prev) => ({
          ...prev,
          [deviceId]: new Set([...(prev[deviceId] || []), ...newly]),
        }));
      }
      if (selectedDeviceRef.current?.id === deviceId) {
        setInstalledPackages(after);
      }
    }
  };

  // 统一安装：把待装 APK 入队到所选在线设备，按并发上限并行安装。
  const startUnifiedInstall = async () => {
    if (isUnifiedInstalling || !hasElectronAPI()) return;
    const targetIds = Array.from(installTargets).filter((id) => devices.find((d) => d.id === id)?.status === 'connected');
    if (pendingApks.length === 0 || targetIds.length === 0) return;

    appendInstallLog(`开始安装 ${pendingApks.length} 个 APK 到 ${targetIds.length} 台设备（并发 ${installConcurrency > 0 ? installConcurrency : '不限'}${installAllowDowngrade ? '，允许降级' : ''}）`);
    // 新批次：重置本次目标设备的「NEW」——只标最新这一批装上的（批次内含重试会继续累加）。
    setNewlyInstalledByDevice((prev) => {
      const next = { ...prev };
      targetIds.forEach((id) => { delete next[id]; });
      return next;
    });

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

  const handleStartMirror = async (params: { maxSize?: number; bitRate?: string; forwardAudio?: boolean }) => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    setError('');
    setMirrorStartingDeviceIds(prev => new Set(prev).add(deviceId));
    try {
      const result = await window.electronAPI!.startMirror(deviceId, {
        isPico: isLikelyPicoDevice(selectedDevice),
        maxSize: params.maxSize,
        bitRate: params.bitRate,
        forwardAudio: params.forwardAudio,
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

  // 点「立即更新」：手动开始下载新版本（autoDownload 已关，需显式触发）。
  const handleDownloadUpdate = async () => {
    if (!hasElectronAPI() || !window.electronAPI?.downloadUpdate) return;
    try {
      await window.electronAPI.downloadUpdate();
    } catch (err) {
      setError('下载更新失败：' + (err as Error).message);
    }
  };

  // 安装并重启：先显示全屏「正在安装」遮罩（留一帧给 UI 渲染），再触发静默安装+自动重启。
  const handleInstallUpdate = async () => {
    if (!hasElectronAPI()) return;
    setInstalling(true);
    window.setTimeout(() => {
      window.electronAPI!.quitAndInstallUpdate().catch((err) => {
        setInstalling(false);
        setError('安装更新失败：' + (err as Error).message);
      });
    }, 300);
  };

  // 投屏中实时切换音频去向（设备本机 / 电脑）。主进程返回更新后的会话，乐观更新本地状态。
  const handleToggleMirrorAudio = async (forward: boolean) => {
    if (!selectedDevice || !hasElectronAPI()) return;
    const deviceId = selectedDevice.id;
    try {
      const result = await window.electronAPI!.setMirrorAudio(deviceId, forward);
      if (result.success && result.data) {
        setMirrorSessionsByDeviceId(prev => ({ ...prev, [deviceId]: result.data! }));
      } else if (!result.success) {
        setError(result.error || '切换投屏声音失败');
      }
    } catch (err) {
      setError('切换投屏声音失败：' + (err as Error).message);
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

  // 拉取当前设备在运行的应用包名集合（带设备切换防过期）。失败静默，不打扰用户。
  const loadRunningPackages = async () => {
    if (!selectedDevice || !hasElectronAPI() || !window.electronAPI?.getRunningPackages) return;
    const targetDeviceId = selectedDevice.id;
    try {
      const result = await window.electronAPI.getRunningPackages(targetDeviceId);
      if (selectedDeviceRef.current?.id !== targetDeviceId) return; // 设备已切换，丢弃过期结果
      if (result.success && result.data) {
        setRunningPackages(new Set(result.data));
      }
    } catch {
      /* 运行态查询失败不影响主流程，忽略 */
    }
  };

  const handleLaunchApp = async (packageName: string) => {
    if (!selectedDevice || !hasElectronAPI() || busyPackage) return;
    if (runningPackages.has(packageName)) return; // 已在运行，禁止重复启动
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
      // 进程要一会儿才起来，稍后刷新运行态让「运行中」标识跟上
      window.setTimeout(() => { void loadRunningPackages(); }, 1200);
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
      window.setTimeout(() => { void loadRunningPackages(); }, 600); // 关闭后进程很快消失，稍后刷新运行态
    }
  };

  const handleUninstallApp = (packageName: string) => {
    const device = selectedDevice; // 捕获当前设备：确认期间若切换设备，仍卸载用户当时看到的那台
    if (!device || !hasElectronAPI() || busyPackage) return;
    requestConfirm({
      message: `确定卸载应用「${packageName}」？此操作不可撤销。`,
      confirmText: '卸载',
      danger: true,
      onConfirm: () => { void doUninstallApp(device, packageName); },
    });
  };

  const doUninstallApp = async (device: DeviceInfo, packageName: string) => {
    if (!hasElectronAPI()) return;
    setBusyPackage(packageName);
    setBusyAction('uninstall');
    try {
      setError('');
      const result = await window.electronAPI!.uninstallApp(device.id, packageName);
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
      setLastExportedLogPath(result.data || null);
    } else if (result.error !== '\u53d6\u6d88\u5bfc\u51fa') {
      setError(result.error || '\u65e5\u5fd7\u5bfc\u51fa\u5931\u8d25');
    }
  };

  // \u5bfc\u51fa\u5b8c\u6574\u539f\u59cb\u65e5\u5fd7\uff1a\u4ece\u76d1\u63a7\u7b2c\u4e00\u884c\u5230\u5f53\u524d\u7684\u5168\u91cf\uff08\u5168\u7b49\u7ea7\u3001\u4e0d\u53d7 2 \u4e07\u6761\u4e0a\u9650/\u7b5b\u9009\u5f71\u54cd\uff09\uff0c\u7531\u4e3b\u8fdb\u7a0b\u843d\u76d8\u6587\u4ef6\u53e6\u5b58\u3002
  const exportFullLogs = async () => {
    if (!hasElectronAPI() || !selectedDevice) return;
    const result = await window.electronAPI!.exportFullLogs(selectedDevice.id);
    if (result.success) {
      setError('');
      setLastExportedLogPath(result.data || null);
    } else if (result.error !== '\u53d6\u6d88\u5bfc\u51fa') {
      setError(result.error || '\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7\u5931\u8d25');
    }
  };

  // \u6309\u5f53\u524d\u5305\u540d\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7\uff1a\u4e0d\u91cd\u65b0\u91c7\u96c6\uff0c\u76f4\u63a5\u7528\u300c\u5e94\u7528/\u5305\u540d\u300d\u91cc\u586b\u7684\u8bcd\u5173\u8054\u8fc7\u6ee4\u6574\u4efd\u843d\u76d8\u6587\u4ef6\uff0c\u5207\u51fa\u4e00\u4efd\u5b8c\u6574\u5b50\u96c6\u3002
  const exportFullLogsByPackage = async () => {
    if (!hasElectronAPI() || !selectedDevice) return;
    const pkg = logPackageFilter.trim() || packageFilter.trim();
    if (!pkg) {
      setError('\u8bf7\u5148\u5728\u300c\u5e94\u7528/\u5305\u540d\u300d\u91cc\u586b\u5199\u8981\u5bfc\u51fa\u7684\u5305\u540d');
      return;
    }
    const result = await window.electronAPI!.exportFullLogsByPackage(selectedDevice.id, pkg);
    if (result.success) {
      setError('');
      setLastExportedLogPath(result.data || null);
    } else if (result.error !== '\u53d6\u6d88\u5bfc\u51fa') {
      setError(result.error || '\u6309\u5305\u540d\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7\u5931\u8d25');
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
  const isSelectedCapturing = Boolean(selectedDeviceId && activeCaptureByDeviceId[selectedDeviceId]);
  // 展示会话：采集中=活动会话，否则=最近一次报告会话（停止后留存）。
  const selectedCaptureSession = selectedDeviceId
    ? activeCaptureByDeviceId[selectedDeviceId] || reportSessionByDeviceId[selectedDeviceId] || null
    : null;
  const isSelectedCaptureBusy = Boolean(selectedDeviceId && captureBusyDeviceIds.has(selectedDeviceId));
  const selectedCaptureElapsed = selectedDeviceId ? captureElapsedByDeviceId[selectedDeviceId] || 0 : 0;
  const selectedSoftLimitNotice = selectedDeviceId ? softLimitNoticeByDeviceId[selectedDeviceId] || null : null;
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
    const hasInstallDetail = activeDeviceIds.length > 0 || installLog.length > 0;

    return (
      <section style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {/* 标题行：标题在左，并发数/降级收到右侧，省掉单独一行配置 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', flexShrink: 0 }}>
          <h2 style={{ fontSize: '18px', fontWeight: 600, margin: 0 }}>{'应用安装'}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#9ca3af' }}>并发数
              <select value={installConcurrency} disabled={isUnifiedInstalling} onChange={(e) => setInstallConcurrency(Number(e.target.value))} style={{ padding: '5px 8px', fontSize: '13px', color: '#e5e7eb', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>
                <option value={2}>2</option><option value={4}>4</option><option value={8}>8</option><option value={0}>不限</option>
              </select>
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', color: '#9ca3af', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer' }}>
              <input type="checkbox" checked={installAllowDowngrade} disabled={isUnifiedInstalling} onChange={(e) => setInstallAllowDowngrade(e.target.checked)} />允许降级覆盖
            </label>
          </div>
        </div>

        {/* 操作区（占比 3）：选 APK + 目标设备 + 安装按钮 */}
        <div style={{ flex: 3, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
        {/* 拖放区：无文件时图标提示，有文件时放 chip */}
        <div
          onClick={() => { if (!isUnifiedInstalling) selectApkFiles(); }}
          onDragOver={(e) => { e.preventDefault(); if (!isUnifiedInstalling) setIsApkDragOver(true); }}
          onDragEnter={(e) => { e.preventDefault(); if (!isUnifiedInstalling) setIsApkDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsApkDragOver(false); }}
          onDrop={handleApkDrop}
          style={{
            flex: 1,
            minHeight: '90px',
            display: 'flex',
            flexDirection: 'column',
            border: `1.5px dashed ${isApkDragOver ? '#4a90d9' : '#3a3a55'}`,
            backgroundColor: isApkDragOver ? '#2a3550' : '#1f1f3320',
            borderRadius: '10px',
            padding: pendingApks.length > 0 ? '12px 14px' : '16px',
            cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer',
            transition: 'background-color 120ms ease, border-color 120ms ease',
          }}
        >
          {pendingApks.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', minHeight: 0, overflowY: 'auto' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '12px', color: '#9ca3af' }}>{`已选 ${pendingApks.length} 个安装包`}</span>
                <span style={{ fontSize: '12px', color: '#60a5fa' }}>{'＋ 点击或拖拽继续添加'}</span>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                {pendingApks.map((a) => (
                  <span key={a.path} title={a.path} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 10px', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '999px', fontSize: '12px', color: '#e5e7eb' }}>
                    {a.fileName}
                    <button onClick={(e) => { e.stopPropagation(); removePendingApk(a.path); }} disabled={isUnifiedInstalling} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: isUnifiedInstalling ? 'not-allowed' : 'pointer', padding: 0, fontSize: '13px' }}>✕</button>
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: isApkDragOver ? '#93c5fd' : '#9ca3af', pointerEvents: 'none' }}>
              <span style={{ fontSize: '36px', lineHeight: 1, opacity: 0.85 }}>{'📦'}</span>
              <span style={{ fontSize: '14px', fontWeight: 500 }}>
                {isApkDragOver ? '松开以添加 APK' : '把 .apk 拖到这里，或点击选择'}
              </span>
              <span style={{ fontSize: '12px', color: '#6b7280' }}>{'支持多选'}</span>
            </div>
          )}
        </div>

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
                  <span style={{ fontSize: '13px', color: '#e5e7eb' }}>{getDeviceLabel(d)}</span>
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
        </div>

        {/* 安装详情（占比 7）：进度 + 错误 + 安装日志 */}
        <div style={{ flex: 7, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '8px', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <span style={{ fontSize: '14px', fontWeight: 600, color: '#cbd5e1' }}>{'安装详情'}</span>
            {installLog.length > 0 && (
              <button onClick={() => setInstallLog([])} style={{ fontSize: '12px', color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}>{'清空日志'}</button>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '10px', backgroundColor: '#1b1b2e', border: '1px solid #353550', borderRadius: '8px', padding: '10px' }}>
            {!hasInstallDetail && (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '13px' }}>{'安装进度、结果与日志会显示在这里'}</div>
            )}
        {activeDeviceIds.map((deviceId) => {
          const device = devices.find((d) => d.id === deviceId);
          const queue = apkInstallStates[deviceId]?.queue || [];
          const finished = queue.filter((it) => it.status === 'success' || it.status === 'failed').length;
          const hasFailed = queue.some((it) => it.status === 'failed');
          const hasSuccess = queue.some((it) => it.status === 'success');
          return (
            <div key={deviceId} style={{ border: '1px solid #353550', borderRadius: '8px', padding: '12px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{device ? getDeviceLabel(device) : deviceId}</span>
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
                    {item.error && (
                      <div style={{ marginTop: '6px', color: '#fca5a5', fontSize: '12px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.error}</div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}
            {installLog.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <span style={{ fontSize: '12px', color: '#9ca3af' }}>{'安装日志'}</span>
                <div style={{ fontFamily: 'Consolas, monospace', fontSize: '12px', lineHeight: 1.7, display: 'flex', flexDirection: 'column', gap: '2px' }}>
                  {installLog.map((l, i) => (
                    <div key={i} style={{ color: l.level === 'success' ? '#86efac' : l.level === 'error' ? '#fca5a5' : '#9ca3af', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{l.text}</div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
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

      // 应用/包名过滤为「关联匹配」：跨 message+tag+包名+PID 命中即保留，与主进程抓取口径一致，
      // 这样系统服务/其它进程里提到该应用的日志也能显示，而不是只剩应用自身进程那几行。
      if (packageFilter) {
        const packageHaystack = `${log.message} ${log.tag} ${log.packageName || ''} ${log.processId}`.toLowerCase();
        if (!packageHaystack.includes(packageFilter)) {
          return false;
        }
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

  // 变高虚拟滚动：每条日志高度按行数变化，需先把当前可见列表物化成数组以便算累计偏移。
  const activeLogList = useMemo<LogEntry[]>(
    () => (hasActiveLogFilter ? filteredLogs : currentLogState?.store.toArray() ?? []),
    [logVersion, hasActiveLogFilter, filteredLogs, currentLogState]
  );
  const displayedLogCount = activeLogList.length;
  // 前缀和：logRowOffsets[i] = 第 i 条之前所有行的累计高度（即第 i 条的 top）；末项为总高度。
  const logRowOffsets = useMemo<number[]>(() => {
    const offsets = new Array<number>(activeLogList.length + 1);
    offsets[0] = 0;
    for (let i = 0; i < activeLogList.length; i++) {
      offsets[i + 1] = offsets[i] + getLogRowHeight(activeLogList[i]);
    }
    return offsets;
  }, [activeLogList]);
  const totalLogHeight = logRowOffsets[logRowOffsets.length - 1] || 0;
  // 二分查找：返回最大的 i 使 logRowOffsets[i] <= y（即落在偏移 y 处的那一条）。
  const findLogRowIndexAtOffset = (y: number): number => {
    let lo = 0;
    let hi = displayedLogCount;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (logRowOffsets[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const visibleStartIndex = Math.max(0, findLogRowIndexAtOffset(logViewport.scrollTop) - LOG_OVERSCAN_ROWS);
  const visibleEndIndex = Math.min(
    displayedLogCount,
    findLogRowIndexAtOffset(logViewport.scrollTop + logViewport.height) + 1 + LOG_OVERSCAN_ROWS
  );
  const visibleLogs = useMemo(() => {
    const rows: Array<{ log: LogEntry; index: number }> = [];
    for (let index = visibleStartIndex; index < visibleEndIndex; index++) {
      const log = activeLogList[index];
      if (log) {
        rows.push({ log, index });
      }
    }
    return rows;
  }, [activeLogList, visibleStartIndex, visibleEndIndex]);
  const virtualTopPadding = logRowOffsets[visibleStartIndex] || 0;
  const virtualBottomPadding = Math.max(0, totalLogHeight - (logRowOffsets[visibleEndIndex] ?? totalLogHeight));

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
        <button onClick={exportVisibleLogs} title={'导出当前可见 / 筛选后的日志（受等级、搜索与显示上限影响）'} style={{ padding: '8px 12px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>{'\u5bfc\u51fa'}</button>
        <button onClick={exportFullLogs} title={'从监控第一行到当前的完整原始日志（全等级，不受 2 万条上限与筛选影响）'} style={{ padding: '8px 12px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>{'\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7'}</button>
        <button onClick={exportFullLogsByPackage} title={'\u5728\u5b8c\u6574\u539f\u59cb\u65e5\u5fd7\u4e0a\uff0c\u7528\u300c\u5e94\u7528/\u5305\u540d\u300d\u91cc\u586b\u7684\u5305\u540d\u5173\u8054\u8fc7\u6ee4\uff0c\u5207\u51fa\u4e00\u4efd\u5b8c\u6574\u5b50\u96c6\uff08\u591a\u884c\u5806\u6808\u6574\u6761\u4fdd\u7559\uff0c\u4e0d\u91cd\u65b0\u91c7\u96c6\uff09'} style={{ padding: '8px 12px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}>{'\u6309\u5305\u540d\u5bfc\u51fa\u5b8c\u6574\u65e5\u5fd7'}</button>
        {lastExportedLogPath && (
          <button
            onClick={async () => {
              if (!hasElectronAPI() || !lastExportedLogPath) return;
              const r = await window.electronAPI!.showItemInFolder(lastExportedLogPath);
              if (!r.success && r.error) setError(r.error);
            }}
            title={`\u6253\u5f00\u6700\u8fd1\u5bfc\u51fa\u7684\u65e5\u5fd7\u6240\u5728\u6587\u4ef6\u5939\uff1a${lastExportedLogPath}`}
            style={{ padding: '8px 12px', backgroundColor: '#166534', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer' }}
          >{'\ud83d\udcc2 \u6253\u5f00\u4f4d\u7f6e'}</button>
        )}
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
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            placeholder={useRegexSearch ? '\u6b63\u5219\u641c\u7d22' : '\u641c\u7d22\u65e5\u5fd7'}
            value={searchTerm}
            // 每次输入变化都重新弹出并刷新匹配的历史（visibleSearchHistory 按输入联想过滤，无匹配则自动隐藏）。
            onChange={(e) => { setSearchTerm(e.target.value); setShowSearchHistory(true); }}
            onFocus={() => setShowSearchHistory(true)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { recordSearchHistory(searchTerm); setShowSearchHistory(false); }
              else if (e.key === 'Escape') setShowSearchHistory(false);
            }}
            // \u8bb0\u5f55\u5173\u952e\u5b57\u5e76\u5ef6\u8fdf\u6536\u8d77\uff0c\u7559\u51fa\u65f6\u95f4\u8ba9\u4e0b\u62c9\u9879\u7684 mousedown \u5148\u89e6\u53d1\u9009\u62e9\u3002
            onBlur={() => { recordSearchHistory(searchTerm); window.setTimeout(() => setShowSearchHistory(false), 150); }}
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', backgroundColor: '#252540', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }}
          />
          {showSearchHistory && visibleSearchHistory.length > 0 && (
            <div style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0, zIndex: 30, maxHeight: '260px', overflowY: 'auto', backgroundColor: '#252540', border: '1px solid #454560', borderRadius: '6px', boxShadow: '0 8px 24px rgba(0,0,0,0.45)' }}>
              {visibleSearchHistory.map((keyword) => (
                <div
                  key={keyword}
                  // \u7528 onMouseDown + preventDefault\uff1a\u5728 input \u5931\u7126\u524d\u5b8c\u6210\u9009\u62e9\uff0c\u907f\u514d\u4e0b\u62c9\u5148\u88ab\u5173\u6389\u3002
                  onMouseDown={(e) => { e.preventDefault(); setSearchTerm(keyword); recordSearchHistory(keyword); setShowSearchHistory(false); }}
                  onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#33335a'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = 'transparent'; }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '7px 10px', cursor: 'pointer', color: '#e5e7eb', fontSize: '13px' }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{keyword}</span>
                  <span
                    onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); removeOneSearchHistory(keyword); }}
                    title={'\u4ece\u5386\u53f2\u79fb\u9664'}
                    style={{ flexShrink: 0, color: '#9ca3af', cursor: 'pointer', padding: '0 4px', fontSize: '14px', lineHeight: 1 }}
                  >{'\u00d7'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
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
          // width:max-content + minWidth:100% 让内容随最长日志行增宽，超出容器时出现横向滚动条；行与表头同宽对齐。
          <div style={{ minHeight: totalLogHeight, width: 'max-content', minWidth: '100%' }}>
            <div style={{ position: 'sticky', top: 0, zIndex: 1, width: '100%', display: 'grid', gridTemplateColumns: '96px 64px 70px 130px 140px minmax(280px, max-content)', backgroundColor: '#1f2937', color: '#9ca3af', fontWeight: 700 }}>
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
                  gridTemplateColumns: '96px 64px 70px 130px 140px minmax(280px, max-content)',
                  width: '100%',
                  height: `${getLogRowHeight(log)}px`,
                  lineHeight: `${LOG_LINE_HEIGHT}px`,
                  padding: '4px 0',
                  boxSizing: 'border-box',
                  alignItems: 'start',
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
                {/* 整条铺开多行：white-space:pre 保留换行、每个逻辑行不自动换行（高度=行数×LOG_LINE_HEIGHT 可预测）。
                    不裁切，过长单行靠日志窗口横向滚动条拖动查看；完整内容也可点开看底部详情面板。 */}
                <div style={{ padding: '0 8px', color: '#e5e7eb', whiteSpace: 'pre' }}>{log.message}</div>
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
      {/* 全局深色滚动条：index.css 未被入口引入，这里就地注入，和工具深色主题统一。
          仅用 webkit 规则——Electron 是 Chromium 内核，加 scrollbar-width 反而会接管并禁用自定义样式。 */}
      <style>{`
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #3a3a55; border-radius: 8px; border: 2px solid transparent; background-clip: content-box; }
        ::-webkit-scrollbar-thumb:hover { background: #50506e; background-clip: content-box; }
        ::-webkit-scrollbar-corner { background: transparent; }
      `}</style>
      {!appReady && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 3000, backgroundColor: '#1a1a2e', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '320px', textAlign: 'center' }}>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff', marginBottom: '6px' }}>{'安卓设备监控'}</div>
            <div style={{ fontSize: '13px', color: '#9ca3af', marginBottom: '16px' }}>{'工具启动中，请稍候…'}</div>
            <div style={{ height: '6px', backgroundColor: '#252540', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '40%', backgroundColor: '#4a90d9', borderRadius: '3px', animation: 'admIndeterminate 1.1s ease-in-out infinite' }} />
            </div>
          </div>
          <style>{'@keyframes admIndeterminate{0%{margin-left:-40%}100%{margin-left:100%}}'}</style>
        </div>
      )}
      {installing && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 2000, backgroundColor: 'rgba(10,10,20,0.88)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: '360px', textAlign: 'center', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '12px', padding: '28px 24px' }}>
            <div style={{ fontSize: '15px', fontWeight: 700, color: '#fff', marginBottom: '10px' }}>
              {`正在安装新版本${updateStatus?.version ? ` v${updateStatus.version}` : ''}…`}
            </div>
            <div style={{ fontSize: '13px', color: '#cbd5e1', lineHeight: 1.7 }}>
              {'工具会自动退出、安装到当前目录，'}<br />{'安装完成后自动重启，请稍候…'}
            </div>
            <div style={{ marginTop: '16px', height: '6px', backgroundColor: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: '40%', backgroundColor: '#4a90d9', borderRadius: '3px', animation: 'admIndeterminate 1.1s ease-in-out infinite' }} />
            </div>
          </div>
          <style>{'@keyframes admIndeterminate{0%{margin-left:-40%}100%{margin-left:100%}}'}</style>
        </div>
      )}
      {updateStatus && !updateDismissed && ['available', 'downloading', 'downloaded'].includes(updateStatus.state) && (
        <div style={{ position: 'fixed', right: '16px', bottom: '16px', zIndex: 1100, width: '440px', maxWidth: 'calc(100vw - 32px)', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '10px', padding: '16px 18px', boxShadow: '0 6px 20px rgba(0,0,0,0.45)' }}>
          {updateStatus.state === 'available' && (
            <div>
              <div style={{ fontSize: '13px', color: '#cbd5e1', fontWeight: 600, marginBottom: '8px' }}>{`发现新版本${updateStatus.version ? ` v${updateStatus.version}` : ''}`}</div>
              {updateStatus.releaseNotes && (
                <div style={{ marginBottom: '10px', maxHeight: '300px', overflowY: 'auto', fontSize: '13px', lineHeight: 1.6, color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', padding: '10px 12px' }}>
                  <div style={{ color: '#9ca3af', marginBottom: '4px' }}>{'本次更新说明'}</div>
                  {updateStatus.releaseNotes}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setUpdateDismissed(true)} style={{ padding: '5px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid #4b5563', backgroundColor: 'transparent', color: '#d1d5db', cursor: 'pointer' }}>{'稍后'}</button>
                <button onClick={handleDownloadUpdate} style={{ padding: '5px 12px', fontSize: '12px', borderRadius: '6px', border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: 'pointer' }}>{'立即更新'}</button>
              </div>
            </div>
          )}
          {updateStatus.state === 'downloading' && (
            <div>
              <div style={{ fontSize: '13px', color: '#cbd5e1', marginBottom: '6px' }}>{`正在下载新版本${updateStatus.version ? ` v${updateStatus.version}` : ''} … ${updateStatus.percent ?? 0}%`}</div>
              <div style={{ height: '6px', backgroundColor: '#334155', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${updateStatus.percent ?? 0}%`, backgroundColor: '#4a90d9', transition: 'width 240ms ease' }} />
              </div>
            </div>
          )}
          {updateStatus.state === 'downloaded' && (
            <div>
              <div style={{ fontSize: '13px', color: '#86efac', fontWeight: 600, marginBottom: '8px' }}>{`新版本${updateStatus.version ? ` v${updateStatus.version}` : ''} 已就绪`}</div>
              {updateStatus.releaseNotes && (
                <div style={{ marginBottom: '10px', maxHeight: '300px', overflowY: 'auto', fontSize: '13px', lineHeight: 1.6, color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', backgroundColor: '#1f1f33', border: '1px solid #353550', borderRadius: '6px', padding: '10px 12px' }}>
                  <div style={{ color: '#9ca3af', marginBottom: '4px' }}>{'本次更新说明'}</div>
                  {updateStatus.releaseNotes}
                </div>
              )}
              <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
                <button onClick={() => setUpdateDismissed(true)} style={{ padding: '5px 12px', fontSize: '12px', borderRadius: '6px', border: '1px solid #4b5563', backgroundColor: 'transparent', color: '#d1d5db', cursor: 'pointer' }}>{'稍后'}</button>
                <button onClick={handleInstallUpdate} style={{ padding: '5px 12px', fontSize: '12px', borderRadius: '6px', border: 'none', backgroundColor: '#16a34a', color: '#fff', cursor: 'pointer' }}>{'立即安装并重启'}</button>
              </div>
            </div>
          )}
          {updateStatus.state === 'error' && (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px' }}>
              <span style={{ flex: 1, fontSize: '12px', color: '#fca5a5', wordBreak: 'break-all' }}>{`检查更新失败：${updateStatus.error ?? ''}`}</span>
              <button onClick={() => setUpdateDismissed(true)} style={{ flexShrink: 0, padding: '2px 8px', fontSize: '12px', borderRadius: '4px', border: '1px solid #4b5563', backgroundColor: 'transparent', color: '#d1d5db', cursor: 'pointer' }}>{'知道了'}</button>
            </div>
          )}
        </div>
      )}
      <header style={{ height: '56px', backgroundColor: '#252540', borderBottom: '1px solid #353550', display: 'flex', alignItems: 'center', padding: '0 16px', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px' }}>
          <h1 style={{ fontSize: '18px', fontWeight: '600', margin: 0 }}>{'\u5b89\u5353\u8bbe\u5907\u76d1\u63a7'}</h1>
          {appVersion && (
            <button
              onClick={openReleaseNotes}
              title={'\u67e5\u770b\u672c\u7248\u672c\u66f4\u65b0\u65e5\u5fd7'}
              style={{ fontSize: '12px', color: '#93c5fd', background: 'none', border: 'none', cursor: 'pointer', padding: 0, textDecoration: 'underline dotted' }}
            >v{appVersion}</button>
          )}
          <button
            onClick={handleCheckUpdate}
            disabled={checkResult === '\u68c0\u67e5\u4e2d\u2026'}
            title={'\u5411\u66f4\u65b0\u670d\u52a1\u5668\u68c0\u67e5\u662f\u5426\u6709\u65b0\u7248\u672c'}
            style={{ fontSize: '12px', color: '#cbd5e1', background: 'none', border: '1px solid #454560', borderRadius: '6px', cursor: checkResult === '\u68c0\u67e5\u4e2d\u2026' ? 'not-allowed' : 'pointer', padding: '2px 8px', opacity: checkResult === '\u68c0\u67e5\u4e2d\u2026' ? 0.6 : 1 }}
          >{'\u68c0\u67e5\u66f4\u65b0'}</button>
          {/* \u542f\u52a8\u65f6\u9759\u9ed8\u68c0\u67e5\u5230\u65b0\u7248 \u2192 \u5728\u6309\u94ae\u65c1\u5e38\u9a7b\u9192\u76ee\u63d0\u793a\uff08\u4e0d\u81ea\u52a8\u66f4\u65b0\uff0c\u7531\u7528\u6237\u70b9\u66f4\u65b0\uff09 */}
          {updateStatus?.state === 'available' && (
            <button
              onClick={() => setUpdateDismissed(false)}
              title={'\u70b9\u67e5\u770b\u5e76\u66f4\u65b0'}
              style={{ fontSize: '12px', fontWeight: 700, color: '#fff', backgroundColor: '#dc2626', border: 'none', borderRadius: '6px', cursor: 'pointer', padding: '2px 8px' }}
            >{`\u6709\u65b0\u7248\u672c${updateStatus.version ? ` v${updateStatus.version}` : ''}`}</button>
          )}
          {updateStatus?.state === 'downloaded' && (
            <button
              onClick={() => setUpdateDismissed(false)}
              title={'\u70b9\u7acb\u5373\u5b89\u88c5\u5e76\u91cd\u542f'}
              style={{ fontSize: '12px', fontWeight: 700, color: '#fff', backgroundColor: '#16a34a', border: 'none', borderRadius: '6px', cursor: 'pointer', padding: '2px 8px' }}
            >{'\u65b0\u7248\u5df2\u5c31\u7eea'}</button>
          )}
          {checkResult && updateStatus?.state !== 'available' && updateStatus?.state !== 'downloaded' && (
            <span style={{ fontSize: '12px', color: '#9ca3af' }}>{checkResult}</span>
          )}
        </div>
      </header>
      {showReleaseNotes && (
        <div onClick={() => setShowReleaseNotes(false)} style={{ position: 'fixed', inset: 0, zIndex: 1200, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: '460px', maxHeight: '70vh', display: 'flex', flexDirection: 'column', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '12px', padding: '18px 20px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
              <h2 style={{ fontSize: '15px', fontWeight: 700, margin: 0 }}>{'\u66f4\u65b0\u65e5\u5fd7'} {appVersion ? `v${appVersion}` : ''}</h2>
              <button onClick={() => setShowReleaseNotes(false)} style={{ background: 'none', border: 'none', color: '#9ca3af', cursor: 'pointer', fontSize: '18px', lineHeight: 1 }}>{'\u00d7'}</button>
            </div>
            <div style={{ overflowY: 'auto', fontSize: '13px', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6 }}>
              {releaseNotesText.trim() ? releaseNotesText : '\u6682\u65e0\u672c\u7248\u672c\u66f4\u65b0\u8bf4\u660e\u3002'}
            </div>
          </div>
        </div>
      )}
      
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* 侧栏用 flex 列 + 各区块 order 控制顺序：ADB状态(0) → WiFi连接(1) → 设备列表(2) → 设备信息(3) → 历史设备(4)。
            用 order 而非物理调整 JSX 顺序，避免大段含中文的块搬运出错；ADB 状态保持默认 order 0 居首。 */}
        <aside style={{ width: '288px', backgroundColor: '#252540', borderRight: '1px solid #353550', padding: '16px', overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
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

          <div style={{ order: 2 }}>
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
                    <span style={{ fontWeight: '500', fontSize: '14px' }}>{getDeviceLabel(device)}</span>
                    </div>
                    <span style={{ padding: '2px 8px', borderRadius: '999px', fontSize: '11px', backgroundColor: statusMeta.background, color: statusMeta.color, flexShrink: 0 }}>
                      {statusMeta.label}
                    </span>
                  </div>
                  <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '2px' }}>
                    {'SN'}: {device.serialNo || '--'}
                  </div>
                  {device.connectionType === 'wifi' && (
                    <div style={{ fontSize: '12px', color: '#aaa' }}>{device.id}</div>
                  )}
                  <div style={{ marginTop: '6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', minWidth: 0 }}>
                      {renderBatteryBadge(device)}
                      {renderScreenStateBadge(device)}
                    </div>
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
                      onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);handleSleepDevice(device); }}
                      disabled={Boolean(busyDeviceAction)}
                      style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#d1d5db', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                    >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'sleep' ? '息屏中…' : '息屏'}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);handleWakeDevice(device); }}
                      disabled={Boolean(busyDeviceAction)}
                      style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#86efac', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                    >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'wake' ? '唤醒中…' : '唤醒'}</button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);handleUnlockDevice(device); }}
                      disabled={Boolean(busyDeviceAction)}
                      title="唤醒并上滑解锁；有 PIN/密码/手势的设备请在设备上手动输入"
                      style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#93c5fd', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                    >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'unlock' ? '解锁中…' : '解锁'}</button>
                    {confirmRebootId === device.id ? (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmRebootId(null); handleRebootDevice(device); }}
                          style={{ padding: '4px 8px', backgroundColor: '#ef4444', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px' }}
                        >确认重启</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmRebootId(null); }}
                          style={{ padding: '4px 8px', backgroundColor: '#475569', border: 'none', borderRadius: '4px', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px' }}
                        >取消</button>
                      </>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmDisconnectId(null); setConfirmRebootId(device.id); }}
                        disabled={Boolean(busyDeviceAction)}
                        style={{ padding: '4px 8px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#fca5a5', cursor: busyDeviceAction ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: busyDeviceAction ? 0.6 : 1 }}
                      >{busyDeviceAction?.id === device.id && busyDeviceAction.action === 'reboot' ? '重启中…' : '重启'}</button>
                    )}
                    {confirmDisconnectId === device.id ? (
                      <>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmDisconnectId(null); disconnectDevice(device); }}
                          style={{ padding: '4px 8px', backgroundColor: '#ef4444', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px' }}
                        >确认断开</button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmDisconnectId(null); }}
                          style={{ padding: '4px 8px', backgroundColor: '#475569', border: 'none', borderRadius: '4px', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px' }}
                        >取消</button>
                      </>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setConfirmRebootId(null); setConfirmDisconnectId(device.id); }}
                        style={{ padding: '4px 8px', backgroundColor: '#555', border: 'none', borderRadius: '4px', color: '#ff6b6b', cursor: 'pointer', fontSize: '12px' }}
                      >断开设备</button>
                    )}
                  </div>
                  <div style={{ marginTop: '6px' }}>
                    <button
                      onClick={(e) => { e.stopPropagation(); setSelectedDevice(device);setFileBrowserDevice(device); }}
                      title="浏览设备文件、下载到电脑、上传文件到设备"
                      style={{ width: '100%', padding: '6px 8px', backgroundColor: '#2a3550', border: '1px solid #3b4a6b', borderRadius: '4px', color: '#fcd34d', cursor: 'pointer', fontSize: '12px' }}
                    >📁 文件管理</button>
                  </div>
                </div>
              )})}
            </div>
          )}
          </div>

          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #353550', order: 1 }}>
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
                    style={{ flex: 1, minWidth: 0, padding: '8px 10px', backgroundColor: '#353550', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '13px', outline: 'none' }}
                  />
                  <button
                    onClick={pairWiFiDevice}
                    disabled={pairing}
                    style={{ flexShrink: 0, whiteSpace: 'nowrap', padding: '0 16px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: 'white', cursor: pairing ? 'not-allowed' : 'pointer', fontSize: '13px', opacity: pairing ? 0.6 : 1 }}
                  >{pairing ? '\u914d\u5bf9\u4e2d\u2026' : '\u914d\u5bf9'}</button>
                </div>
              </div>
            )}
          </div>

          <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #353550', order: 4 }}>
            <h2 style={{ fontSize: '14px', fontWeight: '500', color: '#888', margin: '0 0 12px 0' }}>{'\u5386\u53f2\u8bbe\u5907'}</h2>
            {offlineHistoryDevices.length === 0 ? (
              <div style={{ fontSize: '12px', color: '#6b7280', lineHeight: 1.6 }}>
                {historyDevices.length === 0
                  ? '\u6682\u65e0\u5386\u53f2 WiFi \u8bbe\u5907\uff0c\u6210\u529f\u8fde\u63a5\u4e00\u6b21\u540e\u4f1a\u81ea\u52a8\u51fa\u73b0\u5728\u8fd9\u91cc\uff0c\u4e0b\u6b21\u53ef\u4e00\u952e\u5feb\u901f\u91cd\u8fde\u3002'
                  : '\u5386\u53f2 WiFi \u8bbe\u5907\u5df2\u5168\u90e8\u8fde\u63a5\uff0c\u65ad\u5f00\u6216\u91cd\u542f\u540e\u4f1a\u56de\u5230\u8fd9\u91cc\u3002'}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {offlineHistoryDevices.map(item => {
                  const connecting = quickConnectingSerial === item.serialNo;
                  const editing = inlineEditSerial === item.serialNo;
                  const cardError = historyErrorBySerial[item.serialNo];
                  // 卡片标题用设备显示名，不用型号：优先当前自定义名（按上次地址匹配，重命名即时生效），
                  // 回退写入时存的显示名，再回退型号。
                  const displayName = customDeviceNames[item.lastAddress]?.trim() || item.name || item.model;
                  return (
                    <div key={item.serialNo} style={{ padding: '10px', backgroundColor: '#2a2a40', borderRadius: '8px', border: '1px solid #353550' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                        <span style={{ color: '#fff', fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={displayName}>{displayName}</span>
                        <span style={{ flexShrink: 0, fontSize: '11px', color: '#9ca3af', backgroundColor: '#9ca3af22', padding: '2px 8px', borderRadius: '10px' }}>{'\u672a\u8fde\u63a5'}</span>
                      </div>
                      <div style={{ marginTop: '6px', fontSize: '11px', color: '#9ca3af', lineHeight: 1.7 }}>
                        <div style={{ wordBreak: 'break-all' }}>{'SN\uff1a'}{item.serialNo}</div>
                        <div>{'\u4e0a\u6b21\u5730\u5740\uff1a'}{item.lastAddress}</div>
                        <div>{'\u4e0a\u6b21\u8fde\u63a5\uff1a'}{formatHistoryTime(item.lastConnectedAt)}</div>
                      </div>
                      {editing && (
                        <div style={{ marginTop: '8px', display: 'flex', gap: '6px' }}>
                          <input
                            type="text"
                            placeholder={'\u8bbe\u5907 IP \u5730\u5740:\u7aef\u53e3'}
                            value={inlineEditValue}
                            onChange={(e) => setInlineEditValue(e.target.value)}
                            onKeyPress={(e) => { if (e.key === 'Enter' && !connecting) { handleInlineReconnectHistory(item); } }}
                            style={{ flex: 1, minWidth: 0, padding: '6px 8px', backgroundColor: '#353550', border: '1px solid #454560', borderRadius: '6px', color: 'white', fontSize: '12px', outline: 'none' }}
                          />
                          <button
                            onClick={() => handleInlineReconnectHistory(item)}
                            disabled={connecting}
                            style={{ flexShrink: 0, whiteSpace: 'nowrap', padding: '0 12px', backgroundColor: '#4a90d9', border: 'none', borderRadius: '6px', color: 'white', cursor: connecting ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: connecting ? 0.6 : 1 }}
                          >{connecting ? '\u8fde\u63a5\u4e2d\u2026' : '\u91cd\u8fde'}</button>
                        </div>
                      )}
                      {cardError && (
                        <div style={{ marginTop: '6px', fontSize: '11px', color: '#fca5a5', lineHeight: 1.5 }}>{cardError}</div>
                      )}
                      <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        {!editing && (
                          <button
                            onClick={() => handleQuickConnectHistory(item)}
                            disabled={connecting}
                            title={'\u4f7f\u7528\u4e0a\u6b21\u7684 IP:\u7aef\u53e3\u5feb\u901f\u8fde\u63a5'}
                            style={{ padding: '4px 10px', backgroundColor: '#2f6fb0', border: 'none', borderRadius: '4px', color: '#fff', cursor: connecting ? 'not-allowed' : 'pointer', fontSize: '12px', opacity: connecting ? 0.6 : 1 }}
                          >{connecting ? '\u8fde\u63a5\u4e2d\u2026' : '\u5feb\u901f\u8fde\u63a5'}</button>
                        )}
                        {editing && (
                          <button
                            onClick={() => { setInlineEditSerial(null); setInlineEditValue(''); clearHistoryError(item.serialNo); }}
                            style={{ padding: '4px 10px', backgroundColor: '#475569', border: 'none', borderRadius: '4px', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px' }}
                          >{'\u6536\u8d77'}</button>
                        )}
                        {confirmRemoveSerial === item.serialNo ? (
                          <>
                            <button
                              onClick={() => handleRemoveHistory(item.serialNo)}
                              style={{ padding: '4px 10px', backgroundColor: '#ef4444', border: 'none', borderRadius: '4px', color: '#fff', cursor: 'pointer', fontSize: '12px' }}
                            >{'\u786e\u8ba4\u79fb\u9664'}</button>
                            <button
                              onClick={() => setConfirmRemoveSerial(null)}
                              style={{ padding: '4px 10px', backgroundColor: '#475569', border: 'none', borderRadius: '4px', color: '#e2e8f0', cursor: 'pointer', fontSize: '12px' }}
                            >{'\u53d6\u6d88'}</button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmRemoveSerial(item.serialNo)}
                            title={'\u4ece\u5386\u53f2\u5217\u8868\u79fb\u9664\u8be5\u8bbe\u5907\uff08\u4e0d\u5f71\u54cd\u5f53\u524d\u5df2\u5efa\u7acb\u7684\u8fde\u63a5\uff09'}
                            style={{ padding: '4px 10px', backgroundColor: '#353550', border: 'none', borderRadius: '4px', color: '#fca5a5', cursor: 'pointer', fontSize: '12px' }}
                          >{'\u79fb\u9664'}</button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {selectedDevice && (
            <div style={{ marginTop: '16px', paddingTop: '16px', borderTop: '1px solid #353550', order: 3 }}>
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
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px', gap: '12px' }}>
                  <span style={{ flexShrink: 0 }}>{'\u8bbe\u5907\u5e8f\u5217\u53f7'}</span>
                  <span style={{ color: '#fff', wordBreak: 'break-all', textAlign: 'right' }}>{selectedDevice.serialNo || '--'}</span>
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
                  <div style={{ display: 'flex', flexDirection: 'row', gap: '16px', height: '100%', alignItems: 'stretch' }}>
                    {/* 应用安装：放右侧（order 2），内部分操作区 + 安装详情两段 */}
                    <div style={{ order: 2, flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                      {renderUnifiedInstallPanel()}
                    </div>

                  {/* 已安装应用：放左侧（order 1），占更宽，列表内部滚动 */}
                  <div style={{ order: 1, flex: '1.4 1 0', minWidth: 0, display: 'flex', flexDirection: 'column', backgroundColor: '#252540', borderRadius: '8px', padding: '16px', overflow: 'hidden' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px', gap: '12px', flexShrink: 0 }}>
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
                      const matched = keyword ? installedPackages.filter(pkg => pkg.toLowerCase().includes(keyword)) : installedPackages;
                      // 当前选中设备的「NEW」集合（按设备存，切设备不丢）。新装的包浮到列表顶部，稳定排序保留原顺序。
                      const deviceNew = newlyInstalledByDevice[selectedDevice?.id || ''] || EMPTY_PACKAGE_SET;
                      const filtered = deviceNew.size > 0
                        ? [...matched].sort((a, b) => (deviceNew.has(b) ? 1 : 0) - (deviceNew.has(a) ? 1 : 0))
                        : matched;
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
                        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {filtered.map(pkg => (
                            <div
                              key={pkg}
                              style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: '#1f1f33', borderRadius: '6px', gap: '12px' }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                                <span style={{ fontSize: '13px', color: '#e5e7eb', fontFamily: 'monospace', wordBreak: 'break-all' }}>{pkg}</span>
                                {deviceNew.has(pkg) && (
                                  <span title={'本次新安装'} style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', padding: '2px 7px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.5px', color: '#7dd3fc', backgroundColor: '#0ea5e91f', border: '1px solid #38bdf855', borderRadius: '999px' }}>{'NEW'}</span>
                                )}
                                {runningPackages.has(pkg) && (
                                  <span title={'应用正在运行'} style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: '4px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, color: '#86efac', backgroundColor: '#22c55e1f', border: '1px solid #22c55e55', borderRadius: '999px' }}>
                                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: '#22c55e', boxShadow: '0 0 4px #22c55e' }} />{'运行中'}
                                  </span>
                                )}
                              </div>
                              {(() => {
                                const isBusy = busyPackage === pkg;
                                const isRunning = runningPackages.has(pkg);
                                const busyStyle = (base: React.CSSProperties): React.CSSProperties => ({
                                  ...base,
                                  cursor: isBusy ? 'not-allowed' : 'pointer',
                                  opacity: isBusy ? 0.5 : 1,
                                });
                                return (
                                  <div style={{ flexShrink: 0, display: 'flex', gap: '6px' }}>
                                    <button
                                      onClick={() => handleLaunchApp(pkg)}
                                      disabled={isBusy || isRunning}
                                      title={isRunning ? '应用已在运行，无需重复启动' : undefined}
                                      style={{ padding: '5px 12px', fontSize: '12px', color: '#86efac', backgroundColor: '#22c55e22', border: '1px solid #22c55e55', borderRadius: '6px', cursor: (isBusy || isRunning) ? 'not-allowed' : 'pointer', opacity: (isBusy || isRunning) ? 0.4 : 1 }}
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
                    captureSession={selectedCaptureSession}
                    captureSamples={selectedPerformanceSamples}
                    isCapturing={isSelectedCapturing}
                    isCaptureBusy={isSelectedCaptureBusy}
                    elapsedMs={selectedCaptureElapsed}
                    softLimitNotice={selectedSoftLimitNotice}
                    onToggleCapture={toggleCaptureSession}
                    onDismissSoftLimit={() => selectedDeviceId && dismissSoftLimit(selectedDeviceId)}
                    onSaveCaptureMarkers={saveCaptureMarkers}
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
                    onToggleAudio={handleToggleMirrorAudio}
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

      {fileBrowserDevice && (
        <div
          onClick={closeFileBrowser}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1500 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(900px, 92vw)', maxHeight: '88vh', display: 'flex', flexDirection: 'column', backgroundColor: '#0f172a', border: '1px solid #334155', borderRadius: '12px', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid #1f2937' }}>
              <span style={{ fontSize: '15px', fontWeight: 700, color: '#fff' }}>
                {'📁 设备文件 · '}{customDeviceNames[fileBrowserDevice.id] || fileBrowserDevice.name || fileBrowserDevice.id}
              </span>
              <button
                onClick={closeFileBrowser}
                style={{ width: '28px', height: '28px', background: '#1f2937', border: 'none', borderRadius: '6px', color: '#cbd5e1', cursor: 'pointer', fontSize: '16px', lineHeight: 1 }}
              >×</button>
            </div>
            <div style={{ overflow: 'hidden', flex: 1, minHeight: 0, display: 'flex' }}>
              <FilesPanel selectedDevice={fileBrowserDevice} onError={setError} />
            </div>
          </div>
        </div>
      )}

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

      {confirmDialog && (
        <div
          onClick={() => setConfirmDialog(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 4000, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(420px, 92vw)', backgroundColor: '#252540', border: '1px solid #353550', borderRadius: '12px', padding: '20px 22px', boxShadow: '0 24px 60px rgba(0,0,0,0.5)' }}
          >
            <div style={{ fontSize: '14px', color: '#e5e7eb', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: '18px' }}>
              {confirmDialog.message}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setConfirmDialog(null)}
                style={{ padding: '8px 16px', backgroundColor: '#353550', border: 'none', borderRadius: '6px', color: '#d1d5db', fontSize: '13px', cursor: 'pointer' }}
              >{'\u53d6\u6d88'}</button>
              <button
                onClick={() => { const cb = confirmDialog.onConfirm; setConfirmDialog(null); cb(); }}
                style={{ padding: '8px 16px', backgroundColor: confirmDialog.danger ? '#dc2626' : '#2563eb', border: 'none', borderRadius: '6px', color: 'white', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}
              >{confirmDialog.confirmText}</button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

export default SimpleApp;

