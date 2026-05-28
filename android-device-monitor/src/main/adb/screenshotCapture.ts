import type { ExecFileOptions } from 'child_process';
import { logger } from '../logger';

type ExecAdbBuffer = (args: string[], options?: ExecFileOptions) => Promise<{ stdout: Buffer; stderr: Buffer }>;

export type ScreenshotCaptureSource = 'adb-raw-framebuffer' | 'adb-png-screencap';

export type CapturedScreenshot =
  | {
      kind: 'bitmap';
      source: ScreenshotCaptureSource;
      bitmap: Buffer;
      width: number;
      height: number;
      pixelFormat: number;
      colorSpace?: number;
    }
  | {
      kind: 'png';
      source: ScreenshotCaptureSource;
      buffer: Buffer;
    };

type SnapshotCaptureProvider = {
  readonly name: ScreenshotCaptureSource;
  capture(deviceId: string): Promise<CapturedScreenshot>;
};

type RawHeader = {
  width: number;
  height: number;
  pixelFormat: number;
  colorSpace?: number;
  headerSize: number;
  bytesPerPixel: number;
  payloadBytes: number;
};

const RAW_CAPTURE_MAX_BUFFER = 128 * 1024 * 1024;
const PNG_CAPTURE_MAX_BUFFER = 32 * 1024 * 1024;
const MAX_REASONABLE_DIMENSION = 16384;

const PIXEL_FORMAT_RGBA_8888 = 1;
const PIXEL_FORMAT_RGBX_8888 = 2;
const PIXEL_FORMAT_RGB_888 = 3;
const PIXEL_FORMAT_RGB_565 = 4;
const PIXEL_FORMAT_BGRA_8888 = 5;

export class AdbScreenshotCapture {
  private readonly providers: SnapshotCaptureProvider[];

  constructor(execAdbBuffer: ExecAdbBuffer) {
    this.providers = [
      new AdbRawFramebufferSnapshotProvider(execAdbBuffer),
      new AdbPngScreencapSnapshotProvider(execAdbBuffer),
    ];
  }

  async capture(deviceId: string): Promise<CapturedScreenshot> {
    const failures: string[] = [];

    for (const provider of this.providers) {
      try {
        return await provider.capture(deviceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${provider.name}: ${message}`);
        logger.warn(`AdbScreenshotCapture: ${provider.name} failed, trying next provider:`, error);
      }
    }

    throw new Error(`设备截图失败：${failures.join('；')}`);
  }
}

class AdbRawFramebufferSnapshotProvider implements SnapshotCaptureProvider {
  readonly name = 'adb-raw-framebuffer' as const;

  constructor(private readonly execAdbBuffer: ExecAdbBuffer) {}

  async capture(deviceId: string): Promise<CapturedScreenshot> {
    const { stdout } = await this.execAdbBuffer(['-s', deviceId, 'exec-out', 'screencap'], {
      timeout: 15000,
      maxBuffer: RAW_CAPTURE_MAX_BUFFER,
    });

    return decodeRawScreencap(stdout, this.name);
  }
}

class AdbPngScreencapSnapshotProvider implements SnapshotCaptureProvider {
  readonly name = 'adb-png-screencap' as const;

  constructor(private readonly execAdbBuffer: ExecAdbBuffer) {}

  async capture(deviceId: string): Promise<CapturedScreenshot> {
    const { stdout } = await this.execAdbBuffer(['-s', deviceId, 'exec-out', 'screencap', '-p'], {
      timeout: 20000,
      maxBuffer: PNG_CAPTURE_MAX_BUFFER,
    });

    if (isPngBuffer(stdout)) {
      return { kind: 'png', source: this.name, buffer: stdout };
    }

    const normalized = Buffer.from(stdout.toString('binary').replace(/\r\n/g, '\n'), 'binary');
    if (isPngBuffer(normalized)) {
      return { kind: 'png', source: this.name, buffer: normalized };
    }

    throw new Error('设备截图失败，未返回有效 PNG 数据。');
  }
}

export function decodeRawScreencap(buffer: Buffer, source: ScreenshotCaptureSource = 'adb-raw-framebuffer'): CapturedScreenshot {
  const header = parseRawHeader(buffer);
  const pixelData = buffer.subarray(header.headerSize, header.headerSize + header.payloadBytes);

  return {
    kind: 'bitmap',
    source,
    bitmap: convertRawPixelsToElectronBitmap(pixelData, header.width, header.height, header.pixelFormat),
    width: header.width,
    height: header.height,
    pixelFormat: header.pixelFormat,
    colorSpace: header.colorSpace,
  };
}

function parseRawHeader(buffer: Buffer): RawHeader {
  const header = ([16, 12] as const)
    .map((headerSize) => readRawHeader(buffer, headerSize))
    .find((candidate): candidate is RawHeader => Boolean(candidate));

  if (!header) {
    const preview = buffer.subarray(0, 96).toString('utf8').replace(/\s+/g, ' ').trim();
    throw new Error(`设备未返回有效 raw framebuffer 数据${preview ? `：${preview}` : ''}`);
  }

  return header;
}

function readRawHeader(buffer: Buffer, headerSize: 12 | 16): RawHeader | null {
  if (buffer.length < headerSize) {
    return null;
  }

  const width = buffer.readUInt32LE(0);
  const height = buffer.readUInt32LE(4);
  const pixelFormat = buffer.readUInt32LE(8);
  const bytesPerPixel = getBytesPerPixel(pixelFormat);
  if (!bytesPerPixel || !isReasonableDimension(width) || !isReasonableDimension(height)) {
    return null;
  }

  const payloadBytes = width * height * bytesPerPixel;
  if (!Number.isSafeInteger(payloadBytes) || buffer.length < headerSize + payloadBytes) {
    return null;
  }

  return {
    width,
    height,
    pixelFormat,
    colorSpace: headerSize === 16 ? buffer.readUInt32LE(12) : undefined,
    headerSize,
    bytesPerPixel,
    payloadBytes,
  };
}

function isReasonableDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= MAX_REASONABLE_DIMENSION;
}

function getBytesPerPixel(pixelFormat: number): number | null {
  if (
    pixelFormat === PIXEL_FORMAT_RGBA_8888 ||
    pixelFormat === PIXEL_FORMAT_RGBX_8888 ||
    pixelFormat === PIXEL_FORMAT_BGRA_8888
  ) {
    return 4;
  }

  if (pixelFormat === PIXEL_FORMAT_RGB_888) {
    return 3;
  }

  if (pixelFormat === PIXEL_FORMAT_RGB_565) {
    return 2;
  }

  return null;
}

function convertRawPixelsToElectronBitmap(pixelData: Buffer, width: number, height: number, pixelFormat: number): Buffer {
  const bitmap = Buffer.alloc(width * height * 4);
  const totalPixels = width * height;

  if (pixelFormat === PIXEL_FORMAT_BGRA_8888) {
    pixelData.copy(bitmap, 0, 0, bitmap.length);
    return bitmap;
  }

  if (pixelFormat === PIXEL_FORMAT_RGBA_8888 || pixelFormat === PIXEL_FORMAT_RGBX_8888) {
    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
      const sourceIndex = pixel * 4;
      const targetIndex = pixel * 4;
      bitmap[targetIndex] = pixelData[sourceIndex + 2];
      bitmap[targetIndex + 1] = pixelData[sourceIndex + 1];
      bitmap[targetIndex + 2] = pixelData[sourceIndex];
      bitmap[targetIndex + 3] = pixelFormat === PIXEL_FORMAT_RGBX_8888 ? 255 : pixelData[sourceIndex + 3];
    }
    return bitmap;
  }

  if (pixelFormat === PIXEL_FORMAT_RGB_888) {
    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
      const sourceIndex = pixel * 3;
      const targetIndex = pixel * 4;
      bitmap[targetIndex] = pixelData[sourceIndex + 2];
      bitmap[targetIndex + 1] = pixelData[sourceIndex + 1];
      bitmap[targetIndex + 2] = pixelData[sourceIndex];
      bitmap[targetIndex + 3] = 255;
    }
    return bitmap;
  }

  if (pixelFormat === PIXEL_FORMAT_RGB_565) {
    for (let pixel = 0; pixel < totalPixels; pixel += 1) {
      const sourceIndex = pixel * 2;
      const value = pixelData.readUInt16LE(sourceIndex);
      const targetIndex = pixel * 4;
      bitmap[targetIndex] = scaleRgb565ToByte(value & 0x1f);
      bitmap[targetIndex + 1] = scaleRgb565ToByte((value >> 5) & 0x3f, 63);
      bitmap[targetIndex + 2] = scaleRgb565ToByte((value >> 11) & 0x1f);
      bitmap[targetIndex + 3] = 255;
    }
    return bitmap;
  }

  throw new Error(`不支持的 raw framebuffer 像素格式：${pixelFormat}`);
}

function scaleRgb565ToByte(value: number, max = 31): number {
  return Math.round((value / max) * 255);
}

function isPngBuffer(buffer: Buffer): boolean {
  return (
    buffer.length > 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  );
}
