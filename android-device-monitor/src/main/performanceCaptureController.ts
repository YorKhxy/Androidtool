import { IPC_CHANNELS } from '../shared/ipc/channels';
import { logger } from './logger';
import type { ADBManager } from './adb/ADBManager';
import type { PerformanceCaptureStore } from './performanceCaptureStore';
import type {
  CaptureSamplePayload,
  CaptureSizeLimitPayload,
  PerformanceCaptureSession,
  PerformanceMetrics,
  PerformanceSample,
} from '../shared/types';

// 采集编排（Phase 14）。点「开始采集」即同时启动「性能采样循环」与「持续分段录制」：
//   - 采样每秒一次 getPerformanceMetrics → 流式 appendSamples 落盘 → 实时推送渲染层（实时曲线）；
//   - 录制由 ADBManager.captureRecorder 负责，分段落盘后回调 appendSegment + 累计体积；
//   - 软上限：录制达 30 分钟或视频累计 2GB（先到先触发）推送一次提醒，不强制停止；
//   - 点「关闭采集」停采样 + 停录制 + finalize 会话。

const SAMPLE_INTERVAL_MS = 1000;
const SOFT_LIMIT_DURATION_MS = 30 * 60 * 1000;
const SOFT_LIMIT_SIZE_BYTES = 2 * 1024 * 1024 * 1024;

type ActiveSession = {
  sessionId: string;
  deviceId: string;
  startedAtMs: number;
  timer: NodeJS.Timeout | null;
  sampleSeq: number;
  totalVideoBytes: number;
  softLimitNotified: boolean;
};

export class PerformanceCaptureController {
  private readonly active = new Map<string, ActiveSession>();

  constructor(
    private readonly adb: ADBManager,
    private readonly store: PerformanceCaptureStore,
    private readonly emit: (channel: string, payload: unknown) => void
  ) {}

  isActive(deviceId: string): boolean {
    return this.active.has(deviceId);
  }

  async start(deviceId: string): Promise<PerformanceCaptureSession> {
    if (this.active.has(deviceId)) {
      throw new Error('当前设备已在采集中。');
    }

    // 先取一次指标，拿到前台应用写进会话元数据（失败不阻塞开始）。
    let initialMetrics: PerformanceMetrics | undefined;
    try {
      initialMetrics = await this.adb.getPerformanceMetrics(deviceId);
    } catch {
      initialMetrics = undefined;
    }

    const session = await this.store.createSession({
      deviceId,
      deviceSn: this.adb.getDeviceSerial(deviceId),
      provider: this.adb.getCaptureProvider(deviceId),
      // Pico 的 screenrecord 录的是双眼原图，单眼靠播放时裁切（shouldCropCaptureVideo）。
      // 录制端从不产出单眼文件，故恒为 false（视频不是单眼）。
      singleEyeVideo: false,
      packageName: initialMetrics?.packageName,
      activityName: initialMetrics?.activityName,
    });

    const state: ActiveSession = {
      sessionId: session.id,
      deviceId,
      startedAtMs: Date.now(),
      timer: null,
      sampleSeq: 0,
      totalVideoBytes: 0,
      softLimitNotified: false,
    };

    try {
      await this.adb.startCaptureRecording({
        deviceId,
        videoDir: this.store.getVideoDir(session.id),
        onSegment: (segment) => {
          this.store.appendSegment(session.id, segment).catch((error) => {
            logger.error('PerformanceCaptureController: appendSegment failed:', error);
          });
        },
        onSizeBytes: (totalBytes) => {
          state.totalVideoBytes = totalBytes;
          this.checkSoftLimit(state);
        },
        onError: (error) => {
          logger.error('PerformanceCaptureController: capture recording error:', error);
        },
      });
    } catch (error) {
      // 录制启动失败：把会话标记为 failed 并抛出，让上层提示用户。
      await this.store
        .finalizeSession(session.id, {
          endedAt: new Date(),
          durationMs: 0,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      throw error;
    }

    state.timer = setInterval(() => {
      void this.tick(state);
    }, SAMPLE_INTERVAL_MS);
    this.active.set(deviceId, state);
    return session;
  }

  async stop(deviceId: string): Promise<PerformanceCaptureSession> {
    const state = this.active.get(deviceId);
    if (!state) {
      throw new Error('当前设备没有进行中的采集。');
    }
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    this.active.delete(deviceId);

    await this.adb.stopCaptureRecording(deviceId).catch((error) => {
      logger.error('PerformanceCaptureController: stopCaptureRecording failed:', error);
    });

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - state.startedAtMs;
    return this.store.finalizeSession(state.sessionId, { endedAt, durationMs, status: 'completed' });
  }

  /** 应用退出时停掉所有进行中的采集，避免残留定时器与设备端 screenrecord。 */
  async stopAll(): Promise<void> {
    const deviceIds = Array.from(this.active.keys());
    await Promise.all(deviceIds.map((deviceId) => this.stop(deviceId).catch(() => undefined)));
  }

  private async tick(state: ActiveSession): Promise<void> {
    try {
      const metrics = await this.adb.getPerformanceMetrics(state.deviceId);
      const elapsedMs = Date.now() - state.startedAtMs;
      const sample: PerformanceSample = {
        id: `${state.sessionId}-${state.sampleSeq}`,
        deviceId: state.deviceId,
        capturedAt: new Date(),
        metrics,
      };
      state.sampleSeq += 1;
      await this.store.appendSamples(state.sessionId, [sample]);
      const payload: CaptureSamplePayload = {
        deviceId: state.deviceId,
        sessionId: state.sessionId,
        sample,
        elapsedMs,
      };
      this.emit(IPC_CHANNELS.CAPTURE_SAMPLE, payload);
      this.checkSoftLimit(state);
    } catch {
      // 单次采样失败（设备瞬时无响应）不终止整次采集。
    }
  }

  private checkSoftLimit(state: ActiveSession): void {
    if (state.softLimitNotified) return;
    const durationMs = Date.now() - state.startedAtMs;
    let reason: 'duration' | 'size' | null = null;
    if (durationMs >= SOFT_LIMIT_DURATION_MS) {
      reason = 'duration';
    } else if (state.totalVideoBytes >= SOFT_LIMIT_SIZE_BYTES) {
      reason = 'size';
    }
    if (!reason) return;

    state.softLimitNotified = true;
    const payload: CaptureSizeLimitPayload = {
      deviceId: state.deviceId,
      sessionId: state.sessionId,
      reason,
      durationMs,
      sizeBytes: state.totalVideoBytes,
    };
    this.emit(IPC_CHANNELS.CAPTURE_SIZE_LIMIT, payload);
  }
}
