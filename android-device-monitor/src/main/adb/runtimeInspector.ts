import type { ExecFileOptions } from 'child_process';
import type { ActivityStackEntry, PerformanceMetrics, ProcessInfo } from '../../shared/types';
import { logger } from '../logger';
import { PicoAppSupportResult, PicoMetricsReader } from './picoMetrics';
import { AdbScreenshotCapture, CapturedScreenshot } from './screenshotCapture';

type ExecAdbText = (args: string[], options?: ExecFileOptions) => Promise<{ stdout: string; stderr: string }>;
type ExecAdbBuffer = (args: string[], options?: ExecFileOptions) => Promise<{ stdout: Buffer; stderr: Buffer }>;

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

export type CapturedPerformanceSnapshot = {
  capturedAt: Date;
  metrics: PerformanceMetrics;
  screenshot: CapturedScreenshot;
};

type PerformanceOptions = {
  preferPico?: boolean;
  currentMetrics?: PerformanceMetrics;
};

export class AdbRuntimeInspector {
  private readonly picoMetricsReader: PicoMetricsReader;
  private readonly screenshotCapture: AdbScreenshotCapture;

  constructor(
    private readonly execAdb: ExecAdbText,
    private readonly execAdbBuffer: ExecAdbBuffer
  ) {
    this.picoMetricsReader = new PicoMetricsReader(this.execAdb);
    this.screenshotCapture = new AdbScreenshotCapture(this.execAdbBuffer);
  }

  async getPerformanceMetrics(deviceId: string, options: PerformanceOptions = {}): Promise<PerformanceMetrics> {
    try {
      const foregroundApp = await this.getForegroundAppContext(deviceId);
      const isPicoDevice = options.preferPico || (await this.picoMetricsReader.isPicoDevice(deviceId).catch(() => false));
      if (isPicoDevice) {
        const appSupport = await this.picoMetricsReader.detectForegroundAppSupport(deviceId, foregroundApp);
        try {
          const picoMetrics = await this.picoMetricsReader.getPerformanceMetrics(deviceId, foregroundApp);
          if (picoMetrics?.picoMetrics && this.hasNativePicoMetrics(picoMetrics.picoMetrics)) {
            const androidMetrics = await this.getAndroidPerformanceMetrics(deviceId, foregroundApp).catch((error) => {
              logger.warn('AdbRuntimeInspector: getPerformanceMetrics(android sidecar) failed:', error);
              return undefined;
            });
            const nativePicoFps = picoMetrics.picoMetrics.fps?.value ?? androidMetrics?.fps ?? picoMetrics.fps;
            return {
              ...picoMetrics,
              cpuUsage: androidMetrics?.cpuUsage ?? 0,
              memoryUsage: androidMetrics?.memoryUsage ?? 0,
              fps: nativePicoFps,
              picoMetricsState: 'native',
              picoAppSupport: appSupport.status,
              picoSupportMessage: appSupport.message,
              androidMetrics: androidMetrics?.androidMetrics,
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
      logger.error('AdbRuntimeInspector: getPerformanceMetrics failed:', error);
      return {
        provider: 'android',
        cpuUsage: 0,
        memoryUsage: 0,
        fps: 0,
      };
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

      const [memInfo, cpuInfo, gfxInfo] = await Promise.all([
        this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'meminfo']),
        this.execAdb(['-s', deviceId, 'shell', 'top', '-n', '1']),
        this.execAdb(gfxInfoArgs).catch(() => ({ stdout: '', stderr: '' })),
      ]);

      const memoryUsage = this.parseMemoryUsage(memInfo.stdout);
      const cpuUsage = this.parseCpuUsage(cpuInfo.stdout);

      return {
        provider: 'android',
        cpuUsage,
        memoryUsage,
        fps: this.parseGfxInfo(gfxInfo.stdout),
        packageName: foregroundApp.packageName,
        activityName: foregroundApp.activityName,
        androidMetrics: {
          source: 'android',
          cpuSource: 'adb shell top -n 1',
          memorySource: 'adb shell dumpsys meminfo',
          fpsSource: foregroundApp.packageName
            ? `adb shell dumpsys gfxinfo ${foregroundApp.packageName} framestats`
            : 'adb shell dumpsys gfxinfo framestats',
        },
      };
    } catch (error) {
      logger.error('AdbRuntimeInspector: getAndroidPerformanceMetrics failed:', error);
      return {
        provider: 'android',
        cpuUsage: 0,
        memoryUsage: 0,
        fps: 0,
      };
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

  private parseMemoryUsage(output: string): number {
    const usedMatch = output.match(/Used RAM:\s+([\d,]+)K/i);
    if (usedMatch) {
      return Number.parseInt(usedMatch[1].replace(/,/g, ''), 10);
    }

    const topMemMatch = output.match(/Mem:\s+([\d,]+)([KMG])\s+total,\s+([\d,]+)([KMG])\s+used/i);
    if (topMemMatch) {
      return this.toKilobytes(topMemMatch[3], topMemMatch[4]);
    }

    const totalMatch = output.match(/Total RAM:\s+([\d,]+)K/i);
    return Number.parseInt(totalMatch?.[1]?.replace(/,/g, '') || '0', 10);
  }

  private toKilobytes(value: string, unit: string): number {
    const parsed = Number.parseInt(value.replace(/,/g, ''), 10);
    if (unit.toUpperCase() === 'G') return parsed * 1024 * 1024;
    if (unit.toUpperCase() === 'M') return parsed * 1024;
    return parsed;
  }

  async capturePerformanceSnapshot(deviceId: string, options: PerformanceOptions = {}): Promise<CapturedPerformanceSnapshot> {
    const screenState = await this.getScreenPowerState(deviceId);
    if (!screenState.isOn) {
      throw new Error('设备当前息屏，请先唤醒设备后再抓取性能快照。');
    }

    const metrics = options.currentMetrics || await this.getPerformanceMetrics(deviceId, options);
    const screenshot = await this.screenshotCapture.capture(deviceId);

    return {
      capturedAt: new Date(),
      metrics,
      screenshot,
    };
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

  private async getForegroundAppContext(deviceId: string): Promise<ForegroundAppContext> {
    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'window', 'windows'], {
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
