import { spawn, ChildProcess } from 'child_process';
import type { MirrorSession, MirrorStartOptions } from '../../shared/types';
import { resolveBundledScrcpyBinaryPath } from './scrcpyBinary';
import { resolveBundledAdbBinaryPath } from '../adb/adbBinary';

export type MirrorStatusListener = (session: MirrorSession) => void;

/**
 * 投屏镜像进程管理器。
 *
 * 路线 A：以子进程方式 spawn 打包的 scrcpy，调起其原生窗口，不内嵌解码。
 * 关键约束：通过子进程环境变量 ADB 指向内置 adb，避免 scrcpy 另起一个
 * 与主程序冲突的 adb server。进程退出 / 出错时清理映射并广播状态。
 */
export class ScrcpyManager {
  private readonly sessions = new Map<string, ChildProcess>();
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
  startMirror(deviceId: string, options: MirrorStartOptions = {}): MirrorSession {
    if (this.sessions.has(deviceId)) {
      return { deviceId, status: 'running' };
    }

    const scrcpyPath = resolveBundledScrcpyBinaryPath();
    if (!scrcpyPath) {
      throw new Error('未找到内置 scrcpy，请先运行 npm run scrcpy:prepare 或检查打包资源。');
    }

    const windowTitle = options.windowTitle ?? `投屏 - ${deviceId}`;
    const args = ['-s', deviceId, '--window-title', windowTitle];

    // 让 scrcpy 复用内置 adb，避免与主程序的 adb server 冲突。
    const adbPath = resolveBundledAdbBinaryPath();
    const env = adbPath ? { ...process.env, ADB: adbPath } : process.env;

    const child = spawn(scrcpyPath, args, { env, windowsHide: false });
    this.sessions.set(deviceId, child);

    const startedAt = new Date().toISOString();

    child.on('spawn', () => {
      this.emit({ deviceId, status: 'running', startedAt });
    });

    child.on('error', (error: Error) => {
      this.sessions.delete(deviceId);
      this.emit({ deviceId, status: 'failed', error: error.message });
    });

    child.on('exit', () => {
      // 用户关闭 scrcpy 窗口或进程结束都会走到这里。
      this.sessions.delete(deviceId);
      this.emit({ deviceId, status: 'stopped' });
    });

    return { deviceId, status: 'starting', startedAt };
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
  }
}
