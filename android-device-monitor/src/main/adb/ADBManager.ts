import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { EventEmitter } from 'events';
import * as path from 'path';
import { statSync as nodeFsStatSync, mkdtempSync as nodeFsMkdtempSync, renameSync as nodeFsRenameSync, copyFileSync as nodeFsCopyFileSync, rmSync as nodeFsRmSync } from 'fs';
import { tmpdir as nodeOsTmpdir } from 'os';
import type { ExecFileOptions, ChildProcess } from 'child_process';
import { ActivityStackEntry, AdbStatus, DeviceFileEntry, DeviceFileList, DeviceInfo, LogEntry, NetworkRequest, PairResult, PerformanceMetrics, ProcessInfo } from '../../shared/types';
import { logger } from '../logger';
import { AdbCommandError, classifyAdbError } from './adbError';
import { ResolvedAdbBinary, getBundledAdbCandidates, resolveBundledAdbBinaryPath } from './adbBinary';
import { AdbRuntimeInspector } from './runtimeInspector';
import { PerformanceCaptureRecorder, type CaptureSegmentMeta } from './captureRecorder';
import type { PerformanceCaptureProvider } from '../../shared/types';

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
    (args, options) => this.execAdb(args, options)
  );
  // Phase 14 持续分段录制引擎（采集会话用）。
  private readonly captureRecorder = new PerformanceCaptureRecorder(
    (args, options) => this.execAdb(args, options),
    async () => (await this.resolveAdbBinary()).path
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
  private screenStateCache = new Map<string, { checkedAt: number; screenState: 'on' | 'off' | 'unknown' }>();
  private batteryLevelCache = new Map<string, { checkedAt: number; batteryLevel?: number }>();
  private deviceMonitorTimer: NodeJS.Timeout | null = null;
  private isDeviceMonitorPolling = false;
  // 正在进行的传输子进程（push/pull），退出前用于 SIGTERM 终止；进程自然结束时自行移除。
  private activeTransferChildren = new Set<ChildProcess>();
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
  private readonly screenStateCacheMs = 3000; // 屏幕状态变化快，缓存短一些；息屏/唤醒动作还会主动清缓存即时刷新

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
          serialNo: 'Unknown',
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
          // WiFi 设备的 id 是 IP:port，真实 SN 需从 ro.serialno 取；取不到时回退到 id
          device.serialNo = props['ro.serialno'] || props['ro.boot.serialno'] || summary.id;
          device.model = props['ro.product.model'] || device.model;
          device.manufacturer = props['ro.product.manufacturer'] || device.manufacturer;
          device.androidVersion = props['ro.build.version.release'] || device.androidVersion;
          device.apiLevel = parseInt(props['ro.build.version.sdk'] || '0');
        } catch (e) {
          logger.warn('Failed to get props for', summary.id, e);
        }

        device = await this.refreshBatteryLevelForDevice(device);
        device = await this.refreshWifiLatencyForDevice(device);
        device = await this.refreshScreenStateForDevice(device);
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

      // 过滤 adb 列出的 mDNS 服务条目（如 adb-xxxx._adb-tls-connect._tcp）。
      // 无线调试自动连接后，adb devices 会同时列出真实连接（IP:端口）和这个服务名，
      // 服务名不是真实设备，否则会在设备列表里多出一张重复卡片。
      if (id.includes('._tcp') || id.includes('_adb-tls-') || id.includes('_adb._')) {
        logger.log('ADBManager: skipping mdns service entry:', id);
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

  // 屏幕电源状态（息屏/唤醒），带短缓存。复用 runtimeInspector 已有的多版本 dumpsys power 解析。
  private async getScreenState(deviceId: string): Promise<'on' | 'off' | 'unknown'> {
    const cached = this.screenStateCache.get(deviceId);
    if (cached && Date.now() - cached.checkedAt < this.screenStateCacheMs) {
      return cached.screenState;
    }
    const screenState = await this.runtimeInspector.getScreenState(deviceId);
    this.screenStateCache.set(deviceId, { checkedAt: Date.now(), screenState });
    return screenState;
  }

  private async refreshScreenStateForDevice(device: DeviceInfo): Promise<DeviceInfo> {
    if (device.status !== 'connected') {
      return device;
    }
    try {
      const screenState = await this.getScreenState(device.id);
      return { ...device, screenState };
    } catch (error) {
      logger.warn('Failed to get screen state for', device.id, error);
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

  async pairDevice(target: string, pairingCode: string): Promise<PairResult> {
    try {
      logger.log('ADBManager: pairDevice called with:', target);

      const trimmedTarget = target.trim();
      const trimmedCode = pairingCode.trim();

      if (!trimmedTarget.includes(':')) {
        throw new Error('请填写配对地址 IP:端口（无线调试「使用配对码配对设备」里显示的地址和端口）');
      }

      // 先检查是否已配对过：adb 无法直接查询"配对记录"，但配对成功后设备会自动连接并留在设备列表里。
      // 因此设备列表中已存在该 IP 的已连接设备，即视为已配对过，直接返回避免重复配对。
      const ip = trimmedTarget.split(':')[0];
      const alreadyConnected = (await this.getDevices()).find(
        (d) => d.id.startsWith(`${ip}:`) && d.status === 'connected'
      );
      if (alreadyConnected) {
        alreadyConnected.connectionType = 'wifi';
        return { message: '该设备已配对并连接', device: alreadyConnected, alreadyPaired: true };
      }

      if (!/^\d{6}$/.test(trimmedCode)) {
        throw new Error('配对码应为 6 位数字（无线调试弹窗里显示的配对码）');
      }

      // adb pair 是交互式命令：正常会提示输入配对码，这里通过参数直接传入
      const { stdout, stderr } = await this.execAdb(['pair', trimmedTarget, trimmedCode], {
        timeout: 20000,
      });
      logger.log('ADBManager: pair result:', stdout, stderr);

      const output = `${stdout}\n${stderr}`;
      if (!output.includes('Successfully paired')) {
        // 失败时把 adb 的原始提示带出去，便于排查（配对码错误 / 端口不对 / 配对窗口已关闭）
        throw new Error(stdout.trim() || stderr.trim() || '配对失败，请确认配对地址、端口和配对码是否正确');
      }

      // 配对成功后，现代 adb 会通过 mDNS/TLS 自动把设备连上，并以 IP:连接端口 出现在设备列表里。
      // 这里轮询设备列表，按配对地址的 IP 找到那台自动连上的设备，省去用户再手填连接端口。
      const device = await this.discoverPairedConnection(ip);
      if (device) {
        return { message: '配对并连接成功', device };
      }
      return {
        message: '配对成功，但未能自动连接。请用上方「连接」填写无线调试主界面显示的 IP:连接端口',
        device: null,
      };
    } catch (error) {
      logger.error('ADBManager: pairDevice failed:', error);
      throw this.wrapOperationError('WiFi pairing failed', error);
    }
  }

  // 配对成功后发现并返回已自动连接的设备：优先轮询设备列表按 IP 匹配，
  // 兜底用 adb mdns services 找到连接端口后主动 connect（部分 Windows 环境 mDNS 不稳定，仅作兜底）。
  private async discoverPairedConnection(ip: string): Promise<DeviceInfo | null> {
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const devices = await this.getDevices();
      const found = devices.find((d) => d.id.startsWith(`${ip}:`) && d.status === 'connected');
      if (found) {
        found.connectionType = 'wifi';
        return found;
      }

      const discovered = await this.discoverConnectAddress(ip);
      if (discovered) {
        try {
          return await this.connectWiFi(discovered);
        } catch (error) {
          logger.warn('ADBManager: auto-connect after pair failed:', discovered, error);
        }
      }
    }
    return null;
  }

  private async discoverConnectAddress(ip: string): Promise<string | null> {
    try {
      const { stdout } = await this.execAdb(['mdns', 'services'], { timeout: 5000 });
      const escapedIp = ip.replace(/\./g, '\\.');
      const matcher = new RegExp(`(${escapedIp}:\\d+)`);
      for (const line of stdout.split('\n')) {
        if (line.includes('_adb-tls-connect._tcp')) {
          const match = line.match(matcher);
          if (match) {
            return match[1];
          }
        }
      }
    } catch (error) {
      logger.warn('ADBManager: mdns services discovery failed:', error);
    }
    return null;
  }

  // 列出设备上指定目录的内容（默认从 /sdcard 起步）。基于 toybox `ls -lA` 解析，
  // 兼容主流 Android ROM。访问受限目录（如 /data/data）时 adb 会返回 Permission denied，
  // 这里转成友好的中文错误抛出，让前端如实提示而不是假装能进。
  async listDeviceFiles(deviceId: string, dirPath: string): Promise<DeviceFileList> {
    const normalizedDir = this.normalizeRemoteDir(dirPath);
    // 末尾补斜杠：/sdcard 本身是指向 /storage/self/primary 的符号链接，
    // 不带斜杠时 ls -lA 只会返回链接自身一行；带斜杠才会跟随进目录列出内容。
    const lsTarget = normalizedDir === '/' ? '/' : `${normalizedDir}/`;
    try {
      const { stdout, stderr } = await this.execAdbWithExitCode(
        ['-s', deviceId, 'shell', 'ls', '-lA', this.quoteRemotePath(lsTarget)],
        { timeout: 15000, maxBuffer: 1024 * 1024 * 16 }
      ).then((r) => ({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }));

      const lowerErr = (stderr || '').toLowerCase();
      if (lowerErr.includes('permission denied')) {
        throw new Error('该目录需要更高权限（可能需要 root），无法访问');
      }
      if (lowerErr.includes('no such file') || lowerErr.includes('not a directory')) {
        throw new Error('目录不存在或不是文件夹');
      }

      const entries = this.parseLsOutput(stdout, normalizedDir);
      return { path: normalizedDir, entries };
    } catch (error) {
      if (error instanceof Error && (error.message.includes('权限') || error.message.includes('目录'))) {
        throw error;
      }
      logger.error('ADBManager: listDeviceFiles failed:', error);
      throw this.wrapOperationError('列出设备文件失败', error);
    }
  }

  // 把电脑本地文件上传到设备目录（adb push）。adb push 在 pipe 模式下不输出中间进度，
  // 因此用 spawn 启动 push 的同时，定时轮询设备端目标文件已写入大小，按本地总大小算真实百分比。
  // onProgress 回调把 0-100 的百分比上报给上层（再经 IPC 推给渲染层进度条）。
  async pushDeviceFile(
    deviceId: string,
    localPath: string,
    remoteDir: string,
    fileName: string,
    onProgress?: (percent: number) => void
  ): Promise<void> {
    const adbBinary = await this.resolveAdbBinary();
    const normalizedDir = this.normalizeRemoteDir(remoteDir);
    const remotePath = normalizedDir === '/' ? `/${fileName}` : `${normalizedDir}/${fileName}`;
    // 先传到隐藏临时名，传完再 mv 成最终名：保证设备端最终文件名要么不存在、要么完整。
    // 进程被打断只会留下可识别的 .part，不产生「看着成功实则损坏」的脏文件。
    const tempName = `.${fileName}.part`;
    const tempRemotePath = normalizedDir === '/' ? `/${tempName}` : `${normalizedDir}/${tempName}`;

    let totalBytes = 0;
    try {
      totalBytes = nodeFsStatSync(localPath).size;
    } catch {
      totalBytes = 0;
    }

    // push 前清理可能残留的旧临时文件，支持中断后重传（清理失败不阻断）。
    try {
      await this.execAdb(
        ['-s', deviceId, 'shell', 'rm', '-f', this.quoteRemotePath(tempRemotePath)],
        { timeout: 5000, maxBuffer: 1024 * 64 }
      );
    } catch {
      /* 残留清理失败忽略 */
    }

    return new Promise<void>((resolve, reject) => {
      const child = spawn(adbBinary.path, ['-s', deviceId, 'push', localPath, tempRemotePath], {
        windowsHide: true,
      });
      // 登记到活动传输集合，退出前可统一 SIGTERM；进程结束时移除。
      this.activeTransferChildren.add(child);
      child.once('close', () => this.activeTransferChildren.delete(child));

      let stderrText = '';
      let stdoutText = '';
      let settled = false;
      let pushDone = false; // push 进程已成功结束、进入 mv 阶段，不再轮询

      // 轮询设备端临时文件已写入大小，换算百分比；本地很快就传完时这条最多触发一两次
      let pollTimer: NodeJS.Timeout | null = null;
      if (totalBytes > 0 && onProgress) {
        const poll = async () => {
          try {
            const { stdout } = await this.execAdb(
              ['-s', deviceId, 'shell', 'stat', '-c', '%s', this.quoteRemotePath(tempRemotePath)],
              { timeout: 5000, maxBuffer: 1024 * 64 }
            );
            const written = parseInt(stdout.trim(), 10);
            if (Number.isFinite(written) && written > 0) {
              const percent = Math.min(99, Math.round((written / totalBytes) * 100));
              onProgress(percent);
            }
          } catch {
            // 文件还没创建或 stat 失败，忽略本次轮询
          }
          if (!settled && !pushDone) {
            pollTimer = setTimeout(poll, 500);
          }
        };
        pollTimer = setTimeout(poll, 500);
      }

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (pollTimer) clearTimeout(pollTimer);
        if (err) {
          reject(this.wrapOperationError('上传文件失败', err));
        } else {
          onProgress?.(100);
          resolve();
        }
      };

      // push 成功后把临时名原子改成最终名（同一文件系统内 mv 为原子操作，会覆盖同名旧文件）。
      const commitUpload = () => {
        pushDone = true;
        if (pollTimer) clearTimeout(pollTimer);
        this.execAdb(
          [
            '-s', deviceId, 'shell', 'mv', '-f',
            this.quoteRemotePath(tempRemotePath), this.quoteRemotePath(remotePath),
          ],
          { timeout: 15000, maxBuffer: 1024 * 64 }
        )
          .then(() => settle())
          .catch((mvErr) => settle(new Error(`上传完成但落地重命名失败：${(mvErr as Error).message}`)));
      };

      child.stdout.on('data', (d) => { stdoutText += d.toString(); });
      child.stderr.on('data', (d) => { stderrText += d.toString(); });
      child.on('error', (err) => settle(err));
      child.on('close', (code) => {
        const combined = `${stdoutText}\n${stderrText}`.toLowerCase();
        if (code === 0 && combined.includes('file pushed') && !combined.includes('error:')) {
          commitUpload();
        } else if (combined.includes('permission denied') || combined.includes('read-only')) {
          settle(new Error('目标目录没有写入权限'));
        } else if (code === 0 && !combined.includes('error:')) {
          // 某些 adb 版本成功也可能不打 "file pushed"，按退出码兜底
          commitUpload();
        } else {
          settle(new Error(stderrText.trim() || stdoutText.trim() || '上传失败'));
        }
      });
    });
  }

  // 把设备上的文件/目录拉取到电脑本地路径（adb pull）。localPath 由主进程的保存对话框确定。
  async pullDeviceFile(deviceId: string, remotePath: string, localPath: string): Promise<void> {
    // adb 已知缺陷：pull 无法把文件直接写到盘符根目录（如 F:\file.mp4），但写到任意子目录正常。
    // 当目标在盘根时，先 pull 到系统临时目录，再移动到用户选定位置，规避该缺陷。
    const parsed = path.parse(localPath);
    const isDriveRoot = parsed.dir === parsed.root && parsed.root !== '';

    try {
      if (isDriveRoot) {
        // 盘根：adb 无法把文件直接写到盘符根目录（如 F:\file.mp4），先 pull 到系统临时目录再移动。
        const tempDir = nodeFsMkdtempSync(path.join(nodeOsTmpdir(), 'adm-pull-'));
        const tempPath = path.join(tempDir, parsed.base);
        try {
          await this.runAdbPull(deviceId, remotePath, tempPath);
          this.commitPulledFile(tempPath, localPath);
        } finally {
          nodeFsRmSync(tempDir, { recursive: true, force: true });
        }
      } else {
        // 非盘根：先拉到目标同目录的隐藏 .part，完成后再 rename 成最终名，
        // 保证本地最终文件名要么不存在、要么完整；被打断只留下可识别的 .part。
        const tempPath = path.join(parsed.dir, `.${parsed.base}.part`);
        // 清理可能残留的旧临时文件，支持中断后重传（不存在则忽略）。
        try { nodeFsRmSync(tempPath, { recursive: true, force: true }); } catch { /* 忽略 */ }
        try {
          await this.runAdbPull(deviceId, remotePath, tempPath);
          this.commitPulledFile(tempPath, localPath);
        } catch (err) {
          try { nodeFsRmSync(tempPath, { recursive: true, force: true }); } catch { /* 忽略 */ }
          throw err;
        }
      }
    } catch (error) {
      logger.error('ADBManager: pullDeviceFile failed:', error);
      throw this.wrapOperationError('下载设备文件失败', error);
    }
  }

  // 把拉取到临时位置的文件原子落地到最终路径：先清理目标同名残留，再尝试 rename（同卷原子），
  // 跨卷 rename 失败时用复制+删除兜底（仅文件，盘根下载场景适用）。
  private commitPulledFile(tempPath: string, localPath: string): void {
    try { nodeFsRmSync(localPath, { recursive: true, force: true }); } catch { /* 目标不存在则忽略 */ }
    try {
      nodeFsRenameSync(tempPath, localPath);
    } catch {
      nodeFsCopyFileSync(tempPath, localPath);
      nodeFsRmSync(tempPath, { force: true });
    }
  }

  private async runAdbPull(deviceId: string, remotePath: string, localPath: string): Promise<void> {
    const result = await this.execAdbWithExitCode(
      ['-s', deviceId, 'pull', remotePath, localPath],
      { timeout: 300000, maxBuffer: 1024 * 1024 * 16 },
      (child) => {
        // 登记 pull 子进程，退出前可统一 SIGTERM；结束时移除。
        this.activeTransferChildren.add(child);
        child.once('close', () => this.activeTransferChildren.delete(child));
      }
    );
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (result.exitCode !== 0 || output.includes('permission denied') || output.includes('error:')) {
      throw new Error(result.stderr.trim() || result.stdout.trim() || '拉取文件失败');
    }
  }

  // 终止当前正在进行的所有传输子进程（push/pull 主进程）。退出前调用，给 adb 子进程发 SIGTERM。
  // 仅登记 push/pull 主进程；push 落地的 mv、stat 轮询、rm 等毫秒级短命令不在集合内、不被回收。
  // 仅能拦截优雅退出；进程被 SIGKILL 强杀 / 崩溃时拦不住，最终兜底是 journal 恢复。
  cancelActiveTransfers(): void {
    for (const child of this.activeTransferChildren) {
      try {
        child.kill('SIGTERM');
      } catch {
        /* 子进程可能已退出，忽略 */
      }
    }
    this.activeTransferChildren.clear();
  }

  // 删除上传残留的临时文件（设备端 .part），用于「丢弃恢复」时清理设备端，失败忽略。
  async removeRemotePartial(deviceId: string, remoteDir: string, fileName: string): Promise<void> {
    const normalizedDir = this.normalizeRemoteDir(remoteDir);
    const tempName = `.${fileName}.part`;
    const tempPath = normalizedDir === '/' ? `/${tempName}` : `${normalizedDir}/${tempName}`;
    try {
      await this.execAdb(
        ['-s', deviceId, 'shell', 'rm', '-f', this.quoteRemotePath(tempPath)],
        { timeout: 5000, maxBuffer: 1024 * 64 }
      );
    } catch {
      /* 残留清理失败忽略 */
    }
  }

  // 删除设备上的文件或目录（adb shell rm）。目录用 -rf 递归删除，文件用 -f。
  // 删除不可逆，二次确认由渲染层负责；这里只做实际删除并把权限/失败提示带回。
  async deleteDeviceFile(deviceId: string, remotePath: string, isDir: boolean): Promise<void> {
    try {
      const rmArgs = isDir ? ['rm', '-rf'] : ['rm', '-f'];
      const result = await this.execAdbWithExitCode(
        ['-s', deviceId, 'shell', ...rmArgs, this.quoteRemotePath(remotePath)],
        { timeout: 15000, maxBuffer: 1024 * 64 }
      );
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (output.includes('permission denied') || output.includes('read-only')) {
        throw new Error('没有删除权限（可能需要 root）');
      }
      if (result.exitCode !== 0 || output.includes('no such file')) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || '删除失败');
      }
    } catch (error) {
      logger.error('ADBManager: deleteDeviceFile failed:', error);
      throw this.wrapOperationError('删除设备文件失败', error);
    }
  }

  // 在指定目录下新建文件夹。name 不允许包含路径分隔符或越级（. / ..），避免越权写到别处。
  async createDeviceFolder(deviceId: string, dirPath: string, name: string): Promise<string> {
    const trimmedName = (name || '').trim();
    if (!trimmedName || trimmedName === '.' || trimmedName === '..' || /[\/\\]/.test(trimmedName)) {
      throw new Error('文件夹名称不合法（不能为空，且不能包含 / \\）');
    }
    const normalizedDir = this.normalizeRemoteDir(dirPath);
    const targetPath = `${normalizedDir === '/' ? '' : normalizedDir}/${trimmedName}`;
    try {
      const result = await this.execAdbWithExitCode(
        ['-s', deviceId, 'shell', 'mkdir', this.quoteRemotePath(targetPath)],
        { timeout: 15000, maxBuffer: 1024 * 64 }
      );
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (output.includes('file exists') || output.includes('already exists')) {
        throw new Error('同名文件或文件夹已存在');
      }
      if (output.includes('permission denied') || output.includes('read-only')) {
        throw new Error('没有创建权限（可能需要 root）');
      }
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || '创建文件夹失败');
      }
      return targetPath;
    } catch (error) {
      logger.error('ADBManager: createDeviceFolder failed:', error);
      throw this.wrapOperationError('创建文件夹失败', error);
    }
  }

  private normalizeRemoteDir(dirPath: string): string {
    const trimmed = (dirPath || '').trim() || '/sdcard';
    // 统一为以 / 开头、不以 / 结尾（根目录除外），并去掉重复斜杠
    const collapsed = ('/' + trimmed).replace(/\/+/g, '/');
    if (collapsed.length > 1 && collapsed.endsWith('/')) {
      return collapsed.slice(0, -1);
    }
    return collapsed;
  }

  private quoteRemotePath(remotePath: string): string {
    // 用单引号包裹，处理带空格的路径；转义路径内的单引号
    return `'${remotePath.replace(/'/g, `'\\''`)}'`;
  }

  private parseLsOutput(stdout: string, baseDir: string): DeviceFileEntry[] {
    const entries: DeviceFileEntry[] = [];
    // toybox `ls -lA` 行格式：mode links owner group size YYYY-MM-DD HH:MM name
    // 符号链接行尾形如 "name -> target"
    const lineRe = /^([dlbcps-])[rwxsStT.+@-]{9,}\s+\d+\s+\S+\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/;
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (!line.trim() || line.startsWith('total ')) continue;
      const match = line.match(lineRe);
      if (!match) continue;

      const typeChar = match[1];
      const size = parseInt(match[2], 10) || 0;
      const mtime = match[3];
      let name = match[4];

      const isSymlink = typeChar === 'l';
      if (isSymlink) {
        const arrowIdx = name.indexOf(' -> ');
        if (arrowIdx >= 0) {
          name = name.slice(0, arrowIdx);
        }
      }
      if (name === '.' || name === '..') continue;

      const isDir = typeChar === 'd';
      const childPath = baseDir === '/' ? `/${name}` : `${baseDir}/${name}`;
      entries.push({ name, path: childPath, isDir, isSymlink, size, mtime });
    }

    // 目录在前，再按名称排序，符合文件管理器习惯
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, 'zh');
    });
    return entries;
  }

  async disconnect(deviceId: string): Promise<void> {
    try {
      await this.execAdb(['disconnect', deviceId]);
      this.deviceInfoCache.delete(deviceId);
      this.wifiLatencyCache.delete(deviceId);
      this.batteryLevelCache.delete(deviceId);
      this.screenStateCache.delete(deviceId);
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
      // 仅显式传入的数字 PID 才用 --pid 锁定进程；按包名过滤不再用 --pid。
      const sourcePid = this.resolveExplicitLogcatPid(pid);
      // 按包名过滤采用「关联匹配」口径：不把范围锁死到应用自身进程，而是全量抓取后保留所有与该包相关的行
      //（应用自身进程的日志 + 其它进程/系统服务消息体里提到该包的行），与 Android Studio 整机日志口径一致。
      const relatedPackage = !sourcePid ? packageName?.trim().toLowerCase() || undefined : undefined;
      if (relatedPackage) {
        // 预热 PID→包名缓存：应用自身日志的消息体未必含包名，需靠进程归属判定，先同步一次避免开头漏判。
        await this.refreshLogcatPidPackageCache(deviceId).catch(() => undefined);
      }
      const logcatArgs = ['-s', deviceId, 'logcat', '-v', 'long'];
      const adbBinary = await this.resolveAdbBinary();
      if (sourcePid) {
        logcatArgs.push(`--pid=${sourcePid}`);
      }
      logcatArgs.push(`*:${minLevel}`);

      let callbackWindowStart = Date.now();
      let callbackCount = 0;

      // 用 -v long 的条目边界解析：每条日志 = 「[ 头 ]」+ 若干消息行 + 一个空行分隔符。
      // 据此精确切分——多行堆栈合为一条，同毫秒、同 PID/TID/级别/TAG 的独立日志也能分开，
      // 避免 threadtime 文本下「按头合并」把同头独立日志误并导致条目变少。
      let pendingEntry: LogEntry | null = null;
      let pendingHasMessage = false;
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      const ENTRY_FLUSH_MS = 250;

      // flush 时统一做级别过滤、关联过滤与限流：一条（可能多行）日志只计一次吞吐、整条命中关联词。
      const flushPendingLog = () => {
        const entry = pendingEntry;
        const hasMessage = pendingHasMessage;
        pendingEntry = null;
        pendingHasMessage = false;
        if (!entry || !hasMessage) return;
        // 进程归属包名，用于关联过滤与渲染层来源展示。
        entry.packageName = this.getCachedLogcatPackageName(deviceId, entry.processId);
        if (levelPriority[entry.level] < minPriority) return;
        if (relatedPackage) {
          const haystack = `${entry.tag} ${entry.message} ${entry.packageName || ''} ${entry.processId}`.toLowerCase();
          if (!haystack.includes(relatedPackage)) return;
        }
        const now = Date.now();
        if (now - callbackWindowStart >= 1000) {
          callbackWindowStart = now;
          callbackCount = 0;
        }
        if (callbackCount >= this.maxLogCallbacksPerSecond) return;
        callbackCount++;
        callback(entry);
      };

      const logcatProcess = spawn(adbBinary.path, logcatArgs);

      logcatProcess.stdout.on('data', (data) => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
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

        for (const rawLine of limitedLines) {
          const line = rawLine.replace(/[\r\n]+$/, '');
          // logcat buffer 分隔标记（如 "--------- beginning of main"），忽略。
          if (line.startsWith('---------')) continue;

          const header = this.parseLongLogHeader(line, deviceId);
          if (header) {
            // 新条目开始：上一条已完整，先 flush，再以本头开新条目。
            flushPendingLog();
            pendingEntry = header;
            pendingHasMessage = false;
            continue;
          }
          if (line === '') {
            // 空行 = 条目结束分隔符。
            flushPendingLog();
            continue;
          }
          // 其余行是当前条目的消息行（含多行堆栈），按行累加。
          if (pendingEntry) {
            pendingEntry.message = pendingHasMessage ? `${pendingEntry.message}\n${line}` : line;
            pendingHasMessage = true;
          }
        }

        // 末条目的分隔空行可能落在下一批数据里，定时兜底 flush，避免最后一条迟迟不显示。
        flushTimer = setTimeout(flushPendingLog, ENTRY_FLUSH_MS);
      });
      
      logcatProcess.stderr.on('data', (data) => {
        logger.error('Logcat error:', data.toString().slice(-4096));
      });
      
      logcatProcess.on('error', (err) => {
        logger.error('ADBManager: logcat process error:', err);
      });
      
      let stopEntry: StopLogcatProcess | undefined;
      logcatProcess.on('close', () => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        flushPendingLog();
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
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
        flushPendingLog();

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

  // 仅解析用户显式输入的数字 PID（用于 --pid 锁定单进程）。按包名过滤不再在此解析进程，
  // 改由 startLogcat 全量抓取 + 关联过滤实现，覆盖系统/其它进程提到该包的日志。
  private resolveExplicitLogcatPid(pid?: string): string | undefined {
    const cleanedPid = pid?.trim();
    if (!cleanedPid) {
      return undefined;
    }
    if (!/^\d+$/.test(cleanedPid)) {
      throw new Error('PID must be numeric.');
    }
    return cleanedPid;
  }

  // 解析 -v long 的头行：形如「[ 06-02 17:53:19.595  1368:15488 W/qdgralloc ]」。
  // 匹配成功返回只含元数据、message 为空的 LogEntry（消息行由流式状态机后续累加）；非头行返回 null。
  // TID 可能空格右对齐（如「1355: 4375」），故用 :\s* 容错。
  private parseLongLogHeader(line: string, deviceId: string): LogEntry | null {
    const match = line.match(/^\[ (\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\s+(\d+):\s*(\d+) ([VDIWEF])\/(.*?) \]$/);
    if (!match) return null;
    const [, month, day, hours, minutes, seconds, ms, pid, tid, level, tag] = match;
    const now = new Date();
    return {
      id: `${pid}-${tid}-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
      deviceId,
      timestamp: new Date(now.getFullYear(), Number(month) - 1, Number(day), Number(hours), Number(minutes), Number(seconds), Number(ms)),
      processId: Number(pid),
      threadId: Number(tid),
      level: level as LogEntry['level'],
      tag: tag.trim(),
      message: '',
    };
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

  // 把 adb install 的失败输出翻成「精准中文原因 + 可操作建议」。命中已知 INSTALL_FAILED_* 码就给具体提示，
  // 否则尽量截出原始码兜底。原始完整输出仍放进 AdbCommandError.details 供排查。
  private classifyInstallFailure(output: string): { message: string; hint: string } {
    const o = output || '';
    const has = (re: RegExp) => re.test(o);

    // 从失败输出里抽出冲突应用的包名：优先 "Package com.x.y ..." 明确写法，否则退而找像包名的 token（至少两个点）。
    // 命中时拼进提示，方便用户直接定位是哪个包冲突。
    const pkg =
      o.match(/Package\s+([A-Za-z][\w]*(?:\.[A-Za-z_][\w]*)+)/)?.[1] ||
      o.match(/\b[A-Za-z][\w]*(?:\.[A-Za-z_][\w]*){2,}\b/)?.[0];
    const pkgSuffix = pkg ? `（包名 ${pkg}）` : '';

    // 签名不一致：设备已存在同包名应用，但签名与当前 APK 不同 → 无法覆盖（最常见、用户最容易困惑的一种）。
    if (
      has(/INSTALL_FAILED_UPDATE_INCOMPATIBLE/i) ||
      has(/INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES/i) ||
      has(/INSTALL_FAILED_SHARED_USER_INCOMPATIBLE/i) ||
      has(/signatures do not match/i)
    ) {
      return {
        message: `签名不一致：设备上已安装同包名应用${pkgSuffix}，但签名与当前 APK 不同，无法覆盖安装`,
        hint: pkg
          ? `请先在右侧「已安装应用」卸载设备上的「${pkg}」（会清除该应用数据），再重新安装本 APK。`
          : '请先在右侧「已安装应用」卸载设备上的旧版本（会清除该应用数据），再重新安装本 APK。',
      };
    }
    if (has(/INSTALL_FAILED_VERSION_DOWNGRADE/i)) {
      return {
        message: `版本降级被拒绝：当前 APK 的版本号低于设备上已安装的版本${pkgSuffix}`,
        hint: '勾选上方「允许降级覆盖」后重试（降级可能导致应用数据异常）。',
      };
    }
    if (has(/INSTALL_FAILED_INSUFFICIENT_STORAGE/i)) {
      return { message: '设备存储空间不足，无法安装', hint: '清理设备存储空间后重试。' };
    }
    if (has(/INSTALL_FAILED_NO_MATCHING_ABIS/i)) {
      return {
        message: 'CPU 架构不兼容：APK 内的 so 原生库与设备架构不匹配',
        hint: '换用与设备架构匹配的 APK（设备为 arm64 就用 arm64 包）。',
      };
    }
    if (has(/INSTALL_FAILED_OLDER_SDK/i)) {
      return { message: '设备系统版本过低，低于该 APK 要求的最低系统版本', hint: '升级设备系统，或换用兼容更低系统的 APK。' };
    }
    if (has(/INSTALL_FAILED_TEST_ONLY/i)) {
      return { message: '该 APK 被标记为仅供测试（testOnly），常规安装被拒绝', hint: '换用正式发布的 APK，或用测试模式安装。' };
    }
    if (has(/INSTALL_FAILED_DUPLICATE_PERMISSION/i)) {
      return { message: '权限冲突：该 APK 声明的权限与设备上已装的其它应用重复', hint: '卸载冲突的那个应用后再重试。' };
    }
    if (has(/INSTALL_PARSE_FAILED_NO_CERTIFICATES/i)) {
      return { message: 'APK 未签名或证书缺失，无法安装', hint: '使用已正确签名的 APK。' };
    }
    if (has(/INSTALL_PARSE_FAILED/i) || has(/INSTALL_FAILED_INVALID_APK/i)) {
      return { message: 'APK 文件损坏或解析失败', hint: '确认安装包完整未损坏，必要时重新获取该 APK。' };
    }
    if (has(/INSTALL_FAILED_USER_RESTRICTED/i)) {
      return {
        message: '设备拒绝安装：可能未允许 USB 安装 / 未知来源安装',
        hint: '在设备「开发者选项」开启「USB 安装」，或在设备弹窗中允许本次安装。',
      };
    }
    if (has(/No such file|failed to stat|can't find|cannot stat/i)) {
      return { message: 'APK 文件未找到或已被移动', hint: '确认文件仍在原路径，重新选择安装包后再装。' };
    }
    if (has(/device offline|device unauthorized|device .* not found/i)) {
      return { message: '设备连接异常（离线或未授权）', hint: '重新连接设备，并在设备上确认 USB 调试授权。' };
    }

    const codeMatch = o.match(/INSTALL_[A-Z_]+/);
    if (codeMatch) {
      return { message: `安装失败：${codeMatch[0]}`, hint: '展开下方详情可见原始报错。' };
    }
    return { message: '安装失败', hint: '请检查设备连接、调试授权、安装权限、版本签名以及设备剩余空间。' };
  }

  async installApk(deviceId: string, apkPath: string, options?: { allowDowngrade?: boolean }): Promise<string> {
    const cleanedApkPath = apkPath.trim();
    if (!cleanedApkPath.toLowerCase().endsWith('.apk')) {
      throw new Error('Only APK files can be installed.');
    }

    // -r 重装保留数据；-d 允许版本降级覆盖（按 options.allowDowngrade 开启）。
    const installFlags = options?.allowDowngrade ? ['-r', '-d'] : ['-r'];
    const installOptions: ExecFileOptions = {
      timeout: 10 * 60 * 1000,
      maxBuffer: 1024 * 1024 * 8,
    };
    const baseArgs = ['-s', deviceId, 'install', ...installFlags, cleanedApkPath];
    const primaryResult = await this.execAdbWithExitCode(baseArgs, installOptions);
    const primaryOutput = [primaryResult.stdout, primaryResult.stderr].filter(Boolean).join('\n').trim();
    if (/success/i.test(primaryOutput)) {
      return primaryOutput;
    }

    if (this.shouldRetryInstallWithoutStreaming(primaryResult)) {
      const fallbackArgs = ['-s', deviceId, 'install', '--no-streaming', ...installFlags, cleanedApkPath];
      const fallbackResult = await this.execAdbWithExitCode(fallbackArgs, installOptions);
      const fallbackOutput = [fallbackResult.stdout, fallbackResult.stderr].filter(Boolean).join('\n').trim();
      if (/success/i.test(fallbackOutput)) {
        return fallbackOutput;
      }

      const failureOutput = fallbackOutput || primaryOutput || '';
      const { message, hint } = this.classifyInstallFailure(failureOutput);
      throw new AdbCommandError({
        code: 'ADB_COMMAND_FAILED',
        message: `${message}（${path.basename(cleanedApkPath)}）`,
        hint,
        details: failureOutput || 'adb install did not report success.',
      });
    }

    const { message, hint } = this.classifyInstallFailure(primaryOutput);
    throw new AdbCommandError({
      code: 'ADB_COMMAND_FAILED',
      message: `${message}（${path.basename(cleanedApkPath)}）`,
      hint,
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

  async launchApp(deviceId: string, packageName: string): Promise<string> {
    const cleanedPackage = this.assertValidPackageName(packageName);
    const result = await this.execAdbWithExitCode(
      ['-s', deviceId, 'shell', 'monkey', '-p', cleanedPackage, '-c', 'android.intent.category.LAUNCHER', '1'],
      { timeout: 15 * 1000 }
    );
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (/Events injected:\s*1/i.test(output)) {
      return output;
    }

    throw new AdbCommandError({
      code: 'ADB_COMMAND_FAILED',
      message: `启动应用失败：${cleanedPackage}`,
      hint: '该应用可能没有可启动的入口 Activity（如纯后台/服务类应用），或包名不存在。',
      details: output || 'monkey did not report an injected launcher event.',
    });
  }

  async forceStopApp(deviceId: string, packageName: string): Promise<void> {
    const cleanedPackage = this.assertValidPackageName(packageName);
    await this.execAdb(['-s', deviceId, 'shell', 'am', 'force-stop', cleanedPackage], {
      timeout: 10 * 1000,
    });
  }

  private assertValidPackageName(packageName: string): string {
    const cleaned = packageName.trim();
    if (!cleaned || !/^[A-Za-z][\w.]*$/.test(cleaned)) {
      throw new AdbCommandError({
        code: 'ADB_COMMAND_FAILED',
        message: `非法包名：${packageName}`,
        hint: '请从已安装应用列表中选择一个有效的应用包名。',
        details: `Invalid package name: ${packageName}`,
      });
    }
    return cleaned;
  }

  async sleepDevice(deviceId: string): Promise<void> {
    await this.execAdb(['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_SLEEP'], {
      timeout: 8000,
    });
    this.screenStateCache.delete(deviceId); // 主动失效缓存：下次轮询即刷出最新息屏/唤醒状态
  }

  async wakeDevice(deviceId: string): Promise<void> {
    await this.execAdb(['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], {
      timeout: 8000,
    });
    this.screenStateCache.delete(deviceId);
  }

  async unlockDevice(deviceId: string): Promise<void> {
    // 先点亮屏幕
    await this.execAdb(['-s', deviceId, 'shell', 'input', 'keyevent', 'KEYCODE_WAKEUP'], {
      timeout: 8000,
    });

    // 读取屏幕分辨率以计算上滑坐标，读取失败时退回常见的 1080x1920
    let width = 1080;
    let height = 1920;
    try {
      const { stdout: sizeOutput } = await this.execAdb(['-s', deviceId, 'shell', 'wm', 'size'], {
        timeout: 8000,
      });
      const match =
        sizeOutput.match(/Override size:\s*(\d+)x(\d+)/) || sizeOutput.match(/Physical size:\s*(\d+)x(\d+)/);
      if (match) {
        width = parseInt(match[1], 10);
        height = parseInt(match[2], 10);
      }
    } catch {
      // 分辨率读取失败时使用默认值继续上滑
    }

    // 从屏幕下方向上滑动划开锁屏：无锁屏/滑动锁直接进入桌面；
    // 有 PIN/密码/手势的设备会停在输入界面，需在设备上手动输入
    const x = Math.round(width / 2);
    const startY = Math.round(height * 0.8);
    const endY = Math.round(height * 0.2);
    await this.execAdb(
      ['-s', deviceId, 'shell', 'input', 'swipe', String(x), String(startY), String(x), String(endY), '300'],
      { timeout: 8000 }
    );
    this.screenStateCache.delete(deviceId); // 解锁会点亮屏幕，失效缓存让卡片尽快显示「唤醒」
  }

  async rebootDevice(deviceId: string): Promise<void> {
    const result = await this.execAdbWithExitCode(['-s', deviceId, 'reboot'], {
      timeout: 8000,
    });

    if (result.exitCode === 0 || this.isExpectedRebootDisconnect(result)) {
      this.deviceInfoCache.delete(deviceId);
      this.wifiLatencyCache.delete(deviceId);
      this.screenStateCache.delete(deviceId);
      return;
    }

    throw this.createRebootError(result);
  }

  // —— Phase 14 采集会话：持续分段录制 —— //

  isPicoDevice(deviceId: string): boolean {
    return this.isLikelyPicoDevice(deviceId);
  }

  getDeviceSerial(deviceId: string): string {
    return this.deviceInfoCache.get(deviceId)?.serialNo || deviceId;
  }

  getCaptureProvider(deviceId: string): PerformanceCaptureProvider {
    return this.isLikelyPicoDevice(deviceId) ? 'pico-screenrecord' : 'android-screenrecord';
  }

  isCaptureRecording(deviceId: string): boolean {
    return this.captureRecorder.isRecording(deviceId);
  }

  async startCaptureRecording(input: {
    deviceId: string;
    videoDir: string;
    bitRateMbps?: number;
    onSegment?: (meta: CaptureSegmentMeta) => void;
    onSizeBytes?: (totalBytes: number) => void;
    onError?: (error: Error) => void;
  }): Promise<void> {
    return this.captureRecorder.start(input);
  }

  async stopCaptureRecording(deviceId: string): Promise<void> {
    return this.captureRecorder.stop(deviceId);
  }

  async getProcesses(deviceId: string): Promise<ProcessInfo[]> {
    return this.runtimeInspector.getProcesses(deviceId);
  }

  // 当前在运行的应用包名集合：用 ps -A 全量进程，按进程名归一出包名（取 ':' 前并校验格式）。
  // 供已安装列表标「运行中」、禁止重复启动用。无论工具启动还是设备本机启动都能反映真实状态。
  async getRunningPackages(deviceId: string): Promise<string[]> {
    try {
      const stdout = await this.getProcessListOutput(deviceId);
      const running = new Set<string>();
      for (const line of stdout.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 2) continue;
        const pkg = this.normalizeAndroidPackageName(parts[parts.length - 1]);
        if (pkg) running.add(pkg);
      }
      return Array.from(running);
    } catch (error) {
      logger.warn('ADBManager: getRunningPackages failed:', error);
      return [];
    }
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

  private async execAdbWithExitCode(
    args: string[],
    options?: ExecFileOptions,
    onChild?: (child: ChildProcess) => void
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const adbBinary = await this.resolveAdbBinary();
    return await new Promise((resolve, reject) => {
      const child = execFile(adbBinary.path, args, options, (error, stdout, stderr) => {
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
      onChild?.(child);
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
        const connectedDevices = Array.from(this.deviceInfoCache.values())
          .filter((device) => device.status === 'connected');

        if (connectedDevices.length > 0) {
          const refreshedDevices = await Promise.all(
            connectedDevices.map(async (device) => {
              // 屏幕状态 USB / WiFi 都周期刷（卡片要显示息屏/唤醒）；电量与延迟仍仅 WiFi 周期刷，保持原有开销。
              let refreshed = await this.refreshScreenStateForDevice(device);
              if (refreshed.connectionType === 'wifi') {
                refreshed = await this.refreshBatteryLevelForDevice(refreshed);
                refreshed = await this.refreshWifiLatencyForDevice(refreshed);
              }
              return refreshed;
            })
          );
          let hasDeviceHealthChanged = false;
          for (const device of refreshedDevices) {
            const previousDevice = this.deviceInfoCache.get(device.id);
            if (
              previousDevice?.batteryLevel !== device.batteryLevel ||
              previousDevice?.latencyMs !== device.latencyMs ||
              previousDevice?.latencyStatus !== device.latencyStatus ||
              previousDevice?.screenState !== device.screenState
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
    this.screenStateCache.clear();
    this.lastDeviceSnapshot.clear();
    await this.killAdbServer();
    
    logger.log('ADBManager: cleanup completed');
  }
}
