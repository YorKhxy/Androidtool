import type { ChildProcess } from 'child_process';
import { logger } from '../logger';

type SpawnAdb = (args: string[]) => Promise<ChildProcess>;
type StopChild = (child: ChildProcess) => Promise<void>;
type EnsureHub = (deviceId: string) => Promise<void>;

type StreamEntry = {
  child: ChildProcess;
  latestLine: string | null;
  latestAt: number;
  lastReadAt: number;
  startedAt: number;
  buffer: string;
};

const IDLE_TIMEOUT_MS = 15000; // 超过此时长无人读取（采集停止/设备断开）→ 回收常驻进程，省电。
const SWEEP_INTERVAL_MS = 5000;
const MAX_PARTIAL_BUFFER = 64 * 1024;

// 常驻 PxrMetric 流：每台 Pico 设备一条 `adb logcat -T 1 -v time -s PxrMetric` 长进程，
// 后台持续吃最新行、只缓存「最近一行 + 时间戳」。采样时只读缓存（无每拍 spawn —— 最省电、最稳，
// 且天然不存在「-d 全量 dump 超 maxBuffer/timeout」的每拍失败面）。
//   - hub streaming 必须开着才有数据，故 ensureStreaming 内先 ensureHub；
//   - 数据新鲜度由调用方用 getFreshLine(maxAgeMs) 把关，陈旧即视为「当前无数据」交由上层回退，不显示旧值；
//   - 空闲看门狗自动回收，无需调用方显式管理生命周期。
export class PicoMetricsStream {
  private readonly streams = new Map<string, StreamEntry>();
  private readonly starting = new Map<string, Promise<void>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly spawnAdb: SpawnAdb,
    private readonly stopChild: StopChild,
    private readonly ensureHub: EnsureHub
  ) {}

  // 幂等启动：已在跑直接返回；并发调用合流到同一启动 Promise，避免重复 spawn。
  async ensureStreaming(deviceId: string): Promise<void> {
    if (this.streams.has(deviceId)) return;
    const inflight = this.starting.get(deviceId);
    if (inflight) return inflight;
    const promise = this.startStream(deviceId).finally(() => this.starting.delete(deviceId));
    this.starting.set(deviceId, promise);
    return promise;
  }

  private async startStream(deviceId: string): Promise<void> {
    if (this.streams.has(deviceId)) return;
    await this.ensureHub(deviceId).catch((error) => {
      logger.warn('PicoMetricsStream: ensureHub failed (继续尝试读流):', error);
    });
    const child = await this.spawnAdb(['-s', deviceId, 'logcat', '-T', '1', '-v', 'time', '-s', 'PxrMetric']);
    const now = Date.now();
    const entry: StreamEntry = { child, latestLine: null, latestAt: 0, lastReadAt: now, startedAt: now, buffer: '' };
    this.streams.set(deviceId, entry);
    this.ensureSweepTimer();

    child.stdout?.on('data', (data: Buffer) => {
      const text = entry.buffer + data.toString('utf-8');
      const lines = text.split('\n');
      entry.buffer = lines.pop() ?? ''; // 末尾可能是半行，留到下次
      if (entry.buffer.length > MAX_PARTIAL_BUFFER) entry.buffer = entry.buffer.slice(-4096);
      for (const raw of lines) {
        const line = raw.replace(/[\r\n]+$/, '');
        // 只认 PxrMetric 行（忽略 "--------- beginning of main" 等分隔标记）。仅记录字符串，
        // 解析推迟到采样时按需做，故每行成本极低，海量回看行也不卡。
        if (line.includes('PxrMetric')) {
          entry.latestLine = line;
          entry.latestAt = Date.now();
        }
      }
    });
    child.stderr?.on('data', () => {
      /* 忽略 logcat 噪声 */
    });
    child.on('error', (error) => {
      logger.warn('PicoMetricsStream: process error:', error);
      if (this.streams.get(deviceId) === entry) this.streams.delete(deviceId);
    });
    child.on('close', () => {
      // adb 退出（设备断开等）→ 清掉条目，下次 ensureStreaming 会重启。
      if (this.streams.get(deviceId) === entry) this.streams.delete(deviceId);
    });
  }

  // 返回 maxAgeMs 内的最新行；陈旧或没有则 null。读取即刷新 lastReadAt（喂活看门狗）。
  getFreshLine(deviceId: string, maxAgeMs: number): string | null {
    const entry = this.streams.get(deviceId);
    if (!entry) return null;
    entry.lastReadAt = Date.now();
    if (!entry.latestLine) return null;
    if (Date.now() - entry.latestAt > maxAgeMs) return null;
    return entry.latestLine;
  }

  // 预热期：流已起、还没收到任何 PxrMetric 行、且启动未超过 warmupMs（用于决定要不要一次性兜底读取）。
  isWarmingUp(deviceId: string, warmupMs: number): boolean {
    const entry = this.streams.get(deviceId);
    if (!entry) return false;
    return entry.latestLine === null && Date.now() - entry.startedAt < warmupMs;
  }

  async stop(deviceId: string): Promise<void> {
    const entry = this.streams.get(deviceId);
    if (!entry) return;
    this.streams.delete(deviceId);
    entry.child.stdout?.removeAllListeners('data');
    entry.child.stderr?.removeAllListeners('data');
    await this.stopChild(entry.child).catch((error) => {
      logger.warn('PicoMetricsStream: stopChild failed:', error);
    });
    if (this.streams.size === 0) this.clearSweepTimer();
  }

  async stopAll(): Promise<void> {
    this.clearSweepTimer();
    await Promise.all([...this.streams.keys()].map((id) => this.stop(id)));
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepIdle(), SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  private clearSweepTimer(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [deviceId, entry] of this.streams) {
      if (now - entry.lastReadAt > IDLE_TIMEOUT_MS) {
        void this.stop(deviceId);
      }
    }
  }
}
