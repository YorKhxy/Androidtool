const fs = require('fs');
const path = require('path');

describe('project smoke checks', () => {
  const root = path.resolve(__dirname, '..');

  test('main source files exist', () => {
    expect(fs.existsSync(path.join(root, 'src/main/adb/ADBManager.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/renderer/SimpleApp.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/main/preload.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/main/adb/adbError.ts'))).toBe(true);
  });

  test('package entry points are configured', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const batSource = fs.readFileSync(path.join(root, 'scripts/build-and-package.bat'), 'utf-8');
    const ps1Source = fs.readFileSync(path.join(root, 'scripts/build-and-package.ps1'), 'utf-8');
    const electronRuntimeSource = fs.readFileSync(path.join(root, 'scripts/ensure-electron-runtime.js'), 'utf-8');
    expect(pkg.main).toBe('./dist/main/main/index.js');
    expect(pkg.scripts.build).toContain('build:main');
    expect(pkg.scripts.build).toContain('build:renderer');
    expect(pkg.scripts['build:main']).toContain('copy-preload.js');
    expect(pkg.scripts['adb:prepare']).toContain('prepare-platform-tools.js');
    expect(pkg.scripts.pack).toContain('adb:prepare');
    expect(batSource).toContain('build-and-package.ps1');
    expect(ps1Source).toContain('npm run adb:prepare');
    expect(ps1Source).toContain('npm run build:main');
    expect(ps1Source).toContain('npm run build:renderer');
    expect(ps1Source).toContain('ensure-electron-runtime.js');
    expect(ps1Source).toContain('vendor\\platform-tools');
    expect(electronRuntimeSource).toContain('restoreFromTempElectronRuntime');
    expect(pkg.build.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'vendor/platform-tools',
          to: 'platform-tools',
        }),
      ])
    );
  });

  test('logcat cleanup has bounded buffers and kills process trees on Windows', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    expect(source).toContain('maxLogcatBufferChars');
    expect(source).toContain("execFile('taskkill'");
    expect(source).toContain("removeAllListeners('data')");
  });

  test('renderer avoids unbounded pending log and performance polling backlog', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    expect(source).toContain('MAX_PENDING_LOG_BUFFER');
    expect(source).toContain('performanceRequestInFlightRef');
    expect(source).toContain('if (performanceRequestInFlightRef.current) return');
  });

  test('renderer keeps logcat data in chronological bounded storage', () => {
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const logStoreSource = fs.readFileSync(path.join(root, 'src/renderer/lib/logStore.ts'), 'utf-8');
    expect(logStoreSource).toContain('class ChunkedLogStore');
    expect(rendererSource).toContain('state.store.append(buffer)');
    expect(rendererSource).not.toContain('Object.values(logsByLevel).flat');
    expect(rendererSource).not.toContain('setLogsByLevel');
  });

  test('logcat entries are routed by device for multi-device monitoring', () => {
    const adbSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const logStoreSource = fs.readFileSync(path.join(root, 'src/renderer/lib/logStore.ts'), 'utf-8');

    expect(typeSource).toContain('deviceId: string');
    expect(adbSource).toContain('parseLogcatLine(line, deviceId)');
    expect(adbSource).toContain('deviceId,');
    expect(logStoreSource).toContain('type DeviceLogState');
    expect(rendererSource).toContain('new Map<string, DeviceLogState>()');
    expect(rendererSource).toContain('const entriesByDevice = new Map<string, LogEntry[]>()');
    expect(rendererSource).toContain('reconcileLogStatesWithDevices');
  });

  test('logcat entries can infer package names from process ids', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');

    expect(source).toContain('logcatPidPackageCache');
    expect(source).toContain('refreshLogcatPidPackageCacheIfNeeded(deviceId)');
    expect(source).toContain('logEntry.packageName = this.getCachedLogcatPackageName(deviceId, logEntry.processId)');
    expect(source).toContain("this.execAdb(['-s', deviceId, 'shell', 'ps', '-A'])");
    expect(source).toContain('normalizeAndroidPackageName');
  });

  test('logcat package filters do not fail startup when a package is not running', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');

    expect(source).toContain('continuing unscoped logcat');
    expect(source).toContain('return undefined');
    expect(source).toContain('const sourcePackageName = sourcePid && packageName?.trim()');
    expect(source).not.toContain('Package process is not running');
  });

  test('starting or stopping one device logcat does not clear all queued logs', () => {
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');

    for (const source of [mainSource, prodSource]) {
      const startHandler = source.slice(source.indexOf('IPC_CHANNELS.START_LOGCAT'), source.indexOf('IPC_CHANNELS.STOP_LOGCAT'));
      const stopHandler = source.slice(source.indexOf('IPC_CHANNELS.STOP_LOGCAT'), source.indexOf('IPC_CHANNELS.GET_PERFORMANCE'));
      expect(startHandler).not.toContain('clearLogQueue()');
      expect(stopHandler).not.toContain('clearLogQueue()');
    }
  });

  test('renderer honors selected low log levels when starting logcat', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(source).toContain("const sourceLevel: LogEntry['level'] = filterLevel === 'all' ? 'V' : filterLevel");
    expect(source).not.toContain("sourceLevel = 'W'");
  });

  test('renderer removes USB devices from the monitor view without adb disconnect', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(source).toContain("if (device.connectionType === 'usb')");
    expect(source).toContain('stopLogcat(deviceId).catch');
    expect(source).toContain('prev.filter(item => item.id !== deviceId)');
    expect(source).toContain('disconnectDevice(device)');
  });

  test('adb status and device list changes are exposed through preload and shared channels', () => {
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');

    expect(preloadSource).toContain("getAdbStatus: () => ipcRenderer.invoke('adb:get-status')");
    expect(preloadSource).toContain("ipcRenderer.on('adb:status-changed'");
    expect(preloadSource).toContain("ipcRenderer.on('device:list-changed'");
    expect(channelSource).toContain("GET_ADB_STATUS: 'adb:get-status'");
    expect(channelSource).toContain("ADB_STATUS_CHANGED: 'adb:status-changed'");
    expect(channelSource).toContain("DEVICE_LIST_CHANGED: 'device:list-changed'");
    expect(typeSource).toContain('export interface AdbStatus');
  });

  test('packaged build keeps preload bridge file available for Electron', () => {
    const scriptSource = fs.readFileSync(path.join(root, 'scripts/copy-preload.js'), 'utf-8');
    expect(scriptSource).toContain("path.join(projectRoot, 'src', 'main', 'preload.js')");
    expect(scriptSource).toContain("path.join(projectRoot, 'dist', 'main', 'main')");
    expect(scriptSource).toContain("fs.copyFileSync(sourcePath, targetPath)");
  });

  test('adb manager monitors device changes and classifies adb failures', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const errorSource = fs.readFileSync(path.join(root, 'src/main/adb/adbError.ts'), 'utf-8');
    const binarySource = fs.readFileSync(path.join(root, 'src/main/adb/adbBinary.ts'), 'utf-8');

    expect(managerSource).toContain('startDeviceMonitoring');
    expect(managerSource).toContain('pollDeviceChanges');
    expect(managerSource).toContain('getAdbStatus(forceRefresh = false)');
    expect(managerSource).toContain('emitDeviceListChanged');
    expect(managerSource).toContain("source: 'bundled'");
    expect(managerSource).toContain("source: 'system'");
    expect(binarySource).toContain('resolveBundledAdbBinaryPath');
    expect(binarySource).toContain("platform-tools', target, 'platform-tools'");
    expect(errorSource).toContain('class AdbCommandError');
    expect(errorSource).toContain('ADB_NOT_FOUND');
    expect(errorSource).toContain('DEVICE_UNAUTHORIZED');
    expect(errorSource).toContain('WIFI_CONNECTION_REFUSED');
  });

  test('renderer supports persisted custom device display names', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(source).toContain('DEVICE_NAME_STORAGE_KEY');
    expect(source).toContain('loadStoredDeviceNames');
    expect(source).toContain('saveStoredDeviceNames');
    expect(source).toContain('getDeviceDisplayName');
    expect(source).toContain('updateCustomDeviceName');
    expect(source).toContain('android-device-monitor.custom-device-names');
  });

  test('wifi devices surface low-frequency latency on cards', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');

    expect(typeSource).toContain('latencyMs?: number');
    expect(typeSource).toContain("latencyStatus?: 'ok' | 'timeout' | 'unknown'");
    expect(managerSource).toContain('measureWifiLatency');
    expect(managerSource).toContain('wifiLatencyCacheMs = 10000');
    expect(managerSource).toContain('net.createConnection');
    expect(rendererSource).toContain('getWifiLatencyLabel');
    expect(rendererSource).toContain('延迟 ${device.latencyMs}ms');
    expect(rendererSource).toContain('连接不稳');
  });

  test('renderer does not show phone text placeholders in empty states', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(source).not.toContain("{'\\u624b\\u673a'}");
    expect(source).not.toContain("fontSize: '48px', marginBottom: '8px' }}>{'\\u624b\\u673a'}");
    expect(source).not.toContain("fontSize: '64px', marginBottom: '16px' }}>{'\\u624b\\u673a'}");
  });

  test('renderer virtualizes log rows instead of rendering every entry', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    expect(source).toContain('LOG_ROW_HEIGHT');
    expect(source).toContain('visibleStartIndex');
    expect(source).toContain('visibleLogs.map');
    expect(source).toContain('virtualTopPadding');
  });

  test('performance metrics use foreground app FPS semantics and switch Pico devices to Pico metrics view', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/runtimeInspector.ts'), 'utf-8');
    const picoSource = fs.readFileSync(path.join(root, 'src/main/adb/picoMetrics.ts'), 'utf-8');
    const adbManagerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/components/PerformancePanel.tsx'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');

    expect(managerSource).toContain("'dumpsys', 'gfxinfo', foregroundApp.packageName, 'framestats'");
    expect(managerSource).toContain('options.preferPico');
    expect(managerSource).toContain("provider: 'android'");
    expect(managerSource).toContain('parseFrameStatsFps');
    expect(managerSource).toContain('buildPicoFallbackMetrics');
    expect(managerSource).toContain("picoMetricsState: 'native'");
    expect(managerSource).toContain('detectForegroundAppSupport');
    expect(managerSource).toContain('picoAppSupport: appSupport.status');
    expect(managerSource).toContain('picoSupportMessage: appSupport.message');
    expect(managerSource).not.toContain("if (appSupport.status === 'unsupported')");
    expect(managerSource).toContain('mCurrentFocus');
    expect(managerSource).toContain("this.getDeviceProp(deviceId, 'ro.product.manufacturer')");
    expect(managerSource).toContain('packageName: foregroundApp.packageName');
    expect(managerSource).toContain('androidMetrics');
    expect(managerSource).toContain("source: 'android'");
    expect(managerSource).toContain('adb shell dumpsys meminfo');
    expect(picoSource).toContain("provider: 'pico'");
    expect(picoSource).toContain("'shell', 'logcat'");
    expect(picoSource).toContain("'-s', 'PxrMetric'");
    expect(picoSource).not.toContain("'*:S'");
    expect(picoSource).toContain("this.getDeviceProp(deviceId, 'ro.product.manufacturer')");
    expect(picoSource).toContain("'shell', 'getprop', propertyName");
    expect(picoSource).toContain('ensureMetricsHubStarted');
    expect(picoSource).toContain('com.pico.developer.hub.streaming.on');
    expect(picoSource).toContain('XRProfilingToolkitLogger');
    expect(picoSource).toContain('CommandRunner');
    expect(picoSource).toContain('CommandQueue');
    expect(picoSource).toContain('appSupportCache');
    expect(picoSource).toContain('pm path');
    expect(picoSource).toContain('apk_paths=$(pm path');
    expect(picoSource).toContain('while IFS= read -r apk_path');
    expect(picoSource).toContain('grep -a -m 1 -E');
    expect(picoSource).toContain('rawLine: line');
    expect(picoSource).toContain('rawFields');
    expect(picoSource).toContain('PxrMetric(?:\\(\\d+\\))?:\\s*(.*)$');
    expect(picoSource).toContain("'FrmCpu'");
    expect(adbManagerSource).toContain('preferPico: this.isLikelyPicoDevice(deviceId)');
    expect(adbManagerSource).toContain('private isLikelyPicoDevice(deviceId: string): boolean');
    expect(typeSource).toContain("provider: 'android' | 'pico'");
    expect(typeSource).toContain("export type PicoMetricsState = 'native' | 'fallback' | 'unavailable'");
    expect(typeSource).toContain('picoMetrics?: PicoMetricsPayload');
    expect(typeSource).toContain('rawLine?: string');
    expect(typeSource).toContain('rawFields?: Record<string, string>');
    expect(typeSource).toContain('androidMetrics?: AndroidPerformancePayload');
    expect(typeSource).toContain('picoMetricsState?: PicoMetricsState');
    expect(typeSource).toContain("export type PicoAppSupportStatus = 'supported' | 'unsupported' | 'unknown'");
    expect(typeSource).toContain('picoAppSupport?: PicoAppSupportStatus');
    expect(typeSource).toContain('fps: number');
    expect(rendererSource).toContain('前台渲染帧率');
    expect(rendererSource).toContain('通用 Android Provider');
    expect(rendererSource).not.toContain('Pico Metrics 官方原始数据');
    expect(rendererSource).not.toContain('当前使用应用内置 ADB');
    expect(rendererSource).not.toContain('adbStatus: AdbStatus | null');
    expect(rendererSource).not.toContain('前台应用已检测到 XR Profiling Toolkit');
    expect(rendererSource).not.toContain('前台应用未检测到 XR Profiling Toolkit');
    expect(rendererSource).not.toContain('picoSupportMessage');
    expect(rendererSource).toContain('当前 Pico 指标关联前台应用');
    expect(rendererSource).toContain('renderPicoFallbackMetrics');
    expect(rendererSource).toContain('通用 CPU 采样回退');
    expect(rendererSource).toContain('FrmGpu');
    expect(rendererSource).toContain('ATWGPU');
  });

  test('network capture parses request details and renderer shows a request detail panel', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/components/NetworkPanel.tsx'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');

    expect(managerSource).toContain("'-tttt'");
    expect(managerSource).toContain('parseTcpdumpPackets');
    expect(managerSource).toContain('parseHttpRequestMessage');
    expect(managerSource).toContain('parseHttpResponseMessage');
    expect(managerSource).toContain('responseHeaders');
    expect(typeSource).toContain('statusText?: string');
    expect(typeSource).toContain('responseHeaders?: Record<string, string>');
    expect(rendererSource).toContain('selectedNetworkRequestId');
    expect(rendererSource).toContain('formatNetworkDuration');
    expect(rendererSource).toContain('请求头');
    expect(rendererSource).toContain('响应头');
    expect(rendererSource).toContain('请求体');
    expect(rendererSource).toContain('响应体');
  });

  test('network capture failures keep classified Chinese messages instead of mixed English wrappers', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');

    expect(managerSource).toContain('createNetworkCaptureError');
    expect(managerSource).toContain('抓取 HTTP 请求超时');
    expect(managerSource).toContain('当前设备无法执行 tcpdump 抓包');
    expect(managerSource).not.toContain('Network capture failed. tcpdump may be missing or require elevated device permissions');
  });

  test('manual performance snapshots save screenshot artifacts and renderer surfaces snapshot history', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/runtimeInspector.ts'), 'utf-8');
    const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const snapshotStoreSource = fs.readFileSync(path.join(root, 'src/main/performanceSnapshots.ts'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/components/PerformancePanel.tsx'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');

    expect(managerSource).toContain("'exec-out', 'screencap', '-p'");
    expect(managerSource).toContain('capturePerformanceSnapshot');
    expect(managerSource).not.toContain('capturePicoSystemScreenshot');
    expect(managerSource).not.toContain("'shell', 'input', 'keyevent', '120'");
    expect(managerSource).not.toContain('listScreenshotCandidates');
    expect(managerSource).toContain("return identity.includes('pico')");
    expect(managerSource).toContain('parseCpuUsage');
    expect(managerSource).toContain('parseMemoryUsage');
    expect(managerSource).toContain('Used RAM');
    expect(snapshotStoreSource).toContain('performance-snapshots');
    expect(snapshotStoreSource).toContain('formatDateFolder');
    expect(snapshotStoreSource).toContain('resolveRuntimeAppRoot');
    expect(snapshotStoreSource).toContain('path.dirname(process.execPath)');
    expect(snapshotStoreSource).toContain('buildAnnotatedSnapshotImage');
    expect(snapshotStoreSource).toContain('nativeImage.createFromBuffer');
    expect(snapshotStoreSource).toContain('sourceImage.crop');
    expect(snapshotStoreSource).toContain('buildSnapshotMetricLines');
    expect(snapshotStoreSource).toContain('CPU USAGE');
    expect(snapshotStoreSource).toContain('formatMemoryMb');
    expect(snapshotStoreSource).not.toContain("formatMetricValue(metrics.memoryUsage, 'KB')");
    expect(indexSource).toContain('CAPTURE_PERFORMANCE_SNAPSHOT');
    expect(indexSource).toContain('resolveRuntimeAppRoot(app)');
    expect(indexSource).not.toContain("app.getPath('userData')");
    expect(preloadSource).toContain('capturePerformanceSnapshot');
    expect(typeSource).toContain("trigger: 'manual' | 'fps_drop' | 'threshold'");
    expect(typeSource).toContain('screenshotPath?: string');
    expect(rendererSource).toContain('抓取性能快照');
    expect(rendererSource).toContain('性能快照');
    expect(rendererSource).toContain('CPU 占用率');
    expect(rendererSource).toContain('内存占用');
    expect(rendererSource).not.toContain("'GPU',\n        'GPU 使用率'");
    expect(rendererSource).toContain('formatMemoryMb');
    expect(rendererSource).not.toContain("'KB'");
    const picoMetricsSource = rendererSource.slice(
      rendererSource.indexOf('const renderPicoMetrics'),
      rendererSource.indexOf('const renderPicoFallbackMetrics')
    );
    expect(picoMetricsSource.indexOf("'FPS',\n        'Pico 实时帧率'")).toBeLessThan(picoMetricsSource.indexOf("'CPU',\n        'CPU 占用率'"));
    expect(picoMetricsSource.indexOf("'CPU',\n        'CPU 占用率'")).toBeLessThan(picoMetricsSource.indexOf("'MEM',\n        '内存占用'"));
    expect(picoMetricsSource.indexOf("'MEM',\n        '内存占用'")).toBeLessThan(picoMetricsSource.indexOf("'GPU',\n        'GPU 利用率'"));
    expect(rendererSource).toContain("width: '200%'");
    expect(rendererSource).toContain("minWidth: '200%'");
    expect(rendererSource).toContain("objectPosition: 'left center'");
    expect(rendererSource).toContain("justifyContent: isPicoSnapshot ? 'flex-start' : 'center'");
    expect(simpleAppSource).toContain('setPerformanceSnapshots');
  });

  test('network tab does not auto-trigger capture or show loading as an error toast', () => {
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(rendererSource).not.toContain("if (selectedDevice && activeTab === 'network') {\r\n      loadNetworkRequests();");
    expect(rendererSource).not.toContain("\\u6b63\\u5728\\u6293\\u53d6 HTTP \\u8bf7\\u6c42...");
  });
});
