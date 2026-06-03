export interface DeviceInfo {
  id: string;
  name: string;
  serialNo: string;
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

// 仅保存通过 WiFi 成功连过的设备，用于「快速重连」历史卡片。
// 以 serialNo 为唯一键去重：设备 IP 变了仍认得出是同一台，覆盖更新而非新增。
// 在线状态不进持久化结构，由当前设备列表按 serialNo 实时匹配计算。
// 持久化沿用渲染层 localStorage（物理上落在 Electron userData 目录下），不暴露宿主绝对路径。
export interface HistoryDevice {
  serialNo: string; // 设备序列号 SN，唯一标识
  name: string; // 设备显示名（自定义名优先，回退设备名/型号），卡片标题展示
  model: string; // 设备型号，显示名缺失时的兜底
  lastAddress: string; // 最近一次连接的 IP:端口，快速重连默认值
  lastConnectedAt: number; // 最近连接时间戳（毫秒），列表倒序排序用
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

export interface PullProgress {
  pullId: string;
  fileName: string;
  index: number;       // 当前是第几个文件（从 0 起）
  total: number;       // 本批共多少个文件
  status: 'downloading' | 'done' | 'error';
  error?: string;
}

export interface PullFilesResult {
  savedDir: string;    // 保存到的 PC 文件夹
  succeeded: number;   // 成功下载的文件数
  failed: number;      // 失败的文件数
}

/** 文件传输方向：上传到设备 / 从设备下载。 */
export type TransferDirection = 'upload' | 'download';

/** 单个传输任务的状态。pending=未开始，transferring=进行中，done=已完成，failed=失败。 */
export type TransferTaskStatus = 'pending' | 'transferring' | 'done' | 'failed';

/**
 * 一次文件传输任务（批量中的单个文件）。持久化到 userData/transfer-journal.json，
 * 用于进程崩溃 / 被强杀后识别未完成任务并文件级续传。只有停留在 pending/transferring
 * 的任务才算「需恢复的残留」；用户主动取消或失败的任务在了结时即移除，不进恢复队列。
 */
export interface TransferTask {
  id: string;                  // 任务唯一 id
  batchId: string;             // 所属批次 id（一次批量上传/下载共享同一 batchId）
  direction: TransferDirection;
  deviceId: string;            // 任务绑定的设备，恢复以原设备为前提
  sourcePath: string;          // 上传=本地文件路径；下载=设备文件路径
  targetPath: string;          // 上传=设备目标目录；下载=PC 保存目录
  fileName: string;            // 文件名
  size: number;                // 文件大小（字节），未知填 0
  status: TransferTaskStatus;
  createdAt: number;           // 创建时间戳
  updatedAt: number;           // 最后更新时间戳
}

/** 启动时推送给渲染层的「可恢复批次」摘要，用于弹窗提示。 */
export interface TransferResumeBatch {
  batchId: string;
  direction: TransferDirection;
  deviceId: string;
  remaining: number;           // 该批次未完成文件数
  sampleNames: string[];       // 文件名样例（最多几个，供提示展示）
}

/** 一批传输（新建或恢复）执行完毕的结果统计。 */
export interface TransferBatchResult {
  succeeded: number;
  failed: number;
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
  | 'adb:pull-device-files'
  | 'adb:pull-device-file-progress'
  | 'adb:delete-device-file'
  | 'app:show-item-in-folder'
  | 'adb:push-device-file'
  | 'adb:push-device-file-progress'
  | 'adb:select-upload-files'
  | 'adb:resume-transfers'
  | 'adb:discard-transfers'
  | 'adb:transfer-resume-available'
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
