export interface DeviceInfo {
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  apiLevel: number;
  connectionType: 'usb' | 'wifi';
  status: 'connected' | 'disconnected' | 'offline' | 'unauthorized';
  latencyMs?: number;
  latencyStatus?: 'ok' | 'timeout' | 'unknown';
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  packageName: string;
  cpuUsage: number;
  memoryUsage: number;
  status: 'running' | 'sleeping' | 'zombie';
}

export interface LogEntry {
  id: string;
  deviceId: string;
  timestamp: Date;
  processId: number;
  threadId: number;
  level: 'V' | 'D' | 'I' | 'W' | 'E' | 'F';
  tag: string;
  message: string;
  packageName?: string;
}

export interface NetworkRequest {
  id: string;
  timestamp: Date;
  packageName: string;
  method: string;
  url: string;
  statusCode: number;
  statusText?: string;
  path?: string;
  host?: string;
  requestBody?: string;
  responseBody?: string;
  headers: Record<string, string>;
  responseHeaders?: Record<string, string>;
  rawRequest?: string;
  rawResponse?: string;
  duration: number;
}

export interface ActivityStackEntry {
  id: string;
  packageName: string;
  activityName: string;
  state: string;
  taskId?: string;
  raw: string;
}

export interface MetricReading {
  value: number;
  unit?: string;
  maxValue?: number;
  maxValueUnit?: string;
  raw?: string;
}

export interface PicoMetricsPayload {
  rawLine?: string;
  rawFields?: Record<string, string>;
  fps?: MetricReading;
  mtp?: MetricReading;
  frameCpu?: MetricReading;
  frameGpu?: MetricReading;
  atwGpu?: MetricReading;
  gpuUtil?: MetricReading;
}

export interface AndroidPerformancePayload {
  source: 'android';
  cpuSource?: string;
  memorySource?: string;
  fpsSource?: string;
}

export type PicoMetricsState = 'native' | 'fallback' | 'unavailable';
export type PicoAppSupportStatus = 'supported' | 'unsupported' | 'unknown';

export interface PerformanceMetrics {
  provider: 'android' | 'pico';
  cpuUsage: number;
  memoryUsage: number;
  fps: number;
  packageName?: string;
  activityName?: string;
  androidMetrics?: AndroidPerformancePayload;
  picoMetrics?: PicoMetricsPayload;
  picoMetricsState?: PicoMetricsState;
  picoMetricsMessage?: string;
  picoAppSupport?: PicoAppSupportStatus;
  picoSupportMessage?: string;
}

export interface PerformanceSnapshot {
  id: string;
  deviceId: string;
  capturedAt: Date;
  metrics: PerformanceMetrics;
  screenshotPath?: string;
  packageName?: string;
  activityName?: string;
  trigger: 'manual' | 'fps_drop' | 'threshold';
  note?: string;
}

export interface PerformanceSample {
  id: string;
  deviceId: string;
  capturedAt: Date;
  metrics: PerformanceMetrics;
}

export interface PerformanceSessionExportPayload {
  device: DeviceInfo;
  startedAt: Date;
  endedAt?: Date;
  samples: PerformanceSample[];
  snapshots: PerformanceSnapshot[];
}

export interface AdbStatus {
  available: boolean;
  version: string | null;
  path: string | null;
  source?: 'bundled' | 'system';
  message: string;
  checkedAt: number;
  code?: string;
  hint?: string;
}

export interface LogcatFilters {
  packageName?: string;
  tag?: string;
  level?: LogEntry['level'];
  keyword?: string;
}

export type IpcChannel =
  | 'adb:get-status'
  | 'adb:get-devices'
  | 'adb:connect-usb'
  | 'adb:connect-wifi'
  | 'adb:disconnect'
  | 'adb:start-logcat'
  | 'adb:stop-logcat'
  | 'adb:get-performance'
  | 'adb:capture-performance-snapshot'
  | 'performance:export-session'
  | 'adb:get-processes'
  | 'adb:get-activity-stack'
  | 'adb:get-network-requests'
  | 'adb:status-changed'
  | 'device:connected'
  | 'device:disconnected'
  | 'log:export'
  | 'log:entry'
  | 'log:batch'
  | 'device:list-changed';

export interface IpcRequest<T = unknown> {
  channel: IpcChannel;
  payload?: T;
}

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  hint?: string;
  details?: string;
}
