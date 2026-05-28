import { useEffect, useState } from 'react';
import type { DeviceInfo, MetricReading, PerformanceMetrics, PerformanceSample, PerformanceSnapshot, PicoMetricsState } from '../../shared/types';

type PerformancePanelProps = {
  device: DeviceInfo | null;
  performance: PerformanceMetrics | null;
  samples: PerformanceSample[];
  snapshots: PerformanceSnapshot[];
  sessionSnapshots: PerformanceSnapshot[];
  isMonitoringPerformance: boolean;
  isCapturingSnapshot: boolean;
  onToggleMonitoring: () => void;
  onCaptureSnapshot: () => void;
  onExportSession: () => void;
};

const createScreenshotUrl = (screenshotPath?: string) => {
  if (!screenshotPath) return undefined;
  return encodeURI(`file:///${screenshotPath.replace(/\\/g, '/')}`);
};

const renderMetricCard = (
  title: string,
  subtitle: string,
  value: string,
  suffix: string,
  color: string,
  width: string
) => (
  <div style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '16px' }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
      <span style={{ fontSize: '20px' }}>{title}</span>
      <span style={{ fontSize: '14px', color: '#888' }}>{subtitle}</span>
    </div>
    <div style={{ fontSize: '32px', fontWeight: '700', marginBottom: '8px' }}>
      {value} <span style={{ fontSize: '16px', fontWeight: '400', color: '#888' }}>{suffix}</span>
    </div>
    <div style={{ height: '6px', backgroundColor: '#353550', borderRadius: '3px', overflow: 'hidden' }}>
      <div style={{ height: '100%', backgroundColor: color, width }} />
    </div>
  </div>
);

const renderMutedMetricCard = (title: string, subtitle: string) =>
  renderMetricCard(title, subtitle, '--', '', '#4b5563', '0%');

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
    <div style={{ marginTop: '8px', color: '#6b7280', fontSize: '11px', wordBreak: 'break-all' }}>{snapshot.screenshotPath}</div>
  ) : null;

const renderAndroidMetrics = (performance: PerformanceMetrics | null) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
      {renderMetricCard(
        'FPS',
        '前台渲染帧率',
        performance ? String(performance.fps) : '--',
        'FPS',
        '#a855f7',
        `${Math.min(((performance?.fps || 0) / 120) * 100, 100)}%`
      )}
      {renderMetricCard(
        'CPU',
        'CPU 使用率',
        performance ? performance.cpuUsage.toFixed(1) : '--',
        '%',
        '#3b82f6',
        `${Math.min(performance?.cpuUsage || 0, 100)}%`
      )}
      {renderMetricCard(
        'MEM',
        '内存占用',
        performance ? formatMemoryMb(performance.memoryUsage) : '--',
        'MB',
        '#22c55e',
        `${Math.min(((performance?.memoryUsage || 0) / 8_000_000) * 100, 100)}%`
      )}
  </div>
);

const renderPicoMetrics = (performance: PerformanceMetrics | null) => {
  const pico = performance?.picoMetrics;
  const picoFpsValue = pico?.fps?.value ?? performance?.fps;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '16px' }}>
      {renderMetricCard(
        'FPS',
        'Pico 实时帧率',
        picoFpsValue !== undefined ? String(picoFpsValue) : '--',
        pico?.fps?.maxValue !== undefined ? `/ ${pico.fps.maxValue}` : '',
        '#a855f7',
        `${Math.min(((picoFpsValue || 0) / 120) * 100, 100)}%`
      )}
      {renderMetricCard(
        'CPU',
        'CPU 占用率',
        performance ? performance.cpuUsage.toFixed(1) : '--',
        '%',
        '#3b82f6',
        `${Math.min(performance?.cpuUsage || 0, 100)}%`
      )}
      {renderMetricCard(
        'MEM',
        '内存占用',
        performance ? (performance.memoryUsage / 1024).toFixed(1) : '--',
        'MB',
        '#22c55e',
        `${Math.min(((performance?.memoryUsage || 0) / 8_000_000) * 100, 100)}%`
      )}
      {renderMetricCard(
        'GPU',
        'GPU 利用率',
        pico?.gpuUtil ? String(pico.gpuUtil.value) : '--',
        pico?.gpuUtil?.unit || '%',
        '#ec4899',
        `${Math.min(pico?.gpuUtil?.value || 0, 100)}%`
      )}
      {renderMetricCard(
        'MTP',
        'Motion-to-Photon',
        pico?.mtp ? String(pico.mtp.value) : '--',
        pico?.mtp?.unit || '',
        '#60a5fa',
        `${Math.min(((pico?.mtp?.value || 0) / 60) * 100, 100)}%`
      )}
      {renderMetricCard(
        'FrmCpu',
        'CPU 帧耗时',
        pico?.frameCpu ? String(pico.frameCpu.value) : '--',
        pico?.frameCpu?.unit || '',
        '#22c55e',
        `${Math.min(((pico?.frameCpu?.value || 0) / 40) * 100, 100)}%`
      )}
      {renderMetricCard(
        'FrmGpu',
        'App GPU 帧耗时',
        pico?.frameGpu ? String(pico.frameGpu.value) : '--',
        pico?.frameGpu?.unit || '',
        '#f97316',
        `${Math.min(((pico?.frameGpu?.value || 0) / 40) * 100, 100)}%`
      )}
      {renderMetricCard(
        'ATWGPU',
        'Compositor GPU',
        pico?.atwGpu ? String(pico.atwGpu.value) : '--',
        pico?.atwGpu?.unit || '',
        '#facc15',
        `${Math.min(((pico?.atwGpu?.value || 0) / 30) * 100, 100)}%`
      )}
    </div>
  );
};

const renderPicoFallbackMetrics = (performance: PerformanceMetrics | null) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '16px' }}>
    {renderMetricCard(
      'FPS',
      '通用前台帧率回退',
      performance ? String(performance.fps) : '--',
      'FPS',
      '#a855f7',
      `${Math.min(((performance?.fps || 0) / 120) * 100, 100)}%`
    )}
    {renderMetricCard(
      'CPU',
      '通用 CPU 采样回退',
      performance ? performance.cpuUsage.toFixed(1) : '--',
      '%',
      '#3b82f6',
      `${Math.min(performance?.cpuUsage || 0, 100)}%`
    )}
    {renderMetricCard(
        'MEM',
        '通用内存采样回退',
        performance ? formatMemoryMb(performance.memoryUsage) : '--',
        'MB',
      '#22c55e',
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
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '6px', fontSize: '12px' }}>
    <div style={{ color: '#93c5fd' }}>{`CPU ${snapshot.metrics.cpuUsage.toFixed(1)}%`}</div>
    <div style={{ color: '#86efac' }}>{`MEM ${formatMemoryMb(snapshot.metrics.memoryUsage)}MB`}</div>
    <div style={{ color: '#d8b4fe' }}>{`FPS ${snapshot.metrics.fps}`}</div>
  </div>
);

const renderPicoSnapshotSummary = (snapshot: PerformanceSnapshot) => {
  const pico = snapshot.metrics.picoMetrics;
  if (snapshot.metrics.picoMetricsState && snapshot.metrics.picoMetricsState !== 'native') {
    return renderAndroidSnapshotSummary(snapshot);
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', fontSize: '12px' }}>
      <div style={{ color: '#d8b4fe' }}>{`FPS ${formatMetricReading(pico?.fps)}`}</div>
      <div style={{ color: '#93c5fd' }}>{`CPU ${snapshot.metrics.cpuUsage.toFixed(1)}%`}</div>
      <div style={{ color: '#86efac' }}>{`MEM ${(snapshot.metrics.memoryUsage / 1024).toFixed(1)}MB`}</div>
      <div style={{ color: '#93c5fd' }}>{`MTP ${formatMetricReading(pico?.mtp)}`}</div>
      <div style={{ color: '#86efac' }}>{`FrmCpu ${formatMetricReading(pico?.frameCpu)}`}</div>
      <div style={{ color: '#f97316' }}>{`FrmGpu ${formatMetricReading(pico?.frameGpu)}`}</div>
      <div style={{ color: '#facc15' }}>{`ATWGPU ${formatMetricReading(pico?.atwGpu)}`}</div>
      <div style={{ color: '#ec4899' }}>{`GPU ${formatMetricReading(pico?.gpuUtil)}`}</div>
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
  const width = 720;
  const height = 220;
  const hoveredSnapshot = snapshots.find((snapshot) => snapshot.id === hoveredSnapshotId);
  const hoveredUrl = createScreenshotUrl(hoveredSnapshot?.screenshotPath);
  const memoryValues = samples.map((sample) => Number(formatMemoryMb(sample.metrics.memoryUsage))).filter(Number.isFinite);
  const memoryMax = Math.max(1, ...memoryValues);
  const memoryAxisMax = Math.ceil(memoryMax / 512) * 512;
  const series: ChartSeries[] = [
    { key: 'fps', label: 'FPS', color: '#a855f7', axis: 'percent', getValue: (sample) => sample.metrics.fps },
    { key: 'cpu', label: 'CPU%', color: '#3b82f6', axis: 'percent', getValue: (sample) => sample.metrics.cpuUsage },
    { key: 'gpu', label: 'GPU%', color: '#ec4899', axis: 'percent', getValue: getGpuValue },
    { key: 'mem', label: 'MEM MB', color: '#22c55e', axis: 'memory', getValue: (sample) => Number(formatMemoryMb(sample.metrics.memoryUsage)) },
  ];
  const snapshotMarkers = snapshots
    .map((snapshot, index) => ({ snapshot, label: `S${index + 1}`, nearest: findNearestSample(samples, snapshot) }))
    .filter((marker): marker is { snapshot: PerformanceSnapshot; label: string; nearest: { sample: PerformanceSample; index: number; delta: number } } => Boolean(marker.nearest));

  if (samples.length === 0) {
    return <div style={{ color: '#6b7280', fontSize: '13px' }}>开启采集后，这里会显示本次采集曲线和快照标记。</div>;
  }

  const plotWidth = width - chartPadding.left - chartPadding.right;
  const plotHeight = height - chartPadding.top - chartPadding.bottom;
  const percentTicks = [0, 25, 50, 75, 100];
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
        style={{ width: '100%', height: '280px', background: '#0f172a', borderRadius: '10px' }}
      >
        <rect x="0" y="0" width={width} height={height} fill="#0f172a" />
        {percentTicks.map((tick) => {
          const y = chartPadding.top + plotHeight - (tick / 100) * plotHeight;
          return (
            <g key={tick}>
              <line x1={chartPadding.left} y1={y} x2={chartPadding.left + plotWidth} y2={y} stroke="#1f2937" />
              <text x={chartPadding.left - 10} y={y + 4} fill="#94a3b8" fontSize="11" textAnchor="end">{tick}</text>
            </g>
          );
        })}
        {memoryTicks.map((tick) => {
          const y = chartPadding.top + plotHeight - (tick / memoryAxisMax) * plotHeight;
          return <text key={tick} x={chartPadding.left + plotWidth + 10} y={y + 4} fill="#86efac" fontSize="11">{tick}</text>;
        })}
        <line x1={chartPadding.left} y1={chartPadding.top} x2={chartPadding.left} y2={chartPadding.top + plotHeight} stroke="#64748b" />
        <line x1={chartPadding.left + plotWidth} y1={chartPadding.top} x2={chartPadding.left + plotWidth} y2={chartPadding.top + plotHeight} stroke="#22c55e" />
        <line x1={chartPadding.left} y1={chartPadding.top + plotHeight} x2={chartPadding.left + plotWidth} y2={chartPadding.top + plotHeight} stroke="#64748b" />
        {series.map((item) => (
          <polyline
            key={item.key}
            points={buildPoints(samples, width, height, item.getValue, item.axis === 'memory' ? memoryAxisMax : 100)}
            fill="none"
            stroke={item.color}
            strokeWidth="2.4"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}
        {snapshotMarkers.map(({ snapshot, label, nearest }) => {
          const x = chartPadding.left + (samples.length === 1 ? 0 : (nearest.index / (samples.length - 1)) * plotWidth);
          const y = chartPadding.top + plotHeight - (Math.max(0, nearest.sample.metrics.fps) / 100) * plotHeight;
          return (
            <g
              key={snapshot.id}
              onMouseEnter={() => setHoveredSnapshotId(snapshot.id)}
              onMouseMove={(event) => updateHoverPoint(event.clientX, event.clientY, event.currentTarget.ownerSVGElement!)}
              style={{ cursor: 'pointer' }}
            >
              <circle cx={x} cy={y} r="6" fill="#f59e0b" stroke="#fff" strokeWidth="2" />
              <text x={x + 8} y={y - 8} fill="#fbbf24" fontSize="12">{label}</text>
            </g>
          );
        })}
        <text x={chartPadding.left} y="16" fill="#94a3b8" fontSize="11">% / FPS</text>
        <text x={chartPadding.left + plotWidth - 32} y="16" fill="#86efac" fontSize="11">MEM MB</text>
        {series.map((item, index) => (
          <g key={item.key}>
            <rect x={chartPadding.left + index * 86} y={height - 18} width="10" height="10" fill={item.color} rx="2" />
            <text x={chartPadding.left + 14 + index * 86} y={height - 9} fill="#cbd5e1" fontSize="11">{item.label}</text>
          </g>
        ))}
      </svg>
      {hoveredSnapshot && hoveredUrl && (
        <div style={{ position: 'absolute', left: `${hoverPoint?.x || 16}px`, top: `${hoverPoint?.y || 16}px`, width: '220px', backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', padding: '8px', boxShadow: '0 12px 30px rgba(0,0,0,0.35)', pointerEvents: 'none', zIndex: 2 }}>
          <img src={hoveredUrl} alt={hoveredSnapshot.id} style={{ width: '100%', maxHeight: '120px', objectFit: 'cover', borderRadius: '6px' }} />
          <div style={{ color: '#fff', fontSize: '12px', marginTop: '6px' }}>{new Date(hoveredSnapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          <div style={{ color: '#94a3b8', fontSize: '12px' }}>{`FPS ${hoveredSnapshot.metrics.fps} / CPU ${hoveredSnapshot.metrics.cpuUsage.toFixed(1)}% / MEM ${formatMemoryMb(hoveredSnapshot.metrics.memoryUsage)}MB`}</div>
        </div>
      )}
      {hoverPoint && !hoveredSnapshot && (
        <div style={{ position: 'absolute', left: `${hoverPoint.x}px`, top: `${hoverPoint.y}px`, backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', padding: '8px 10px', boxShadow: '0 12px 30px rgba(0,0,0,0.35)', pointerEvents: 'none', zIndex: 1 }}>
          <div style={{ color: '#fff', fontSize: '12px', marginBottom: '4px' }}>{new Date(hoverPoint.sample.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          {getSampleValues(hoverPoint.sample).map((line) => <div key={line} style={{ color: '#cbd5e1', fontSize: '12px' }}>{line}</div>)}
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
  onToggleMonitoring,
  onCaptureSnapshot,
  onExportSession,
}: PerformancePanelProps) {
  const isPicoView = performance?.provider === 'pico' || (!performance && isLikelyPicoDevice(device));
  const picoMetricsState: PicoMetricsState = performance?.picoMetricsState || 'native';
  const showPicoFallback = isPicoView && picoMetricsState !== 'native';
  const [previewSnapshot, setPreviewSnapshot] = useState<PerformanceSnapshot | null>(null);
  const previewUrl = createScreenshotUrl(previewSnapshot?.screenshotPath);

  useEffect(() => {
    if (!previewSnapshot) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPreviewSnapshot(null);
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [previewSnapshot]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div style={{ color: '#9ca3af', fontSize: '13px' }}>
          {isMonitoringPerformance
            ? isPicoView
              ? getPicoIntroText(performance)
              : '当前设备性能采集中，可以把当前画面和指标绑定成一条性能快照。'
            : '性能采集已关闭。点击开启后才会获取当前设备的性能参数。'}
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            onClick={onToggleMonitoring}
            style={{
              padding: '8px 16px',
              backgroundColor: isMonitoringPerformance ? '#ef4444' : '#22c55e',
              border: 'none',
              borderRadius: '6px',
              color: 'white',
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {isMonitoringPerformance ? '关闭采集' : '开启采集'}
          </button>
          <button
            onClick={onCaptureSnapshot}
            disabled={isCapturingSnapshot || !performance}
            style={{
              padding: '8px 16px',
              backgroundColor: isCapturingSnapshot || !performance ? '#4b5563' : '#4a90d9',
              border: 'none',
              borderRadius: '6px',
              color: 'white',
              cursor: isCapturingSnapshot || !performance ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {isCapturingSnapshot ? '抓取中...' : '抓取性能快照'}
          </button>
          <button
            onClick={onExportSession}
            disabled={samples.length === 0}
            style={{
              padding: '8px 16px',
              backgroundColor: samples.length === 0 ? '#4b5563' : '#353550',
              border: 'none',
              borderRadius: '6px',
              color: 'white',
              cursor: samples.length === 0 ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
            }}
          >导出报告</button>
        </div>
      </div>

      {isPicoView ? (showPicoFallback ? renderPicoFallbackMetrics(performance) : renderPicoMetrics(performance)) : renderAndroidMetrics(performance)}

      {(performance?.packageName || performance?.activityName) && (
        <div style={{ backgroundColor: '#202038', borderRadius: '8px', padding: '12px 14px', color: '#cbd5e1' }}>
          <div style={{ fontSize: '12px', color: '#888', marginBottom: '6px' }}>
            {isPicoView ? '当前 Pico 指标关联前台应用' : '当前 FPS 口径'}
          </div>
          <div style={{ fontSize: '14px', marginBottom: '4px' }}>{performance?.packageName || '--'}</div>
          <div style={{ fontSize: '12px', color: '#94a3b8', wordBreak: 'break-all' }}>
            {performance?.activityName || '未能解析前台 Activity'}
          </div>
        </div>
      )}

      <div style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>本次采集报告</div>
          <div style={{ fontSize: '12px', color: '#94a3b8' }}>{`采样 ${samples.length} 条 / 快照 ${sessionSnapshots.length} 张`}</div>
        </div>
        {renderSessionReport(samples, sessionSnapshots)}
      </div>

      <div style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '14px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', marginBottom: '12px' }}>性能快照</div>
        {snapshots.length === 0 ? (
          <div style={{ color: '#6b7280', fontSize: '13px' }}>还没有快照，先抓一张看看当时的页面和指标。</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
            {snapshots.map((snapshot) => {
              const screenshotUrl = createScreenshotUrl(snapshot.screenshotPath);
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
                    backgroundColor: '#202038',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    cursor: snapshot.screenshotPath ? 'zoom-in' : 'default',
                  }}
                  title={snapshot.screenshotPath ? '点击查看大图' : undefined}
                >
                  <div
                    style={{
                      height: '124px',
                      backgroundColor: '#111827',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: isPicoSnapshot ? 'flex-start' : 'center',
                      overflow: 'hidden',
                    }}
                  >
                    {screenshotUrl ? (
                      <img
                        src={screenshotUrl}
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
                      <div style={{ color: '#6b7280', fontSize: '12px' }}>截图不可用</div>
                    )}
                  </div>
                  <div style={{ padding: '12px' }}>
                    <div style={{ color: '#fff', fontSize: '13px', marginBottom: '6px' }}>
                      {new Date(snapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}
                    </div>
                    <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '8px' }}>
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
      {previewSnapshot && previewUrl && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="性能快照大图预览"
          onClick={() => setPreviewSnapshot(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 1000,
            backgroundColor: 'rgba(5, 8, 15, 0.88)',
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
              color: '#e5e7eb',
              marginBottom: '16px',
            }}
          >
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>性能快照大图</div>
              <div style={{ fontSize: '12px', color: '#94a3b8', marginTop: '4px' }}>
                {new Date(previewSnapshot.capturedAt).toLocaleString('zh-CN', { hour12: false })}
              </div>
            </div>
            <button
              onClick={(event) => {
                event.stopPropagation();
                setPreviewSnapshot(null);
              }}
              style={{
                width: '36px',
                height: '36px',
                border: '1px solid #475569',
                borderRadius: '6px',
                backgroundColor: '#111827',
                color: '#e5e7eb',
                cursor: 'pointer',
                fontSize: '20px',
                lineHeight: '20px',
              }}
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
              backgroundColor: '#020617',
              border: '1px solid #1f2937',
              borderRadius: '8px',
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <img
              src={previewUrl}
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
    </div>
  );
}
