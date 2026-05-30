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
  batteryLevel?: number;
}

export interface PairResult {
  message: string;
  device: DeviceInfo | null;
  alreadyPaired?: boolean;
}

export interface DeviceFileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  mtime: string;
}

export interface DeviceFileList {
  path: string;
  entries: DeviceFileEntry[];
}

export interface PushProgress {
  uploadId: string;
  fileName: string;
  index: number;       // 当前是第几个文件（从 0 起）
  total: number;       // 本批共多少个文件
  percent: number;     // 当前文件 0-100
  status: 'uploading' | 'done' | 'error';
  error?: string;
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

export interface ApkInstallResult {
  apkPath: string;
  output: string;
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

export type PerformanceRecordingProvider = 'android-screenrecord' | 'pico-screenrecord' | 'pico-sdk';

export type PerformanceRecordingStatus = 'completed' | 'failed';

export interface PerformanceRecordingOptions {
  durationSeconds: 10 | 30 | 60;
  bitRateMbps?: number;
}

export interface PerformanceRecording {
  id: string;
  deviceId: string;
  provider: PerformanceRecordingProvider;
  status: PerformanceRecordingStatus;
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  videoRelativePath?: string;
  manifestRelativePath?: string;
  singleEyeVideo?: boolean;
  samples: PerformanceSample[];
  packageName?: string;
  activityName?: string;
  error?: string;
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

export type MirrorSessionStatus = 'starting' | 'running' | 'stopped' | 'failed';

/** 投屏会话状态，含 Pico 单眼裁切与画质配置。 */
export interface MirrorSession {
  deviceId: string;
  status: MirrorSessionStatus;
  startedAt?: string;
  error?: string;
  isPico?: boolean;
  crop?: string; // scrcpy --crop 参数，Pico 单眼裁切，如 "1920:1920:0:0"
  maxSize?: number; // scrcpy --max-size 分辨率上限
  bitRate?: string; // scrcpy --video-bit-rate 码率，如 "8M"
}

/** 启动投屏的可选参数。 */
export interface MirrorStartOptions {
  windowTitle?: string;
  isPico?: boolean; // Pico 设备自动附加单眼裁切
  maxSize?: number; // --max-size
  bitRate?: string; // --video-bit-rate，如 "8M"
}

export type IpcChannel =
  | 'adb:get-status'
  | 'adb:get-devices'
  | 'adb:connect-usb'
  | 'adb:connect-wifi'
  | 'adb:pair-wifi'
  | 'adb:disconnect'
  | 'adb:start-logcat'
  | 'adb:stop-logcat'
  | 'adb:get-performance'
  | 'adb:capture-performance-snapshot'
  | 'adb:start-performance-recording'
  | 'performance:export-session'
  | 'adb:get-processes'
  | 'adb:get-activity-stack'
  | 'adb:get-network-requests'
  | 'adb:select-apk-files'
  | 'adb:install-apk'
  | 'adb:list-device-files'
  | 'adb:pull-device-file'
  | 'adb:push-device-file'
  | 'adb:push-device-file-progress'
  | 'adb:select-upload-files'
  | 'adb:sleep-device'
  | 'adb:wake-device'
  | 'adb:unlock-device'
  | 'adb:reboot-device'
  | 'adb:status-changed'
  | 'device:connected'
  | 'device:disconnected'
  | 'mirror:start'
  | 'mirror:stop'
  | 'mirror:status'
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
