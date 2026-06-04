import { useEffect, useRef, useState } from 'react';
import type { PerformanceCaptureMarker, PerformanceCaptureSession, PerformanceSample } from '../../shared/types';
import { CaptureChart } from './CaptureChart';
import { CaptureFilterPanel } from './CaptureFilterPanel';
import { captureSegmentFrame, findNearestSample, getSingleEyeWrapperStyle, renderMetricOverlay, renderRecordingPlaceholder } from './captureReportHelpers';
import {
  buildSegmentMediaUrl,
  captureTotalMs,
  computeMarkers,
  formatClock,
  shouldCropCaptureVideo,
  type FilterCondition,
} from './perfFormat';

type CaptureReportProps = {
  session: PerformanceCaptureSession | null;
  samples: PerformanceSample[];
  /** true = 采集进行中（实时曲线 + 录制中占位，无时间轴）；false = 报告（视频 + 时间轴联动）。 */
  live: boolean;
  /** 采集中已用时长（毫秒），用于占位块显示。 */
  elapsedMs?: number;
  /** 加载历史会话时带入的已存过滤标记（实时/刚停止时为空）。 */
  markers?: PerformanceCaptureMarker[];
  /** 过滤后持久化标记到会话（SimpleApp 走 saveCaptureMarkers）。 */
  onSaveMarkers?: (sessionId: string, markers: PerformanceCaptureMarker[]) => void;
  /** 视频快捷截图：把当前帧 PNG dataUrl 归档到会话 screenshots/（SimpleApp 走 saveCaptureFrame），成功返回相对路径。 */
  onSaveFrame?: (sessionId: string, dataUrl: string) => Promise<string | undefined>;
};

export function CaptureReport({ session, samples, live, elapsedMs, markers, onSaveMarkers, onSaveFrame }: CaptureReportProps) {
  const [selectedSeriesKeys, setSelectedSeriesKeys] = useState<Set<string>>(new Set());
  const [playheadMs, setPlayheadMs] = useState(0);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoSize, setVideoSize] = useState<{ width: number; height: number } | null>(null);
  const [filterConditions, setFilterConditions] = useState<FilterCondition[]>([]);
  const [appliedMarkers, setAppliedMarkers] = useState<PerformanceCaptureMarker[]>([]);
  const [frameNote, setFrameNote] = useState<string | null>(null);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pendingSeekOffsetRef = useRef<number | null>(null);
  // markers prop 可能每次渲染换新引用；只在切会话时播种，故经 ref 读取避免反复复位过滤态。
  const markersPropRef = useRef(markers);
  markersPropRef.current = markers;

  const sessionId = session?.id ?? null;
  // 切换会话 / 重新采集时复位播放态与过滤态，避免沿用上一会话的播放头、单眼比例与标记。
  useEffect(() => {
    setPlayheadMs(0);
    setActiveSegmentIndex(0);
    setIsPlaying(false);
    setVideoSize(null);
    pendingSeekOffsetRef.current = null;
    setFilterConditions([]);
    setAppliedMarkers(markersPropRef.current ?? []);
  }, [sessionId, live]);

  if (!session) {
    return <div style={{ color: '#6b7280', fontSize: '13px' }}>开启采集后，这里会显示本次采集的指标曲线与录屏。</div>;
  }

  const segments = session.videoSegments;
  const totalMs = captureTotalMs(session, samples);
  // 各条件独立标记，总命中点数（用于过滤面板提示与播放头显隐）。
  const markCount = appliedMarkers.reduce((sum, marker) => sum + marker.atMs.length, 0);
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

  // 点过滤命中标记：播放头与曲线游标对齐到该时间点，并暂停视频。
  const seekAndPause = (ms: number) => {
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
    seekTo(ms);
  };

  const applyFilter = () => {
    const next = computeMarkers(filterConditions, samples, session.startedAt);
    setAppliedMarkers(next);
    onSaveMarkers?.(session.id, next);
  };

  const clearFilter = () => {
    setFilterConditions([]);
    setAppliedMarkers([]);
    onSaveMarkers?.(session.id, []);
  };

  const activeSegment = segments[activeSegmentIndex];
  const segmentUrl = activeSegment ? buildSegmentMediaUrl(session.id, activeSegment) : undefined;
  const shouldCrop = shouldCropCaptureVideo(session);
  const hasVideoSize = Boolean(videoSize && videoSize.width > 0 && videoSize.height > 0);
  const currentSample = findNearestSample(samples, session.startedAt, playheadMs);

  // 截当前帧自动归档：用离屏 crossOrigin video 抓 activeSegment 在播放头处的帧，不弹系统保存框。
  const handleCaptureFrame = async () => {
    if (!activeSegment || !segmentUrl || !onSaveFrame || capturingFrame) return;
    setCapturingFrame(true);
    setFrameNote(null);
    try {
      const offsetSec = Math.max(0, (playheadMs - activeSegment.startMs) / 1000);
      const dataUrl = await captureSegmentFrame(segmentUrl, offsetSec, shouldCrop);
      await onSaveFrame(session.id, dataUrl);
      setFrameNote('截图已保存');
    } catch (error) {
      setFrameNote(`截图失败：${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      setCapturingFrame(false);
      window.setTimeout(() => setFrameNote(null), 3000);
    }
  };

  const renderVideoArea = () => {
    if (live) {
      return renderRecordingPlaceholder(elapsedMs ?? 0);
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
          {onSaveFrame && (
            <button
              type="button"
              onClick={handleCaptureFrame}
              disabled={capturingFrame}
              title="把当前画面存为截图（自动归档到会话）"
              style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: '#1e293b', color: '#fff', cursor: capturingFrame ? 'not-allowed' : 'pointer', padding: '7px 12px', fontSize: '12px', flexShrink: 0, whiteSpace: 'nowrap' }}
            >{capturingFrame ? '截图中…' : '截图'}</button>
          )}
        </div>
        {frameNote && (
          <div style={{ color: frameNote.startsWith('截图失败') ? '#fca5a5' : '#86efac', fontSize: '12px', marginTop: '6px' }}>{frameNote}</div>
        )}
      </div>
    );
  };

  const showFilter = !live && samples.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1fr)', gap: '16px', alignItems: 'start' }}>
        <CaptureChart
          session={session}
          samples={samples}
          totalMs={totalMs}
          selectedSeriesKeys={selectedSeriesKeys}
          onToggleSeries={toggleSeries}
          playheadMs={playheadMs}
          showPlayhead={!live && (segments.length > 0 || markCount > 0)}
          onSeekToMs={!live && segments.length > 0 ? seekTo : undefined}
          markers={appliedMarkers}
          onMarkerClick={!live ? seekAndPause : undefined}
        />
        {renderVideoArea()}
      </div>
      {showFilter && (
        <CaptureFilterPanel
          conditions={filterConditions}
          onChange={setFilterConditions}
          onApply={applyFilter}
          onClear={clearFilter}
          isPico={session.provider.startsWith('pico')}
          hitCount={markCount}
          applied={appliedMarkers.length > 0}
        />
      )}
    </div>
  );
}
