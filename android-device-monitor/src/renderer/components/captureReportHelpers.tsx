import type { CSSProperties } from 'react';
import type { PerformanceSample } from '../../shared/types';
import { formatMemoryMb, formatMetricReading, getGpuValue, sampleElapsedMs } from './perfFormat';

// CaptureReport 的视频区辅助：单眼裁切 wrapper 样式、按时间取最近样本、视频上指标浮层。
// 抽到独立文件以保持 CaptureReport 单文件职责清晰、行数受控。

export const getSingleEyeWrapperStyle = (naturalSize: { width: number; height: number }): CSSProperties => ({
  position: 'relative',
  height: '100%',
  maxWidth: '100%',
  aspectRatio: `${Math.max(1, Math.floor(naturalSize.width / 2))} / ${Math.max(1, naturalSize.height)}`,
  overflow: 'hidden',
  backgroundColor: '#000',
  flexShrink: 0,
});

export const findNearestSample = (samples: PerformanceSample[], startedAt: Date, targetMs: number) =>
  samples.reduce<{ sample: PerformanceSample; delta: number } | null>((best, sample) => {
    const delta = Math.abs(sampleElapsedMs(sample, startedAt) - targetMs);
    return !best || delta < best.delta ? { sample, delta } : best;
  }, null)?.sample ?? null;

export const renderMetricOverlay = (sample: PerformanceSample | null) => {
  if (!sample) return null;
  const pico = sample.metrics.picoMetrics;
  const lines = [
    `FPS ${pico?.fps ? formatMetricReading(pico.fps) : sample.metrics.fps}`,
    `CPU ${sample.metrics.cpuUsage.toFixed(1)}%`,
    `MEM ${formatMemoryMb(sample.metrics.memoryUsage)}MB`,
    `GPU ${pico?.gpuUtil ? formatMetricReading(pico.gpuUtil) : (getGpuValue(sample) ?? '--')}%`,
  ];
  return (
    <div style={{ position: 'absolute', left: '12px', bottom: '12px', backgroundColor: 'rgba(2, 6, 23, 0.76)', border: '1px solid rgba(148, 163, 184, 0.35)', borderRadius: '8px', padding: '8px 10px', display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, auto))', gap: '4px 12px', pointerEvents: 'none', boxShadow: '0 8px 20px rgba(0,0,0,0.3)' }}>
      {lines.map((line) => (
        <span key={line} style={{ color: '#cbd5e1', fontSize: '12px', whiteSpace: 'nowrap' }}>{line}</span>
      ))}
    </div>
  );
};
