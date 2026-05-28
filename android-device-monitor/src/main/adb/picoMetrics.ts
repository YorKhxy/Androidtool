import type { ExecFileOptions } from 'child_process';
import type { MetricReading, PerformanceMetrics, PicoAppSupportStatus } from '../../shared/types';

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

export type PicoAppSupportResult = {
  status: PicoAppSupportStatus;
  message: string;
};

const PICO_METRICS_LOG_ARGS = ['shell', 'logcat', '-d', '-v', 'time', '-s', 'PxrMetric'];
const PICO_HUB_START_THROTTLE_MS = 15000;
const XR_PROFILING_TOOLKIT_MARKERS = [
  'XRProfilingToolkitLogger',
  'XR_ProfilingToolkit',
  'CommandRunner',
  'CommandQueue',
];

export class PicoMetricsReader {
  private readonly picoDeviceCache = new Map<string, boolean>();
  private readonly metricsHubStartedAt = new Map<string, number>();
  private readonly appSupportCache = new Map<string, PicoAppSupportResult>();

  constructor(private readonly execAdb: ExecAdbText) {}

  async isPicoDevice(deviceId: string): Promise<boolean> {
    if (this.picoDeviceCache.has(deviceId)) {
      return this.picoDeviceCache.get(deviceId)!;
    }

    const fingerprint = await this.getDeviceFingerprint(deviceId);
    const identity = [fingerprint.manufacturer, fingerprint.brand, fingerprint.model, fingerprint.device]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const isPico = identity.includes('pico');
    this.picoDeviceCache.set(deviceId, isPico);
    return isPico;
  }

  async getPerformanceMetrics(deviceId: string, foregroundApp: ForegroundAppContext): Promise<PerformanceMetrics | null> {
    if (!(await this.isPicoDevice(deviceId))) {
      return null;
    }

    await this.ensureMetricsHubStarted(deviceId);

    const { stdout } = await this.execAdb(['-s', deviceId, ...PICO_METRICS_LOG_ARGS], {
      timeout: 4000,
      maxBuffer: 1024 * 1024 * 2,
    });

    const latestLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse()
      .find((line) => line.includes('PxrMetric'));

    if (!latestLine) {
      throw new Error('未读取到 PICO Metrics 实时数据。');
    }

    return this.parseMetricsLine(latestLine, foregroundApp);
  }

  async detectForegroundAppSupport(deviceId: string, foregroundApp: ForegroundAppContext): Promise<PicoAppSupportResult> {
    const packageName = foregroundApp.packageName?.trim();
    if (!packageName) {
      return {
        status: 'unknown',
        message: '未解析到前台应用包名，无法确认是否集成 XR Profiling Toolkit。',
      };
    }

    const cacheKey = `${deviceId}:${packageName}`;
    const cached = this.appSupportCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const result = await this.detectAppSupportFromApk(deviceId, packageName).catch(() => ({
      status: 'unknown' as const,
      message: '无法读取前台应用 APK，需应用侧确认是否集成 XR Profiling Toolkit。',
    }));
    this.appSupportCache.set(cacheKey, result);
    return result;
  }

  private async detectAppSupportFromApk(deviceId: string, packageName: string): Promise<PicoAppSupportResult> {
    const quotedPackageName = this.quoteShellArg(packageName);
    const markerPattern = XR_PROFILING_TOOLKIT_MARKERS.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const script = `
apk_paths=$(pm path ${quotedPackageName} 2>/dev/null | sed 's/^package://')
if [ -z "$apk_paths" ]; then
  echo ADM_PICO_SUPPORT_UNKNOWN_NO_APK
  exit 0
fi
while IFS= read -r apk_path; do
  if [ -n "$apk_path" ] && grep -a -m 1 -E '${markerPattern}' "$apk_path" >/dev/null 2>&1; then
    echo ADM_PICO_SUPPORT_SUPPORTED
    exit 0
  fi
done <<EOF
$apk_paths
EOF
echo ADM_PICO_SUPPORT_UNSUPPORTED
`.trim();

    const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'sh', '-c', script], {
      timeout: 6000,
      maxBuffer: 1024 * 64,
    });
    const output = stdout.trim();

    if (output.includes('ADM_PICO_SUPPORT_SUPPORTED')) {
      return {
        status: 'supported',
        message: '已在前台应用 APK 中检测到 XR Profiling Toolkit 运行时标识。',
      };
    }

    if (output.includes('ADM_PICO_SUPPORT_UNSUPPORTED')) {
      return {
        status: 'unsupported',
        message: '前台应用 APK 未检测到 XR Profiling Toolkit 运行时标识，Pico 官方指标不可用。',
      };
    }

    return {
      status: 'unknown',
      message: '未找到前台应用 APK，无法确认是否集成 XR Profiling Toolkit。',
    };
  }

  private async ensureMetricsHubStarted(deviceId: string): Promise<void> {
    const lastStartedAt = this.metricsHubStartedAt.get(deviceId) || 0;
    if (Date.now() - lastStartedAt < PICO_HUB_START_THROTTLE_MS) {
      return;
    }

    const actions = ['com.pico.developer.hub.streaming.on', 'com.pico.developer.hub.on'];
    for (const action of actions) {
      try {
        await this.execAdb(
          ['-s', deviceId, 'shell', 'am', 'startservice', '-a', action, 'com.pico.developerhubservice/.HubService'],
          {
            timeout: 4000,
            maxBuffer: 1024 * 64,
          }
        );
      } catch {
        // 某些固件没有暴露这套 action，忽略后继续尝试读取已有指标流。
      }
    }

    this.metricsHubStartedAt.set(deviceId, Date.now());
  }

  private parseMetricsLine(line: string, foregroundApp: ForegroundAppContext): PerformanceMetrics {
    const payload = this.parseEntryMap(line);
    const rawFields = Object.fromEntries(payload.entries());

    const fps = this.parseRatioMetric(payload.get('FPS'));
    const mtp = this.parseSingleMetric(payload.get('MTP'));
    const frameCpu = this.parseSingleMetric(payload.get('FrmCpu'));
    const frameGpu = this.parseSingleMetric(payload.get('FrmGpu'));
    const atwGpu = this.parseSingleMetric(payload.get('ATWGPU'));
    const gpuUtil = this.parseRatioMetric(payload.get('GPU'));
    const packageName = payload.get('Pkg') || foregroundApp.packageName;

    return {
      provider: 'pico',
      cpuUsage: 0,
      memoryUsage: 0,
      fps: fps?.value ?? 0,
      packageName,
      activityName: foregroundApp.activityName,
      picoMetrics: {
        rawLine: line,
        rawFields,
        fps,
        mtp,
        frameCpu,
        frameGpu,
        atwGpu,
        gpuUtil,
      },
    };
  }

  private parseEntryMap(line: string): Map<string, string> {
    const metricMatch = line.match(/PxrMetric(?:\(\s*\d+\s*\))?:\s*(.*)$/);
    const dataStart = metricMatch ? metricMatch[1] : line;
    const entries = dataStart
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);

    const result = new Map<string, string>();
    for (const entry of entries) {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex < 0) {
        continue;
      }

      const key = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      if (key) {
        result.set(key, value);
      }
    }

    return result;
  }

  private parseSingleMetric(raw?: string): MetricReading | undefined {
    if (!raw) {
      return undefined;
    }

    const match = raw.match(/(-?\d+(?:\.\d+)?)([a-zA-Z%]+)?/);
    if (!match) {
      return undefined;
    }

    return {
      value: Number.parseFloat(match[1]),
      unit: match[2],
      raw,
    };
  }

  private parseRatioMetric(raw?: string): MetricReading | undefined {
    if (!raw) {
      return undefined;
    }

    const numbers = raw.match(/-?\d+(?:\.\d+)?/g)?.map((value) => Number.parseFloat(value));
    if (!numbers || numbers.length === 0) {
      return undefined;
    }

    const units = raw.match(/[a-zA-Z%]+/g) || [];
    return {
      value: numbers[0],
      unit: units[0],
      maxValue: numbers[1],
      maxValueUnit: units[1] || units[0],
      raw,
    };
  }

  private async getDeviceFingerprint(deviceId: string): Promise<DeviceFingerprint> {
    const [manufacturer, brand, model, device] = await Promise.all([
      this.getDeviceProp(deviceId, 'ro.product.manufacturer'),
      this.getDeviceProp(deviceId, 'ro.product.brand'),
      this.getDeviceProp(deviceId, 'ro.product.model'),
      this.getDeviceProp(deviceId, 'ro.product.device'),
    ]);

    return { manufacturer, brand, model, device };
  }

  private async getDeviceProp(deviceId: string, propertyName: string): Promise<string> {
    const { stdout } = await this.execAdb(['-s', deviceId, 'shell', 'getprop', propertyName], {
      timeout: 4000,
      maxBuffer: 1024 * 64,
    });
    return stdout.trim();
  }

  private quoteShellArg(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
  }
}
