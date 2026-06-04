import type { MetricReading, PerformanceCaptureMarker, PerformanceCaptureSession, PerformanceCaptureSegment, PerformanceSample } from '../../shared/types';

export type CaptureMetricKey = 'fps' | 'cpu' | 'mem' | 'gpu';
export type CaptureFilterOp = '>' | '=' | '<';

/** 一条过滤条件：某指标按运算符与阈值比较。多条件按 AND 组合。 */
export type FilterCondition = {
  id: string;
  metricKey: CaptureMetricKey;
  op: CaptureFilterOp;
  threshold: number;
};

export const METRIC_LABELS: Record<CaptureMetricKey, string> = {
  fps: 'FPS',
  cpu: 'CPU %',
  mem: 'MEM MB',
  gpu: 'GPU %',
};

// 性能采集报告与指标卡共用的格式化 / 取值小工具。集中放一处，避免 PerformancePanel
// 与 CaptureReport 各写一份导致口径漂移。

export const formatMemoryMb = (memoryKb: number) => (memoryKb / 1024).toFixed(1);

export const getGpuValue = (sample: PerformanceSample) => sample.metrics.picoMetrics?.gpuUtil?.value;

export const formatMetricReading = (metric?: MetricReading, fallback = '--') => {
  if (!metric) {
    return fallback;
  }
  if (metric.maxValue !== undefined) {
    const maxUnit = metric.maxValueUnit || metric.unit || '';
    return `${metric.value}/${metric.maxValue}${maxUnit}`;
  }
  return `${metric.value}${metric.unit || ''}`;
};

/** 把会话内相对路径（performance-captures/...）拼成应用内媒体协议 URL。 */
export const buildCaptureMediaUrl = (relativePath: string | undefined) => {
  if (!relativePath) {
    return undefined;
  }
  const portablePath = relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `adm-media://${portablePath.split('/').map(encodeURIComponent).join('/')}`;
};

/** 某分段视频的媒体 URL：performance-captures/<sessionId>/video/<fileName>。 */
export const buildSegmentMediaUrl = (sessionId: string, segment: PerformanceCaptureSegment) =>
  buildCaptureMediaUrl(`performance-captures/${sessionId}/video/${segment.fileName}`);

/** Pico 原始双眼 MP4 需在播放时裁单眼；已是单眼（singleEyeVideo）或非 Pico 不裁。 */
export const shouldCropCaptureVideo = (session: PerformanceCaptureSession) =>
  session.provider.startsWith('pico') && !session.singleEyeVideo;

/** 样本相对会话起点的毫秒数（实时与回看口径一致：capturedAt - startedAt）。 */
export const sampleElapsedMs = (sample: PerformanceSample, sessionStartedAt: Date) =>
  new Date(sample.capturedAt).getTime() - new Date(sessionStartedAt).getTime();

/** 一次采集的逻辑总时长：优先会话 durationMs，回退到最后分段 / 最后样本。 */
export const captureTotalMs = (session: PerformanceCaptureSession, samples: PerformanceSample[]) => {
  const lastSegmentEnd = session.videoSegments.length
    ? session.videoSegments[session.videoSegments.length - 1].endMs
    : 0;
  const lastSampleMs = samples.length ? sampleElapsedMs(samples[samples.length - 1], session.startedAt) : 0;
  return Math.max(1, session.durationMs || 0, lastSegmentEnd, lastSampleMs);
};

/** 取某样本在指定指标上的数值（mem 归一到 MB；gpu 仅 Pico 有值）。 */
export const metricValueOf = (sample: PerformanceSample, key: CaptureMetricKey): number | undefined => {
  switch (key) {
    case 'fps':
      return sample.metrics.fps;
    case 'cpu':
      return sample.metrics.cpuUsage;
    case 'mem':
      return sample.metrics.memoryUsage / 1024;
    case 'gpu':
      return getGpuValue(sample);
    default:
      return undefined;
  }
};

/** 单条件求值。'=' 用 0.5 容差（指标多为浮点/整数，严格相等几乎不命中）。 */
export const evalCondition = (value: number | undefined, op: CaptureFilterOp, threshold: number): boolean => {
  if (value === undefined || !Number.isFinite(value)) return false;
  switch (op) {
    case '>':
      return value > threshold;
    case '<':
      return value < threshold;
    case '=':
      return Math.abs(value - threshold) < 0.5;
    default:
      return false;
  }
};

/** 逐点求值，每个条件生成一个标记（atMs = 该条件单独命中的相对时间点）。 */
export const computeMarkers = (
  conditions: FilterCondition[],
  samples: PerformanceSample[],
  sessionStartedAt: Date
): PerformanceCaptureMarker[] =>
  conditions.map((condition) => ({
    id: `${condition.metricKey}-${condition.op}-${condition.threshold}`,
    metricKey: condition.metricKey,
    op: condition.op,
    threshold: condition.threshold,
    atMs: samples
      .filter((sample) => evalCondition(metricValueOf(sample, condition.metricKey), condition.op, condition.threshold))
      .map((sample) => sampleElapsedMs(sample, sessionStartedAt)),
  }));

/** 多标记按 AND 组合：取各标记 atMs 的交集（所有条件同时命中的时间点），升序去重。 */
export const andHitTimes = (markers: PerformanceCaptureMarker[]): number[] => {
  if (markers.length === 0) return [];
  const [first, ...rest] = markers;
  let hits = new Set(first.atMs);
  for (const marker of rest) {
    const next = new Set(marker.atMs);
    hits = new Set([...hits].filter((ms) => next.has(ms)));
  }
  return [...hits].sort((a, b) => a - b);
};

export const formatClock = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};
