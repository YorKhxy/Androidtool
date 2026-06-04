import { useRef, useState } from 'react';
import type { PerformanceCaptureSession, PerformanceSample } from '../../shared/types';
import { formatMemoryMb, getGpuValue, METRIC_COLORS, sampleElapsedMs, type CaptureMetricKey } from './perfFormat';

const chartPadding = { left: 54, right: 76, top: 24, bottom: 38 };

type ChartSeries = {
  key: string;
  label: string;
  color: string;
  axis: 'percent' | 'memory';
  getValue: (sample: PerformanceSample) => number | undefined;
};

type HoverPoint = { x: number; y: number; sample: PerformanceSample };

type CaptureChartProps = {
  session: PerformanceCaptureSession;
  samples: PerformanceSample[];
  totalMs: number;
  selectedSeriesKeys: Set<string>;
  onToggleSeries: (key: string) => void;
  playheadMs: number;
  showPlayhead: boolean;
  onSeekToMs?: (ms: number) => void;
  /** 参数过滤标记：每个条件各自在「自己指标的曲线」上打点，按指标区分颜色，跟随该曲线显隐。 */
  markers?: Array<{ metricKey: CaptureMetricKey; atMs: number[] }>;
  onMarkerClick?: (ms: number) => void;
};

const SERIES: ChartSeries[] = [
  { key: 'fps', label: 'FPS', color: METRIC_COLORS.fps, axis: 'percent', getValue: (s) => s.metrics.fps },
  { key: 'cpu', label: 'CPU%', color: METRIC_COLORS.cpu, axis: 'percent', getValue: (s) => s.metrics.cpuUsage },
  { key: 'gpu', label: 'GPU%', color: METRIC_COLORS.gpu, axis: 'percent', getValue: getGpuValue },
  { key: 'mem', label: 'MEM MB', color: METRIC_COLORS.mem, axis: 'memory', getValue: (s) => Number(formatMemoryMb(s.metrics.memoryUsage)) },
];

export function CaptureChart({
  session,
  samples,
  totalMs,
  selectedSeriesKeys,
  onToggleSeries,
  playheadMs,
  showPlayhead,
  onSeekToMs,
  markers,
  onMarkerClick,
}: CaptureChartProps) {
  const [hoverPoint, setHoverPoint] = useState<HoverPoint | null>(null);
  const scrubbingRef = useRef(false);
  const width = 960;
  const height = 300;
  const plotWidth = width - chartPadding.left - chartPadding.right;
  const plotHeight = height - chartPadding.top - chartPadding.bottom;

  const isSeriesVisible = (key: string) => selectedSeriesKeys.size === 0 || selectedSeriesKeys.has(key);
  const visibleSeries = SERIES.filter((s) => isSeriesVisible(s.key));

  const memoryValues = samples.map((s) => Number(formatMemoryMb(s.metrics.memoryUsage))).filter(Number.isFinite);
  const memoryAxisMax = Math.max(512, Math.ceil(Math.max(1, ...memoryValues) / 512) * 512);
  // FPS 与 CPU%/GPU% 共用左轴：高刷设备 FPS 会超过 100，按本次峰值取最近刷新率档位，保底 100。
  const fpsMax = Math.max(0, ...samples.map((s) => s.metrics.fps).filter(Number.isFinite));
  const FPS_TIERS = [100, 120, 144, 165, 240];
  const leftAxisMax = Math.max(100, FPS_TIERS.find((t) => t >= fpsMax) ?? Math.ceil(fpsMax / 60) * 60);
  const percentTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(leftAxisMax * r));
  const memoryTicks = [0, 0.25, 0.5, 0.75, 1].map((r) => Math.round(memoryAxisMax * r));

  const xForMs = (ms: number) => chartPadding.left + (totalMs <= 0 ? 0 : Math.max(0, Math.min(1, ms / totalMs)) * plotWidth);
  const xForSample = (sample: PerformanceSample) => xForMs(sampleElapsedMs(sample, session.startedAt));
  const yForValue = (value: number, axisMax: number) =>
    chartPadding.top + plotHeight - (Math.max(0, value) / axisMax) * plotHeight;

  const buildLine = (series: ChartSeries) => {
    const axisMax = series.axis === 'memory' ? memoryAxisMax : leftAxisMax;
    return samples
      .map((sample) => `${xForSample(sample).toFixed(1)},${yForValue(series.getValue(sample) || 0, axisMax).toFixed(1)}`)
      .join(' ');
  };

  const seekFromEvent = (clientX: number, target: SVGSVGElement) => {
    if (!onSeekToMs || totalMs <= 0) return;
    const rect = target.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * width;
    const ratio = Math.max(0, Math.min(1, (svgX - chartPadding.left) / plotWidth));
    onSeekToMs(ratio * totalMs);
  };

  const updateHoverPoint = (clientX: number, clientY: number, target: SVGSVGElement) => {
    if (samples.length === 0) return;
    const rect = target.getBoundingClientRect();
    const svgX = ((clientX - rect.left) / rect.width) * width;
    const ratio = plotWidth <= 0 ? 0 : Math.max(0, Math.min(1, (svgX - chartPadding.left) / plotWidth));
    const targetMs = ratio * totalMs;
    const nearest = samples.reduce<{ sample: PerformanceSample; delta: number } | null>((best, sample) => {
      const delta = Math.abs(sampleElapsedMs(sample, session.startedAt) - targetMs);
      return !best || delta < best.delta ? { sample, delta } : best;
    }, null);
    if (nearest) setHoverPoint({ x: clientX - rect.left + 12, y: clientY - rect.top + 12, sample: nearest.sample });
  };

  if (samples.length === 0) {
    return <div style={{ color: '#6b7280', fontSize: '13px' }}>开始采集后，这里会实时记录本次采集的指标曲线。</div>;
  }

  const playheadX = xForMs(playheadMs);
  // 命中时间点 → 样本，用于把过滤标记打在对应指标曲线的实际数值位置上。
  const elapsedToSample = new Map(samples.map((sample) => [sampleElapsedMs(sample, session.startedAt), sample]));

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        onPointerDown={(e) => {
          if (!onSeekToMs) return;
          scrubbingRef.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          seekFromEvent(e.clientX, e.currentTarget);
        }}
        onPointerMove={(e) => {
          updateHoverPoint(e.clientX, e.clientY, e.currentTarget);
          if (scrubbingRef.current) seekFromEvent(e.clientX, e.currentTarget);
        }}
        onPointerUp={() => {
          scrubbingRef.current = false;
        }}
        onMouseLeave={() => setHoverPoint(null)}
        style={{ width: '100%', height: '320px', background: '#0f172a', borderRadius: '10px', cursor: onSeekToMs ? 'col-resize' : 'default', touchAction: 'none' }}
      >
        <rect x="0" y="0" width={width} height={height} fill="#0f172a" />
        {percentTicks.map((tick) => {
          const y = yForValue(tick, leftAxisMax);
          return (
            <g key={tick}>
              <line x1={chartPadding.left} y1={y} x2={chartPadding.left + plotWidth} y2={y} stroke="#1f2937" />
              <text x={chartPadding.left - 10} y={y + 4} fill="#94a3b8" fontSize="11" textAnchor="end">{tick}</text>
            </g>
          );
        })}
        {memoryTicks.map((tick) => (
          <text key={tick} x={chartPadding.left + plotWidth + 10} y={yForValue(tick, memoryAxisMax) + 4} fill="#86efac" fontSize="11">{tick}</text>
        ))}
        <line x1={chartPadding.left} y1={chartPadding.top} x2={chartPadding.left} y2={chartPadding.top + plotHeight} stroke="#64748b" />
        <line x1={chartPadding.left + plotWidth} y1={chartPadding.top} x2={chartPadding.left + plotWidth} y2={chartPadding.top + plotHeight} stroke="#22c55e" />
        <line x1={chartPadding.left} y1={chartPadding.top + plotHeight} x2={chartPadding.left + plotWidth} y2={chartPadding.top + plotHeight} stroke="#64748b" />
        {/* 面积填充：每条可见曲线下方填到基线，淡色铺满区域。 */}
        {samples.length >= 2 && visibleSeries.map((series) => {
          const baseY = chartPadding.top + plotHeight;
          const firstX = xForSample(samples[0]);
          const lastX = xForSample(samples[samples.length - 1]);
          return (
            <polygon
              key={`${series.key}-area`}
              points={`${firstX.toFixed(1)},${baseY} ${buildLine(series)} ${lastX.toFixed(1)},${baseY}`}
              fill={series.color}
              opacity={0.12}
            />
          );
        })}
        {visibleSeries.map((series) => (
          <polyline key={series.key} points={buildLine(series)} fill="none" stroke={series.color} strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {/* 波峰 / 波谷标识：仅对可见曲线，各标最大、最小一处。 */}
        {samples.length >= 2 && visibleSeries.flatMap((series) => {
          const axisMax = series.axis === 'memory' ? memoryAxisMax : leftAxisMax;
          let maxI = 0, minI = 0, maxV = -Infinity, minV = Infinity;
          samples.forEach((sample, i) => {
            const v = Number(series.getValue(sample)) || 0;
            if (v > maxV) { maxV = v; maxI = i; }
            if (v < minV) { minV = v; minI = i; }
          });
          const peak = { x: xForSample(samples[maxI]), y: yForValue(maxV, axisMax) };
          const valley = { x: xForSample(samples[minI]), y: yForValue(minV, axisMax) };
          return [
            <g key={`${series.key}-peak`}>
              <polygon points={`${peak.x},${peak.y - 9} ${peak.x - 4},${peak.y - 2} ${peak.x + 4},${peak.y - 2}`} fill={series.color} />
              <text x={peak.x} y={peak.y - 12} fill={series.color} fontSize="10" fontWeight="600" textAnchor="middle">{Math.round(maxV)}</text>
            </g>,
            <g key={`${series.key}-valley`}>
              <polygon points={`${valley.x},${valley.y + 9} ${valley.x - 4},${valley.y + 2} ${valley.x + 4},${valley.y + 2}`} fill={series.color} />
              <text x={valley.x} y={valley.y + 20} fill={series.color} fontSize="10" fontWeight="600" textAnchor="middle">{Math.round(minV)}</text>
            </g>,
          ];
        })}
        {/* 参数过滤标记：每个条件各自在「自己指标的曲线」上打空心圆点，颜色取该指标曲线色，
            隐藏该曲线时其标记一并隐藏（不与波峰波谷三角混淆）。 */}
        {(markers ?? []).flatMap((marker) => {
          const series = SERIES.find((s) => s.key === marker.metricKey);
          if (!series || !isSeriesVisible(series.key)) return [];
          const axisMax = series.axis === 'memory' ? memoryAxisMax : leftAxisMax;
          return marker.atMs.flatMap((ms, i) => {
            const sample = elapsedToSample.get(ms);
            if (!sample) return [];
            const cx = xForMs(ms);
            const cy = yForValue(series.getValue(sample) || 0, axisMax);
            return [
              <g
                key={`${marker.metricKey}-${ms}-${i}`}
                onPointerDown={(e) => {
                  if (!onMarkerClick) return;
                  e.stopPropagation();
                  onMarkerClick(ms);
                }}
                style={{ cursor: onMarkerClick ? 'pointer' : 'default' }}
              >
                <circle cx={cx} cy={cy} r="9" fill="transparent" />
                <circle cx={cx} cy={cy} r="4.5" fill="#0f172a" stroke={series.color} strokeWidth="2.5" />
              </g>,
            ];
          });
        })}
        {showPlayhead && (
          <g>
            <line x1={playheadX} y1={chartPadding.top} x2={playheadX} y2={chartPadding.top + plotHeight} stroke="#f8fafc" strokeWidth="1.5" strokeDasharray="4 3" />
            <polygon points={`${playheadX},${chartPadding.top} ${playheadX - 5},${chartPadding.top - 8} ${playheadX + 5},${chartPadding.top - 8}`} fill="#f8fafc" />
          </g>
        )}
        <text x={chartPadding.left} y="16" fill="#94a3b8" fontSize="11">% / FPS</text>
        <text x={chartPadding.left + plotWidth - 32} y="16" fill="#86efac" fontSize="11">MEM MB</text>
        {SERIES.map((series, index) => {
          const visible = isSeriesVisible(series.key);
          const gx = chartPadding.left + index * 92;
          return (
            <g key={series.key} onPointerDown={(e) => { e.stopPropagation(); onToggleSeries(series.key); }} style={{ cursor: 'pointer' }} opacity={visible ? 1 : 0.4}>
              <rect x={gx - 2} y={height - 21} width="88" height="18" fill="transparent" />
              <rect x={gx} y={height - 18} width="10" height="10" fill={series.color} rx="2" />
              <text x={gx + 14} y={height - 9} fill="#cbd5e1" fontSize="11" textDecoration={visible ? 'none' : 'line-through'}>{series.label}</text>
            </g>
          );
        })}
      </svg>
      {hoverPoint && (
        <div style={{ position: 'absolute', left: `${hoverPoint.x}px`, top: `${hoverPoint.y}px`, backgroundColor: '#0f172a', border: '1px solid #475569', borderRadius: '8px', padding: '8px 10px', boxShadow: '0 12px 30px rgba(0,0,0,0.35)', pointerEvents: 'none', zIndex: 1 }}>
          <div style={{ color: '#fff', fontSize: '12px', marginBottom: '4px' }}>{new Date(hoverPoint.sample.capturedAt).toLocaleString('zh-CN', { hour12: false })}</div>
          <div style={{ color: '#cbd5e1', fontSize: '12px' }}>{`FPS ${hoverPoint.sample.metrics.fps}`}</div>
          <div style={{ color: '#cbd5e1', fontSize: '12px' }}>{`CPU ${hoverPoint.sample.metrics.cpuUsage.toFixed(1)}%`}</div>
          <div style={{ color: '#cbd5e1', fontSize: '12px' }}>{`MEM ${formatMemoryMb(hoverPoint.sample.metrics.memoryUsage)}MB`}</div>
          <div style={{ color: '#cbd5e1', fontSize: '12px' }}>{`GPU ${getGpuValue(hoverPoint.sample) ?? '--'}%`}</div>
        </div>
      )}
    </div>
  );
}
