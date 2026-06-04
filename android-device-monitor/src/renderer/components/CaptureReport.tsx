import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { PerformanceCaptureSession, PerformanceSample } from '../../shared/types';
import { CaptureChart } from './CaptureChart';
import {
  buildSegmentMediaUrl,
  captureTotalMs,
  formatClock,
  formatMemoryMb,
  formatMetricReading,
  getGpuValue,
  sampleElapsedMs,
  shouldCropCaptureVideo,
} from './perfFormat';

type CaptureReportProps = {
  session: PerformanceCaptureSession | null;
  samples: PerformanceSample[];
  /** true = 采集进行中（实时曲线 + 录制中占位，无时间轴）；false = 报告（视频 + 时间轴联动）。 */
  live: boolean;
  /** 采集中已用时长（毫秒），用于占位块显示。 */
  elapsedMs?: number;
};

const getSingleEyeWrapperStyle = (naturalSize: { width: number; height: number }): CSSProperties => ({
  position: 'relative',
  height: '100%',
  maxWidth: '100%',
  aspectRatio: `${Math.max(1, Math.floor(naturalSize.width / 2))} / ${Math.max(1, naturalSize.height)}`,
  overflow: 'hidden',
  backgroundColor: '#000',
  flexShrink: 0,
});

const findNearestSample = (samples: PerformanceSample[], startedAt: Date, targetMs: number) =>
  samples.reduce<{ sample: PerformanceSample; delta: number } | null>((best, sample) => {
    const delta = Math.abs(sampleElapsedMs(sample, startedAt) - targetMs);
    return !best || delta < best.delta ? { sample, delta } : best;
  }, null)?.sample ?? null;

const renderMetricOverlay = (sample: PerformanceSample | null) => {
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

export function CaptureReport({ session, samples, live, elapsedMs }: CaptureReportProps) {
  const [selectedSeriesKeys, setSelectedSeriesKeys] = useState<Set<string>>(new Set());
  const [playheadMs, setPlayheadMs] = useState(0);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekOffsetRef = useRef<number | null>(null);

  const sessionId = session?.id ?? null;
  // 切换会话 / 重新采集时复位播放态，避免沿用上一会话的播放头与单眼比例。
  useEffect(() => {
    setPlayheadMs(0);
    setActiveSegmentIndex(0);
    setIsPlaying(false);
    setVideoSize(null);
    pendingSeekOffsetRef.current = null;
  }, [sessionId, live]);

  if (!session) {
    return <div style={{ color: '#6b7280', fontSize: '13px' }}>开启采集后，这里会显示本次采集的指标曲线与录屏。</div>;
  }

  const segments = session.videoSegments;
  const totalMs = captureTotalMs(session, samples);
  const toggleSeries = (key: string) =>
    setSelectedSeriesKeys((prev) => {
      if (prev.size === 0) return new Set([key]); // 全显状态首点 → 只看这一条
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next; // 删到空集自动回到全显
    });

  const findSegmentIndex = (ms: number) => {
    if (segments.length === 0) return 0;
    const hit = segments.findIndex((s) => ms >= s.startMs && ms < s.endMs);
    if (hit >= 0) return hit;
    return ms >= segments[segments.length - 1].endMs ? segments.length - 1 : 0;
  };

  // 连续轴时间 → 分段索引 + 段内偏移：同段直接 seek，跨段切 <video> 源（remount）后由
  // onLoadedMetadata 落到偏移位置。
  const seekTo = (ms: number) => {
    const clamped = Math.max(0, Math.min(totalMs, ms));
    setPlayheadMs(clamped);
    if (segments.length === 0) return;
    const idx = findSegmentIndex(clamped);
    const seg = segments[idx];
    const offset = Math.max(0, (clamped - seg.startMs) / 1000);
    if (idx === activeSegmentIndex && videoRef.current) {
      videoRef.current.currentTime = offset;
    } else {
      pendingSeekOffsetRef.current = offset;
      setActiveSegmentIndex(idx);
    }
  };

  const handleLoadedMetadata = (video: HTMLVideoElement) => {
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setVideoSize((prev) =>
        prev && prev.width === video.videoWidth && prev.height === video.videoHeight ? prev : { width: video.videoWidth, height: video.videoHeight }
      );
    }
    if (pendingSeekOffsetRef.current != null) {
      video.currentTime = pendingSeekOffsetRef.current;
      pendingSeekOffsetRef.current = null;
    }
    if (isPlaying) void video.play().catch(() => undefined);
  };

  const handleTimeUpdate = (video: HTMLVideoElement) => {
    const seg = segments[activeSegmentIndex];
    if (seg) setPlayheadMs(seg.startMs + video.currentTime * 1000);
  };

  const handleEnded = () => {
    const next = activeSegmentIndex + 1;
    if (next < segments.length) {
      pendingSeekOffsetRef.current = 0;
      setPlayheadMs(segments[next].startMs);
      setActiveSegmentIndex(next); // 仍 isPlaying → onLoadedMetadata 自动续播下一段
    } else {
      setIsPlaying(false);
    }
  };

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (isPlaying) {
      video.pause();
      setIsPlaying(false);
    } else {
      void video.play().then(() => setIsPlaying(true)).catch(() => undefined);
    }
  };

  const activeSegment = segments[activeSegmentIndex];
  const segmentUrl = activeSegment ? buildSegmentMediaUrl(session.id, activeSegment) : undefined;
  const shouldCrop = shouldCropCaptureVideo(session);
  const hasVideoSize = Boolean(videoSize && videoSize.width > 0 && videoSize.height > 0);
  const currentSample = findNearestSample(samples, session.startedAt, playheadMs);

  const renderVideoArea = () => {
    if (live) {
      return (
        <div style={{ height: '260px', borderRadius: '10px', backgroundColor: '#020617', border: '1px solid #1f2937', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', color: '#94a3b8' }}>
          <span style={{ width: '12px', height: '12px', borderRadius: '999px', backgroundColor: '#ef4444', boxShadow: '0 0 0 6px rgba(239,68,68,0.18)' }} />
          <div style={{ fontSize: '14px', color: '#e5e7eb' }}>录制中</div>
          <div style={{ fontSize: '12px' }}>已录制 {formatClock(elapsedMs ?? 0)}（采集中不在工具内回传画面）</div>
        </div>
      );
    }
    if (segments.length === 0 || !segmentUrl) {
      return (
        <div style={{ height: '260px', borderRadius: '10px', backgroundColor: '#020617', border: '1px solid #1f2937', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6b7280', fontSize: '13px' }}>
          本次采集没有录屏分段。
        </div>
      );
    }
    return (
      <div>
        <div style={{ position: 'relative', height: '320px', borderRadius: '10px', backgroundColor: '#020617', border: '1px solid #1f2937', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: shouldCrop ? 'flex-start' : 'center' }}>
          {shouldCrop && hasVideoSize && videoSize ? (
            <div style={getSingleEyeWrapperStyle(videoSize)}>
              <video
                key={activeSegmentIndex}
                ref={videoRef}
                src={segmentUrl}
                playsInline
                onLoadedMetadata={(e) => handleLoadedMetadata(e.currentTarget)}
                onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
                onEnded={handleEnded}
                style={{ position: 'absolute', top: 0, left: 0, width: '200%', height: '100%', objectFit: 'fill', display: 'block' }}
              />
            </div>
          ) : (
            <video
              key={activeSegmentIndex}
              ref={videoRef}
              src={segmentUrl}
              playsInline
              onLoadedMetadata={(e) => handleLoadedMetadata(e.currentTarget)}
              onTimeUpdate={(e) => handleTimeUpdate(e.currentTarget)}
              onEnded={handleEnded}
              // 单眼裁切在拿到真实分辨率前先隐藏，避免闪现双眼画面。
              style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000', opacity: shouldCrop ? 0 : 1 }}
            />
          )}
          {renderMetricOverlay(currentSample)}
        </div>
        {/* 可拖动时间轴：播放头横跨整条逻辑轴，分段在轴上以刻度分隔。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '10px' }}>
          <button
            type="button"
            onClick={togglePlay}
            style={{ width: '40px', height: '40px', borderRadius: '999px', border: '1px solid #475569', backgroundColor: '#1e293b', color: '#fff', cursor: 'pointer', fontSize: '16px', flexShrink: 0 }}
            aria-label={isPlaying ? '暂停' : '播放'}
          >
            {isPlaying ? '❚❚' : '▶'}
          </button>
          <input
            type="range"
            min={0}
            max={Math.round(totalMs)}
            value={Math.round(playheadMs)}
            onChange={(e) => seekTo(Number(e.target.value))}
            style={{ flex: 1, accentColor: '#a855f7', cursor: 'pointer' }}
            aria-label="采集时间轴"
          />
          <div style={{ color: '#cbd5e1', fontSize: '12px', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {formatClock(playheadMs)} / {formatClock(totalMs)}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: '16px', alignItems: 'start' }}>
      <CaptureChart
        session={session}
        samples={samples}
        totalMs={totalMs}
        selectedSeriesKeys={selectedSeriesKeys}
        onToggleSeries={toggleSeries}
        playheadMs={playheadMs}
        showPlayhead={!live && segments.length > 0}
        onSeekToMs={!live && segments.length > 0 ? seekTo : undefined}
      />
      {renderVideoArea()}
    </div>
  );
}
