import { useEffect, useState, type CSSProperties } from 'react';
import type { DeviceInfo, MetricReading, PerformanceMetrics, PerformanceRecording, PerformanceSample, PerformanceSnapshot, PicoMetricsState } from '../../shared/types';
import { Badge } from './ui';

type PerformancePanelProps = {
  device: DeviceInfo | null;
  performance: PerformanceMetrics | null;
  samples: PerformanceSample[];
  snapshots: PerformanceSnapshot[];
  sessionSnapshots: PerformanceSnapshot[];
  isMonitoringPerformance: boolean;
  isCapturingSnapshot: boolean;
  isRecording: boolean;
  recordings: PerformanceRecording[];
  onToggleMonitoring: () => void;
  onCaptureSnapshot: () => void;
  onStartRecording: (durationSeconds: 10 | 30 | 60) => void;
  onExportSession: () => void;
};

const useSnapshotImageUrl = (screenshotPath?: string) => {
  const [imageUrl, setImageUrl] = useState<string | undefined>();
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setImageUrl(undefined);
    setLoadFailed(false);

    if (!screenshotPath) return;

    const readSnapshotImage = window.electronAPI?.readSnapshotImage;
    if (!readSnapshotImage) {
      setLoadFailed(true);
      return;
    }

    readSnapshotImage(screenshotPath).then((result) => {
      if (cancelled) return;
      if (result.success && result.data) {
        setImageUrl(result.data);
      } else {
        setLoadFailed(true);
      }
    }).catch(() => {
      if (!cancelled) {
        setLoadFailed(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [screenshotPath]);

  return { imageUrl, loadFailed };
};

const SnapshotImage = ({
  screenshotPath,
  alt,
  style,
}: {
  screenshotPath?: string;
  alt: string;
  style: CSSProperties;
}) => {
  const { imageUrl, loadFailed } = useSnapshotImageUrl(screenshotPath);

  if (!screenshotPath) {
    return <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>截图不可用</div>;
  }

  if (loadFailed) {
    return <div style={{ color: 'var(--danger)', fontSize: '12px' }}>截图加载失败</div>;
  }

  if (!imageUrl) {
    return <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>截图加载中...</div>;
  }

  return <img src={imageUrl} alt={alt} style={style} />;
};

const renderMetricCard = (
  title: string,
  subtitle: string,
  value: string,
  suffix: string,
  color: string,
  width: string
) => {
  const muted = value === '--';
  return (
  <div
    style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--r-md)',
      padding: '15px 17px',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'baseline', gap: '9px' }}>
      <span style={{ fontSize: '17px', fontWeight: 700, color: muted ? 'var(--fg-secondary)' : color }}>{title}</span>
      <span style={{ fontSize: '12px', color: 'var(--fg-tertiary)' }}>{subtitle}</span>
    </div>
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: '26px',
        fontWeight: 600,
        margin: '10px 0 10px',
        color: muted ? 'var(--fg-disabled)' : 'var(--fg-primary)',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value}
      {suffix && <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--fg-tertiary)' }}> {suffix}</span>}
    </div>
    <div style={{ height: '6px', background: 'var(--bg-elevated)', borderRadius: 'var(--r-pill)', overflow: 'hidden' }}>
      <div style={{ height: '100%', background: color, width, borderRadius: 'var(--r-pill)' }} />
    </div>
  </div>
  );
};

const renderMutedMetricCard = (title: string, subtitle: string) =>
  renderMetricCard(title, subtitle, '--', '', 'var(--fg-disabled)', '0%');

const formatMetricReading = (metric?: MetricReading, fallback = '--') => {
  if (!metric) {
    return fallback;
  }

  if (metric.maxValue !== undefined) {
    const maxUnit = metric.maxValueUnit || metric.unit || '';
    return `${metric.value}/${metric.maxValue}${maxUnit}`;
  }

  return `${metric.value}${metric.unit || ''}`;
};

const formatMemoryMb = (memoryKb: number) => (memoryKb / 1024).toFixed(1);

const renderSnapshotPath = (snapshot: PerformanceSnapshot) =>
  snapshot.screenshotPath ? (
    <div style={{ marginTop: '8px', color: 'var(--fg-tertiary)', fontSize: '11px', wordBreak: 'break-all' }}>{snapshot.screenshotPath}</div>
  ) : null;

const renderAndroidMetrics = (performance: PerformanceMetrics | null) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '14px' }}>
      {renderMetricCard(
        'FPS',
        '前台渲染帧率',
        performance ? String(performance.fps) : '--',
        'FPS',
        'var(--chart-fps)',
        `${Math.min(((performance?.fps || 0) / 120) * 100, 100)}%`
      )}
      {renderMetricCard(
        'CPU',
        'CPU 使用率',
        performance ? performance.cpuUsage.toFixed(1) : '--',
        '%',
        'var(--chart-cpu)',
        `${Math.min(performance?.cpuUsage || 0, 100)}%`
      )}
      {renderMetricCard(
        'MEM',
        '内存占用',
        performance ? formatMemoryMb(performance.memoryUsage) : '--',
        'MB',
        'var(--chart-mem)',
        `${Math.min(((performance?.memoryUsage || 0) / 8_000_000) * 100, 100)}%`
      )}
  </div>
);

const renderPicoMetrics = (performance: PerformanceMetrics | null) => {
  const pico = performance?.picoMetrics;
  const picoFpsValue = pico?.fps?.value ?? performance?.fps;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '14px' }}>
      {renderMetricCard(
        'FPS',
        'Pico 实时帧率',
        picoFpsValue !== undefined ? String(picoFpsValue) : '--',
        pico?.fps?.maxValue !== undefined ? `/ ${pico.fps.maxValue}` : '',
        'var(--chart-fps)',
        `${Math.min(((picoFpsValue || 0) / 120) * 100, 100)}%`
      )}
      {renderMetricCard(
        'CPU',
        'CPU 占用率',
        performance ? performance.cpuUsage.toFixed(1) : '--',
        '%',
        'var(--chart-cpu)',
        `${Math.min(performance?.cpuUsage || 0, 100)}%`
      )}
      {renderMetricCard(
        'MEM',
        '内存占用',
        performance ? (performance.memoryUsage / 1024).toFixed(1) : '--',
        'MB',
        'var(--chart-mem)',
        `${Math.min(((performance?.memoryUsage || 0) / 8_000_000) * 100, 100)}%`
      )}
      {renderMetricCard(
        'GPU',
        'GPU 利用率',
        pico?.gpuUtil ? String(pico.gpuUtil.value) : '--',
        pico?.gpuUtil?.unit || '%',
        'var(--info)',
        `${Math.min(pico?.gpuUtil?.value || 0, 100)}%`
      )}
      {renderMetricCard(
        'MTP',
        'Motion-to-Photon',
        pico?.mtp ? String(pico.mtp.value) : '--',
        pico?.mtp?.unit || '',
        'var(--warning)',
        `${Math.min(((pico?.mtp?.value || 0) / 60) * 100, 100)}%`
      )}
      {renderMetricCard(
        'FrmCpu',
        'CPU 帧耗时',
        pico?.frameCpu ? String(pico.frameCpu.value) : '--',
        pico?.frameCpu?.unit || '',
        'var(--chart-cpu)',
        `${Math.min(((pico?.frameCpu?.value || 0) / 40) * 100, 100)}%`
      )}
      {renderMetricCard(
        'FrmGpu',
        'App GPU 帧耗时',
        pico?.frameGpu ? String(pico.frameGpu.value) : '--',
        pico?.frameGpu?.unit || '',
        'var(--chart-mem)',
        `${Math.min(((pico?.frameGpu?.value || 0) / 40) * 100, 100)}%`
      )}
      {renderMetricCard(
        'ATWGPU',
        'Compositor GPU',
        pico?.atwGpu ? String(pico.atwGpu.value) : '--',
        pico?.atwGpu?.unit || '',
        'var(--info)',
        `${Math.min(((pico?.atwGpu?.value || 0) / 30) * 100, 100)}%`
      )}
    </div>
  );
};

const renderPicoFallbackMetrics = (performance: PerformanceMetrics | null) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '14px' }}>
    {renderMetricCard(
      'FPS',
      '通用前台帧率回退',
      performance ? String(performance.fps) : '--',
      'FPS',
      'var(--chart-fps)',
      `${Math.min(((performance?.fps || 0) / 120) * 100, 100)}%`
    )}
    {renderMetricCard(
      'CPU',
      '通用 CPU 采样回退',
      performance ? performance.cpuUsage.toFixed(1) : '--',
      '%',
      'var(--chart-cpu)',
      `${Math.min(performance?.cpuUsage || 0, 100)}%`
    )}
    {renderMetricCard(
        'MEM',
        '通用内存采样回退',
        performance ? formatMemoryMb(performance.memoryUsage) : '--',
        'MB',
      'var(--chart-mem)',
      `${Math.min(performance?.memoryUsage || 0, 100)}%`
    )}
    {renderMutedMetricCard('GPU', '等待 Pico 官方指标')}
    {renderMutedMetricCard('MTP', '等待 Pico 官方指标')}
    {renderMutedMetricCard('FrmCpu', '等待 Pico 官方指标')}
    {renderMutedMetricCard('FrmGpu', '等待 Pico 官方指标')}
    {renderMutedMetricCard('ATWGPU', '等待 Pico 官方指标')}
  </div>
);

const renderAndroidSnapshotSummary = (snapshot: PerformanceSnapshot) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
    <div style={{ color: 'var(--chart-cpu)' }}>{`CPU ${snapshot.metrics.cpuUsage.toFixed(1)}%`}</div>
    <div style={{ color: 'var(--chart-mem)' }}>{`MEM ${formatMemoryMb(snapshot.metrics.memoryUsage)}MB`}</div>
    <div style={{ color: 'var(--chart-fps)' }}>{`FPS ${snapshot.metrics.fps}`}</div>
  </div>
);

const renderPicoSnapshotSummary = (snapshot: PerformanceSnapshot) => {
  const pico = snapshot.metrics.picoMetrics;
  if (snapshot.metrics.picoMetricsState && snapshot.metrics.picoMetricsState !== 'native') {
    return renderAndroidSnapshotSummary(snapshot);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>
      <div style={{ color: 'var(--chart-fps)' }}>{`FPS ${formatMetricReading(pico?.fps)}`}</div>
      <div style={{ color: 'var(--chart-cpu)' }}>{`CPU ${snapshot.metrics.cpuUsage.toFixed(1)}%`}</div>
      <div style={{ color: 'var(--chart-mem)' }}>{`MEM ${(snapshot.metrics.memoryUsage / 1024).toFixed(1)}MB`}</div>
      <div style={{ color: 'var(--info)' }}>{`MTP ${formatMetricReading(pico?.mtp)}`}</div>
      <div style={{ color: 'var(--chart-cpu)' }}>{`FrmCpu ${formatMetricReading(pico?.frameCpu)}`}</div>
      <div style={{ color: 'var(--chart-mem)' }}>{`FrmGpu ${formatMetricReading(pico?.frameGpu)}`}</div>
      <div style={{ color: 'var(--warning)' }}>{`ATWGPU ${formatMetricReading(pico?.atwGpu)}`}</div>
      <div style={{ color: 'var(--info)' }}>{`GPU ${formatMetricReading(pico?.gpuUtil)}`}</div>
    </div>
  );
};

const getPicoIntroText = (performance: PerformanceMetrics | null) => {
  return performance?.picoMetricsState === 'native'
    ? 'Pico 性能指标会和当前设备画面一起保存到快照。'
    : '当前显示 Pico 性能回退采样，可抓取快照记录现场。';
};

const isLikelyPicoDevice = (device: DeviceInfo | null) => {
  const identity = [device?.manufacturer, device?.name, device?.model]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return identity.includes('pico') || identity.includes('a9210') || identity.includes('sparrow');
};

const chartPadding = { left: 54, right: 76, top: 24, bottom: 38 };

type ChartSeries = {
  key: string;
  label: string;
  color: string;
  axis: 'percent' | 'memory';
  getValue: (sample: PerformanceSample) => number | undefined;
};

const getGpuValue = (sample: PerformanceSample) => sample.metrics.picoMetrics?.gpuUtil?.value;

type HoverPoint = {
  x: number;
  y: number;
  sample: PerformanceSample;
};

const getSampleValues = (sample: PerformanceSample) => [
  `FPS ${sample.metrics.fps}`,
  `CPU ${sample.metrics.cpuUsage.toFixed(1)}%`,
  `MEM ${formatMemoryMb(sample.metrics.memoryUsage)}MB`,
  `GPU ${getGpuValue(sample) ?? '--'}%`,
];

const getRecordingProviderLabel = (recording: PerformanceRecording) => {
  switch (recording.provider) {
    case 'pico-sdk':
      return 'Pico SDK';
    case 'pico-screenrecord':
      return 'Pico screenrecord';
    default:
      return 'Android screenrecord';
  }
};

const formatRecordingDuration = (recording: PerformanceRecording) => {
  return `${Math.max(1, Math.round(recording.durationMs / 1000))}s`;
};

const buildRecordingMediaUrl = (recording: PerformanceRecording) => {
  if (!recording.videoRelativePath) {
    return undefined;
  }

  const portablePath = recording.videoRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `adm-media://${portablePath.split('/').map(encodeURIComponent).join('/')}`;
};

const isPicoRecording = (recording: PerformanceRecording) => {
  return recording.provider.startsWith('pico') || recording.samples.some((sample) => sample.metrics.provider === 'pico');
};

const shouldCropRecordingInTool = (recording: PerformanceRecording) => {
  return isPicoRecording(recording) && !recording.singleEyeVideo;
};

const getRecordingVideoStyle = (isPicoVideo: boolean, objectFit: CSSProperties['objectFit']): CSSProperties => (
  isPicoVideo
    ? {
        width: '200%',
        minWidth: '200%',
        height: '100%',
        objectFit,
        objectPosition: 'left center',
        flexShrink: 0,
        backgroundColor: 'var(--bg-mirror)',
      }
    : {
        width: '100%',
        height: '100%',
        objectFit,
        backgroundColor: 'var(--bg-mirror)',
      }
);

// 单眼裁切：用录制视频的真实分辨率把左眼区域以原比例完整展示（不拉伸、不二次裁切），
// 与性能快照的单画面保持一致。外层 wrapper 按单眼宽高比 letterbox，内层 video 放大到
// 双眼整宽后靠左对齐，由 wrapper 的 overflow:hidden 裁掉右眼。
const getSingleEyeWrapperStyle = (naturalSize: { width: number; height: number }): CSSProperties => ({
  position: 'relative',
  height: '100%',
  maxWidth: '100%',
  aspectRatio: `${Math.max(1, Math.floor(naturalSize.width / 2))} / ${Math.max(1, naturalSize.height)}`,
  overflow: 'hidden',
  backgroundColor: 'var(--bg-mirror)',
  flexShrink: 0,
});

const getSingleEyeVideoStyle = (): CSSProperties => ({
  position: 'absolute',
  top: 0,
  left: 0,
  width: '200%',
  height: '100%',
  objectFit: 'fill',
  display: 'block',
});

const findRecordingSampleAt = (recording: PerformanceRecording, playbackSeconds: number) => {
  if (recording.samples.length === 0) {
    return null;
  }

  const startedAtMs = new Date(recording.startedAt).getTime();
  const targetMs = startedAtMs + playbackSeconds * 1000;
  return recording.samples.reduce<{ sample: PerformanceSample; delta: number } | null>((nearest, sample) => {
    const delta = Math.abs(new Date(sample.capturedAt).getTime() - targetMs);
    return !nearest || delta < nearest.delta ? { sample, delta } : nearest;
  }, null)?.sample ?? recording.samples[0];
};

const getRecordingMetricLines = (sample: PerformanceSample | null) => {
  if (!sample) {
    return [{ key: 'empty', color: 'var(--fg-secondary)', text: '暂无指标样本' }];
  }

  const pico = sample.metrics.picoMetrics;
  const gpuValue = pico?.gpuUtil ? formatMetricReading(pico.gpuUtil) : (getGpuValue(sample) !== undefined ? `${getGpuValue(sample)}%` : '--');
  const lines = [
    { key: 'time', color: 'var(--fg-secondary)', text: new Date(sample.capturedAt).toLocaleTimeString('zh-CN', { hour12: false }) },
    { key: 'fps', color: 'var(--chart-fps)', text: `FPS ${pico?.fps ? formatMetricReading(pico.fps) : sample.metrics.fps}` },
    { key: 'cpu', color: 'var(--chart-cpu)', text: `CPU ${sample.metrics.cpuUsage.toFixed(1)}%` },
    { key: 'mem', color: 'var(--chart-mem)', text: `MEM ${formatMemoryMb(sample.metrics.memoryUsage)}MB` },
    { key: 'gpu', color: 'var(--info)', text: `GPU ${gpuValue}` },
    pico?.mtp ? { key: 'mtp', color: 'var(--info)', text: `MTP ${formatMetricReading(pico.mtp)}` } : undefined,
    pico?.frameCpu ? { key: 'frmCpu', color: 'var(--chart-fps)', text: `FrmCpu ${formatMetricReading(pico.frameCpu)}` } : undefined,
    pico?.frameGpu ? { key: 'frmGpu', color: 'var(--warning)', text: `FrmGpu ${formatMetricReading(pico.frameGpu)}` } : undefined,
  ];

  return lines.filter((line): line is { key: string; color: string; text: string } => Boolean(line));
};

const renderRecordingMetricOverlay = (sample: PerformanceSample | null, compact = false) => {
  const lines = compact
    ? getRecordingMetricLines(sample).filter((line) => line.key !== 'time').slice(0, 4)
    : getRecordingMetricLines(sample);

  return (
    <div
      style={{
        position: 'absolute',
        left: compact ? '8px' : '16px',
        bottom: compact ? '8px' : '16px',
        maxWidth: compact ? 'calc(100% - 16px)' : 'min(420px, calc(100% - 32px))',
        background: 'var(--bg-scrim)',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--r-sm)',
        padding: compact ? '6px 8px' : '10px 12px',
        display: 'grid',
        gridTemplateColumns: compact ? 'repeat(2, minmax(0, auto))' : 'repeat(3, minmax(0, auto))',
        gap: compact ? '4px 8px' : '6px 12px',
        pointerEvents: 'none',
        boxShadow: 'var(--sh-md)',
      }}
    >
      {lines.map((line) => (
        <span key={line.key} style={{ color: line.color, fontSize: compact ? '11px' : '12px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {line.text}
        </span>
      ))}
    </div>
  );
};

const buildPoints = (
  samples: PerformanceSample[],
  width: number,
  height: number,
  getValue: (sample: PerformanceSample) => number | undefined,
  maxValue: number
) => {
  if (samples.length === 0) return '';
  const plotWidth = width - chartPadding.left - chartPadding.right;
  const plotHeight = height - chartPadding.top - chartPadding.bottom;
  return samples.map((sample, index) => {
    const x = chartPadding.left + (samples.length === 1 ? 0 : (index / (samples.length - 1)) * plotWidth);
    const value = getValue(sample) || 0;
    const y = chartPadding.top + plotHeight - (Math.max(0, value) / maxValue) * plotHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
};

const findNearestSample = (samples: PerformanceSample[], snapshot: PerformanceSnapshot) => {
  const snapshotTime = new Date(snapshot.capturedAt).getTime();
  return samples.reduce<{ sample: PerformanceSample; index: number; delta: number } | null>((nearest, sample, index) => {
    const delta = Math.abs(new Date(sample.capturedAt).getTime() - snapshotTime);
    return !nearest || delta < nearest.delta ? { sample, index, delta } : nearest;
  }, null);
};

const renderSessionReport = (samples: PerformanceSample[], snapshots: PerformanceSnapshot[]) => {
  const [hoveredSnapshotId, setHoveredSnapshotId] = useState<string | null>(null);
  const [hoverPoint, setHoverPoint] = useState<HoverPoint | null>(null);
  // 选中的曲线 key 集合：空集 = 全显；非空 = 只显示集合内的。点图例：全显时首点=只看它，
  // 之后点别的=多选追加，点已选的=取消，删空回到全显。
  const [selectedSeriesKeys, setSelectedSeriesKeys] = useState<Set<string>>(new Set());
  const width = 720;
  const height = 220;
  const hoveredSnapshot = snapshots.find((snapshot) => snapshot.id === hoveredSnapshotId);
  const memoryValues = samples.map((sample) => Number(formatMemoryMb(sample.metrics.memoryUsage))).filter(Number.isFinite);
  const memoryMax = Math.max(1, ...memoryValues);
  const memoryAxisMax = Math.ceil(memoryMax / 512) * 512;
  const series: ChartSeries[] = [
    { key: 'fps', label: 'FPS', color: 'var(--chart-fps)', axis: 'percent', getValue: (sample) => sample.metrics.fps },
    { key: 'cpu', label: 'CPU%', color: 'var(--chart-cpu)', axis: 'percent', getValue: (sample) => sample.metrics.cpuUsage },
    { key: 'gpu', label: 'GPU%', color: 'var(--info)', axis: 'percent', getValue: getGpuValue },
    { key: 'mem', label: 'MEM MB', color: 'var(--chart-mem)', axis: 'memory', getValue: (sample) => Number(formatMemoryMb(sample.metrics.memoryUsage)) },
  ];
  const isSeriesVisible = (key: string) => selectedSeriesKeys.size === 0 || selectedSeriesKeys.has(key);
  const toggleSeries = (key: string) =>
    setSelectedSeriesKeys((prev) => {
      if (prev.size === 0) return new Set([key]); // 全显状态首点 → 只看这一条
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next; // 删到空集会自动回到全显
    });
  const visibleSeries = series.filter((s) => isSeriesVisible(s.key));
  const snapshotMarkers = snapshots
    .map((snapshot, index) => ({ snapshot, label: `S${index + 1}`, nearest: findNearestSample(samples, snapshot) }))
    .filter((marker): marker is { snapshot: PerformanceSnapshot; label: string; nearest: { sample: PerformanceSample; index: number; delta: number } } => Boolean(marker.nearest));

  if (samples.length === 0) {
    return <div style={{ color: 'var(--fg-tertiary)', fontSize: '13px' }}>开启采集后，这里会显示本次采集曲线和快照标记。</div>;
  }

  const plotWidth = width - chartPadding.left - chartPadding.right;
  const plotHeight = height - chartPadding.top - chartPadding.bottom;
  // FPS 与 CPU%/GPU% 共用左轴。CPU/GPU 是 0-100 百分比，但 FPS 在高刷设备（120/144Hz 等）会超过 100，
  // 写死上限 100 会让 FPS 曲线溢出顶部。这里按本次采集的 FPS 峰值动态取最接近的刷新率档位
  // （100/120/144/165/240，再高则向上取 60 的倍数），并保底 100 以免低帧时 CPU/GPU 百分比反而溢出。
  const fpsValues = samples.map((sample) => sample.metrics.fps).filter(Number.isFinite);
  const fpsMax = Math.max(0, ...fpsValues);
  const FPS_AXIS_TIERS = [100, 120, 144, 165, 240];
  const fpsAxisCeil = FPS_AXIS_TIERS.find((tier) => tier >= fpsMax) ?? Math.ceil(fpsMax / 60) * 60;
  const leftAxisMax = Math.max(100, fpsAxisCeil);
  const percentTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(leftAxisMax * ratio));
  const memoryTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => Math.round(memoryAxisMax * ratio));

  const updateHoverPoint = (clientX: number, clientY: number, target: SVGSVGElement) => {
    const rect = target.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * width;
    const clampedX = Math.max(chartPadding.left, Math.min(chartPadding.left + plotWidth, svgX));
    const ratio = plotWidth <= 0 ? 0 : (clampedX - chartPadding.left) / plotWidth;
    const index = Math.max(0, Math.min(samples.length - 1, Math.round(ratio * (samples.length - 1))));
    setHoverPoint({ x: clientX - rect.left + 12, y: clientY - rect.top + 12, sample: samples[index] });
  };

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        onMouseMove={(event) => updateHoverPoint(event.clientX, event.clientY, event.currentTarget)}
        onMouseLeave={() => {
          setHoverPoint(null);
          setHoveredSnapshotId(null);
        }}
        style={{ width: '100%', height: '280px', background: 'var(--bg-mirror)', borderRadius: 'var(--r-md)' }}
      >
        <rect x="0" y="0" width={width} height={height} fill="var(--bg-mirror)" />
        {percentTicks.map((tick) => {
          const y = chartPadding.top + plotHeight - (tick / leftAxisMax) * plotHeight;
          return (
            <g key={tick}>
              <line x1={chartPadding.left} y1={y} x2={chartPadding.left + plotWidth} y2={y} stroke="var(--chart-grid)" />
              <text x={chartPadding.left - 10} y={y + 4} fill="var(--fg-tertiary)" fontSize="11" textAnchor="end">{tick}</text>
            </g>
          );
        })}
        {memoryTicks.map((tick) => {
          const y = chartPadding.top + plotHeight - (tick / memoryAxisMax) * plotHeight;
          return <text key={tick} x={chartPadding.left + plotWidth + 10} y={y + 4} fill="var(--chart-mem)" fontSize="11">{tick}</text>;
        })}
        <line x1={chartPadding.left} y1={chartPadding.top} x2={chartPadding.left} y2={chartPadding.top + plotHeight} stroke="var(--border-strong)" />
        <line x1={chartPadding.left + plotWidth} y1={chartPadding.top} x2={chartPadding.left + plotWidth} y2={chartPadding.top + plotHeight} stroke="var(--chart-mem)" />
        <line x1={chartPadding.left} y1={chartPadding.top + plotHeight} x2={chartPadding.left + plotWidth} y2={chartPadding.top + plotHeight} stroke="var(--border-strong)" />
        {visibleSeries.map((item) => (
          <polyline
            key={item.key}
            points={buildPoints(samples, width, height, item.getValue, item.axis === 'memory' ? memoryAxisMax : leftAxisMax)}
            fill="none"
            stroke={item.color}
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {/* 波峰 / 波谷标识：仅对可见曲线，各标最大、最小一处（▲峰 ▼谷 + 数值）。 */}
        {samples.length >= 2 && visibleSeries.flatMap((item) => {
          const axisMax = item.axis === 'memory' ? memoryAxisMax : leftAxisMax;
          let maxI = 0, minI = 0, maxV = -Infinity, minV = Infinity;
          samples.forEach((sample, i) => {
            const v = Number(item.getValue(sample)) || 0;
            if (v > maxV) { maxV = v; maxI = i; }
            if (v < minV) { minV = v; minI = i; }
          });
          const at = (i: number, v: number) => ({
            x: chartPadding.left + (i / (samples.length - 1)) * plotWidth,
            y: chartPadding.top + plotHeight - (Math.max(0, v) / axisMax) * plotHeight,
          });
          const peak = at(maxI, maxV);
          const valley = at(minI, minV);
          const fmt = (v: number) => (item.axis === 'memory' ? Math.round(v).toString() : Math.round(v).toString());
          return [
            <g key={`${item.key}-peak`}>
              <polygon points={`${peak.x},${peak.y - 9} ${peak.x - 4},${peak.y - 2} ${peak.x + 4},${peak.y - 2}`} fill={item.color} />
              <text x={peak.x} y={peak.y - 12} fill={item.color} fontSize="10" fontWeight="600" textAnchor="middle">{fmt(maxV)}</text>
            </g>,
            <g key={`${item.key}-valley`}>
              <polygon points={`${valley.x},${valley.y + 9} ${valley.x - 4},${valley.y + 2} ${valley.x + 4},${valley.y + 2}`} fill={item.color} />
              <text x={valley.x} y={valley.y + 20} fill={item.color} fontSize="10" fontWeight="600" textAnchor="middle">{fmt(minV)}</text>
            </g>,
          ];
        })}
        {snapshotMarkers.map(({ snapshot, label, nearest }) => {
          const x = chartPadding.left + (samples.length === 1 ? 0 : (nearest.index / (samples.length - 1)) * plotWidth);
          const y = chartPadding.top + plotHeight - (Math.max(0, nearest.sample.metrics.fps) / leftAxisMax) * plotHeight;
          return (
            <g
              key={snapshot.id}
              onMouseEnter={() => setHoveredSnapshotId(snapshot.id)}
              onMouseMove={(event) => updateHoverPoint(event.clientX, event.clientY, event.currentTarget.ownerSVGElement!)}
              style={{ cursor: 'pointer' }}
            >
              <circle cx={x} cy={y} r="6" fill="var(--warning)" stroke="var(--fg-on-accent)" strokeWidth="2" />
              <text x={x + 8} y={y - 8} fill="var(--warning)" fontSize="12">{label}</text>
            </g>
          );
        })}
        <text x={chartPadding.left} y="16" fill="var(--fg-tertiary)" fontSize="11">% / FPS</text>
        <text x={chartPadding.left + plotWidth - 32} y="16" fill="var(--chart-mem)" fontSize="11">MEM MB</text>
        {series.map((item, index) => {
          const visible = isSeriesVisible(item.key);
          const gx = chartPadding.left + index * 86;
          return (
            <g key={item.key} onClick={() => toggleSeries(item.key)} style={{ cursor: 'pointer' }} opacity={visible ? 1 : 0.4}>
              <rect x={gx - 2} y={height - 21} width="82" height="18" fill="transparent" />
              <rect x={gx} y={height - 18} width="10" height="10" fill={item.color} rx="2" />
              <text x={gx + 14} y={height - 9} fill="var(--fg-secondary)" fontSize="11" textDecoration={visible ? 'none' : 'line-through'}>{item.label}</text>
            </g>
          );
        })}
      </svg>
      {hoveredSnapshot && (
        <div style={{ position: 'absolute', left: `${hoverPoint?.x || 16}px`, top: `${hoverPoint?.y || 16}px`, width: '220px', background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: '8px', boxShadow: 'var(--sh-pop)', pointerEvents: 'none', zIndex: 2 }}>
          <SnapshotImage screenshotPath={hoveredSnapshot.screenshotPath} alt={hoveredSnapshot.id} style={{ width: '100%', maxHeight: '120px', objectFit: 'cover', borderRadius: '6px' }} />
          <div style={{ color: 'var(--fg-primary)', fontSize: '12px', marginTop: '6px' }}>{new Date(hoveredSnapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          <div style={{ color: 'var(--fg-secondary)', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>{`FPS ${hoveredSnapshot.metrics.fps} / CPU ${hoveredSnapshot.metrics.cpuUsage.toFixed(1)}% / MEM ${formatMemoryMb(hoveredSnapshot.metrics.memoryUsage)}MB`}</div>
        </div>
      )}
      {hoverPoint && !hoveredSnapshot && (
        <div style={{ position: 'absolute', left: `${hoverPoint.x}px`, top: `${hoverPoint.y}px`, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: 'var(--r-sm)', padding: '8px 10px', boxShadow: 'var(--sh-pop)', pointerEvents: 'none', zIndex: 1 }}>
          <div style={{ color: 'var(--fg-primary)', fontSize: '12px', marginBottom: '4px' }}>{new Date(hoverPoint.sample.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          {getSampleValues(hoverPoint.sample).map((line) => <div key={line} style={{ color: 'var(--fg-secondary)', fontSize: '12px', fontVariantNumeric: 'tabular-nums' }}>{line}</div>)}
        </div>
      )}
    </div>
  );
};

export function PerformancePanel({
  device,
  performance,
  samples,
  snapshots,
  sessionSnapshots,
  isMonitoringPerformance,
  isCapturingSnapshot,
  isRecording,
  recordings,
  onToggleMonitoring,
  onCaptureSnapshot,
  onStartRecording,
  onExportSession,
}: PerformancePanelProps) {
  const isPicoView = performance?.provider === 'pico' || (!performance && isLikelyPicoDevice(device));
  const picoMetricsState: PicoMetricsState = performance?.picoMetricsState || 'native';
  const showPicoFallback = isPicoView && picoMetricsState !== 'native';
  const [previewSnapshot, setPreviewSnapshot] = useState<PerformanceSnapshot | null>(null);
  const [previewRecording, setPreviewRecording] = useState<PerformanceRecording | null>(null);
  const [recordingPlaybackTime, setRecordingPlaybackTime] = useState(0);
  const [previewVideoSize, setPreviewVideoSize] = useState<{ width: number; height: number } | null>(null);

  // 切换/关闭播放时重置真实分辨率，避免沿用上一段录制的单眼比例。
  useEffect(() => {
    setPreviewVideoSize(null);
  }, [previewRecording]);

  useEffect(() => {
    if (!previewSnapshot && !previewRecording) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewSnapshot(null);
        setPreviewRecording(null);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewSnapshot, previewRecording]);

  const previewRecordingMediaUrl = previewRecording ? buildRecordingMediaUrl(previewRecording) : undefined;
  const previewRecordingSample = previewRecording ? findRecordingSampleAt(previewRecording, recordingPlaybackTime) : null;
  const previewShouldCrop = previewRecording ? shouldCropRecordingInTool(previewRecording) : false;
  const previewHasVideoSize = Boolean(previewVideoSize && previewVideoSize.width > 0 && previewVideoSize.height > 0);

  const handlePreviewVideoMetadata = (video: HTMLVideoElement) => {
    setRecordingPlaybackTime(video.currentTime);
    if (video.videoWidth > 0 && video.videoHeight > 0) {
      setPreviewVideoSize((prev) =>
        prev && prev.width === video.videoWidth && prev.height === video.videoHeight
          ? prev
          : { width: video.videoWidth, height: video.videoHeight }
      );
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '14px', alignItems: 'stretch' }}>
        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
            <h2>{isPicoView ? 'Pico 性能诊断' : 'Android 性能诊断'}</h2>
            <Badge tone={isMonitoringPerformance ? 'success' : 'neutral'} dot={isMonitoringPerformance}>
              {isMonitoringPerformance ? '采集中' : '未采集'}
            </Badge>
          </div>
          <div style={{ color: 'var(--fg-secondary)', fontSize: '13px', lineHeight: 1.5 }}>
            {isMonitoringPerformance
              ? isPicoView
                ? getPicoIntroText(performance)
                : '当前设备性能采集中，可以抓取快照或录制一段带指标时间线的视频。'
              : '性能采集已关闭。点击开启后才会获取当前设备的性能参数。'}
          </div>
          <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>
            {isPicoView ? '录制会标记 Pico provider，后续可接入 Pico SDK / 实时流通道。' : '录制使用设备端 screenrecord 编码，结束后再拉取 MP4。'}
          </div>
        </section>

        <section style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
            <h3>取证操作</h3>
            <button
              className="btn"
              onClick={onToggleMonitoring}
              style={{
                background: isMonitoringPerformance ? 'var(--danger)' : 'var(--success)',
                color: '#fff',
                borderColor: 'transparent',
              }}
            >
              {isMonitoringPerformance ? '关闭采集' : '开启采集'}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: '10px' }}>
            <button
              className="btn primary"
              onClick={onCaptureSnapshot}
              disabled={isCapturingSnapshot}
              style={{ justifyContent: 'center' }}
            >
              {isCapturingSnapshot ? '抓取中...' : '抓取快照'}
            </button>
            <button
              className="btn secondary"
              onClick={onExportSession}
              disabled={samples.length === 0}
              style={{ justifyContent: 'center' }}
            >导出报告</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(90px, 1fr))', gap: '10px' }}>
            {([10, 30, 60] as const).map(duration => (
              <button
                key={duration}
                className="btn"
                onClick={() => onStartRecording(duration)}
                disabled={isRecording || !device}
                style={{
                  justifyContent: 'center',
                  background: isRecording || !device ? 'var(--bg-elevated)' : 'var(--purple)',
                  color: isRecording || !device ? 'var(--fg-disabled)' : '#fff',
                  borderColor: 'transparent',
                }}
              >
                {isRecording ? '录制中...' : `${duration}s 录制`}
              </button>
            ))}
          </div>
        </section>
      </div>

      {isPicoView ? (showPicoFallback ? renderPicoFallbackMetrics(performance) : renderPicoMetrics(performance)) : renderAndroidMetrics(performance)}

      {(performance?.packageName || performance?.activityName) && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: '14px 16px', color: 'var(--fg-secondary)' }}>
          <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginBottom: '6px' }}>
            {isPicoView ? '当前 Pico 指标关联前台应用' : '当前 FPS 口径'}
          </div>
          <div style={{ fontSize: '14px', marginBottom: '4px', color: 'var(--fg-primary)', fontFamily: 'var(--font-mono)' }}>{performance?.packageName || '--'}</div>
          <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>
            {performance?.activityName || '未能解析前台 Activity'}
          </div>
        </div>
      )}

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: '16px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
          <h3>本次采集报告</h3>
          <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{`采样 ${samples.length} 条 / 快照 ${sessionSnapshots.length} 张`}</div>
        </div>
        {renderSessionReport(samples, sessionSnapshots)}
      </div>

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: '16px 18px' }}>
        <h3 style={{ marginBottom: '12px' }}>性能快照</h3>
        {snapshots.length === 0 ? (
          <div style={{ color: 'var(--fg-tertiary)', fontSize: '13px' }}>还没有快照，先抓一张看看当时的页面和指标。</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
            {snapshots.map((snapshot) => {
              const isPicoSnapshot = snapshot.metrics.provider === 'pico';
              return (
                <div
                  key={snapshot.id}
                  onClick={() => {
                    if (snapshot.screenshotPath) {
                      setPreviewSnapshot(snapshot);
                    }
                  }}
                  style={{
                    background: 'var(--bg-elevated)',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--r-md)',
                    overflow: 'hidden',
                    cursor: snapshot.screenshotPath ? 'zoom-in' : 'default',
                  }}
                  title={snapshot.screenshotPath ? '点击查看大图' : undefined}
                >
                  <div
                    style={{
                      height: '124px',
                      background: 'var(--bg-mirror)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: isPicoSnapshot ? 'flex-start' : 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {snapshot.screenshotPath ? (
                      <SnapshotImage
                        screenshotPath={snapshot.screenshotPath}
                        alt={`snapshot-${snapshot.id}`}
                        style={
                          isPicoSnapshot
                            ? {
                                width: '200%',
                                minWidth: '200%',
                                height: '100%',
                                objectFit: 'cover',
                                objectPosition: 'left center',
                                flexShrink: 0,
                              }
                            : { width: '100%', height: '100%', objectFit: 'cover' }
                        }
                      />
                    ) : (
                      <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>截图不可用</div>
                    )}
                  </div>
                  <div style={{ padding: '12px' }}>
                    <div style={{ color: 'var(--fg-primary)', fontSize: '13px', marginBottom: '6px', fontVariantNumeric: 'tabular-nums' }}>
                      {new Date(snapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                    <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px', marginBottom: '8px' }}>
                      {snapshot.trigger === 'manual' ? '手动快照' : snapshot.trigger}
                    </div>
                    {isPicoSnapshot ? renderPicoSnapshotSummary(snapshot) : renderAndroidSnapshotSummary(snapshot)}
                    {renderSnapshotPath(snapshot)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-default)', borderRadius: 'var(--r-md)', padding: '16px 18px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', marginBottom: '12px', alignItems: 'center' }}>
          <h3>性能录制</h3>
          <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{`共 ${recordings.length} 段`}</div>
        </div>
        {recordings.length === 0 ? (
          <div style={{ color: 'var(--fg-tertiary)', fontSize: '13px' }}>还没有录制，遇到卡顿时录一段 10s / 30s / 60s 视频。</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '12px' }}>
            {recordings.map((recording) => {
              const mediaUrl = buildRecordingMediaUrl(recording);
              const shouldCropVideo = shouldCropRecordingInTool(recording);
              const firstSample = findRecordingSampleAt(recording, 0);
              const canPlayRecording = Boolean(mediaUrl) && recording.status === 'completed';

              return (
                <div key={recording.id} style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-md)', padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      if (canPlayRecording) {
                        setPreviewRecording(recording);
                        setRecordingPlaybackTime(0);
                      }
                    }}
                    disabled={!canPlayRecording}
                    title={canPlayRecording ? '点击播放录制' : '视频不可用'}
                    style={{
                      position: 'relative',
                      height: '152px',
                      background: 'var(--bg-mirror)',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--r-sm)',
                      overflow: 'hidden',
                      padding: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: shouldCropVideo ? 'flex-start' : 'center',
                      cursor: canPlayRecording ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {canPlayRecording && mediaUrl ? (
                      <>
                        <video
                          src={mediaUrl}
                          muted
                          preload="metadata"
                          playsInline
                          style={getRecordingVideoStyle(shouldCropVideo, 'cover')}
                        />
                        <span
                          style={{
                            position: 'absolute',
                            inset: '0',
                            margin: 'auto',
                            width: '42px',
                            height: '42px',
                            borderRadius: 'var(--r-pill)',
                            background: 'var(--bg-scrim)',
                            color: '#fff',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: '18px',
                            boxShadow: 'var(--sh-md)',
                            pointerEvents: 'none',
                          }}
                        >
                          ▶
                        </span>
                        {renderRecordingMetricOverlay(firstSample, true)}
                      </>
                    ) : (
                      <div style={{ color: 'var(--fg-tertiary)', fontSize: '12px' }}>视频不可用</div>
                    )}
                  </button>

                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
                    <div style={{ color: 'var(--fg-primary)', fontSize: '13px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{new Date(recording.startedAt).toLocaleString('zh-CN', { hour12: false })}</div>
                    <span style={{ color: recording.status === 'completed' ? 'var(--success)' : 'var(--danger)', fontSize: '12px', whiteSpace: 'nowrap' }}>
                      {recording.status === 'completed' ? '已完成' : '失败'}
                    </span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', color: 'var(--fg-secondary)', fontSize: '12px' }}>
                    <div>{getRecordingProviderLabel(recording)}</div>
                    <div>{formatRecordingDuration(recording)}</div>
                    <div>{`采样 ${recording.samples.length} 条`}</div>
                    <div>{recording.packageName || '--'}</div>
                  </div>
                  {recording.videoRelativePath && <div style={{ color: 'var(--accent)', fontSize: '11px', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>{recording.videoRelativePath}</div>}
                  {recording.manifestRelativePath && <div style={{ color: 'var(--fg-tertiary)', fontSize: '11px', wordBreak: 'break-all', fontFamily: 'var(--font-mono)' }}>{recording.manifestRelativePath}</div>}
                  {recording.error && <div style={{ color: 'var(--danger)', fontSize: '12px', wordBreak: 'break-word' }}>{recording.error}</div>}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {previewSnapshot && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="性能快照大图预览"
          onClick={() => setPreviewSnapshot(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'var(--bg-scrim)',
            display: 'flex',
            flexDirection: 'column',
            padding: '24px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '16px',
              color: 'var(--fg-primary)',
              marginBottom: '16px',
            }}
          >
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>性能快照大图</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
                {new Date(previewSnapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}
              </div>
            </div>
            <button
              className="btn iconbtn"
              onClick={(event) => {
                event.stopPropagation();
                setPreviewSnapshot(null);
              }}
              style={{ fontSize: '20px', lineHeight: '20px' }}
              aria-label="关闭大图预览"
            >
              ×
            </button>
          </div>
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              flex: 1,
              minHeight: 0,
              background: 'var(--bg-mirror)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-md)',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <SnapshotImage
              screenshotPath={previewSnapshot.screenshotPath}
              alt={`snapshot-preview-${previewSnapshot.id}`}
              style={{
                maxWidth: '100%',
                maxHeight: '100%',
                width: 'auto',
                height: 'auto',
                objectFit: 'contain',
              }}
            />
          </div>
        </div>
      )}
      {previewRecording && previewRecordingMediaUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="性能录制播放预览"
          onClick={() => setPreviewRecording(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            background: 'var(--bg-scrim)',
            display: 'flex',
            flexDirection: 'column',
            padding: '24px',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: '16px',
              color: 'var(--fg-primary)',
              marginBottom: '16px',
            }}
          >
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>性能录制播放</div>
              <div style={{ fontSize: '12px', color: 'var(--fg-tertiary)', marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
                {`${new Date(previewRecording.startedAt).toLocaleString('zh-CN', { hour12: false })} · ${getRecordingProviderLabel(previewRecording)} · ${formatRecordingDuration(previewRecording)}`}
              </div>
            </div>
            <button
              className="btn iconbtn"
              onClick={(event) => {
                event.stopPropagation();
                setPreviewRecording(null);
              }}
              style={{ fontSize: '20px', lineHeight: '20px' }}
              aria-label="关闭录制播放"
            >
              ×
            </button>
          </div>
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              flex: 1,
              minHeight: 0,
              background: 'var(--bg-mirror)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--r-md)',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
            }}
          >
            {previewShouldCrop && previewHasVideoSize && previewVideoSize ? (
              <div style={getSingleEyeWrapperStyle(previewVideoSize)}>
                <video
                  src={previewRecordingMediaUrl}
                  controls
                  autoPlay
                  playsInline
                  onLoadedMetadata={(event) => handlePreviewVideoMetadata(event.currentTarget)}
                  onTimeUpdate={(event) => setRecordingPlaybackTime(event.currentTarget.currentTime)}
                  style={getSingleEyeVideoStyle()}
                />
              </div>
            ) : (
              <video
                src={previewRecordingMediaUrl}
                controls
                autoPlay
                playsInline
                onLoadedMetadata={(event) => handlePreviewVideoMetadata(event.currentTarget)}
                onTimeUpdate={(event) => setRecordingPlaybackTime(event.currentTarget.currentTime)}
                // 单眼录制在拿到真实分辨率前先隐藏，避免闪现双眼画面。
                style={{ ...getRecordingVideoStyle(false, 'contain'), opacity: previewShouldCrop ? 0 : 1 }}
              />
            )}
            {renderRecordingMetricOverlay(previewRecordingSample)}
          </div>
        </div>
      )}
    </div>
  );
}
