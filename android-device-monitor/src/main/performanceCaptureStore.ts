import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  PerformanceCaptureMarker,
  PerformanceCaptureProvider,
  PerformanceCaptureSegment,
  PerformanceCaptureSession,
  PerformanceCaptureSessionDetail,
  PerformanceSample,
} from '../shared/types';

// 采集会话归档（Phase 14）。一次「开始采集 → 关闭采集」= 一个会话，整次落盘到工具根目录：
//   performance-captures/<sessionId>/
//     ├── manifest.json     会话元数据（含分段列表）
//     ├── video/seg-N.mp4    分段视频（由 captureRecorder 写入）
//     ├── data/samples.jsonl 采样序列（流式追加，防崩溃）
//     ├── data/markers.json  参数过滤标记（可选）
//     └── screenshots/       回看快捷截图（可选）
// 数据与视频分目录存放；根目录用 resolveRuntimeAppRoot，不落 C 盘 userData，UI 只见相对路径。

const CAPTURES_DIR = 'performance-captures';
const SAMPLES_FILE = 'samples.jsonl';
const MARKERS_FILE = 'markers.json';
const MANIFEST_FILE = 'manifest.json';

const toPortablePath = (value: string) => value.split(path.sep).join('/');
const sanitizeSegment = (value: string) => value.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'device';

export type CreateCaptureSessionInput = {
  deviceId: string;
  deviceSn: string;
  provider: PerformanceCaptureProvider;
  singleEyeVideo?: boolean;
  packageName?: string;
  activityName?: string;
};

export type FinalizeCaptureSessionInput = {
  endedAt: Date;
  durationMs: number;
  status?: 'completed' | 'failed';
  error?: string;
};

const reviveSession = (raw: PerformanceCaptureSession): PerformanceCaptureSession => ({
  ...raw,
  startedAt: new Date(raw.startedAt),
  endedAt: raw.endedAt ? new Date(raw.endedAt) : undefined,
  videoSegments: Array.isArray(raw.videoSegments) ? raw.videoSegments : [],
});

export class PerformanceCaptureStore {
  // 每个会话串行化 manifest 的「读-改-写」，避免 appendSegment 与 finalize 并发丢更新。
  private readonly manifestLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly resolveAppRoot: () => string) {}

  private capturesRoot(): string {
    return path.join(this.resolveAppRoot(), CAPTURES_DIR);
  }

  private sessionDir(sessionId: string): string {
    // sessionId 会经 14.4 的 IPC 从渲染层传入，是外部可控输入。所有落到 sessionDir 的
    // 操作（删除/读写/追加）都先在此把关，拒绝 `..`、绝对路径、含分隔符的 id，
    // 防止穿越到 performance-captures 之外（与 performanceMedia 的越界检查口径一致）。
    const root = this.capturesRoot();
    const resolved = path.resolve(root, sessionId);
    const relativeToRoot = path.relative(root, resolved);
    if (
      !sessionId ||
      sessionId.includes('/') ||
      sessionId.includes('\\') ||
      relativeToRoot === '' ||
      relativeToRoot.startsWith('..') ||
      path.isAbsolute(relativeToRoot)
    ) {
      throw new Error(`非法的采集会话 ID：${sessionId}`);
    }
    return resolved;
  }

  getVideoDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'video');
  }

  getScreenshotDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'screenshots');
  }

  private dataDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'data');
  }

  async createSession(input: CreateCaptureSessionInput): Promise<PerformanceCaptureSession> {
    const startedAt = new Date();
    const id = `${sanitizeSegment(input.deviceSn || input.deviceId)}-${startedAt.getTime()}`;
    const sessionDir = this.sessionDir(id);
    await fs.mkdir(this.getVideoDir(id), { recursive: true });
    await fs.mkdir(this.dataDir(id), { recursive: true });
    await fs.mkdir(this.getScreenshotDir(id), { recursive: true });

    const session: PerformanceCaptureSession = {
      id,
      deviceId: input.deviceId,
      deviceSn: input.deviceSn,
      provider: input.provider,
      status: 'recording',
      startedAt,
      durationMs: 0,
      singleEyeVideo: input.singleEyeVideo,
      videoSegments: [],
      dataRelativePath: toPortablePath(path.join(CAPTURES_DIR, id, 'data', SAMPLES_FILE)),
      screenshotDir: toPortablePath(path.join(CAPTURES_DIR, id, 'screenshots')),
      packageName: input.packageName,
      activityName: input.activityName,
      sizeBytes: 0,
    };
    await this.writeManifest(sessionDir, session);
    // 预创建空样本文件，便于中途崩溃后 loadSession 不报错。
    await fs.writeFile(path.join(this.dataDir(id), SAMPLES_FILE), '', 'utf8');
    return session;
  }

  /** 流式追加采样：每条一行 JSON，落盘即不丢，避免内存攒到结束。 */
  async appendSamples(sessionId: string, samples: PerformanceSample[]): Promise<void> {
    if (samples.length === 0) return;
    const lines = samples.map((sample) => JSON.stringify(sample)).join('\n') + '\n';
    await fs.appendFile(path.join(this.dataDir(sessionId), SAMPLES_FILE), lines, 'utf8');
  }

  /** 记录一段已落盘的视频分段，并累加总体积。 */
  async appendSegment(sessionId: string, segment: PerformanceCaptureSegment): Promise<void> {
    await this.mutateManifest(sessionId, (session) => {
      const videoSegments = [...session.videoSegments.filter((s) => s.index !== segment.index), segment]
        .sort((a, b) => a.index - b.index);
      const videoBytes = videoSegments.reduce((sum, s) => sum + (s.sizeBytes || 0), 0);
      return { ...session, videoSegments, sizeBytes: videoBytes };
    });
  }

  async finalizeSession(sessionId: string, input: FinalizeCaptureSessionInput): Promise<PerformanceCaptureSession> {
    return this.mutateManifest(sessionId, (session) => ({
      ...session,
      status: input.status ?? 'completed',
      endedAt: input.endedAt,
      durationMs: input.durationMs,
      error: input.error,
    }));
  }

  async renameSession(sessionId: string, title: string): Promise<PerformanceCaptureSession> {
    const trimmed = title.trim();
    return this.mutateManifest(sessionId, (session) => ({ ...session, title: trimmed || undefined }));
  }

  async saveMarkers(sessionId: string, markers: PerformanceCaptureMarker[]): Promise<void> {
    await fs.writeFile(
      path.join(this.dataDir(sessionId), MARKERS_FILE),
      `${JSON.stringify(markers, null, 2)}\n`,
      'utf8'
    );
  }

  /** 保存一帧快捷截图到会话 screenshots/，返回相对路径（供回看展示）。 */
  async saveScreenshot(sessionId: string, pngBuffer: Buffer): Promise<string> {
    const dir = this.getScreenshotDir(sessionId);
    await fs.mkdir(dir, { recursive: true });
    const fileName = `shot-${Date.now()}.png`;
    await fs.writeFile(path.join(dir, fileName), pngBuffer);
    return toPortablePath(path.join(CAPTURES_DIR, sessionId, 'screenshots', fileName));
  }

  async deleteSession(sessionId: string): Promise<void> {
    // 二次确认在 UI 侧；这里直接递归删整个会话文件夹（video/data/screenshots 一并清除）。
    await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true });
  }

  async listSessions(): Promise<PerformanceCaptureSession[]> {
    const root = this.capturesRoot();
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const sessions: PerformanceCaptureSession[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const session = await this.readManifest(entry.name).catch(() => null);
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
  }

  async loadSession(sessionId: string): Promise<PerformanceCaptureSessionDetail> {
    const session = await this.readManifest(sessionId);
    const samples = await this.readSamples(sessionId);
    const markers = await this.readMarkers(sessionId);
    return { session, samples, markers };
  }

  private async readSamples(sessionId: string): Promise<PerformanceSample[]> {
    const raw = await fs.readFile(path.join(this.dataDir(sessionId), SAMPLES_FILE), 'utf8').catch(() => '');
    const samples: PerformanceSample[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as PerformanceSample;
        samples.push({ ...parsed, capturedAt: new Date(parsed.capturedAt) });
      } catch {
        // 容错：跳过损坏行（如崩溃时写了半行），不让整次回看失败。
      }
    }
    return samples;
  }

  private async readMarkers(sessionId: string): Promise<PerformanceCaptureMarker[]> {
    const raw = await fs.readFile(path.join(this.dataDir(sessionId), MARKERS_FILE), 'utf8').catch(() => '');
    if (!raw.trim()) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as PerformanceCaptureMarker[]) : [];
    } catch {
      return [];
    }
  }

  private async readManifest(sessionId: string): Promise<PerformanceCaptureSession> {
    const raw = await fs.readFile(path.join(this.sessionDir(sessionId), MANIFEST_FILE), 'utf8');
    return reviveSession(JSON.parse(raw) as PerformanceCaptureSession);
  }

  private async writeManifest(sessionDir: string, session: PerformanceCaptureSession): Promise<void> {
    await fs.writeFile(path.join(sessionDir, MANIFEST_FILE), `${JSON.stringify(session, null, 2)}\n`, 'utf8');
  }

  // 串行化单会话 manifest 的读-改-写。
  private mutateManifest(
    sessionId: string,
    update: (session: PerformanceCaptureSession) => PerformanceCaptureSession
  ): Promise<PerformanceCaptureSession> {
    const previous = this.manifestLocks.get(sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const session = await this.readManifest(sessionId);
        const updated = update(session);
        await this.writeManifest(this.sessionDir(sessionId), updated);
        return updated;
      });
    this.manifestLocks.set(sessionId, next);
    next.finally(() => {
      if (this.manifestLocks.get(sessionId) === next) {
        this.manifestLocks.delete(sessionId);
      }
    }).catch(() => undefined);
    return next;
  }
}
