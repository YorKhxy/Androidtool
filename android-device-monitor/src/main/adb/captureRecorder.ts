import { spawn, type ChildProcess, type ExecFileOptions } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

// 持续分段录制引擎（Phase 14）。
// 背景：Android 设备端 `screenrecord` 单段最长 180 秒（AOSP 硬编码），到点自动结束。
// 为支持「点开始采集 → 点关闭采集」的不限时长录制，这里把一次采集拆成多段 ≤180s 的 mp4：
//   - 任一时刻设备端只有一个 screenrecord 在跑：当前段 waitForExit 返回后才 spawn 下一段；
//     重叠的是「已完成段的 adb pull」与「下一段录制」，pull 不是 screenrecord，故 stop 时
//     pkill 只会命中唯一在录的那一段；
//   - 每段录完（到点或被 stop 时 SIGINT finalize）pull 到会话 video 目录并删除设备端临时文件；
//   - 每段 pull 完成即落盘，工具中途崩溃最多丢失「当前正在录、未 pull 回」的一段。
// 本引擎只负责产出视频分段；采样、会话归档、单眼裁切（播放时）分别由上层编排与回看 UI 处理。

type ExecAdb = (args: string[], options?: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
type ResolveAdbPath = () => Promise<string>;

const MAX_SEGMENT_SECONDS = 180;
const DEFAULT_BIT_RATE_MBPS = 8;
// 首段启动后用于判定「设备端 screenrecord 是否瞬间失败」的探测窗口。
const FIRST_SEGMENT_PROBE_MS = 700;

// 把设备端 screenrecord 瞬间失败的 stderr 翻译成可操作的中文指引。
// 实测最常见原因是手机锁屏/熄屏：此时无可编码的显示 surface，screenrecord 会以
// 「Encoder failed (err=-38)」立即退出（真机 vivo/Android 13 验证）。
const describeSegmentFailure = (stderr: string): string => {
  const lower = stderr.toLowerCase();
  if (lower.includes('encoder failed') || lower.includes('err=-38') || stderr === '') {
    return (
      '设备端录屏启动失败，最常见原因是手机处于锁屏或熄屏状态——请先解锁手机屏幕并保持亮屏，再开始采集。' +
      (stderr ? `（设备返回：${stderr}）` : '')
    );
  }
  if (lower.includes('permission') || lower.includes('denied')) {
    return `设备端录屏被拒绝，权限不足：${stderr}`;
  }
  return `${stderr}（若手机处于锁屏/熄屏状态，请先解锁亮屏再开始采集）`;
};

export type CaptureSegmentMeta = {
  index: number;
  /** 相对 videoDir 的文件名，如 seg-0.mp4 */
  fileName: string;
  /** 相对采集起点的毫秒数（本段开始录制时刻） */
  startMs: number;
  /** 相对采集起点的毫秒数（本段结束录制时刻） */
  endMs: number;
  /** 本段视频体积（字节） */
  sizeBytes: number;
};

export type StartCaptureInput = {
  deviceId: string;
  /** 分段视频落盘目录（绝对路径，由会话存储提供） */
  videoDir: string;
  bitRateMbps?: number;
  /** 每段 pull 完成后回调，用于会话存储记录分段 */
  onSegment?: (meta: CaptureSegmentMeta) => void;
  /** 每段落盘后回调累计视频体积（字节），供软上限提醒 */
  onSizeBytes?: (totalBytes: number) => void;
  /** 录制循环出错时回调（单段失败不一定终止整次采集，由上层决定） */
  onError?: (error: Error) => void;
};

type SpawnedSegment = {
  child: ChildProcess;
  getStderr: () => string;
};

type ActiveCapture = {
  deviceId: string;
  stopRequested: boolean;
  startedAtMs: number;
  pullJobs: Promise<void>[];
  totalBytes: number;
  loop: Promise<void>;
  stopPromise: Promise<void> | null;
};

const sanitizeSegment = (value: string) => value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'device';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PerformanceCaptureRecorder {
  private readonly active = new Map<string, ActiveCapture>();

  constructor(
    private readonly execAdb: ExecAdb,
    private readonly resolveAdbPath: ResolveAdbPath
  ) {}

  isRecording(deviceId: string): boolean {
    return this.active.has(deviceId);
  }

  /**
   * 启动持续分段录制。等首段确认能录（设备端 screenrecord 未瞬间失败）后返回；
   * 录制循环在后台运行直到 stop。设备已在录制则抛错；首段启动失败则 reject。
   */
  async start(input: StartCaptureInput): Promise<void> {
    if (this.active.has(input.deviceId)) {
      throw new Error('当前设备已有采集录制正在进行。');
    }

    await fs.mkdir(input.videoDir, { recursive: true });
    const adbPath = await this.resolveAdbPath();
    const bitRate = this.normalizeBitRate(input.bitRateMbps);

    const state: ActiveCapture = {
      deviceId: input.deviceId,
      stopRequested: false,
      startedAtMs: Date.now(),
      pullJobs: [],
      totalBytes: 0,
      loop: Promise.resolve(),
      stopPromise: null,
    };
    this.active.set(input.deviceId, state);

    try {
      const first = await this.spawnSegment(adbPath, input.deviceId, this.remotePath(input.deviceId, 0), bitRate);
      // 首段探测：若设备端 screenrecord 瞬间退出（命令不存在/无权限），让 start 抛错而不是空转。
      await this.assertSegmentAlive(first, FIRST_SEGMENT_PROBE_MS);
      state.loop = this.runLoop(input, adbPath, bitRate, state, first).catch((error) => {
        input.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      this.active.delete(input.deviceId);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** 停止录制：SIGINT 让设备端 finalize 当前段，等待循环收尾与所有 pull 完成。幂等且并发安全。 */
  async stop(deviceId: string): Promise<void> {
    const state = this.active.get(deviceId);
    if (!state) return;
    if (state.stopPromise) {
      await state.stopPromise;
      return;
    }
    state.stopPromise = (async () => {
      state.stopRequested = true;
      await this.signalScreenrecordStop(deviceId);
      await state.loop.catch(() => undefined);
      await Promise.all(state.pullJobs).catch(() => undefined);
      this.active.delete(deviceId);
    })();
    await state.stopPromise;
  }

  private async runLoop(
    input: StartCaptureInput,
    adbPath: string,
    bitRate: number,
    state: ActiveCapture,
    firstSegment: SpawnedSegment
  ): Promise<void> {
    let index = 0;
    let segment: SpawnedSegment | null = firstSegment;
    let segmentStartMs = 0;

    while (segment) {
      await this.waitForExit(segment.child);
      const segmentEndMs = Date.now() - state.startedAtMs;
      const finishedIndex = index;
      const finishedRemote = this.remotePath(input.deviceId, finishedIndex);

      // 先把下一段录起来（与已完成段的 pull 重叠），缩短接缝；已请求 stop 则不再开新段。
      index += 1;
      let next: SpawnedSegment | null = null;
      if (!state.stopRequested) {
        try {
          next = await this.spawnSegment(adbPath, input.deviceId, this.remotePath(input.deviceId, index), bitRate);
          // 二次检查：spawn 期间若 stop 触发，pkill 已广播，这一段已被终结，不应作为内容段继续。
          if (state.stopRequested) {
            await this.signalScreenrecordStop(input.deviceId);
          }
        } catch (error) {
          input.onError?.(error instanceof Error ? error : new Error(String(error)));
          next = null;
        }
      }

      const pullJob = this.pullSegment(input, finishedIndex, finishedRemote, segmentStartMs, segmentEndMs, state);
      state.pullJobs.push(pullJob);

      segment = next;
      segmentStartMs = segmentEndMs;
    }
  }

  private async pullSegment(
    input: StartCaptureInput,
    index: number,
    remotePath: string,
    startMs: number,
    endMs: number,
    state: ActiveCapture
  ): Promise<void> {
    const fileName = `seg-${index}.mp4`;
    const localPath = path.join(input.videoDir, fileName);
    try {
      await this.execAdb(['-s', input.deviceId, 'pull', remotePath, localPath], {
        timeout: 60000,
        maxBuffer: 1024 * 1024 * 2,
      });
      await this.execAdb(['-s', input.deviceId, 'shell', 'rm', '-f', remotePath], { timeout: 8000 }).catch(() => undefined);

      const stat = await fs.stat(localPath).catch(() => null);
      const sizeBytes = stat?.size ?? 0;
      if (sizeBytes <= 0) {
        // 空段（被打断且未写出有效内容）直接清掉，不上报，避免时间轴出现无视频的空洞。
        await fs.rm(localPath, { force: true }).catch(() => undefined);
        return;
      }

      state.totalBytes += sizeBytes;
      input.onSegment?.({ index, fileName, startMs, endMs, sizeBytes });
      input.onSizeBytes?.(state.totalBytes);
    } catch (error) {
      input.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private spawnSegment(adbPath: string, deviceId: string, remotePath: string, bitRateMbps: number): Promise<SpawnedSegment> {
    const args = [
      '-s', deviceId,
      'shell', 'screenrecord',
      '--time-limit', String(MAX_SEGMENT_SECONDS),
      '--bit-rate', String(bitRateMbps * 1000 * 1000),
      remotePath,
    ];
    return new Promise((resolve, reject) => {
      // stderr 收集起来：设备端 screenrecord 的失败信息（不支持/无权限）会打到 stderr，
      // 用于首段探测与 onError 文案，不能像之前那样 'ignore' 丢弃。
      const child = spawn(adbPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const onSpawn = () => {
        child.removeListener('error', onError);
        resolve({ child, getStderr: () => stderr });
      };
      const onError = (error: Error) => {
        child.removeListener('spawn', onSpawn);
        reject(error);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  // 首段探测：在 probeMs 窗口内若子进程提前 close（设备端 screenrecord 瞬间失败），抛错；
  // 否则视为录制正常进行。仅用于首段，避免给后续每段都加启动延迟。
  private assertSegmentAlive(segment: SpawnedSegment, probeMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const onClose = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(describeSegmentFailure(segment.getStderr().trim())));
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        segment.child.removeListener('close', onClose);
        resolve();
      }, probeMs);
      segment.child.once('close', onClose);
    });
  }

  private waitForExit(child: ChildProcess): Promise<void> {
    return new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const done = () => {
        child.removeListener('close', done);
        child.removeListener('error', done);
        resolve();
      };
      child.once('close', done);
      child.once('error', done);
    });
  }

  // 向设备端 screenrecord 发 SIGINT（pkill -2），让其 finalize 当前 mp4 而不是丢弃。
  private async signalScreenrecordStop(deviceId: string): Promise<void> {
    await this.execAdb(['-s', deviceId, 'shell', 'pkill', '-2', 'screenrecord'], { timeout: 8000 }).catch(() => undefined);
    await this.execAdb(['-s', deviceId, 'shell', 'killall', '-2', 'screenrecord'], { timeout: 8000 }).catch(() => undefined);
    await delay(400);
  }

  private normalizeBitRate(bitRateMbps?: number): number {
    const value = Number.isFinite(bitRateMbps) ? Number(bitRateMbps) : DEFAULT_BIT_RATE_MBPS;
    return Math.max(2, Math.min(20, Math.round(value)));
  }

  private remotePath(deviceId: string, index: number): string {
    return `/sdcard/adm-capture-${sanitizeSegment(deviceId)}-${index}.mp4`;
  }
}
