import type { MetricReading, PerformanceMetrics, PerformanceSnapshot, PicoMetricsState } from '../../shared/types';

type PerformancePanelProps = {
  performance: PerformanceMetrics | null;
  snapshots: PerformanceSnapshot[];
  isCapturingSnapshot: boolean;
  onCaptureSnapshot: () => void;
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
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '16px' }}>
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
      {renderMetricCard(
        'NET',
        '网络速度',
        performance ? String(performance.networkSpeed) : '--',
        'KB/s',
        '#f59e0b',
        `${Math.min(((performance?.networkSpeed || 0) / 1000) * 100, 100)}%`
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
  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '6px', fontSize: '12px' }}>
    <div style={{ color: '#93c5fd' }}>{`CPU ${snapshot.metrics.cpuUsage.toFixed(1)}%`}</div>
    <div style={{ color: '#86efac' }}>{`MEM ${formatMemoryMb(snapshot.metrics.memoryUsage)}MB`}</div>
    <div style={{ color: '#d8b4fe' }}>{`FPS ${snapshot.metrics.fps}`}</div>
    <div style={{ color: '#fcd34d' }}>{`NET ${snapshot.metrics.networkSpeed}`}</div>
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

export function PerformancePanel({
  performance,
  snapshots,
  isCapturingSnapshot,
  onCaptureSnapshot,
}: PerformancePanelProps) {
  const isPicoView = performance?.provider === 'pico';
  const picoMetricsState: PicoMetricsState = performance?.picoMetricsState || 'native';
  const showPicoFallback = isPicoView && picoMetricsState !== 'native';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
        <div style={{ color: '#9ca3af', fontSize: '13px' }}>
          {isPicoView
            ? getPicoIntroText(performance)
            : '观察实时指标后，可以把当前画面和指标绑定成一条性能快照。'}
        </div>
        <button
          onClick={onCaptureSnapshot}
          disabled={isCapturingSnapshot}
          style={{
            padding: '8px 16px',
            backgroundColor: isCapturingSnapshot ? '#4b5563' : '#4a90d9',
            border: 'none',
            borderRadius: '6px',
            color: 'white',
            cursor: isCapturingSnapshot ? 'not-allowed' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {isCapturingSnapshot ? '抓取中...' : '抓取性能快照'}
        </button>
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
        <div style={{ fontSize: '14px', fontWeight: 600, color: '#fff', marginBottom: '12px' }}>性能快照</div>
        {snapshots.length === 0 ? (
          <div style={{ color: '#6b7280', fontSize: '13px' }}>还没有快照，先抓一张看看当时的页面和指标。</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '12px' }}>
            {snapshots.map((snapshot) => {
              const screenshotUrl = createScreenshotUrl(snapshot.screenshotPath);
              const isPicoSnapshot = snapshot.metrics.provider === 'pico';
              return (
                <div key={snapshot.id} style={{ backgroundColor: '#202038', borderRadius: '8px', overflow: 'hidden' }}>
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
                    {snapshot.screenshotSkippedReason && (
                      <div style={{ color: '#fbbf24', fontSize: '12px', marginBottom: '8px' }}>{snapshot.screenshotSkippedReason}</div>
                    )}
                    {isPicoSnapshot ? renderPicoSnapshotSummary(snapshot) : renderAndroidSnapshotSummary(snapshot)}
                    {renderSnapshotPath(snapshot)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
