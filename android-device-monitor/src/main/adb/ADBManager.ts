import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as path from 'path';
import type { ExecFileOptions } from 'child_process';
import { ActivityStackEntry, AdbStatus, DeviceInfo, LogEntry, NetworkRequest, PerformanceMetrics, PerformanceRecording, PerformanceRecordingOptions, ProcessInfo } from '../../shared/types';
import { logger } from '../logger';
import { AdbCommandError, classifyAdbError } from './adbError';
import { ResolvedAdbBinary, getBundledAdbCandidates, resolveBundledAdbBinaryPath } from './adbBinary';
import { AdbRuntimeInspector, CapturedPerformanceSnapshot } from './runtimeInspector';
import { PerformanceRecordingManager } from './performanceRecording';

export interface PerformanceInfo {
  provider?: 'android' | 'pico';
  cpu: number;
  memory: number;
  fps: number;
  network: { rx: number; tx: number };
  packageName?: string;
  activityName?: string;
}

type HttpPacketBlock = {
  timestamp: Date | null;
  payload: string;
};

type ParsedHttpMessage = {
  timestamp: Date | null;
  startLine: string;
  headers: Record<string, string>;
  body?: string;
  raw: string;
};

type DeviceSummary = Pick<DeviceInfo, 'id' | 'connectionType' | 'status'>;
type StopLogcatProcess = {
  stop: () => Promise<void>;
};

type ParsedHttpRequestMessage = ParsedHttpMessage & {
  method: string;
  path: string;
  httpVersion: string;
};

type ParsedHttpResponseMessage = ParsedHttpMessage & {
  httpVersion: string;
  statusCode: number;
  statusText: string;
};

const execFileAsync = promisify(execFile);

export class ADBManager extends EventEmitter {
  private readonly runtimeInspector = new AdbRuntimeInspector(
    (args, options) => this.execAdb(args, options),
    (args, options) => this.execAdbBuffer(args, options)
  );
  private readonly performanceRecordingManager = new PerformanceRecordingManager(
    (args, options) => this.execAdb(args, options),
    async () => (await this.resolveAdbBinary()).path,
    (deviceId) => this.getPerformanceMetrics(deviceId)
  );
  private adbBinary: ResolvedAdbBinary | null = null;
  private deviceInfoCache = new Map<string, DeviceInfo>();
  private lastDeviceSnapshot = new Map<string, string>();
  private logcatProcesses = new Map<string, StopLogcatProcess>();
  private logcatBuffer = new Map<string, string>();
  private logcatPidPackageCache = new Map<string, Map<number, string>>();
  private logcatPidPackageRefreshAt = new Map<string, number>();
  private logcatPidPackageRefreshes = new Map<string, Promise<void>>();
  private wifiLatencyCache = new Map<string, { checkedAt: number; latencyMs?: number; status: 'ok' | 'timeout' | 'unknown' }>();
  private batteryLevelCache = new Map<string, { checkedAt: number; batteryLevel?: number }>();
  private deviceMonitorTimer: NodeJS.Timeout | null = null;
  private isDeviceMonitorPolling = false;
  private adbStatus: AdbStatus = {
    available: false,
    version: null,
    path: null,
    message: '正在检测 ADB 环境...',
    checkedAt: 0,
  };
  private readonly maxLogCallbacksPerSecond = 1500;
  private readonly maxLogLinesPerChunk = 4000;
  private readonly maxLogcatBufferChars = 256 * 1024;
  private readonly logcatPidPackageRefreshIntervalMs = 2000;
  private readonly deviceMonitorIntervalMs = 3000;
  private readonly adbStatusCacheMs = 5000;
  private readonly wifiLatencyCacheMs = 3000;
  private readonly batteryLevelCacheMs = 30000;

  async getDevices(): Promise<DeviceInfo[]> {
    try {
      logger.log('ADBManager: getDevices called');
      const { stdout } = await this.execAdb(['devices', '-l']);
      logger.log('ADBManager: adb devices output:', stdout);
      
      const summaries = this.parseDeviceSummaries(stdout);
      const nextCache = new Map<string, DeviceInfo>();
      
      const devices = await Promise.all(summaries.map(async (summary) => {
        let device: DeviceInfo = {
          id: summary.id,
          name: 'Unknown',
          model: 'Unknown',
          manufacturer: 'Unknown',
          androidVersion: 'Unknown',
          apiLevel: 0,
          connectionType: summary.connectionType,
          status: summary.status,
        };
        
        try {
          const props = await this.getDeviceProperties(summary.id);
          device.name = props['ro.product.name'] || device.name;
          device.model = props['ro.product.model'] || device.model;
          device.manufacturer = props['ro.product.manufacturer'] || device.manufacturer;
          device.androidVersion = props['ro.build.version.release'] || device.androidVersion;
          device.apiLevel = parseInt(props['ro.build.version.sdk'] || '0');
        } catch (e) {
          logger.warn('Failed to get props for', summary.id, e);
        }

        device = await this.refreshBatteryLevelForDevice(device);
        device = await this.refreshWifiLatencyForDevice(device);
        nextCache.set(summary.id, device);
        return device;
      }));

      this.deviceInfoCache = nextCache;
      
      logger.log('ADBManager: parsed devices:', devices);
      return devices;
    } catch (error) {
      logger.error('ADBManager: Failed to get devices:', error);
      throw this.wrapOperationError('Failed to get device list', error);
    }
  }

  private parseDeviceSummaries(stdout: string): DeviceSummary[] {
    const lines = stdout.trim().split('\n');
    const summaries: DeviceSummary[] = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      const id = parts[0];

      if (!id || id === 'List') continue;

      const rawStatus = parts[1] || '';
      if (rawStatus !== 'device' && rawStatus !== 'offline' && rawStatus !== 'unauthorized') {
        logger.log('ADBManager: skipping unknown status:', id, rawStatus);
        continue;
      }

      if (id === 'adb' || id.startsWith('emulator-') || id === 'host') {
        logger.log('ADBManager: skipping special device:', id);
        continue;
      }

      summaries.push({
        id,
        connectionType: id.includes(':') ? 'wifi' : 'usb',
        status: rawStatus === 'device' ? 'connected' : rawStatus,
      });
    }

    return summaries;
  }

  private createDeviceSummarySnapshot(device: DeviceSummary): string {
    return [
      device.id,
      device.status,
      device.connectionType,
    ].join('|');
  }

  private async getDeviceSummaries(): Promise<DeviceSummary[]> {
    const { stdout } = await this.execAdb(['devices', '-l']);
    return this.parseDeviceSummaries(stdout);
  }

  async connectUSB(): Promise<DeviceInfo[]> {
    try {
      await this.execAdb(['start-server']);
      return await this.getDevices();
    } catch (error) {
      logger.error('ADBManager: connectUSB failed:', error);
      throw this.wrapOperationError('USB connection refresh failed', error);
    }
  }

  private async getDeviceProperties(deviceId: string): Promise<Record<string, string>> {
    const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'getprop']);
    const props: Record<string, string> = {};
    
    for (const line of stdout.trim().split('\n')) {
      const match = line.match(/\[([^\]]+)\]: \[([^\]]*)\]/);
      if (match) {
        props[match[1]] = match[2];
      }
    }
    
    return props;
  }

  private async getBatteryLevel(deviceId: string): Promise<number | undefined> {
    const cached = this.batteryLevelCache.get(deviceId);
    if (cached && Date.now() - cached.checkedAt < this.batteryLevelCacheMs) {
      return cached.batteryLevel;
    }

    const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'battery'], {
      timeout: 3000,
      maxBuffer: 1024 * 64,
    });
    const match = stdout.match(/(?:level|capacity):\s*(\d+)/i);
    if (!match) {
      this.batteryLevelCache.set(deviceId, { checkedAt: Date.now(), batteryLevel: undefined });
      return undefined;
    }
    const level = Number.parseInt(match[1], 10);
    if (!Number.isFinite(level)) {
      this.batteryLevelCache.set(deviceId, { checkedAt: Date.now(), batteryLevel: undefined });
      return undefined;
    }
    const batteryLevel = Math.max(0, Math.min(level, 100));
    this.batteryLevelCache.set(deviceId, { checkedAt: Date.now(), batteryLevel });
    return batteryLevel;
  }

  private async refreshBatteryLevelForDevice(device: DeviceInfo): Promise<DeviceInfo> {
    if (device.status !== 'connected') {
      return device;
    }

    try {
      const batteryLevel = await this.getBatteryLevel(device.id);
      return {
        ...device,
        batteryLevel,
      };
    } catch (error) {
      logger.warn('Failed to get battery level for', device.id, error);
      return device;
    }
  }

  async connectWiFi(target: string): Promise<DeviceInfo> {
    try {
      logger.log('ADBManager: connectWiFi called with:', target);
      
      if (!target.includes(':')) {
        target = `${target}:5555`;
      }
      
      try {
        await this.execAdb(['disconnect', target]);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (_) {}
      
      const { stdout, stderr } = await this.execAdb(['connect', target], { timeout: 10000 });
      logger.log('ADBManager: connect result:', stdout, stderr);
      
      if (stdout.includes('refused') || stdout.includes('failed') || stderr.includes('refused') || stderr.includes('failed')) {
        throw new Error(stdout.trim() || stderr.trim());
      }
      
      if (!stdout.includes('connected') && !stderr.includes('connected') && !stdout.includes('already connected')) {
        throw new Error(stdout.trim() || stderr.trim() || 'Connection failed');
      }
      
      let connectedDevice: DeviceInfo | undefined;
      const maxRetries = 8;
      for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        const devices = await this.getDevices();
        connectedDevice = devices.find(d => d.id === target && d.status === 'connected');
        if (connectedDevice) {
          break;
        }
        logger.log(`ADBManager: connectWiFi retry ${i + 1}/${maxRetries}, device status: ${devices.find(d => d.id === target)?.status || 'not found'}`);
      }
      
      if (!connectedDevice) {
        const anyDevice = (await this.getDevices()).find(d => d.id === target);
        if (anyDevice && anyDevice.status === 'offline') {
          throw new Error('Device is offline. Please check USB debugging is enabled on the device and try again.');
        }
        throw new Error('Connected but device not found in list. Please check the device IP and port.');
      }
      
      connectedDevice.connectionType = 'wifi';
      return connectedDevice;
    } catch (error) {
      logger.error('ADBManager: connectWiFi failed:', error);
      throw this.wrapOperationError('WiFi connection failed', error);
    }
  }

  async disconnect(deviceId: string): Promise<void> {
    try {
      await this.execAdb(['disconnect', deviceId]);
      this.deviceInfoCache.delete(deviceId);
      this.wifiLatencyCache.delete(deviceId);
      this.batteryLevelCache.delete(deviceId);
    } catch (error) {
      throw this.wrapOperationError('Disconnect failed', error);
    }
  }

  private async measureWifiLatency(deviceId: string): Promise<{ latencyMs?: number; status: 'ok' | 'timeout' | 'unknown' }> {
    const cached = this.wifiLatencyCache.get(deviceId);
    if (cached && Date.now() - cached.checkedAt < this.wifiLatencyCacheMs) {
      return { latencyMs: cached.latencyMs, status: cached.status };
    }

    const startedAt = Date.now();
    let result: { latencyMs?: number; status: 'ok' | 'timeout' | 'unknown' };
    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'get-state'], {
        timeout: 3000,
        maxBuffer: 1024 * 4,
      });
      const state = stdout.trim();
      result = state === 'device'
        ? { latencyMs: Date.now() - startedAt, status: 'ok' }
        : { status: 'unknown' };
    } catch (error) {
      logger.warn('ADBManager: wifi latency probe failed:', deviceId, error);
      result = { status: 'unknown' };
    }

    this.wifiLatencyCache.set(deviceId, { checkedAt: Date.now(), latencyMs: result.latencyMs, status: result.status });
    return result;
  }

  private async refreshWifiLatencyForDevice(device: DeviceInfo): Promise<DeviceInfo> {
    if (device.connectionType !== 'wifi' || device.status !== 'connected') {
      return device;
    }

    const latency = await this.measureWifiLatency(device.id);
    return {
      ...device,
      latencyMs: latency.latencyMs,
      latencyStatus: latency.status,
    };
  }

  async startLogcat(
    deviceId: string,
    callback: (log: LogEntry) => void,
    minLevel: 'V' | 'D' | 'I' | 'W' | 'E' | 'F' = 'D',
    packageName?: string,
    pid?: string
  ): Promise<void> {
    try {
      await this.stopLogcat(deviceId);

      const levelPriority = { V: 0, D: 1, I: 2, W: 3, E: 4, F: 5 };
      const minPriority = levelPriority[minLevel];
      const sourcePid = await this.resolveLogcatPid(deviceId, packageName, pid);
      const sourcePackageName = sourcePid && packageName?.trim() ? packageName.trim() : undefined;
      const logcatArgs = ['-s', deviceId, 'logcat', '-v', 'time'];
      const adbBinary = await this.resolveAdbBinary();
      if (sourcePid) {
        logcatArgs.push(`--pid=${sourcePid}`);
      }
      logcatArgs.push(`*:${minLevel}`);

      let callbackWindowStart = Date.now();
      let callbackCount = 0;

      const logcatProcess = spawn(adbBinary.path, logcatArgs);
      
      logcatProcess.stdout.on('data', (data) => {
        this.refreshLogcatPidPackageCacheIfNeeded(deviceId);
        const rawData = data.toString('utf-8');
        const existingBuffer = this.logcatBuffer.get(deviceId) || '';
        const fullData = (existingBuffer + rawData).slice(-this.maxLogcatBufferChars);
        const lines = fullData.split('\n');
        
        let remainingBuffer = '';
        if (lines.length > 0 && !rawData.endsWith('\n')) {
          remainingBuffer = lines.pop() || '';
        }
        this.logcatBuffer.set(deviceId, remainingBuffer);
        
        const limitedLines = lines.length > this.maxLogLinesPerChunk
          ? lines.slice(-this.maxLogLinesPerChunk)
          : lines;

        for (const line of limitedLines) {
          if (!line.trim()) continue;
          
          const logEntry = this.parseLogcatLine(line, deviceId);
          if (logEntry) {
            const entryPriority = levelPriority[logEntry.level];
            if (entryPriority >= minPriority) {
              const now = Date.now();
              if (now - callbackWindowStart >= 1000) {
                callbackWindowStart = now;
                callbackCount = 0;
              }
              if (callbackCount >= this.maxLogCallbacksPerSecond) {
                continue;
              }
              callbackCount++;
              if (sourcePackageName) {
                logEntry.packageName = sourcePackageName;
              } else {
                logEntry.packageName = this.getCachedLogcatPackageName(deviceId, logEntry.processId);
              }
              callback(logEntry);
            }
          }
        }
      });
      
      logcatProcess.stderr.on('data', (data) => {
        logger.error('Logcat error:', data.toString().slice(-4096));
      });
      
      logcatProcess.on('error', (err) => {
        logger.error('ADBManager: logcat process error:', err);
      });
      
      let stopEntry: StopLogcatProcess | undefined;
      logcatProcess.on('close', () => {
        if (this.logcatProcesses.get(deviceId) === stopEntry) {
          this.logcatProcesses.delete(deviceId);
        }
        this.logcatBuffer.delete(deviceId);
        this.clearLogcatPackageCache(deviceId);
      });
      
      stopEntry = {
        stop: async () => {
        logcatProcess.stdout.removeAllListeners('data');
        logcatProcess.stderr.removeAllListeners('data');

        if (!logcatProcess.killed) {
          if (process.platform === 'win32' && logcatProcess.pid) {
            await this.killWindowsProcessTree(logcatProcess.pid);
          } else {
            logcatProcess.kill('SIGTERM');
          }
        }
        if (this.logcatProcesses.get(deviceId) === stopEntry) {
          this.logcatProcesses.delete(deviceId);
        }
        this.logcatBuffer.delete(deviceId);
        this.clearLogcatPackageCache(deviceId);
        },
      };
      
      this.logcatProcesses.set(deviceId, stopEntry);
    } catch (error) {
      logger.error('ADBManager: startLogcat failed:', error);
      throw new Error('启动日志监听失败: ' + (error as Error).message);
    }
  }

  async stopLogcat(deviceId: string): Promise<void> {
    const stopEntry = this.logcatProcesses.get(deviceId);
    if (stopEntry) {
      await stopEntry.stop();
    }
    this.logcatBuffer.delete(deviceId);
    this.clearLogcatPackageCache(deviceId);
  }

  private refreshLogcatPidPackageCacheIfNeeded(deviceId: string): void {
    const now = Date.now();
    const lastRefreshAt = this.logcatPidPackageRefreshAt.get(deviceId) || 0;
    if (now - lastRefreshAt < this.logcatPidPackageRefreshIntervalMs) {
      return;
    }
    if (this.logcatPidPackageRefreshes.has(deviceId)) {
      return;
    }

    this.logcatPidPackageRefreshAt.set(deviceId, now);
    const refreshPromise = this.refreshLogcatPidPackageCache(deviceId)
      .catch((error) => {
        logger.warn('ADBManager: failed to refresh logcat package cache:', deviceId, error);
      })
      .finally(() => {
        this.logcatPidPackageRefreshes.delete(deviceId);
      });
    this.logcatPidPackageRefreshes.set(deviceId, refreshPromise);
  }

  private async refreshLogcatPidPackageCache(deviceId: string): Promise<void> {
    const stdout = await this.getProcessListOutput(deviceId);
    const pidPackages = new Map<number, string>();
    const lines = stdout.trim().split('\n');

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number(parts[1]);
      if (!Number.isFinite(pid)) continue;
      const processName = parts[parts.length - 1];
      const packageName = this.normalizeAndroidPackageName(processName);
      if (packageName) {
        pidPackages.set(pid, packageName);
      }
    }

    this.logcatPidPackageCache.set(deviceId, pidPackages);
  }

  private async getProcessListOutput(deviceId: string): Promise<string> {
    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'ps', '-A']);
      return stdout;
    } catch {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'ps']);
      return stdout;
    }
  }

  private normalizeAndroidPackageName(processName: string): string | undefined {
    if (!processName || !processName.includes('.')) {
      return undefined;
    }
    const basePackageName = processName.split(':')[0];
    return /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/.test(basePackageName) ? basePackageName : undefined;
  }

  private getCachedLogcatPackageName(deviceId: string, processId: number): string | undefined {
    if (!processId) return undefined;
    return this.logcatPidPackageCache.get(deviceId)?.get(processId);
  }

  private clearLogcatPackageCache(deviceId: string): void {
    this.logcatPidPackageCache.delete(deviceId);
    this.logcatPidPackageRefreshAt.delete(deviceId);
    this.logcatPidPackageRefreshes.delete(deviceId);
  }

  private async resolveLogcatPid(deviceId: string, packageName?: string, pid?: string): Promise<string | undefined> {
    const cleanedPid = pid?.trim();
    if (cleanedPid) {
      if (!/^\d+$/.test(cleanedPid)) {
        throw new Error('PID must be numeric.');
      }
      return cleanedPid;
    }

    const cleanedPackage = packageName?.trim();
    if (!cleanedPackage) {
      return undefined;
    }

    try {
      const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'pidof', cleanedPackage]);
      return stdout.trim().split(/\s+/).find((value) => /^\d+$/.test(value));
    } catch (error) {
      logger.warn('ADBManager: package process not found, continuing unscoped logcat:', cleanedPackage, error);
      return undefined;
    }
  }

  private parseLogcatLine(line: string, deviceId: string): LogEntry | null {
    try {
      const timeFormatMatch = line.match(/^(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]+):\s?(.*)$/);
      if (timeFormatMatch) {
        const [, month, day, hours, minutes, seconds, ms, pid, tid, level, tag, message] = timeFormatMatch;
        const now = new Date();
        return {
          id: `${pid}-${tid}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
          deviceId,
          timestamp: new Date(now.getFullYear(), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds), Number(ms)),
          processId: Number(pid),
          threadId: Number(tid),
          level: level as LogEntry['level'],
          tag: tag.trim(),
          message
        };
      }

      const fullTimePattern = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})/;
      const fullTimeMatch = line.match(fullTimePattern);
      
      let timestamp = new Date();
      if (fullTimeMatch) {
        const timeStr = fullTimeMatch[1];
        const datePart = timeStr.substring(0, 5);
        const timePart = timeStr.substring(6);
        
        const now = new Date();
        const currentYear = now.getFullYear();
        const [month, day] = datePart.split('-').map(Number);
        const [hours, minutes, secondsMs] = timePart.split(':');
        const [seconds, ms] = secondsMs.split('.');
        
        timestamp = new Date(currentYear, month - 1, day, parseInt(hours), parseInt(minutes), parseInt(seconds), parseInt(ms));
      }

      const levelPattern = /([VDIWEF])\//;
      const levelMatch = line.match(levelPattern);
      if (!levelMatch) {
        return {
          id: `unknown-${Date.now()}`,
          deviceId,
          timestamp,
          processId: 0,
          threadId: 0,
          level: 'V',
          tag: 'UNKNOWN',
          message: line
        };
      }

      const level = levelMatch[1] as LogEntry['level'];
      
      const tagPattern = /[VDIWEF]\/([^\(\s]+)/;
      const tagMatch = line.match(tagPattern);
      const tag = tagMatch ? tagMatch[1].trim() : 'UNKNOWN';
      
      const pidPattern = /\((\d+)\)/;
      const pidMatch = line.match(pidPattern);
      const processId = pidMatch ? parseInt(pidMatch[1]) : 0;
      
      const messageStart = line.indexOf('):');
      const message = messageStart >= 0 ? line.substring(messageStart + 2).trim() : line;
      
      return {
        id: `${processId}-${timestamp.getTime()}`,
        deviceId,
        timestamp,
        processId,
        threadId: 0,
        level,
        tag,
        message
      };
    } catch (e) {
      return {
        id: `unknown-${Date.now()}`,
        deviceId,
        timestamp: new Date(),
        processId: 0,
        threadId: 0,
        level: 'V',
        tag: 'UNKNOWN',
        message: line
      };
    }
  }

  async getPerformanceInfo(deviceId: string): Promise<PerformanceInfo> {
    const metrics = await this.runtimeInspector.getPerformanceMetrics(deviceId, {
      preferPico: this.isLikelyPicoDevice(deviceId),
    });
    return {
      provider: metrics.provider,
      cpu: metrics.cpuUsage,
      memory: metrics.memoryUsage,
      fps: metrics.fps,
      network: { rx: 0, tx: 0 },
      packageName: metrics.packageName,
      activityName: metrics.activityName,
    };
  }

  async getPerformanceMetrics(deviceId: string): Promise<PerformanceMetrics> {
    return this.runtimeInspector.getPerformanceMetrics(deviceId, {
      preferPico: this.isLikelyPicoDevice(deviceId),
    });
  }

  async installApk(deviceId: string, apkPath: string): Promise<string> {
    const cleanedApkPath = apkPath.trim();
    if (!cleanedApkPath.toLowerCase().endsWith('.apk')) {
      throw new Error('Only APK files can be installed.');
    }

    const installOptions: ExecFileOptions = {
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8,
    };
    const baseArgs = ['-s', deviceId, 'install', '-r', cleanedApkPath];
    const primaryResult = await this.execAdbWithExitCode(baseArgs, installOptions);
    const primaryOutput = [primaryResult.stdout, primaryResult.stderr].filter(Boolean).join('\n').trim();
    if (/success/i.test(primaryOutput)) {
      return primaryOutput;
    }

    if (this.shouldRetryInstallWithoutStreaming(primaryResult)) {
      const fallbackArgs = ['-s', deviceId, 'install', '--no-streaming', '-r', cleanedApkPath];
      const fallbackResult = await this.execAdbWithExitCode(fallbackArgs, installOptions);
      const fallbackOutput = [fallbackResult.stdout, fallbackResult.stderr].filter(Boolean).join('\n').trim();
      if (/success/i.test(fallbackOutput)) {
        return fallbackOutput;
      }

      throw new AdbCommandError({
        code: 'ADB_COMMAND_FAILED',
        message: `安装 APK 失败：${path.basename(cleanedApkPath)}`,
        hint: '已尝试普通安装和非流式安装，请检查设备存储空间、安装权限、签名兼容性和网络稳定性。',
        details: fallbackOutput || primaryOutput || 'adb install did not report success.',
      });
    }

    throw new AdbCommandError({
      code: 'ADB_COMMAND_FAILED',
      message: `安装 APK 失败：${path.basename(cleanedApkPath)}`,
      hint: '请检查设备连接、调试授权、安装权限、版本签名以及设备剩余空间。',
      details: primaryOutput || 'adb install did not report success.',
    });
  }

  async listInstalledPackages(deviceId: string): Promise<string[]> {
    // -3 仅列出第三方（用户安装）应用，排除系统应用。
    const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'pm', 'list', 'packages', '-3'], {
      timeout: 30 * 1000,
    });
    const packages = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('package:'))
      .map((line) => line.slice('package:'.length).trim())
      .filter(Boolean);
    return Array.from(new Set(packages)).sort((a, b) => a.localeCompare(b));
  }

  async uninstallApp(deviceId: string, packageName: string): Promise<string> {
    const cleanedPackage = packageName.trim();
    if (!cleanedPackage || !/^[A-Za-z][\w.]*$/.test(cleanedPackage)) {
      throw new AdbCommandError({
        code: 'ADB_COMMAND_FAILED',
        message: `卸载失败：非法包名 ${packageName}`,
        hint: '请从进程/应用列表中选择一个有效的应用包名。',
        details: `Invalid package name: ${packageName}`,
      });
    }

    const result = await this.execAdbWithExitCode(['-s', deviceId, 'uninstall', cleanedPackage], {
      timeout: 60 * 1000,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (/success/i.test(output)) {
      return output;
    }

    throw new AdbCommandError({
      code: 'ADB_COMMAND_FAILED',
      message: `卸载应用失败：${cleanedPackage}`,
      hint: '请确认该应用存在且非受保护的系统应用，部分预装应用无法卸载。',
      details: output || 'adb uninstall did not report success.',
    });
  }

  async sleepDevice(deviceId: string): Promise<void> {
    await this.execAdb(['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_SLEEP'], {
      timeout: 8000,
    });
  }

  async rebootDevice(deviceId: string): Promise<void> {
    const result = await this.execAdbWithExitCode(['-s', deviceId, 'reboot'], {
      timeout: 8000,
    });

    if (result.exitCode === 0 || this.isExpectedRebootDisconnect(result)) {
      this.deviceInfoCache.delete(deviceId);
      this.wifiLatencyCache.delete(deviceId);
      return;
    }

    throw this.createRebootError(result);
  }

  async capturePerformanceSnapshot(deviceId: string, currentMetrics?: PerformanceMetrics): Promise<CapturedPerformanceSnapshot> {
    return this.runtimeInspector.capturePerformanceSnapshot(deviceId, {
      preferPico: this.isLikelyPicoDevice(deviceId),
      currentMetrics,
    });
  }

  async startPerformanceRecording(
    deviceId: string,
    baseDir: string,
    options: PerformanceRecordingOptions
  ): Promise<PerformanceRecording> {
    return this.performanceRecordingManager.startRecording({
      deviceId,
      baseDir,
      options,
      isPico: this.isLikelyPicoDevice(deviceId),
    });
  }

  async getProcesses(deviceId: string): Promise<ProcessInfo[]> {
    return this.runtimeInspector.getProcesses(deviceId);
  }

  async getActivityStack(deviceId: string, packageName?: string): Promise<ActivityStackEntry[]> {
    try {
      return await this.runtimeInspector.getActivityStack(deviceId, packageName);
    } catch (error) {
      logger.error('ADBManager: getActivityStack failed:', error);
      throw new Error('Activity stack query failed: ' + (error as Error).message);
    }
  }

  async getNetworkRequests(deviceId: string, packageName?: string): Promise<NetworkRequest[]> {
    const tcpdumpArgs = [
      '-s', deviceId,
      'shell',
      'timeout',
      '5',
      'tcpdump',
      '-tttt',
      '-A',
      '-s',
      '0',
      '-c',
      '200',
      'tcp port 80'
    ];

    try {
      const { stdout, stderr } = await this.execAdb(tcpdumpArgs, {
        timeout: 8000,
        maxBuffer: 1024 * 1024 * 8
      });

      if (!stdout.trim() && stderr.trim()) {
        throw new Error(stderr.trim());
      }

      return this.parseHttpRequests(stdout, packageName);
    } catch (error) {
      logger.error('ADBManager: getNetworkRequests failed:', error);
      throw this.createNetworkCaptureError(error, tcpdumpArgs);
    }
  }

  private createNetworkCaptureError(error: unknown, args: string[]): AdbCommandError {
    if (error instanceof AdbCommandError) {
      return error;
    }

    const adbError = classifyAdbError(error, args);
    switch (adbError.code) {
      case 'ADB_TIMEOUT':
        return new AdbCommandError({
          code: adbError.code,
          message: '抓取 HTTP 请求超时，请在设备保持连接时重试，并确保目标应用会产生可抓取的 HTTP 明文流量。',
          hint: '如果应用主要使用 HTTPS，或者设备没有抓包权限，也可能表现为超时。',
          details: adbError.details,
        });
      case 'TCPDUMP_UNAVAILABLE':
        return new AdbCommandError({
          code: adbError.code,
          message: '当前设备无法执行 tcpdump 抓包，可能缺少 tcpdump 或抓包权限不足。',
          hint: '先确认设备支持 tcpdump，再检查是否需要 root、工程机权限或厂商调试能力。',
          details: adbError.details,
        });
      default:
        return new AdbCommandError({
          code: adbError.code,
          message: `抓取 HTTP 请求失败：${adbError.message}`,
          hint: adbError.hint,
          details: adbError.details,
        });
    }
  }

  async getAdbStatus(forceRefresh = false): Promise<AdbStatus> {
    const now = Date.now();
    if (!forceRefresh && this.adbStatus.checkedAt > 0 && now - this.adbStatus.checkedAt < this.adbStatusCacheMs) {
      return this.adbStatus;
    }

    const checkedAt = Date.now();
    try {
      const resolvedAdbBinary = await this.resolveAdbBinary(forceRefresh);
      const versionResult = await execFileAsync(resolvedAdbBinary.path, ['version'], { timeout: 3000 });
      const versionOutput = versionResult.stdout.toString();
      const versionMatch = versionOutput.match(/Android Debug Bridge version ([^\s]+)/i);
      const version = versionMatch?.[1] || null;
      const sourceLabel = resolvedAdbBinary.source === 'bundled' ? '内置 ADB' : '系统 ADB';
      const nextStatus: AdbStatus = {
        available: true,
        version,
        path: resolvedAdbBinary.path,
        source: resolvedAdbBinary.source,
        message: version ? `${sourceLabel} 已就绪（${version}）` : `${sourceLabel} 已就绪`,
        checkedAt,
      };
      this.updateAdbStatus(nextStatus);
      return nextStatus;
    } catch (error) {
      this.adbBinary = null;
      const adbError = classifyAdbError(error, ['version']);
      const nextStatus: AdbStatus = {
        available: false,
        version: null,
        path: null,
        source: undefined,
        message: adbError.message,
        checkedAt,
        code: adbError.code,
        hint: adbError.hint,
      };
      this.updateAdbStatus(nextStatus);
      return nextStatus;
    }
  }

  startDeviceMonitoring(intervalMs = this.deviceMonitorIntervalMs): void {
    if (this.deviceMonitorTimer) {
      return;
    }

    void this.pollDeviceChanges();
    this.deviceMonitorTimer = setInterval(() => {
      void this.pollDeviceChanges();
    }, intervalMs);
  }

  stopDeviceMonitoring(): void {
    if (this.deviceMonitorTimer) {
      clearInterval(this.deviceMonitorTimer);
      this.deviceMonitorTimer = null;
    }
  }

  private async killWindowsProcessTree(pid: number): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
    });
  }

  private parseHttpRequests(output: string, packageName = ''): NetworkRequest[] {
    const packets = this.parseTcpdumpPackets(output);
    const requestMessages: ParsedHttpRequestMessage[] = [];
    const responseMessages: ParsedHttpResponseMessage[] = [];

    for (const packet of packets) {
      const requestMessage = this.parseHttpRequestMessage(packet);
      if (requestMessage) {
        requestMessages.push(requestMessage);
        continue;
      }

      const responseMessage = this.parseHttpResponseMessage(packet);
      if (responseMessage) {
        responseMessages.push(responseMessage);
      }
    }

    const matchedResponseIndexes = new Set<number>();
    return requestMessages.map((requestMessage, index) => {
      const matchedResponse = this.matchHttpResponse(requestMessage, responseMessages, matchedResponseIndexes);
      const host = requestMessage.headers.Host || requestMessage.headers.host || '';
      const requestPath = requestMessage.path;
      const normalizedPath = requestPath.startsWith('/') ? requestPath : `/${requestPath}`;
      const url = host ? `http://${host}${normalizedPath}` : requestPath;

      return {
        id: `network-${Date.now()}-${index}`,
        timestamp: requestMessage.timestamp || new Date(),
        packageName,
        method: requestMessage.method,
        url,
        path: requestPath,
        host: host || undefined,
        statusCode: matchedResponse?.statusCode || 0,
        statusText: matchedResponse?.statusText || undefined,
        requestBody: requestMessage.body,
        responseBody: matchedResponse?.body,
        headers: requestMessage.headers,
        responseHeaders: matchedResponse?.headers,
        rawRequest: requestMessage.raw,
        rawResponse: matchedResponse?.raw,
        duration: this.calculateHttpDurationMs(requestMessage.timestamp, matchedResponse?.timestamp),
      };
    });
  }

  private parseTcpdumpPackets(output: string): HttpPacketBlock[] {
    const lines = output.replace(/\r\n/g, '\n').split('\n');
    const packets: HttpPacketBlock[] = [];
    const packetHeaderPattern = /^((?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2}\.\d+)\s+/;

    let currentTimestamp: Date | null = null;
    let currentPayloadLines: string[] = [];

    const pushCurrentPacket = () => {
      if (currentPayloadLines.length === 0) {
        return;
      }

      const payload = currentPayloadLines.join('\n').trim();
      if (!payload) {
        currentPayloadLines = [];
        return;
      }

      packets.push({
        timestamp: currentTimestamp,
        payload,
      });
      currentPayloadLines = [];
    };

    for (const rawLine of lines) {
      const packetHeaderMatch = rawLine.match(packetHeaderPattern);
      if (packetHeaderMatch) {
        pushCurrentPacket();
        currentTimestamp = this.parseTcpdumpTimestamp(packetHeaderMatch[1]);
        continue;
      }

      if (!rawLine.trim()) {
        if (currentPayloadLines.length > 0) {
          currentPayloadLines.push('');
        }
        continue;
      }

      if (currentTimestamp) {
        currentPayloadLines.push(rawLine);
      }
    }

    pushCurrentPacket();
    return packets;
  }

  private parseTcpdumpTimestamp(value: string): Date | null {
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      return null;
    }

    if (/^\d{4}-\d{2}-\d{2} /.test(normalizedValue)) {
      const [datePart, timePart] = normalizedValue.split(' ');
      const [year, month, day] = datePart.split('-').map(Number);
      return this.createTimestampDate(year, month, day, timePart);
    }

    const now = new Date();
    return this.createTimestampDate(now.getFullYear(), now.getMonth() + 1, now.getDate(), normalizedValue);
  }

  private createTimestampDate(year: number, month: number, day: number, timePart: string): Date | null {
    const match = timePart.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{1,6})$/);
    if (!match) {
      return null;
    }

    const [, hours, minutes, seconds, fraction] = match;
    const milliseconds = Number.parseInt(fraction.padEnd(6, '0').slice(0, 3), 10);
    return new Date(year, month - 1, day, Number(hours), Number(minutes), Number(seconds), milliseconds);
  }

  private parseHttpRequestMessage(packet: HttpPacketBlock): ParsedHttpRequestMessage | null {
    const message = this.parseHttpMessage(packet, /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s+(HTTP\/1\.[01])$/m);
    if (!message?.match) {
      return null;
    }

    return {
      timestamp: packet.timestamp,
      startLine: message.startLine,
      headers: message.headers,
      body: message.body,
      raw: message.raw,
      method: message.match[1],
      path: message.match[2],
      httpVersion: message.match[3],
    };
  }

  private parseHttpResponseMessage(packet: HttpPacketBlock): ParsedHttpResponseMessage | null {
    const message = this.parseHttpMessage(packet, /^(HTTP\/1\.[01])\s+(\d{3})(?:\s+(.+))?$/m);
    if (!message?.match) {
      return null;
    }

    return {
      timestamp: packet.timestamp,
      startLine: message.startLine,
      headers: message.headers,
      body: message.body,
      raw: message.raw,
      httpVersion: message.match[1],
      statusCode: Number.parseInt(message.match[2], 10) || 0,
      statusText: message.match[3]?.trim() || '',
    };
  }

  private parseHttpMessage(packet: HttpPacketBlock, startLinePattern: RegExp): (ParsedHttpMessage & { match: RegExpMatchArray }) | null {
    const payload = packet.payload;
    const match = payload.match(startLinePattern);
    if (!match || typeof match.index !== 'number') {
      return null;
    }

    const rawMessage = payload.slice(match.index).trim();
    const [headerSection, ...bodySections] = rawMessage.split(/\n\n/);
    const headerLines = headerSection.split('\n').map((line) => line.trimRight());
    if (headerLines.length === 0) {
      return null;
    }

    const startLine = headerLines[0].trim();
    const headers: Record<string, string> = {};
    for (const headerLine of headerLines.slice(1)) {
      const separatorIndex = headerLine.indexOf(':');
      if (separatorIndex <= 0) {
        continue;
      }
      const key = headerLine.slice(0, separatorIndex).trim();
      const value = headerLine.slice(separatorIndex + 1).trim();
      if (!key) continue;
      headers[key] = value;
    }

    const body = bodySections.join('\n\n').trim();
    return {
      timestamp: packet.timestamp,
      startLine,
      headers,
      body: body || undefined,
      raw: rawMessage,
      match,
    };
  }

  private matchHttpResponse(
    request: ParsedHttpRequestMessage,
    responses: ParsedHttpResponseMessage[],
    matchedResponseIndexes: Set<number>
  ): ParsedHttpResponseMessage | undefined {
    const requestHost = request.headers.Host || request.headers.host || '';
    for (let index = 0; index < responses.length; index++) {
      if (matchedResponseIndexes.has(index)) {
        continue;
      }

      const response = responses[index];
      if (request.timestamp && response.timestamp && response.timestamp.getTime() < request.timestamp.getTime()) {
        continue;
      }

      const responseHost = response.headers.Host || response.headers.host || '';
      if (requestHost && responseHost && requestHost !== responseHost) {
        continue;
      }

      matchedResponseIndexes.add(index);
      return response;
    }

    return undefined;
  }

  private calculateHttpDurationMs(requestTimestamp: Date | null, responseTimestamp?: Date | null): number {
    if (!requestTimestamp || !responseTimestamp) {
      return 0;
    }

    const duration = responseTimestamp.getTime() - requestTimestamp.getTime();
    return duration > 0 ? duration : 0;
  }

  onDeviceConnected(callback: (device: DeviceInfo) => void): void {
    this.on('deviceConnected', callback);
  }

  onDeviceDisconnected(callback: (deviceId: string) => void): void {
    this.on('deviceDisconnected', callback);
  }

  onDeviceListChanged(callback: (devices: DeviceInfo[]) => void): void {
    this.on('deviceListChanged', callback);
  }

  onAdbStatusChanged(callback: (status: AdbStatus) => void): void {
    this.on('adbStatusChanged', callback);
  }

  private emitDeviceConnected(device: DeviceInfo): void {
    this.emit('deviceConnected', device);
  }

  private emitDeviceDisconnected(deviceId: string): void {
    this.emit('deviceDisconnected', deviceId);
  }

  private emitDeviceListChanged(devices: DeviceInfo[]): void {
    this.emit('deviceListChanged', devices);
  }

  private emitAdbStatusChanged(status: AdbStatus): void {
    this.emit('adbStatusChanged', status);
  }

  private async execAdb(args: string[], options?: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
    const adbBinary = await this.resolveAdbBinary();
    try {
      const result = await execFileAsync(adbBinary.path, args, options);
      if (!this.adbStatus.available) {
        void this.getAdbStatus(true);
      }
      return {
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      };
    } catch (error) {
      const adbError = classifyAdbError(error, args);
      if (adbError.code === 'ADB_NOT_FOUND') {
        this.adbBinary = null;
        this.updateAdbStatus({
          available: false,
          version: null,
          path: null,
          source: undefined,
          message: adbError.message,
          checkedAt: Date.now(),
          code: adbError.code,
          hint: adbError.hint,
        });
      }
      throw adbError;
    }
  }

  private async execAdbBuffer(args: string[], options?: ExecFileOptions): Promise<{ stdout: Buffer; stderr: Buffer }> {
    const adbBinary = await this.resolveAdbBinary();
    try {
      const result = await new Promise<{ stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
        execFile(
          adbBinary.path,
          args,
          { ...options, encoding: 'buffer' } as ExecFileOptions,
          (error, stdout, stderr) => {
            if (error) {
              reject(error);
              return;
            }

            resolve({
              stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as string),
              stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr as string),
            });
          }
        );
      });

      if (!this.adbStatus.available) {
        void this.getAdbStatus(true);
      }

      return result;
    } catch (error) {
      const adbError = classifyAdbError(error, args);
      if (adbError.code === 'ADB_NOT_FOUND') {
        this.adbBinary = null;
        this.updateAdbStatus({
          available: false,
          version: null,
          path: null,
          source: undefined,
          message: adbError.message,
          checkedAt: Date.now(),
          code: adbError.code,
          hint: adbError.hint,
        });
      }
      throw adbError;
    }
  }

  private async execAdbWithExitCode(
    args: string[],
    options?: ExecFileOptions
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const adbBinary = await this.resolveAdbBinary();
    return await new Promise((resolve, reject) => {
      execFile(adbBinary.path, args, options, (error, stdout, stderr) => {
        const stdoutText = Buffer.isBuffer(stdout) ? stdout.toString() : String(stdout ?? '');
        const stderrText = Buffer.isBuffer(stderr) ? stderr.toString() : String(stderr ?? '');

        if (!error) {
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode: 0 });
          return;
        }

        const exitCode = typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
          ? Number((error as NodeJS.ErrnoException & { code?: unknown }).code)
          : undefined;

        if (exitCode !== undefined) {
          resolve({ stdout: stdoutText, stderr: stderrText, exitCode });
          return;
        }

        const adbError = classifyAdbError(error, args);
        if (adbError.code === 'ADB_NOT_FOUND') {
          this.adbBinary = null;
          this.updateAdbStatus({
            available: false,
            version: null,
            path: null,
            source: undefined,
            message: adbError.message,
            checkedAt: Date.now(),
            code: adbError.code,
            hint: adbError.hint,
          });
        }
        reject(adbError);
      });
    });
  }

  private async killAdbServer(): Promise<void> {
    const adbBinary = this.adbBinary ?? await this.resolveAdbBinary().catch(() => null);
    if (!adbBinary) {
      return;
    }

    try {
      await execFileAsync(adbBinary.path, ['kill-server'], { timeout: 3000 });
      logger.log(`ADBManager: adb server stopped for ${adbBinary.source} adb`);
    } catch (error) {
      logger.warn('ADBManager: failed to stop adb server:', error);
    }
  }

  private shouldRetryInstallWithoutStreaming(result: { stdout: string; stderr: string; exitCode: number }): boolean {
    if (result.exitCode === 0) {
      return false;
    }

    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return (
      output.includes('streamed install') ||
      output.includes('streaming') ||
      output.includes('broken pipe') ||
      output.includes('connection reset') ||
      output.includes('unexpected eof') ||
      output.includes('protocol fault')
    );
  }

  private isExpectedRebootDisconnect(result: { stdout: string; stderr: string; exitCode: number }): boolean {
    if (result.exitCode === 0) {
      return true;
    }

    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    return (
      output.includes('device not found') ||
      output.includes('no devices/emulators found') ||
      output.includes('closed') ||
      output.includes('connection reset') ||
      output.includes('connection aborted') ||
      output.includes('connection timed out') ||
      output.includes('transport') ||
      output.includes('offline')
    );
  }

  private createRebootError(result: { stdout: string; stderr: string; exitCode: number }): AdbCommandError {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    return new AdbCommandError({
      code: 'ADB_COMMAND_FAILED',
      message: '设备重启命令发送失败。',
      hint: '请确认设备仍在线、调试授权有效，并且当前账号有权限执行 adb reboot。',
      details: output || `adb reboot exited with code ${result.exitCode}.`,
    });
  }

  private wrapOperationError(prefix: string, error: unknown): Error {
    if (error instanceof AdbCommandError) {
      return error;
    }
    return new Error(`${prefix}: ${(error as Error).message}`);
  }

  private async resolveSystemAdbBinaryPath(): Promise<string | null> {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(locator, ['adb'], { timeout: 2000 });
    return stdout
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || null;
  }

  private async resolveAdbBinary(forceRefresh = false): Promise<ResolvedAdbBinary> {
    if (!forceRefresh && this.adbBinary) {
      return this.adbBinary;
    }

    const bundledPath = resolveBundledAdbBinaryPath();
    if (bundledPath) {
      this.adbBinary = {
        path: bundledPath,
        source: 'bundled',
      };
      return this.adbBinary;
    }

    const systemPath = await this.resolveSystemAdbBinaryPath();
    if (systemPath) {
      this.adbBinary = {
        path: systemPath,
        source: 'system',
      };
      return this.adbBinary;
    }

    throw classifyAdbError(
      new Error(`ENOENT: adb not found. Bundled candidates: ${this.describeBundledAdbCandidates()}`),
      []
    );
  }

  private describeBundledAdbCandidates(): string {
    return getBundledAdbCandidates()
      .map((candidate) => path.normalize(candidate))
      .join(', ');
  }

  private updateAdbStatus(nextStatus: AdbStatus): void {
    const previousStatus = this.adbStatus;
    this.adbStatus = nextStatus;

    if (
      previousStatus.available !== nextStatus.available ||
      previousStatus.version !== nextStatus.version ||
      previousStatus.path !== nextStatus.path ||
      previousStatus.source !== nextStatus.source ||
      previousStatus.message !== nextStatus.message ||
      previousStatus.code !== nextStatus.code ||
      previousStatus.hint !== nextStatus.hint
    ) {
      this.emitAdbStatusChanged(nextStatus);
    }
  }

  private createDeviceSnapshot(device: DeviceInfo): string {
    return JSON.stringify([
      device.id,
      device.status,
      device.connectionType,
      device.name,
      device.model,
      device.manufacturer,
      device.androidVersion,
      device.apiLevel,
      device.batteryLevel,
    ]);
  }

  private isLikelyPicoDevice(deviceId: string): boolean {
    const device = this.deviceInfoCache.get(deviceId);
    if (!device) {
      return false;
    }

    const fingerprint = [device.manufacturer, device.model, device.name, device.id]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return fingerprint.includes('pico');
  }

  private async pollDeviceChanges(): Promise<void> {
    if (this.isDeviceMonitorPolling) {
      return;
    }

    this.isDeviceMonitorPolling = true;
    try {
      await this.getAdbStatus(true);
      const deviceSummaries = await this.getDeviceSummaries();
      const nextSnapshot = new Map(deviceSummaries.map((device) => [device.id, this.createDeviceSummarySnapshot(device)]));
      const hasChanged =
        nextSnapshot.size !== this.lastDeviceSnapshot.size ||
        Array.from(nextSnapshot.entries()).some(([deviceId, snapshot]) => this.lastDeviceSnapshot.get(deviceId) !== snapshot);

      if (hasChanged) {
        const previousIds = new Set(this.lastDeviceSnapshot.keys());
        const nextIds = new Set(nextSnapshot.keys());
        const devices = await this.getDevices();
        const devicesById = new Map(devices.map((device) => [device.id, device]));

        for (const summary of deviceSummaries) {
          if (!previousIds.has(summary.id)) {
            const device = devicesById.get(summary.id);
            if (!device) {
              continue;
            }
            this.emitDeviceConnected(device);
          }
        }

        for (const deviceId of previousIds) {
          if (!nextIds.has(deviceId)) {
            this.emitDeviceDisconnected(deviceId);
          }
        }

        this.lastDeviceSnapshot = nextSnapshot;
        this.emitDeviceListChanged(devices);
      } else {
        const connectedWifiDevices = Array.from(this.deviceInfoCache.values())
          .filter((device) => device.connectionType === 'wifi' && device.status === 'connected');

        if (connectedWifiDevices.length > 0) {
          const refreshedWifiDevices = await Promise.all(
            connectedWifiDevices.map(async (device) => {
              const withBattery = await this.refreshBatteryLevelForDevice(device);
              return this.refreshWifiLatencyForDevice(withBattery);
            })
          );
          let hasDeviceHealthChanged = false;
          for (const device of refreshedWifiDevices) {
            const previousDevice = this.deviceInfoCache.get(device.id);
            if (
              previousDevice?.batteryLevel !== device.batteryLevel ||
              previousDevice?.latencyMs !== device.latencyMs ||
              previousDevice?.latencyStatus !== device.latencyStatus
            ) {
              hasDeviceHealthChanged = true;
            }
            this.deviceInfoCache.set(device.id, device);
          }

          if (hasDeviceHealthChanged) {
            this.emitDeviceListChanged(Array.from(this.deviceInfoCache.values()));
          }
        }
      }
    } catch (error) {
      logger.warn('ADBManager: device monitor poll failed:', error);
      if (this.lastDeviceSnapshot.size > 0 && error instanceof AdbCommandError && error.code === 'ADB_NOT_FOUND') {
        for (const deviceId of this.lastDeviceSnapshot.keys()) {
          this.emitDeviceDisconnected(deviceId);
        }
        this.lastDeviceSnapshot.clear();
        this.deviceInfoCache.clear();
        this.emitDeviceListChanged([]);
      }
    } finally {
      this.isDeviceMonitorPolling = false;
    }
  }

  async cleanup(): Promise<void> {
    logger.log('ADBManager: cleanup called, stopping all processes...');

    this.stopDeviceMonitoring();

    for (const [deviceId, stopEntry] of this.logcatProcesses.entries()) {
      try {
        logger.log(`ADBManager: stopping logcat for device: ${deviceId}`);
        await stopEntry.stop();
      } catch (error) {
        logger.error('ADBManager: failed to stop logcat for device:', deviceId, error);
      }
    }
    this.logcatProcesses.clear();
    this.logcatBuffer.clear();
    this.deviceInfoCache.clear();
    this.batteryLevelCache.clear();
    this.lastDeviceSnapshot.clear();
    await this.killAdbServer();
    
    logger.log('ADBManager: cleanup completed');
  }
}
