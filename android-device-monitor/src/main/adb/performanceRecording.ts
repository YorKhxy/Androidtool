import { execFile, type ExecFileOptions } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  PerformanceMetrics,
  PerformanceRecording,
  PerformanceRecordingOptions,
  PerformanceRecordingProvider,
  PerformanceSample,
} from '../../shared/types';

type ExecAdb = (args: string[], options?: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
type ResolveAdbPath = () => Promise<string>;
type GetPerformanceMetrics = (deviceId: string) => Promise<PerformanceMetrics>;

type RecordingInput = {
  deviceId: string;
  isPico: boolean;
  baseDir: string;
  options: PerformanceRecordingOptions;
};

const RECORDING_SAMPLE_INTERVAL_MS = 1000;
const DEFAULT_BIT_RATE_MBPS = 8;
const VALID_DURATIONS = new Set([10, 30, 60]);

const sanitizeSegment = (value: string) => {
  return value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'device';
};

const formatDateFolder = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const toPortablePath = (value: string) => value.split(path.sep).join('/');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type RecordingSignal = {
  cancelled: boolean;
};

export class PerformanceRecordingManager {
  private readonly activeRecordings = new Set<string>();

  constructor(
    private readonly execAdb: ExecAdb,
    private readonly resolveAdbPath: ResolveAdbPath,
    private readonly getPerformanceMetrics: GetPerformanceMetrics
  ) {}

  async startRecording(input: RecordingInput): Promise<PerformanceRecording> {
    const durationSeconds = this.normalizeDuration(input.options.durationSeconds);
    const bitRateMbps = this.normalizeBitRate(input.options.bitRateMbps);
    if (this.activeRecordings.has(input.deviceId)) {
      throw new Error('当前设备已有性能录制正在进行。');
    }

    this.activeRecordings.add(input.deviceId);
    const startedAt = new Date();
    const provider = this.resolveProvider(input.isPico);
    const recordingDir = path.join(
      input.baseDir,
      'performance-recordings',
      formatDateFolder(startedAt),
      sanitizeSegment(input.deviceId)
    );
    await fs.mkdir(recordingDir, { recursive: true });

    const timestampPart = startedAt.toISOString().replace(/[:.]/g, '-');
    const safeDeviceId = sanitizeSegment(input.deviceId);
    const id = `${safeDeviceId}-${startedAt.getTime()}`;
    const remotePath = `/sdcard/${safeDeviceId}-${timestampPart}-performance.mp4`;
    const relativeDir = path.join('performance-recordings', formatDateFolder(startedAt), sanitizeSegment(input.deviceId));
    const videoFileName = `${safeDeviceId}-${timestampPart}.mp4`;
    const manifestFileName = `${safeDeviceId}-${timestampPart}.json`;
    const videoPath = path.join(recordingDir, videoFileName);
    const manifestPath = path.join(recordingDir, manifestFileName);
    const videoRelativePath = toPortablePath(path.join(relativeDir, videoFileName));
    const manifestRelativePath = toPortablePath(path.join(relativeDir, manifestFileName));
    const samples: PerformanceSample[] = [];
    const signal: RecordingSignal = { cancelled: false };

    try {
      const recordPromise = this.recordOnDevice(input.deviceId, remotePath, durationSeconds, bitRateMbps);
      const samplePromise = this.collectSamples(input.deviceId, durationSeconds, samples, signal);

      await recordPromise;
      signal.cancelled = true;
      await samplePromise;
      await this.execAdb(['-s', input.deviceId, 'pull', remotePath, videoPath], {
        timeout: Math.max(30000, durationSeconds * 3000),
        maxBuffer: 1024 * 1024 * 2,
      });
      await this.cleanupRemoteRecording(input.deviceId, remotePath);

      const endedAt = new Date();
      const appSample = [...samples]
        .reverse()
        .find((sample) => sample.metrics.packageName || sample.metrics.activityName)
        ?.metrics;

      const recording: PerformanceRecording = {
        id,
        deviceId: input.deviceId,
        provider,
        status: 'completed',
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        videoRelativePath,
        manifestRelativePath,
        samples,
        packageName: appSample?.packageName,
        activityName: appSample?.activityName,
      };

      await this.writeManifest(manifestPath, recording);
      return recording;
    } catch (error) {
      signal.cancelled = true;
      await this.cleanupRemoteRecording(input.deviceId, remotePath);
      await fs.rm(videoPath, { force: true }).catch(() => undefined);
      const endedAt = new Date();
      const recording: PerformanceRecording = {
        id,
        deviceId: input.deviceId,
        provider,
        status: 'failed',
        startedAt,
        endedAt,
        durationMs: endedAt.getTime() - startedAt.getTime(),
        manifestRelativePath,
        samples,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.writeManifest(manifestPath, recording).catch(() => undefined);
      throw error;
    } finally {
      this.activeRecordings.delete(input.deviceId);
    }
  }

  private resolveProvider(isPico: boolean): PerformanceRecordingProvider {
    return isPico ? 'pico-screenrecord' : 'android-screenrecord';
  }

  private normalizeDuration(durationSeconds: number): 10 | 30 | 60 {
    if (!VALID_DURATIONS.has(durationSeconds)) {
      throw new Error('性能录制只支持 10 秒、30 秒或 60 秒。');
    }
    return durationSeconds as 10 | 30 | 60;
  }

  private normalizeBitRate(bitRateMbps?: number): number {
    const value = Number.isFinite(bitRateMbps) ? Number(bitRateMbps) : DEFAULT_BIT_RATE_MBPS;
    return Math.max(2, Math.min(20, Math.round(value)));
  }

  private async recordOnDevice(
    deviceId: string,
    remotePath: string,
    durationSeconds: number,
    bitRateMbps: number
  ): Promise<void> {
    const adbPath = await this.resolveAdbPath();
    const args = [
      '-s',
      deviceId,
      'shell',
      'screenrecord',
      '--time-limit',
      String(durationSeconds),
      '--bit-rate',
      String(bitRateMbps * 1000 * 1000),
      remotePath,
    ];

    const result = await this.execAdbProcess(adbPath, args, {
      timeout: (durationSeconds + 15) * 1000,
      maxBuffer: 1024 * 1024 * 2,
    });
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (result.exitCode !== 0) {
      throw new Error(output || `screenrecord exited with code ${result.exitCode}`);
    }
  }

  private async collectSamples(
    deviceId: string,
    durationSeconds: number,
    samples: PerformanceSample[],
    signal: RecordingSignal
  ): Promise<void> {
    const deadline = Date.now() + durationSeconds * 1000;
    while (!signal.cancelled && Date.now() < deadline) {
      try {
        const metrics = await this.getPerformanceMetrics(deviceId);
        if (signal.cancelled) {
          return;
        }
        samples.push({
          id: `${sanitizeSegment(deviceId)}-${Date.now()}-${samples.length}`,
          deviceId,
          capturedAt: new Date(),
          metrics,
        });
      } catch {
        // Recording should not fail only because one metrics sample failed.
      }
      await delay(RECORDING_SAMPLE_INTERVAL_MS);
    }
  }

  private async cleanupRemoteRecording(deviceId: string, remotePath: string): Promise<void> {
    await this.execAdb(['-s', deviceId, 'shell', 'rm', '-f', remotePath], { timeout: 8000 }).catch(() => undefined);
    await this.execAdb(['-s', deviceId, 'shell', 'pkill', '-2', 'screenrecord'], { timeout: 8000 }).catch(() => undefined);
    await this.execAdb(['-s', deviceId, 'shell', 'killall', '-2', 'screenrecord'], { timeout: 8000 }).catch(() => undefined);
    await delay(800);
  }

  private execAdbProcess(
    adbPath: string,
    args: string[],
    options: ExecFileOptions
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      execFile(adbPath, args, options, (error, stdout, stderr) => {
        const stdoutText = Buffer.isBuffer(stdout) ? stdout.toString() : String(stdout ?? '');
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr ?? '');
        if (!error) {
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode: 0 });
          return;
        }

        const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode: code });
          return;
        }

        reject(error);
      });
    });
  }

  private async writeManifest(manifestPath: string, recording: PerformanceRecording): Promise<void> {
    await fs.writeFile(manifestPath, `${JSON.stringify(recording, null, 2)}\n`, 'utf8');
  }
}
