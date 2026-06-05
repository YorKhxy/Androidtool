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
  /** 最近一次导出的采集 zip 在 PC 上的路径；非空时显示「打开位置」按钮。 */
  lastExportedCapturePath?: string | null;
  /** 在资源管理器中定位最近导出的采集 zip。 */
  onRevealExportedCapture?: () => void;
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
  lastExportedCapturePath,
  onRevealExportedCapture,
}: PerformancePanelProps) {
  const [importDragOver, setImportDragOver] = useState(false);
  // 采集回看类型筛选：全部 / 仅安卓 / 仅 Pico（手动筛，不再跟随当前设备）。
  const [captureTypeFilter, setCaptureTypeFilter] = useState<'all' | 'android' | 'pico'>('all');
  // 回放时播放头处的样本（由 CaptureReport 上抛）：让「前台应用 + 参数」块跟随回放数据而非实时设备。
  const [playbackSample, setPlaybackSample] = useState<PerformanceSample | null>(null);

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
  // 回放（非采集且有已加载会话）时，「前台应用 + 参数」块跟随播放头处的回放样本：
  // 样本自带 provider/包名/Pico 指标，于是 Pico 回放显示 Pico 口径，安卓回放显示安卓口径，
  // 不再错误地显示当前实时设备的口径。无回放时仍用实时 performance。
  const isPlayback = !isCapturing && !!captureSession;
  const blockPerformance = isPlayback ? (playbackSample?.metrics ?? captureSamples[0]?.metrics ?? null) : performance;
  const blockIsPicoView = isPlayback ? blockPerformance?.provider === 'pico' : isPicoView;
  const blockShowPicoFallback = blockIsPicoView && (blockPerformance?.picoMetricsState ?? 'native') !== 'native';
  // 按所选类型筛选回看列表：provider 以 pico 开头视为 Pico，否则安卓。
  const filteredSessions = captureSessions.filter((s) =>
    captureTypeFilter === 'all'
      ? true
      : captureTypeFilter === 'pico'
        ? s.provider.startsWith('pico')
        : !s.provider.startsWith('pico'),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {softLimitNotice && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', backgroundColor: '#422006', border: '1px solid #b45309', borderRadius: '8px', padding: '10px 14px', color: '#fde68a' }}>
          <span style={{ fontSize: '13px' }}>{softLimitNotice}</span>
          <button onClick={onDismissSoftLimit} style={{ border: '1px solid #b45309', borderRadius: '6px', backgroundColor: 'transparent', color: '#fde68a', cursor: 'pointer', padding: '4px 10px', fontSize: '12px', whiteSpace: 'nowrap' }}>知道了</button>
        </div>
      )}

      {/* 顶部两列：左=采集控制 +「前台应用/参数」合并块，右=采集回看（性能页右上角）。
          stretch 让左列拉到与右侧回看等高，合并块 flex:1 填满采集控制下方空白。 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: '12px', alignItems: 'stretch' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <section style={{ backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center' }}>
            <div style={{ color: '#fff', fontSize: '15px', fontWeight: 600 }}>采集控制</div>
            <span style={{ color: isCapturing ? '#86efac' : '#9ca3af', backgroundColor: isCapturing ? '#14532d' : '#374151', borderRadius: '999px', padding: '3px 8px', fontSize: '12px', whiteSpace: 'nowrap' }}>
              {isCapturing ? `采集中 ${formatClock(elapsedMs)}` : '未采集'}
            </span>
          </div>
          <div style={{ color: '#9ca3af', fontSize: '12px', lineHeight: 1.5 }}>
            一次「开始采集 → 关闭采集」生成一份采集报告：曲线填满区域，录屏在报告内合并播放，拖动时间轴联动曲线游标与画面。
          </div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
            <button
              onClick={onToggleCapture}
              disabled={isCaptureBusy || !device}
              style={{
                flex: 1,
                minWidth: '120px',
                padding: '9px 14px',
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
            <button
              onClick={onExportSession}
              disabled={!canExport}
              style={{
                flex: 1,
                minWidth: '120px',
                padding: '9px 12px',
                backgroundColor: canExport ? '#353550' : '#4b5563',
                border: 'none',
                borderRadius: '6px',
                color: 'white',
                cursor: canExport ? 'pointer' : 'not-allowed',
                whiteSpace: 'nowrap',
                fontSize: '13px',
              }}
            >导出报告</button>
          </div>
        </section>

        {/* 合并块：前台应用在上，参数指标条在下；flex:1 撑满左列剩余高度。 */}
        <section style={{ flex: 1, backgroundColor: '#202038', border: '1px solid #353550', borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px', justifyContent: 'center' }}>
          {(blockPerformance?.packageName || blockPerformance?.activityName) && (
            <div>
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '6px' }}>{blockIsPicoView ? '当前 Pico 指标关联前台应用' : '当前 FPS 口径'}</div>
              <div style={{ fontSize: '14px', color: '#cbd5e1', marginBottom: '4px' }}>{blockPerformance?.packageName || '--'}</div>
              <div style={{ fontSize: '12px', color: '#94a3b8', wordBreak: 'break-all' }}>{blockPerformance?.activityName || '未能解析前台 Activity'}</div>
            </div>
          )}
          {renderMetricStrip(blockPerformance, blockIsPicoView, blockShowPicoFallback)}
        </section>
        </div>

        <section
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
          onDragLeave={(e) => { e.preventDefault(); setImportDragOver(false); }}
          onDrop={handleImportDrop}
          style={{ backgroundColor: '#202038', border: `1px solid ${importDragOver ? '#6d28d9' : '#353550'}`, borderRadius: '8px', padding: '14px', display: 'flex', flexDirection: 'column', gap: '10px' }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, color: '#fff' }}>采集回看</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              {lastExportedCapturePath && onRevealExportedCapture && (
                <button
                  onClick={onRevealExportedCapture}
                  title={`在资源管理器中定位最近导出的采集：${lastExportedCapturePath}`}
                  style={{ border: 'none', borderRadius: '6px', backgroundColor: '#166534', color: '#fff', cursor: 'pointer', padding: '5px 12px', fontSize: '12px', whiteSpace: 'nowrap' }}
                >📂 打开位置</button>
              )}
              <button
                onClick={onImportCaptureSessions}
                title="导入采集会话（.zip）；也可把 zip 或会话文件夹拖到此区域"
                style={{ border: '1px solid #475569', borderRadius: '6px', backgroundColor: 'transparent', color: '#cbd5e1', cursor: 'pointer', padding: '5px 12px', fontSize: '12px' }}
              >导入</button>
              <div style={{ fontSize: '12px', color: '#94a3b8' }}>{`共 ${filteredSessions.length} 次`}</div>
            </div>
          </div>
          {/* 类型筛选：手动按全部 / 安卓 / Pico 筛选回看，不跟随当前设备。 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: '#94a3b8' }}>类型</span>
            <div style={{ display: 'inline-flex', backgroundColor: '#1a1a2e', border: '1px solid #353550', borderRadius: '8px', padding: '2px' }}>
              {([
                { key: 'all', label: '全部' },
                { key: 'android', label: '安卓' },
                { key: 'pico', label: 'Pico' },
              ] as const).map((opt) => {
                const active = captureTypeFilter === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => setCaptureTypeFilter(opt.key)}
                    style={{ border: 'none', borderRadius: '6px', cursor: 'pointer', padding: '4px 14px', fontSize: '12px', backgroundColor: active ? '#4a90d9' : 'transparent', color: active ? '#fff' : '#94a3b8', fontWeight: active ? 600 : 400 }}
                  >{opt.label}</button>
                );
              })}
            </div>
          </div>
          {importDragOver && (
            <div style={{ color: '#c4b5fd', fontSize: '12px' }}>松开以导入采集会话（.zip 或会话文件夹）</div>
          )}
          {/* 列表可能较长，限高并独立滚动，避免顶部行被撑过高。 */}
          <div style={{ maxHeight: '232px', overflowY: 'auto', paddingRight: filteredSessions.length ? '2px' : 0 }}>
            <CaptureHistoryList
              sessions={filteredSessions}
              selectedSessionId={loadedSessionId}
              onSelect={onSelectCaptureSession}
              onRename={onRenameCaptureSession}
              onDelete={onDeleteCaptureSession}
              onExport={onExportCaptureSession}
            />
          </div>
        </section>
      </div>

      {/* 主区：采集报告（曲线 + 单眼视频）+ 参数过滤。 */}
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
          onActiveSampleChange={setPlaybackSample}
        />
      </div>
    </div>
  );
}
