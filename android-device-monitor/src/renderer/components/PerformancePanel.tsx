import { useState } from 'react';
import type { DeviceInfo, PerformanceCaptureMarker, PerformanceCaptureSession, PerformanceMetrics, PerformanceSample, PicoMetricsState } from '../../shared/types';
import { CaptureReport } from './CaptureReport';
import { CaptureHistoryList } from './CaptureHistoryList';
import { formatClock, formatMemoryMb, METRIC_COLORS } from './perfFormat';

type PerformancePanelProps = {
  device: DeviceInfo | null;
  performance: PerformanceMetrics | null;
  /** 当前展示的会话：采集中=活动会话，停止后=报告会话；无则未采集且无报告。 */
  captureSession: PerformanceCaptureSession | null;
  captureSamples: PerformanceSample[];
  isCapturing: boolean;
  /** start/stop 异步进行中：禁用开关防重复点击。 */
  isCaptureBusy: boolean;
  elapsedMs: number;
  /** 软上限提醒文本（达 30 分钟 / 2GB），null 表示不显示。 */
  softLimitNotice: string | null;
  /** 当前会话已存的过滤标记（加载历史会话时带入）。 */
  captureMarkers?: PerformanceCaptureMarker[];
  /** 采集回看列表（倒序）。 */
  captureSessions: PerformanceCaptureSession[];
  /** 当前在报告区展示的会话 id（列表高亮用）。 */
  loadedSessionId: string | null;
  onToggleCapture: () => void;
  onDismissSoftLimit: () => void;
  onSaveCaptureMarkers: (sessionId: string, markers: PerformanceCaptureMarker[]) => void;
  onSaveCaptureFrame: (sessionId: string, dataUrl: string) => Promise<string | undefined>;
  onSelectCaptureSession: (sessionId: string) => void;
  onRenameCaptureSession: (sessionId: string, title: string) => void;
  onDeleteCaptureSession: (sessionId: string) => void;
  onExportCaptureSession: (sessionId: string) => void;
  /** 选 zip 文件导入。 */
  onImportCaptureSessions: () => void;
  /** 拖拽导入（.zip 或会话文件夹路径）。 */
  onImportCapturePaths: (paths: string[]) => void;
  onExportSession: () => void;
};

type MetricChip = { label: string; value: string; unit?: string; color: string; muted?: boolean };

// 把指标压成紧凑一行小条（色点 + 名 + 数值 + 单位），把竖向空间让给曲线/视频。
const buildMetricChips = (performance: PerformanceMetrics | null, isPicoView: boolean, showPicoFallback: boolean): MetricChip[] => {
  const fps = performance ? String(performance.fps) : '--';
  const cpu = performance ? performance.cpuUsage.toFixed(1) : '--';
  const mem = performance ? formatMemoryMb(performance.memoryUsage) : '--';
  const base: MetricChip[] = [
    { label: 'FPS', value: fps, color: METRIC_COLORS.fps },
    { label: 'CPU', value: cpu, unit: '%', color: METRIC_COLORS.cpu },
    { label: 'MEM', value: mem, unit: 'MB', color: METRIC_COLORS.mem },
  ];
  if (!isPicoView) return base;

  const pico = performance?.picoMetrics;
  if (showPicoFallback) {
    return [
      ...base,
      { label: 'GPU', value: '--', color: METRIC_COLORS.gpu, muted: true },
      { label: 'MTP', value: '--', color: '#60a5fa', muted: true },
      { label: 'FrmCpu', value: '--', color: '#34d399', muted: true },
      { label: 'FrmGpu', value: '--', color: '#f59e0b', muted: true },
      { label: 'ATWGPU', value: '--', color: '#facc15', muted: true },
    ];
  }
  const picoFps = pico?.fps?.value ?? performance?.fps;
  return [
    { label: 'FPS', value: picoFps !== undefined ? String(picoFps) : '--', unit: pico?.fps?.maxValue !== undefined ? `/${pico.fps.maxValue}` : '', color: METRIC_COLORS.fps },
    { label: 'CPU', value: cpu, unit: '%', color: METRIC_COLORS.cpu },
    { label: 'MEM', value: mem, unit: 'MB', color: METRIC_COLORS.mem },
    { label: 'GPU', value: pico?.gpuUtil ? String(pico.gpuUtil.value) : '--', unit: pico?.gpuUtil?.unit || '%', color: METRIC_COLORS.gpu },
    { label: 'MTP', value: pico?.mtp ? String(pico.mtp.value) : '--', unit: pico?.mtp?.unit || '', color: '#60a5fa' },
    { label: 'FrmCpu', value: pico?.frameCpu ? String(pico.frameCpu.value) : '--', unit: pico?.frameCpu?.unit || '', color: '#34d399' },
    { label: 'FrmGpu', value: pico?.frameGpu ? String(pico.frameGpu.value) : '--', unit: pico?.frameGpu?.unit || '', color: '#f59e0b' },
    { label: 'ATWGPU', value: pico?.atwGpu ? String(pico.atwGpu.value) : '--', unit: pico?.atwGpu?.unit || '', color: '#facc15' },
  ];
};

const renderMetricStrip = (performance: PerformanceMetrics | null, isPicoView: boolean, showPicoFallback: boolean) => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
    {buildMetricChips(performance, isPicoView, showPicoFallback).map((chip) => (
      <div key={chip.label} style={{ display: 'flex', alignItems: 'center', gap: '7px', backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '7px 11px', opacity: chip.muted ? 0.5 : 1 }}>
        <span style={{ width: '8px', height: '8px', borderRadius: '2px', backgroundColor: chip.color, flexShrink: 0 }} />
        <span style={{ color: '#94a3b8', fontSize: '12px' }}>{chip.label}</span>
        <span style={{ color: '#fff', fontSize: '15px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{chip.value}</span>
        {chip.unit ? <span style={{ color: '#6b7280', fontSize: '11px' }}>{chip.unit}</span> : null}
      </div>
    ))}
  </div>
);

const getPicoIntroText = (performance: PerformanceMetrics | null) =>
  performance?.picoMetricsState === 'native'
    ? 'Pico 官方指标采集中，曲线会实时记录本次采集的指标时间线。'
    : '当前显示 Pico 性能回退采样，曲线会实时记录本次采集的指标时间线。';

const isLikelyPicoDevice = (device: DeviceInfo | null) => {
  const identity = [device?.manufacturer, device?.name, device?.model].filter(Boolean).join(' ').toLowerCase();
  return identity.includes('pico') || identity.includes('a9210') || identity.includes('sparrow');
};

export function PerformancePanel({
  device,
  performance,
  captureSession,
  captureSamples,
  isCapturing,
  isCaptureBusy,
  elapsedMs,
  softLimitNotice,
  captureMarkers,
  captureSessions,
  loadedSessionId,
  onToggleCapture,
  onDismissSoftLimit,
  onSaveCaptureMarkers,
  onSaveCaptureFrame,
  onSelectCaptureSession,
  onRenameCaptureSession,
  onDeleteCaptureSession,
  onExportCaptureSession,
  onImportCaptureSessions,
  onImportCapturePaths,
  onExportSession,
}: PerformancePanelProps) {
  const [importDragOver, setImportDragOver] = useState(false);

  const handleImportDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setImportDragOver(false);
    const paths = Array.from(e.dataTransfer.files || [])
      .map((f) => (f as File & { path?: string }).path || '')
      .filter(Boolean);
    if (paths.length) onImportCapturePaths(paths);
  };
  const isPicoView = performance?.provider === 'pico' || (!performance && isLikelyPicoDevice(device));
  const picoMetricsState: PicoMetricsState = performance?.picoMetricsState || 'native';
  const showPicoFallback = isPicoView && picoMetricsState !== 'native';
  const canExport = captureSamples.length > 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {softLimitNotice && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', backgroundColor: '#422006', border: '1px solid #b45309', borderRadius: '8px', padding: '10px 14px', color: '#fde68a' }}>
          <span style={{ fontSize: '13px' }}>{softLimitNotice}</span>
          <button onClick={onDismissSoftLimit} style={{ border: '1px solid #b45309', borderRadius: '6px', backgroundColor: 'transparent', color: '#fde68a', cursor: 'pointer', padding: '4px 10px', fontSize: '12px', whiteSpace: 'nowrap' }}>知道了</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '12px', alignItems: 'stretch' }}>
        <section style={{ backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
            <div style={{ color: '#fff', fontSize: '15px', fontWeight: 600 }}>{isPicoView ? 'Pico 性能诊断' : 'Android 性能诊断'}</div>
            <span style={{ color: isCapturing ? '#86efac' : '#9ca3af', backgroundColor: isCapturing ? '#14532d' : '#374151', borderRadius: '999px', padding: '3px 8px', fontSize: '12px', whiteSpace: 'nowrap' }}>
              {isCapturing ? `采集中 ${formatClock(elapsedMs)}` : '未采集'}
            </span>
          </div>
          <div style={{ color: '#9ca3af', fontSize: '13px', lineHeight: 1.5 }}>
            {isCapturing
              ? isPicoView
                ? getPicoIntroText(performance)
                : '当前设备性能采集中，曲线实时记录指标时间线，同时持续录屏（分段保存）。'
              : '性能采集已关闭。点击「开始采集」后同时开始指标采样与持续录屏，关闭采集生成报告。'}
          </div>
          <div style={{ color: '#64748b', fontSize: '12px' }}>
            {isPicoView ? '录屏会标记 Pico provider，回看时按单眼区域裁切显示。' : '录屏使用设备端 screenrecord 持续分段编码，关闭采集后缝合为连续时间轴。'}
          </div>
        </section>

        <section style={{ backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
            <div style={{ color: '#fff', fontSize: '15px', fontWeight: 600 }}>采集控制</div>
            <button
              onClick={onToggleCapture}
              disabled={isCaptureBusy || !device}
              style={{
                padding: '7px 14px',
                backgroundColor: isCaptureBusy || !device ? '#4b5563' : isCapturing ? '#7f1d1d' : '#166534',
                border: 'none',
                borderRadius: '6px',
                color: 'white',
                cursor: isCaptureBusy || !device ? 'not-allowed' : 'pointer',
                whiteSpace: 'nowrap',
                fontSize: '13px',
              }}
            >
              {isCaptureBusy ? '处理中...' : isCapturing ? '关闭采集' : '开始采集'}
            </button>
          </div>
          <div style={{ color: '#9ca3af', fontSize: '12px', lineHeight: 1.5 }}>
            一次「开始采集 → 关闭采集」生成一份采集报告：曲线填满区域，录屏在报告内合并播放，拖动时间轴联动曲线游标与画面。
          </div>
          <button
            onClick={onExportSession}
            disabled={!canExport}
            style={{
              padding: '9px 12px',
              backgroundColor: canExport ? '#353550' : '#4b5563',
              border: 'none',
              borderRadius: '6px',
              color: 'white',
              cursor: canExport ? 'pointer' : 'not-allowed',
              whiteSpace: 'nowrap',
            }}
          >导出报告</button>
        </section>
      </div>

      {renderMetricStrip(performance, isPicoView, showPicoFallback)}

      {(performance?.packageName || performance?.activityName) && (
        <div style={{ backgroundColor: '#202038', borderRadius: '8px', padding: '12px 14px', color: '#cbd5e1' }}>
          <div style={{ fontSize: '12px', color: '#888', marginBottom: '6px' }}>{isPicoView ? '当前 Pico 指标关联前台应用' : '当前 FPS 口径'}</div>
          <div style={{ fontSize: '14px', marginBottom: '4px' }}>{performance?.packageName || '--'}</div>
          <div style={{ fontSize: '12px', color: '#94a3b8', wordBreak: 'break-all' }}>{performance?.activityName || '未能解析前台 Activity'}</div>
        </div>
      )}

      <div style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '14px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>{isCapturing ? '实时采集' : '采集报告'}</div>
          <div style={{ fontSize: '12px', color: '#94a3b8' }}>{`采样 ${captureSamples.length} 条`}</div>
        </div>
        <CaptureReport
          session={captureSession}
          samples={captureSamples}
          live={isCapturing}
          elapsedMs={elapsedMs}
          markers={captureMarkers}
          onSaveMarkers={onSaveCaptureMarkers}
          onSaveFrame={onSaveCaptureFrame}
        />
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
        onDragLeave={(e) => { e.preventDefault(); setImportDragOver(false); }}
        onDrop={handleImportDrop}
        style={{ backgroundColor: '#252540', borderRadius: '8px', padding: '14px', border: `1.5px dashed ${importDragOver ? '#6d28d9' : 'transparent'}` }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '12px', alignItems: 'center', gap: '10px' }}>
          <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff' }}>采集回看</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <button
              onClick={onImportCaptureSessions}
              title="导入采集会话（.zip）；也可把 zip 或会话文件夹拖到此区域"
              style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#cbd5e1', cursor: 'pointer', padding: '5px 12px', fontSize: '12px' }}
            >导入</button>
            <div style={{ fontSize: '12px', color: '#94a3b8' }}>{`共 ${captureSessions.length} 次`}</div>
          </div>
        </div>
        {importDragOver && (
          <div style={{ color: '#c4b5fd', fontSize: '12px', marginBottom: '10px' }}>松开以导入采集会话（.zip 或会话文件夹）</div>
        )}
        <CaptureHistoryList
          sessions={captureSessions}
          selectedSessionId={loadedSessionId}
          onSelect={onSelectCaptureSession}
          onRename={onRenameCaptureSession}
          onDelete={onDeleteCaptureSession}
          onExport={onExportCaptureSession}
        />
      </div>
    </div>
  );
}
