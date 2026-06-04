import type { MetricReading, PerformanceCaptureSession, PerformanceCaptureSegment, PerformanceSample } from '../../shared/types';

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

export const formatClock = (ms: number) => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};
