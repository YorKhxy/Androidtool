import type {
  ActivityStackEntry,
  AdbStatus,
  ApkInstallResult,
  DeviceInfo,
  LogEntry,
  NetworkRequest,
  PerformanceMetrics,
  PerformanceSnapshot,
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
  disconnect: (deviceId: string) => Promise<ElectronResult<undefined>>;
  startLogcat: (
    deviceId: string,
    minLevel?: 'V' | 'D' | 'I' | 'W' | 'E' | 'F',
    packageName?: string,
    pid?: string
  ) => Promise<ElectronResult<undefined>>;
  stopLogcat: (deviceId: string) => Promise<ElectronResult<undefined>>;
  getPerformance: (deviceId: string) => Promise<ElectronResult<PerformanceMetrics>>;
  capturePerformanceSnapshot: (deviceId: string) => Promise<ElectronResult<PerformanceSnapshot>>;
  getProcesses: (deviceId: string) => Promise<ElectronResult<ProcessInfo[]>>;
  connectUSB: () => Promise<ElectronResult<DeviceInfo[]>>;
  getActivityStack: (deviceId: string, packageName?: string) => Promise<ElectronResult<ActivityStackEntry[]>>;
  getNetworkRequests: (deviceId: string, packageName?: string) => Promise<ElectronResult<NetworkRequest[]>>;
  selectApkFiles: () => Promise<ElectronResult<string[]>>;
  installApk: (deviceId: string, apkPath: string) => Promise<ElectronResult<ApkInstallResult>>;
  sleepDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  rebootDevice: (deviceId: string) => Promise<ElectronResult<undefined>>;
  exportLogs: (logs: LogEntry[]) => Promise<ElectronResult<string>>;
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
