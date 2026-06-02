import type {
  ActivityStackEntry,
  AdbStatus,
  ApkInstallResult,
  DeviceInfo,
  LogEntry,
  MirrorSession,
  MirrorStartOptions,
  NetworkRequest,
  PerformanceMetrics,
  PerformanceRecording,
  PerformanceRecordingOptions,
  PerformanceSessionExportPayload,
  PerformanceSnapshot,
  PairResult,
  DeviceFileList,
  PushProgress,
  PullProgress,
  PullFilesResult,
  ProcessInfo,
} from '../../shared/types';

export type ElectronResult<T> = {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  hint?: string;
  details?: string;
};

export interface ElectronAPI {
  getAdbStatus: () => Promise<ElectronResult<AdbStatus>>;
  getDevices: () => Promise<ElectronResult<DeviceInfo[]>>;
  connectWiFi: (ip: string) => Promise<ElectronResult<DeviceInfo>>;
  pairWiFi: (target: string, pairingCode: string) => Promise<ElectronResult<PairResult>>;
  disconnect: (deviceId: string) => Promise<ElectronResult<undefined>>;
  startLogcat: (
    deviceId: string,
    minLevel?: 'V' | 'D' | 'I' | 'W' | 'E' | 'F',
    packageName?: string,
    pid?: string
  ) => Promise<ElectronResult<undefined>>;
  stopLogcat: (deviceId: string) => Promise<ElectronResult<undefined>>;
  getPerformance: (deviceId: string) => Promise<ElectronResult<PerformanceMetrics>>;
  capturePerformanceSnapshot: (deviceId: string, currentMetrics?: PerformanceMetrics) => Promise<ElectronResult<PerformanceSnapshot>>;
  startPerformanceRecording: (deviceId: string, options: PerformanceRecordingOptions) => Promise<ElectronResult<PerformanceRecording>>;
  readSnapshotImage: (screenshotPath: string) => Promise<ElectronResult<string>>;
  getProcesses: (deviceId: string) => Promise<ElectronResult<ProcessInfo[]>>;
  connectUSB: () => Promise<ElectronResult<DeviceInfo[]>>;
  getActivityStack: (deviceId: string, packageName?: string) => Promise<ElectronResult<ActivityStackEntry[]>>;
  getNetworkRequests: (deviceId: string, packageName?: string) => Promise<ElectronResult<NetworkRequest[]>>;
  startMirror: (deviceId: string, options?: MirrorStartOptions) => Promise<ElectronResult<MirrorSession>>;
  stopMirror: (deviceId: string) => Promise<ElectronResult<undefined>>;
  onMirrorStatus: (callback: (session: MirrorSession) => void) => () => void;
  selectApkFiles: () => Promise<ElectronResult<string[]>>;
  installApk: (deviceId: string, apkPath: string, options?: { allowDowngrade?: boolean }) => Promise<ElectronResult<ApkInstallResult>>;
  uninstallApp: (deviceId: string, packageName: string) => Promise<ElectronResult<{ packageName: string; output: string }>>;
  listInstalledPackages: (deviceId: string) => Promise<ElectronResult<string[]>>;
  listDeviceFiles: (deviceId: string, dirPath: string) => Promise<ElectronResult<DeviceFileList>>;
  pullDeviceFile: (deviceId: string, remotePath: string, name: string, isDir: boolean) => Promise<ElectronResult<string>>;
  deleteDeviceFile: (deviceId: string, remotePath: string, isDir: boolean) => Promise<ElectronResult<undefined>>;
  showItemInFolder: (localPath: string) => Promise<ElectronResult<undefined>>;
  pullDeviceFiles: (deviceId: string, items: { path: string; name: string }[], pullId: string) => Promise<ElectronResult<PullFilesResult>>;
  onPullProgress: (callback: (progress: PullProgress) => void) => () => void;
  selectUploadFiles: () => Promise<ElectronResult<string[]>>;
  pushDeviceFile: (deviceId: string, remoteDir: string, localPaths: string[], uploadId: string) => Promise<ElectronResult<number>>;
  onPushProgress: (callback: (progress: PushProgress) => void) => () => void;
  launchApp: (deviceId: string, packageName: string) => Promise<ElectronResult<{ packageName: string; output: string }>>;
  forceStopApp: (deviceId: string, packageName: string) => Promise<ElectronResult<undefined>>;
  sleepDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  wakeDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  unlockDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  rebootDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  exportLogs: (logs: LogEntry[]) => Promise<ElectronResult<string>>;
  exportPerformanceSession: (payload: PerformanceSessionExportPayload) => Promise<ElectronResult<string>>;
  onLogEntry: (callback: (entry: LogEntry) => void) => () => void;
  onLogBatch: (callback: (entries: LogEntry[]) => void) => () => void;
  onAdbStatusChanged: (callback: (status: AdbStatus) => void) => () => void;
  onDeviceConnected: (callback: (device: DeviceInfo) => void) => () => void;
  onDeviceDisconnected: (callback: (deviceId: string) => void) => () => void;
  onDeviceListChanged: (callback: (devices: DeviceInfo[]) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export const hasElectronAPI = (): boolean => {
  return typeof window !== 'undefined' && window.electronAPI !== undefined;
};

export {};
