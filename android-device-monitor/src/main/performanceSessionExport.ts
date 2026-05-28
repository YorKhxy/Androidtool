import type { PerformanceMetrics, PerformanceSample, PerformanceSessionExportPayload, PerformanceSnapshot } from '../shared/types';

const escapeXml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const formatDate = (value?: Date | string | number) => {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { hour12: false });
};

const memoryMb = (metrics: PerformanceMetrics) => metrics.memoryUsage / 1024;

const picoValue = (metrics: PerformanceMetrics, key: keyof NonNullable<PerformanceMetrics['picoMetrics']>) => {
  const value = metrics.picoMetrics?.[key];
  return value && typeof value === 'object' && 'value' in value ? value.value : '';
};

const cell = (value: unknown, styleId = '') => {
  const style = styleId ? ` ss:StyleID="${styleId}"` : '';
  const isNumber = typeof value === 'number' && Number.isFinite(value);
  return `<Cell${style}><Data ss:Type="${isNumber ? 'Number' : 'String'}">${escapeXml(value)}</Data></Cell>`;
};

const row = (values: unknown[], styleId = '') => `<Row>${values.map((value) => cell(value, styleId)).join('')}</Row>`;

const worksheet = (name: string, rows: string) => `<Worksheet ss:Name="${escapeXml(name)}"><Table>${rows}</Table></Worksheet>`;

const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

const buildSummaryRows = (payload: PerformanceSessionExportPayload) => {
  const samples = payload.samples;
  const fpsValues = samples.map((sample) => sample.metrics.fps).filter(Number.isFinite);
  const cpuValues = samples.map((sample) => sample.metrics.cpuUsage).filter(Number.isFinite);
  const memValues = samples.map((sample) => memoryMb(sample.metrics)).filter(Number.isFinite);
  return [
    row(['Field', 'Value'], 'Header'),
    row(['Device', payload.device.name || payload.device.model || payload.device.id]),
    row(['Device ID', payload.device.id]),
    row(['Started At', formatDate(payload.startedAt)]),
    row(['Ended At', formatDate(payload.endedAt)]),
    row(['Samples', samples.length]),
    row(['Snapshots', payload.snapshots.length]),
    row(['Average FPS', Number(average(fpsValues).toFixed(1))]),
    row(['Min FPS', fpsValues.length ? Number(Math.min(...fpsValues).toFixed(1)) : '']),
    row(['Average CPU %', Number(average(cpuValues).toFixed(1))]),
    row(['Peak MEM MB', memValues.length ? Number(Math.max(...memValues).toFixed(1)) : '']),
  ].join('');
};

const snapshotMarkerForSample = (sample: PerformanceSample, snapshots: PerformanceSnapshot[]) => {
  const sampleTime = new Date(sample.capturedAt).getTime();
  const markerIndex = snapshots.findIndex((snapshot) => Math.abs(new Date(snapshot.capturedAt).getTime() - sampleTime) <= 750);
  return markerIndex >= 0 ? `S${markerIndex + 1}` : '';
};

const buildRawRows = (samples: PerformanceSample[], snapshots: PerformanceSnapshot[]) => [
  row([
    'Time', 'FPS', 'CPU %', 'MEM MB', 'GPU %', 'MTP', 'FrmCpu', 'FrmGpu', 'ATWGPU',
    'Provider', 'Package', 'Activity', 'Snapshot Marker', 'Pico Raw Line',
  ], 'Header'),
  ...samples.map((sample) => row([
    formatDate(sample.capturedAt), sample.metrics.fps, Number(sample.metrics.cpuUsage.toFixed(1)),
    Number(memoryMb(sample.metrics).toFixed(1)), picoValue(sample.metrics, 'gpuUtil'),
    picoValue(sample.metrics, 'mtp'), picoValue(sample.metrics, 'frameCpu'), picoValue(sample.metrics, 'frameGpu'),
    picoValue(sample.metrics, 'atwGpu'), sample.metrics.provider, sample.metrics.packageName || '',
    sample.metrics.activityName || '', snapshotMarkerForSample(sample, snapshots), sample.metrics.picoMetrics?.rawLine || '',
  ])),
].join('');

const buildSnapshotRows = (snapshots: PerformanceSnapshot[]) => [
  row(['ID', 'Time', 'FPS', 'CPU %', 'MEM MB', 'Image Path'], 'Header'),
  ...snapshots.map((snapshot, index) => row([
    `S${index + 1}`, formatDate(snapshot.capturedAt), snapshot.metrics.fps,
    Number(snapshot.metrics.cpuUsage.toFixed(1)), Number(memoryMb(snapshot.metrics).toFixed(1)), snapshot.screenshotPath || '',
  ])),
].join('');

export function buildPerformanceSessionWorkbook(payload: PerformanceSessionExportPayload): string {
  return `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/></Style>
 </Styles>
 ${worksheet('Summary', buildSummaryRows(payload))}
 ${worksheet('Raw Data', buildRawRows(payload.samples, payload.snapshots))}
 ${worksheet('Snapshots', buildSnapshotRows(payload.snapshots))}
</Workbook>`;
}
