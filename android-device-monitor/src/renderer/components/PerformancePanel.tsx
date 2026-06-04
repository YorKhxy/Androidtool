import type { DeviceInfo, PerformanceCaptureSession, PerformanceMetrics, PerformanceSample, PicoMetricsState } from '../../shared/types';
import { CaptureReport } from './CaptureReport';
import { formatClock, formatMemoryMb } from './perfFormat';

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
  onToggleCapture: () => void;
  onDismissSoftLimit: () => void;
  onExportSession: () => void;
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

const renderAndroidMetrics = (performance: PerformanceMetrics | null) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px' }}>
    {renderMetricCard('FPS', '前台渲染帧率', performance ? String(performance.fps) : '--', 'FPS', '#a855f7', `${Math.min(((performance?.fps || 0) / 120) * 100, 100)}%`)}
    {renderMetricCard('CPU', 'CPU 使用率', performance ? performance.cpuUsage.toFixed(1) : '--', '%', '#3b82f6', `${Math.min(performance?.cpuUsage || 0, 100)}%`)}
    {renderMetricCard('MEM', '内存占用', performance ? formatMemoryMb(performance.memoryUsage) : '--', 'MB', '#22c55e', `${Math.min(((performance?.memoryUsage || 0) / 8_000_000) * 100, 100)}%`)}
  </div>
);

const renderPicoMetrics = (performance: PerformanceMetrics | null) => {
  const pico = performance?.picoMetrics;
  const picoFpsValue = pico?.fps?.value ?? performance?.fps;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '16px' }}>
      {renderMetricCard('FPS', 'Pico 实时帧率', picoFpsValue !== undefined ? String(picoFpsValue) : '--', pico?.fps?.maxValue !== undefined ? `/ ${pico.fps.maxValue}` : '', '#a855f7', `${Math.min(((picoFpsValue || 0) / 120) * 100, 100)}%`)}
      {renderMetricCard('CPU', 'CPU 占用率', performance ? performance.cpuUsage.toFixed(1) : '--', '%', '#3b82f6', `${Math.min(performance?.cpuUsage || 0, 100)}%`)}
      {renderMetricCard('MEM', '内存占用', performance ? (performance.memoryUsage / 1024).toFixed(1) : '--', 'MB', '#22c55e', `${Math.min(((performance?.memoryUsage || 0) / 8_000_000) * 100, 100)}%`)}
      {renderMetricCard('GPU', 'GPU 利用率', pico?.gpuUtil ? String(pico.gpuUtil.value) : '--', pico?.gpuUtil?.unit || '%', '#ec4899', `${Math.min(pico?.gpuUtil?.value || 0, 100)}%`)}
      {renderMetricCard('MTP', 'Motion-to-Photon', pico?.mtp ? String(pico.mtp.value) : '--', pico?.mtp?.unit || '', '#60a5fa', `${Math.min(((pico?.mtp?.value || 0) / 60) * 100, 100)}%`)}
      {renderMetricCard('FrmCpu', 'CPU 帧耗时', pico?.frameCpu ? String(pico.frameCpu.value) : '--', pico?.frameCpu?.unit || '', '#22c55e', `${Math.min(((pico?.frameCpu?.value || 0) / 40) * 100, 100)}%`)}
      {renderMetricCard('FrmGpu', 'App GPU 帧耗时', pico?.frameGpu ? String(pico.frameGpu.value) : '--', pico?.frameGpu?.unit || '', '#f97316', `${Math.min(((pico?.frameGpu?.value || 0) / 40) * 100, 100)}%`)}
      {renderMetricCard('ATWGPU', 'Compositor GPU', pico?.atwGpu ? String(pico.atwGpu.value) : '--', pico?.atwGpu?.unit || '', '#facc15', `${Math.min(((pico?.atwGpu?.value || 0) / 30) * 100, 100)}%`)}
    </div>
  );
};

const renderPicoFallbackMetrics = (performance: PerformanceMetrics | null) => (
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: '16px' }}>
    {renderMetricCard('FPS', '通用前台帧率回退', performance ? String(performance.fps) : '--', 'FPS', '#a855f7', `${Math.min(((performance?.fps || 0) / 120) * 100, 100)}%`)}
    {renderMetricCard('CPU', '通用 CPU 采样回退', performance ? performance.cpuUsage.toFixed(1) : '--', '%', '#3b82f6', `${Math.min(performance?.cpuUsage || 0, 100)}%`)}
    {renderMetricCard('MEM', '通用内存采样回退', performance ? formatMemoryMb(performance.memoryUsage) : '--', 'MB', '#22c55e', `${Math.min(performance?.memoryUsage || 0, 100)}%`)}
    {renderMutedMetricCard('GPU', '等待 Pico 官方指标')}
    {renderMutedMetricCard('MTP', '等待 Pico 官方指标')}
    {renderMutedMetricCard('FrmCpu', '等待 Pico 官方指标')}
    {renderMutedMetricCard('FrmGpu', '等待 Pico 官方指标')}
    {renderMutedMetricCard('ATWGPU', '等待 Pico 官方指标')}
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
  onToggleCapture,
  onDismissSoftLimit,
  onExportSession,
}: PerformancePanelProps) {
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

      {isPicoView ? (showPicoFallback ? renderPicoFallbackMetrics(performance) : renderPicoMetrics(performance)) : renderAndroidMetrics(performance)}

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
        <CaptureReport session={captureSession} samples={captureSamples} live={isCapturing} elapsedMs={elapsedMs} />
      </div>
    </div>
  );
}
