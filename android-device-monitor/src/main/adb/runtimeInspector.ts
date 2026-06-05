import type { ExecFileOptions } from 'child_process';
import type { ActivityStackEntry, PerformanceMetrics, ProcessInfo } from '../../shared/types';
import { logger } from '../logger';
import { PicoAppSupportResult, PicoMetricsReader, type PicoStreamDeps } from './picoMetrics';

type ExecAdbText = (args: string[], options?: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;

type ForegroundAppContext = {
  packageName?: string;
  activityName?: string;
};

type DeviceFingerprint = {
  manufacturer?: string;
  brand?: string;
  model?: string;
  device?: string;
};

type PerformanceOptions = {
  preferPico?: boolean;
  currentMetrics?: PerformanceMetrics;
};

// 前台应用在一次采集里几乎不变，但解析它要跑 dumpsys window/activity（重、慢、耗电）。
// 按设备缓存，TTL 内复用，避免每秒一次的重型 dumpsys——既稳（少超时）又省电。
const FOREGROUND_APP_TTL_MS = 5000;

export class AdbRuntimeInspector {
  private readonly picoMetricsReader: PicoMetricsReader;
  private readonly foregroundAppCache = new Map<string, { context: ForegroundAppContext; at: number }>();

  constructor(private readonly execAdb: ExecAdbText, picoStreamDeps?: PicoStreamDeps) {
    this.picoMetricsReader = new PicoMetricsReader(this.execAdb, picoStreamDeps);
  }

  /** 停止某设备的常驻 PxrMetric 流（断开设备时调用）。 */
  stopPicoStream(deviceId: string): void {
    this.picoMetricsReader.stopStream(deviceId);
  }

  /** 停止所有常驻 PxrMetric 流（应用退出清理时调用）。 */
  stopPicoStreams(): void {
    this.picoMetricsReader.stopAllStreams();
  }

  async getPerformanceMetrics(deviceId: string, options: PerformanceOptions = {}): Promise<PerformanceMetrics> {
    try {
      const foregroundApp = await this.getForegroundAppContextCached(deviceId);
      const isPicoDevice = options.preferPico || (await this.picoMetricsReader.isPicoDevice(deviceId).catch(() => false));
      if (isPicoDevice) {
        const appSupport = await this.picoMetricsReader.detectForegroundAppSupport(deviceId, foregroundApp);
        try {
          const picoMetrics = await this.picoMetricsReader.getPerformanceMetrics(deviceId, foregroundApp);
          if (picoMetrics?.picoMetrics && this.hasNativePicoMetrics(picoMetrics.picoMetrics)) {
            // CPU/内存仍走 Android 采样旁路。旁路命令失败时不再 `?? 0` 兜底（那会让真实的 Pico FPS
            // 旁边配上假的 CPU 0 / 内存 0），而是让它抛出 → 经下方 catch 落到 Pico 回退；若回退也失败则
            // 整拍跳过。宁可这一拍没有数据（曲线断点），也不混入假 0。
            const androidMetrics = await this.getAndroidPerformanceMetrics(deviceId, foregroundApp);
            const nativePicoFps = picoMetrics.picoMetrics.fps?.value ?? androidMetrics.fps ?? picoMetrics.fps;
            return {
              ...picoMetrics,
              cpuUsage: androidMetrics.cpuUsage,
              memoryUsage: androidMetrics.memoryUsage,
              fps: nativePicoFps,
              picoMetricsState: 'native',
              picoAppSupport: appSupport.status,
              picoSupportMessage: appSupport.message,
              androidMetrics: androidMetrics.androidMetrics,
            };
          }

          return this.buildPicoFallbackMetrics(deviceId, foregroundApp, appSupport, '当前固件未返回 Pico 官方实时指标，已回退为通用 Android 采样。');
        } catch (error) {
          logger.warn('AdbRuntimeInspector: getPerformanceMetrics(pico) failed:', error);
          return this.buildPicoFallbackMetrics(
            deviceId,
            foregroundApp,
            appSupport,
            'Pico 官方 Metrics 服务未返回可解析数据，当前先显示通用 Android 采样。'
          );
        }
      }

      return this.getAndroidPerformanceMetrics(deviceId, foregroundApp);
    } catch (error) {
      // 整条取数失败如实上抛：采集层会跳过本拍（CAPTURE_SAMPLE 不推送 → 曲线断点、顶部指标保留上次值），
      // 实时性能 IPC 句柄会包成结构化错误。两处都不会出现假 0。
      logger.warn('AdbRuntimeInspector: getPerformanceMetrics failed（本拍跳过，不编造 0）:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async getAndroidPerformanceMetrics(
    deviceId: string,
    foregroundApp: ForegroundAppContext
  ): Promise<PerformanceMetrics> {
    try {
      const gfxInfoArgs = foregroundApp.packageName
        ? ['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', foregroundApp.packageName, 'framestats']
        : ['-s', deviceId, 'shell', 'dumpsys', 'gfxinfo', 'framestats'];

      // 三项指标并发采集，每条命令都带 timeout（top / gfxinfo 原先无 timeout，挂起会拖死整次采样）。
      // 诚实优先：任一命令「失败/超时」（命令级故障）即判定本拍「未采到」，抛出让上层跳过整拍——
      // 绝不把失败编造成 0。把失败画成 0 会和「真实空载 / 真实卡死到 0」混淆，污染曲线分析（用户明确反对）。
      // 跳过本拍后曲线在相邻点间自然连线（断点/缺数），而不是冒出一根假的 0 尖刺。
      // 注意：命令「成功但输出为空」导致解析为 0（如应用未用 HWUI 渲染时 FPS 0）是真实读数，照常记录。
      const [memResult, cpuResult, gfxResult] = await Promise.allSettled([
        // 用 /proc/meminfo（瞬时、格式固定、永不超时）取内存。早先用的 `dumpsys meminfo` 很重，
        // 高负载（如运行游戏）时设备端 dumpsys 会触发服务超时、返回缺少「Used RAM」摘要的部分输出。
        this.execAdb(['-s', deviceId, 'shell', 'cat', '/proc/meminfo'], { timeout: 4000, maxBuffer: 1024 * 64 }),
        this.execAdb(['-s', deviceId, 'shell', 'top', '-n', '1'], { timeout: 5000, maxBuffer: 1024 * 1024 }),
        this.execAdb(gfxInfoArgs, { timeout: 4000, maxBuffer: 1024 * 1024 * 4 }),
      ]);

      const failed = [memResult, cpuResult, gfxResult].find((r) => r.status === 'rejected');
      if (failed && failed.status === 'rejected') {
        const reason = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
        throw new Error(`Android 采样命令失败，跳过本拍（不编造 0）：${reason}`);
      }

      const memInfo = memResult.status === 'fulfilled' ? memResult.value.stdout : '';
      const cpuInfo = cpuResult.status === 'fulfilled' ? cpuResult.value.stdout : '';
      const gfxInfo = gfxResult.status === 'fulfilled' ? gfxResult.value.stdout : '';

      const memoryUsage = this.parseMemoryUsage(memInfo);
      const cpuUsage = this.parseCpuUsage(cpuInfo);

      return {
        provider: 'android',
        cpuUsage,
        memoryUsage,
        fps: this.parseGfxInfo(gfxInfo),
        packageName: foregroundApp.packageName,
        activityName: foregroundApp.activityName,
        androidMetrics: {
          source: 'android',
          cpuSource: 'adb shell top -n 1',
          memorySource: 'adb shell cat /proc/meminfo',
          fpsSource: foregroundApp.packageName
            ? `adb shell dumpsys gfxinfo ${foregroundApp.packageName} framestats`
            : 'adb shell dumpsys gfxinfo framestats',
        },
      };
    } catch (error) {
      // 不再编造 0 兜底：失败如实上抛，让采集层跳过本拍（曲线断点），避免假 0 误导分析。
      logger.warn('AdbRuntimeInspector: getAndroidPerformanceMetrics failed（本拍跳过，不编造 0）:', error);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  private async buildPicoFallbackMetrics(
    deviceId: string,
    foregroundApp: ForegroundAppContext,
    appSupport: PicoAppSupportResult,
    message: string
  ): Promise<PerformanceMetrics> {
    const fallback = await this.getAndroidPerformanceMetrics(deviceId, foregroundApp);
    return {
      ...fallback,
      provider: 'pico',
      picoMetrics: {},
      picoMetricsState: this.hasUsefulFallbackMetrics(fallback) ? 'fallback' : 'unavailable',
      picoMetricsMessage: message,
      picoAppSupport: appSupport.status,
      picoSupportMessage: appSupport.message,
    };
  }

  private hasNativePicoMetrics(picoMetrics: NonNullable<PerformanceMetrics['picoMetrics']>): boolean {
    return Boolean(
      picoMetrics.fps ||
        picoMetrics.mtp ||
        picoMetrics.frameCpu ||
        picoMetrics.frameGpu ||
        picoMetrics.atwGpu ||
        picoMetrics.gpuUtil
    );
  }

  private hasUsefulFallbackMetrics(metrics: PerformanceMetrics): boolean {
    return metrics.cpuUsage > 0 || metrics.memoryUsage > 0 || metrics.fps > 0;
  }

  private parseCpuUsage(output: string): number {
    const cpuLine = output.match(/(\d+(?:\.\d+)?)%\s*cpu[^\n]*?(\d+(?:\.\d+)?)%\s*idle/i);
    if (cpuLine) {
      const totalCpu = Number.parseFloat(cpuLine[1]);
      const idleCpu = Number.parseFloat(cpuLine[2]);
      if (totalCpu > 0) {
        return Math.max(0, Math.min(((totalCpu - idleCpu) / totalCpu) * 100, 100));
      }
    }

    const totalLine = output.match(/(\d+(?:\.\d+)?)%\s+TOTAL:/i);
    if (totalLine) {
      return Math.max(0, Math.min(Number.parseFloat(totalLine[1]), 100));
    }

    const legacyMatch = output.match(/(\d+(?:\.\d+)?)%?\s+cpu/i);
    return Math.max(0, Math.min(Number.parseFloat(legacyMatch?.[1] || '0'), 100));
  }

  // 已用内存（KB）。优先 /proc/meminfo：Used = MemTotal - MemAvailable（无 MemAvailable 时退回 MemFree）。
  // 兼容旧 dumpsys meminfo 输出，以防个别设备 /proc 不可读。
  private parseMemoryUsage(output: string): number {
    const readKb = (re: RegExp) => {
      const match = output.match(re);
      return match ? Number.parseInt(match[1].replace(/,/g, ''), 10) : NaN;
    };
    const total = readKb(/MemTotal:\s+(\d+)\s*kB/i);
    const available = readKb(/MemAvailable:\s+(\d+)\s*kB/i);
    const free = readKb(/MemFree:\s+(\d+)\s*kB/i);
    if (Number.isFinite(total) && Number.isFinite(available)) return Math.max(0, total - available);
    if (Number.isFinite(total) && Number.isFinite(free)) return Math.max(0, total - free);

    const usedRam = readKb(/Used RAM:\s+([\d,]+)K/i);
    return Number.isFinite(usedRam) ? usedRam : 0;
  }

  async getProcesses(deviceId: string): Promise<ProcessInfo[]> {
    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'ps']);
      const lines = stdout.trim().split('\n');
      const processes: ProcessInfo[] = [];

      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length < 9) continue;

        const name = parts[parts.length - 1];
        processes.push({
          pid: Number.parseInt(parts[1], 10),
          ppid: Number.parseInt(parts[2], 10),
          name,
          packageName: name,
          cpuUsage: Number.parseFloat(parts[8]) || 0,
          memoryUsage: Number.parseFloat(parts[9]) || 0,
          status: 'running',
        });
      }

      return processes;
    } catch (error) {
      logger.error('AdbRuntimeInspector: getProcesses failed:', error);
      return [];
    }
  }

  async getActivityStack(deviceId: string, packageName?: string): Promise<ActivityStackEntry[]> {
    const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'activity', 'activities'], {
      maxBuffer: 1024 * 1024 * 8,
    });
    return this.parseActivityStack(stdout, packageName);
  }

  // 解析 dumpsys power 文本判断屏幕开关，多版本兼容；识别不出返回 unknown（不臆测）。
  private parseScreenState(raw: string): 'on' | 'off' | 'unknown' {
    const wakefulness = raw.match(/mWakefulness=(\w+)/i)?.[1]?.toLowerCase();
    if (wakefulness === 'awake') return 'on';
    if (wakefulness === 'asleep') return 'off';

    const displayPowerState = raw.match(/Display Power:.*state=(ON|OFF)/i)?.[1]?.toLowerCase();
    if (displayPowerState === 'on') return 'on';
    if (displayPowerState === 'off') return 'off';

    const screenState = raw.match(/mScreenState=(ON|OFF)/i)?.[1]?.toLowerCase();
    if (screenState === 'on') return 'on';
    if (screenState === 'off') return 'off';

    return 'unknown';
  }

  // 供设备卡片用：返回 on/off/unknown。异常或识别不出一律 unknown——状态徽标宁可显示「未知」也不臆测。
  async getScreenState(deviceId: string): Promise<'on' | 'off' | 'unknown'> {
    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'power'], {
        maxBuffer: 1024 * 1024 * 4,
      });
      return this.parseScreenState(stdout);
    } catch (error) {
      logger.warn('AdbRuntimeInspector: getScreenState failed:', error);
      return 'unknown';
    }
  }

  private async getScreenPowerState(deviceId: string): Promise<{ isOn: boolean; raw?: string }> {
    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'power'], {
        maxBuffer: 1024 * 1024 * 4,
      });
      const state = this.parseScreenState(stdout);
      if (state === 'unknown') {
        // 快照场景沿用旧的保守策略：识别不出时按「亮屏」处理，照常抓取截图，避免误判息屏拦截。
        logger.warn('AdbRuntimeInspector: unknown screen power state, capturing screenshot conservatively.');
        return { isOn: true, raw: stdout };
      }
      return { isOn: state === 'on', raw: stdout };
    } catch (error) {
      logger.warn('AdbRuntimeInspector: getScreenPowerState failed, capturing screenshot:', error);
      return { isOn: true };
    }
  }

  private async getDeviceFingerprint(deviceId: string): Promise<DeviceFingerprint> {
    try {
      const [manufacturer, brand, model, device] = await Promise.all([
        this.getDeviceProp(deviceId, 'ro.product.manufacturer'),
        this.getDeviceProp(deviceId, 'ro.product.brand'),
        this.getDeviceProp(deviceId, 'ro.product.model'),
        this.getDeviceProp(deviceId, 'ro.product.device'),
      ]);

      return { manufacturer, brand, model, device };
    } catch (error) {
      logger.warn('AdbRuntimeInspector: getDeviceFingerprint failed:', error);
      return {};
    }
  }

  private async getDeviceProp(deviceId: string, propertyName: string): Promise<string> {
    const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'getprop', propertyName], {
      timeout: 5000,
      maxBuffer: 1024 * 64,
    });
    return stdout.trim();
  }

  private isPicoDevice(fingerprint: DeviceFingerprint): boolean {
    const identity = [fingerprint.manufacturer, fingerprint.brand, fingerprint.model, fingerprint.device]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return identity.includes('pico');
  }

  private parseGfxInfo(output: string): number {
    return this.parseFrameStatsFps(output) || this.parseLegacyFps(output);
  }

  private parseFrameStatsFps(output: string): number {
    const profileSections = output.split('---PROFILEDATA---').slice(1);
    for (const section of profileSections) {
      const lines = section
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

      const headerIndex = lines.findIndex((line) => line.startsWith('Flags,'));
      if (headerIndex < 0) {
        continue;
      }

      const header = lines[headerIndex].split(',');
      const intendedVsyncIndex = header.indexOf('IntendedVsync');
      const frameCompletedIndex = header.indexOf('FrameCompleted');
      if (intendedVsyncIndex < 0 || frameCompletedIndex < 0) {
        continue;
      }

      const frameRows = lines
        .slice(headerIndex + 1)
        .map((line) => line.split(','))
        .filter((columns) => columns.length > frameCompletedIndex);

      const recentRows = frameRows.slice(-60);
      const frameDurations = recentRows
        .map((columns) => {
          const intendedVsync = Number.parseInt(columns[intendedVsyncIndex] || '0', 10);
          const frameCompleted = Number.parseInt(columns[frameCompletedIndex] || '0', 10);
          return { intendedVsync, frameCompleted };
        })
        .filter((row) => row.intendedVsync > 0 && row.frameCompleted > row.intendedVsync);

      if (frameDurations.length < 2) {
        continue;
      }

      const firstFrame = frameDurations[0];
      const lastFrame = frameDurations[frameDurations.length - 1];
      const durationNs = lastFrame.frameCompleted - firstFrame.intendedVsync;
      if (durationNs <= 0) {
        continue;
      }

      const fps = frameDurations.length / (durationNs / 1_000_000_000);
      if (Number.isFinite(fps) && fps > 0) {
        return Math.round(fps * 10) / 10;
      }
    }

    return 0;
  }

  private parseLegacyFps(output: string): number {
    const match = output.match(/(\d+\.?\d*)\s+fps/i);
    return Number.parseFloat(match?.[1] || '0');
  }

  // 带 TTL 缓存的前台应用解析：采集每秒一拍，但前台应用几乎不变，TTL 内直接复用上次结果，
  // 把重型 dumpsys 从「每拍一次」降到「每 5 秒一次」——显著降耗电、少超时。
  private async getForegroundAppContextCached(deviceId: string): Promise<ForegroundAppContext> {
    const cached = this.foregroundAppCache.get(deviceId);
    if (cached && Date.now() - cached.at < FOREGROUND_APP_TTL_MS) {
      return cached.context;
    }
    try {
      const context = await this.getForegroundAppContext(deviceId);
      // 只缓存解析出包名的有效结果；解析失败时若有旧值则沿用旧值，避免 gfxinfo 丢前台目标。
      if (context.packageName) {
        this.foregroundAppCache.set(deviceId, { context, at: Date.now() });
        return context;
      }
      return cached?.context ?? context;
    } catch (error) {
      logger.warn('AdbRuntimeInspector: getForegroundAppContextCached failed, reuse last known:', error);
      return cached?.context ?? {};
    }
  }

  private async getForegroundAppContext(deviceId: string): Promise<ForegroundAppContext> {
    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'window', 'windows'], {
        timeout: 4000,
        maxBuffer: 1024 * 1024 * 4,
      });
      const fromWindows = this.parseForegroundAppFromWindow(stdout);
      if (fromWindows.packageName) {
        return fromWindows;
      }
    } catch (error) {
      logger.warn('AdbRuntimeInspector: getForegroundAppContext(window) failed:', error);
    }

    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'activity', 'activities'], {
        timeout: 4000,
        maxBuffer: 1024 * 1024 * 8,
      });
      const activities = this.parseActivityStack(stdout);
      const resumed = activities.find((entry) => entry.state.toUpperCase() === 'RESUMED') || activities[0];
      return resumed
        ? {
            packageName: resumed.packageName,
            activityName: resumed.activityName,
          }
        : {};
    } catch (error) {
      logger.warn('AdbRuntimeInspector: getForegroundAppContext(activity) failed:', error);
      return {};
    }
  }

  private parseForegroundAppFromWindow(output: string): ForegroundAppContext {
    const patterns = [
      /mCurrentFocus=.*? ([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
      /mFocusedApp=.*? ([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/,
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match) {
        return {
          packageName: match[1],
          activityName: match[2],
        };
      }
    }

    return {};
  }

  private parseActivityStack(output: string, packageFilter?: string): ActivityStackEntry[] {
    const entries: ActivityStackEntry[] = [];
    const lines = output.split('\n');
    let currentTaskId: string | undefined;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      const taskMatch = line.match(/(?:TASK|TaskRecord|Task)\s*#?(\d+)/i);
      if (taskMatch) {
        currentTaskId = taskMatch[1];
      }

      if (!line.includes('ActivityRecord') && !line.includes('Hist #')) {
        continue;
      }

      const componentMatch = line.match(/([a-zA-Z0-9_.]+)\/([a-zA-Z0-9_.$]+)/);
      if (!componentMatch) {
        continue;
      }

      const pkg = componentMatch[1];
      if (packageFilter && !pkg.toLowerCase().includes(packageFilter.toLowerCase())) {
        continue;
      }

      const stateMatch =
        line.match(/\b(?:state|mState)=([A-Z_]+)/i) ||
        line.match(/\b(RESUMED|PAUSED|STOPPED|STARTED|DESTROYED)\b/i);

      entries.push({
        id: `${pkg}-${entries.length}-${Date.now()}`,
        packageName: pkg,
        activityName: componentMatch[2],
        state: stateMatch?.[1] || 'UNKNOWN',
        taskId: currentTaskId,
        raw: line,
      });
    }

    return entries;
  }
}
