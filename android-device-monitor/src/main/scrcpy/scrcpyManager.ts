import { spawn, execFile, ChildProcess } from 'child_process';
import { promisify } from 'util';
import type { MirrorSession, MirrorStartOptions } from '../../shared/types';
import { resolveBundledScrcpyBinaryPath } from './scrcpyBinary';
import { resolveBundledAdbBinaryPath } from '../adb/adbBinary';

const execFileAsync = promisify(execFile);

export type MirrorStatusListener = (session: MirrorSession) => void;

/**
 * 投屏镜像进程管理器。
 *
 * 路线 A：以子进程方式 spawn 打包的 scrcpy，调起其原生窗口，不内嵌解码。
 * 关键约束：通过子进程环境变量 ADB 指向内置 adb，避免 scrcpy 另起一个
 * 与主程序冲突的 adb server。进程退出 / 出错时清理映射并广播状态。
 *
 * Pico 设备自动附加 --crop 单眼裁切，与性能快照 / 录制的单眼口径一致；
 * 裁切后 scrcpy 基于裁切区域自动换算操控坐标，无需额外处理。
 */
export class ScrcpyManager {
  private readonly sessions = new Map<string, ChildProcess>();
  private readonly sessionMeta = new Map<string, Partial<MirrorSession>>();
  // 异步启动期间的占位守卫：避免查询分辨率的窗口内重复 spawn 出第二个 scrcpy。
  private readonly starting = new Set<string>();
  private statusListener: MirrorStatusListener | null = null;

  onStatus(listener: MirrorStatusListener): void {
    this.statusListener = listener;
  }

  private emit(session: MirrorSession): void {
    this.statusListener?.(session);
  }

  isMirroring(deviceId: string): boolean {
    return this.sessions.has(deviceId);
  }

  /**
   * 启动投屏。二进制缺失等同步错误直接抛出，由 IPC 层转为结构化错误响应；
   * 进程级的 error / exit 通过状态回调异步广播。
   */
  async startMirror(deviceId: string, options: MirrorStartOptions = {}): Promise<MirrorSession> {
    if (this.sessions.has(deviceId) || this.starting.has(deviceId)) {
      return { deviceId, status: 'running', ...this.sessionMeta.get(deviceId) };
    }

    const scrcpyPath = resolveBundledScrcpyBinaryPath();
    if (!scrcpyPath) {
      throw new Error('未找到内置 scrcpy，请先运行 npm run scrcpy:prepare 或检查打包资源。');
    }

    // 占位守卫：覆盖查询分辨率的整个异步期，防止并发重复 spawn。
    this.starting.add(deviceId);
    try {
      // 让 scrcpy 复用内置 adb，避免与主程序的 adb server 冲突。
      const adbPath = resolveBundledAdbBinaryPath();
      const windowTitle = options.windowTitle ?? `投屏 - ${deviceId}`;
      // --no-mouse-hover：关闭鼠标悬停事件，使其行为贴近真实触摸，
      // 避免移动鼠标时误关设备上的长按弹出菜单（如卸载菜单）。
      const args = ['-s', deviceId, '--window-title', windowTitle, '--no-mouse-hover'];

      if (options.maxSize && options.maxSize > 0) {
        args.push('--max-size', String(options.maxSize));
      }
      if (options.bitRate) {
        args.push('--video-bit-rate', options.bitRate);
      }

      let crop: string | undefined;
      if (options.isPico) {
        crop = (await this.computePicoSingleEyeCrop(deviceId, adbPath)) ?? undefined;
        if (crop) {
          args.push('--crop', crop);
        }
      }

      const meta: Partial<MirrorSession> = {
        isPico: options.isPico,
        crop,
        maxSize: options.maxSize,
        bitRate: options.bitRate,
      };
      this.sessionMeta.set(deviceId, meta);

      const env = adbPath ? { ...process.env, ADB: adbPath } : process.env;
      const child = spawn(scrcpyPath, args, { env, windowsHide: false });
      this.sessions.set(deviceId, child);

      const startedAt = new Date().toISOString();

      child.on('spawn', () => {
        this.emit({ deviceId, status: 'running', startedAt, ...meta });
      });

      child.on('error', (error: Error) => {
        this.sessions.delete(deviceId);
        this.sessionMeta.delete(deviceId);
        this.emit({ deviceId, status: 'failed', error: error.message, ...meta });
      });

      child.on('exit', () => {
        // 用户关闭 scrcpy 窗口或进程结束都会走到这里。
        this.sessions.delete(deviceId);
        this.sessionMeta.delete(deviceId);
        this.emit({ deviceId, status: 'stopped', ...meta });
      });

      return { deviceId, status: 'starting', startedAt, ...meta };
    } finally {
      this.starting.delete(deviceId);
    }
  }

  /**
   * 通过内置 adb 查询设备分辨率，计算 Pico 左眼单眼裁切区域。
   * 返回 scrcpy --crop 形式 "W:H:X:Y"（自然方向，取左半幅）；查询失败返回 null（不裁切）。
   */
  private async computePicoSingleEyeCrop(deviceId: string, adbPath: string | null): Promise<string | null> {
    if (!adbPath) {
      return null;
    }
    try {
      const { stdout } = await execFileAsync(adbPath, ['-s', deviceId, 'shell', 'wm', 'size'], { timeout: 5000 });
      // 优先取 Override size，其次 Physical size，格式如 "Physical size: 1920x1080"
      const matches = [...stdout.matchAll(/(?:Override|Physical) size:\s*(\d+)x(\d+)/g)];
      const last = matches[matches.length - 1];
      if (!last) {
        return null;
      }
      const width = Number(last[1]);
      const height = Number(last[2]);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
      }
      const halfWidth = Math.floor(width / 2);
      return `${halfWidth}:${height}:0:0`;
    } catch {
      return null;
    }
  }

  /** 停止指定设备的投屏；实际状态由进程 exit 事件广播为 stopped。 */
  stopMirror(deviceId: string): void {
    const child = this.sessions.get(deviceId);
    if (child) {
      child.kill();
    }
  }

  /** 应用退出时统一回收所有 scrcpy 子进程，避免僵尸进程。 */
  stopAll(): void {
    for (const child of this.sessions.values()) {
      child.kill();
    }
    this.sessions.clear();
    this.sessionMeta.clear();
    this.starting.clear();
  }
}
