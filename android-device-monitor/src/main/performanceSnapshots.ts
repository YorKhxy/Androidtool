import * as fs from 'fs/promises';
import * as path from 'path';
import { nativeImage } from 'electron';
import type { PerformanceSnapshot } from '../shared/types';
import type { CapturedPerformanceSnapshot } from './adb/runtimeInspector';
import type { CapturedScreenshot } from './adb/screenshotCapture';

type AppPathResolver = {
  getAppPath(): string;
  isPackaged: boolean;
};

type PersistPerformanceSnapshotInput = {
  deviceId: string;
  snapshot: CapturedPerformanceSnapshot;
  trigger: PerformanceSnapshot['trigger'];
  note?: string;
};

const sanitizeSnapshotSegment = (value: string) => {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'device';
};

const formatDateFolder = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const FONT_5X7: Record<string, string[]> = {
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  '/': ['00001', '00010', '00100', '01000', '10000', '00000', '00000'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  '%': ['11001', '11010', '00100', '01000', '10110', '00110', '00000'],
  '_': ['00000', '00000', '00000', '00000', '00000', '00000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '11100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01110'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00001', '00001', '00001', '00001', '10001', '10001', '01110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
};

const setPixel = (bitmap: Buffer, width: number, height: number, x: number, y: number, color: [number, number, number, number]) => {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const index = (y * width + x) * 4;
  bitmap[index] = color[2];
  bitmap[index + 1] = color[1];
  bitmap[index + 2] = color[0];
  bitmap[index + 3] = color[3];
};

const fillRect = (
  bitmap: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  rectWidth: number,
  rectHeight: number,
  color: [number, number, number, number]
) => {
  for (let row = y; row < y + rectHeight; row += 1) {
    for (let col = x; col < x + rectWidth; col += 1) {
      setPixel(bitmap, width, height, col, row, color);
    }
  }
};

const drawText = (bitmap: Buffer, width: number, height: number, x: number, y: number, text: string, scale = 2) => {
  let cursorX = x;
  const normalized = text.toUpperCase();
  for (const char of normalized) {
    const glyph = FONT_5X7[char] || FONT_5X7[' '];
    for (let row = 0; row < glyph.length; row += 1) {
      for (let col = 0; col < glyph[row].length; col += 1) {
        if (glyph[row][col] === '1') {
          fillRect(bitmap, width, height, cursorX + col * scale, y + row * scale, scale, scale, [255, 255, 255, 255]);
        }
      }
    }
    cursorX += 6 * scale;
  }
};

const formatMetricValue = (value?: number, unit = '') => {
  if (value === undefined || Number.isNaN(value)) return '--';
  const rounded = Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.00$/, '');
  return `${rounded}${unit}`;
};

const formatMemoryMb = (memoryKb: number) => `${(memoryKb / 1024).toFixed(1)}MB`;

const createNativeImageFromScreenshot = (screenshot: CapturedScreenshot) => {
  if (screenshot.kind === 'bitmap') {
    return nativeImage.createFromBitmap(screenshot.bitmap, { width: screenshot.width, height: screenshot.height });
  }

  return nativeImage.createFromBuffer(screenshot.buffer);
};

const buildSnapshotMetricLines = (input: PersistPerformanceSnapshotInput): string[] => {
  const metrics = input.snapshot.metrics;
  const pico = metrics.picoMetrics;
  const capturedAt = input.snapshot.capturedAt.toLocaleString('zh-CN', { hour12: false });
  if (metrics.provider === 'pico') {
    return [
      `PICO ${capturedAt}`,
      `FPS ${pico?.fps?.raw || formatMetricValue(pico?.fps?.value)}  MTP ${pico?.mtp?.raw || formatMetricValue(pico?.mtp?.value, 'MS')}`,
      `CPU USAGE ${formatMetricValue(metrics.cpuUsage, '%')}  MEM ${formatMemoryMb(metrics.memoryUsage)}`,
      `CPU ${pico?.frameCpu?.raw || formatMetricValue(pico?.frameCpu?.value, 'MS')}  GPU ${pico?.frameGpu?.raw || formatMetricValue(pico?.frameGpu?.value, 'MS')}  ATW ${pico?.atwGpu?.raw || formatMetricValue(pico?.atwGpu?.value, 'MS')}`,
      `GPU UTIL ${pico?.gpuUtil?.raw || formatMetricValue(pico?.gpuUtil?.value, '%')}`,
      `APP ${metrics.packageName || '--'}`,
    ];
  }

  return [
    `ANDROID ${capturedAt}`,
    `FPS ${formatMetricValue(metrics.fps)}  CPU ${formatMetricValue(metrics.cpuUsage, '%')}`,
    `MEM ${formatMemoryMb(metrics.memoryUsage)}`,
    `APP ${metrics.packageName || '--'}`,
  ];
};

function buildAnnotatedSnapshotImage(input: PersistPerformanceSnapshotInput): Buffer {
  const baseImage = createNativeImageFromScreenshot(input.snapshot.screenshot);
  const croppedImage = input.snapshot.metrics.provider === 'pico'
    ? baseImage.crop({ x: 0, y: 0, width: Math.max(1, Math.floor(baseImage.getSize().width / 2)), height: baseImage.getSize().height })
    : baseImage;
  const size = croppedImage.getSize();
  const bitmap = Buffer.from(croppedImage.toBitmap());
  const lines = buildSnapshotMetricLines(input);
  const scale = size.width >= 900 ? 3 : 2;
  const lineHeight = 10 * scale;
  const padding = 8 * scale;
  const panelHeight = padding * 2 + lines.length * lineHeight;
  const panelY = Math.max(0, size.height - panelHeight);

  fillRect(bitmap, size.width, size.height, 0, panelY, size.width, panelHeight, [0, 0, 0, 230]);
  lines.forEach((line, index) => drawText(bitmap, size.width, size.height, padding, panelY + padding + index * lineHeight, line, scale));

  return nativeImage.createFromBitmap(bitmap, { width: size.width, height: size.height }).toPNG();
}

export function resolveRuntimeAppRoot(app: AppPathResolver): string {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }

  const appPath = path.normalize(app.getAppPath());
  const distMainSuffix = path.normalize(path.join('dist', 'main', 'main'));
  if (appPath.endsWith(distMainSuffix)) {
    return path.resolve(appPath, '..', '..', '..');
  }

  const distSuffix = path.normalize(path.join('dist', 'main'));
  if (appPath.endsWith(distSuffix)) {
    return path.resolve(appPath, '..', '..');
  }

  return appPath;
}

export async function persistPerformanceSnapshot(
  baseDir: string,
  input: PersistPerformanceSnapshotInput
): Promise<PerformanceSnapshot> {
  const capturedAt = input.snapshot.capturedAt;
  const snapshotsDir = path.join(
    baseDir,
    'performance-snapshots',
    formatDateFolder(capturedAt),
    sanitizeSnapshotSegment(input.deviceId)
  );
  await fs.mkdir(snapshotsDir, { recursive: true });

  const timestampPart = capturedAt.toISOString().replace(/[:.]/g, '-');
  const fileName = `${sanitizeSnapshotSegment(input.deviceId)}-${timestampPart}.png`;
  const screenshotPath = path.join(snapshotsDir, fileName);
  await fs.writeFile(screenshotPath, buildAnnotatedSnapshotImage(input));

  return {
    id: `${sanitizeSnapshotSegment(input.deviceId)}-${capturedAt.getTime()}`,
    deviceId: input.deviceId,
    capturedAt,
    metrics: input.snapshot.metrics,
    screenshotPath,
    packageName: input.snapshot.metrics.packageName,
    activityName: input.snapshot.metrics.activityName,
    trigger: input.trigger,
    note: input.note,
  };
}
