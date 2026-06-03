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
    expect(ps1Source).toContain('vendor\\scrcpy');
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

  test('auto-update wiring and update-package scripts are configured', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const updatePackPs1 = fs.readFileSync(path.join(root, 'scripts/make-update-package.ps1'), 'utf-8');
    const updatePackBat = fs.readFileSync(path.join(root, 'scripts/make-update-package.bat'), 'utf-8');
    const serveSource = fs.readFileSync(path.join(root, 'scripts/serve-updates.js'), 'utf-8');
    // electron-updater 依赖与 generic 更新源配置
    expect(pkg.dependencies['electron-updater']).toBeDefined();
    expect(pkg.build.publish).toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: 'generic' })])
    );
    // 打热更包脚本：必须先 build 主/渲染、切生产入口、再 electron-builder
    expect(pkg.scripts['update:pack']).toContain('make-update-package.ps1');
    expect(updatePackPs1).toContain('npm run build:main');
    expect(updatePackPs1).toContain('npm run build:renderer');
    expect(updatePackPs1).toContain('index-prod.js');
    expect(updatePackPs1).toContain('electron-builder');
    expect(updatePackPs1).toContain('npm version patch');
    expect(updatePackBat).toContain('make-update-package.ps1');
    // 更新服务器脚本支持 Range（差量下载需要）
    expect(pkg.scripts['serve:updates']).toContain('serve-updates.js');
    expect(serveSource).toContain('206');
    expect(serveSource).toContain('Content-Range');
  });

  test('logcat cleanup has bounded buffers and kills process trees on Windows', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    expect(source).toContain('maxLogcatBufferChars');
    expect(source).toContain("execFile('taskkill'");
    expect(source).toContain("removeAllListeners('data')");
    expect(source).toContain('async cleanup(): Promise<void>');
    expect(source).toContain('await stopEntry.stop()');
    expect(source).toContain("['kill-server']");
  });

  test('app waits for adb cleanup before quitting', () => {
    const devSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');

    for (const source of [devSource, prodSource]) {
      expect(source).toContain('cleanupBeforeQuit');
      expect(source).toContain('event.preventDefault()');
      expect(source).toContain('await adbManager.cleanup()');
      expect(source).toContain('app.quit()');
    }
  });

  test('renderer avoids unbounded pending log and performance polling backlog', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    expect(source).toContain('MAX_PENDING_LOG_BUFFER');
    expect(source).toContain('performanceRequestInFlightRef');
    expect(source).toContain('performanceRequestInFlightRef.current.has(deviceId)');
    expect(source).toContain('performanceEnabledDeviceIds.has(selectedDevice.id)');
    expect(source).toContain('togglePerformanceMonitoring');
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
    expect(adbSource).toContain('parseLongLogHeader(line, deviceId)');
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
    expect(source).toContain('entry.packageName = this.getCachedLogcatPackageName(deviceId, entry.processId)');
    expect(source).toContain("this.execAdb(['-s', deviceId, 'shell', 'ps', '-A'])");
    expect(source).toContain('normalizeAndroidPackageName');
  });

  test('logcat package filters capture related logs across processes without failing when app is not running', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');

    // 用 -v long 输出，靠条目边界（[头]+消息行+空行）精确解析 PID/TID/TAG，并区分同头独立日志
    expect(source).toContain("'logcat', '-v', 'long'");
    // 按包名过滤改为「关联匹配」：全量抓取 + 关联过滤，而非用 --pid 锁死应用自身进程
    expect(source).toContain('const relatedPackage =');
    expect(source).toContain('haystack.includes(relatedPackage)');
    // 仅显式数字 PID 才用 --pid；按包名不再 pidof，故应用未运行也不会导致启动失败
    expect(source).toContain('resolveExplicitLogcatPid');
    expect(source).not.toContain('Package process is not running');
  });

  test('logcat assembles -v long entries by boundary (header + message lines + blank separator)', () => {
    const source = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');

    // 按 -v long 头行起新条目、空行结束条目、其余行累加 message：多行堆栈合一条、同头独立日志分开
    expect(source).toContain('parseLongLogHeader');
    expect(source).toContain('pendingHasMessage');
    // 头行起新条目（先 flush 上一条）；空行作为条目分隔符
    expect(source).toContain('flushPendingLog');
    expect(source).toContain('flushTimer');
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

  test('renderer always captures all log levels; level dropdown only filters display', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    // 抓取恒定 all levels（*:V），不受等级下拉框限制；等级仅作显示筛选（filteredLogs 用 filterLevel）
    expect(source).toContain("const sourceLevel: LogEntry['level'] = 'V'");
    expect(source).toContain('const hasLevelFilter = filterLevel !== ');
  });

  test('log search keeps a persisted, selectable history', () => {
    const storeSource = fs.readFileSync(path.join(root, 'src/renderer/lib/searchHistoryStore.ts'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    // 历史持久化到 localStorage，去重置顶
    expect(storeSource).toContain("'adm.logSearchHistory.v1'");
    expect(storeSource).toContain('export const addSearchHistory');
    expect(storeSource).toContain('export const loadSearchHistory');
    // 自定义暗色下拉（非原生 datalist），回车/失焦记录历史，重启后从 localStorage 载入可选，支持移除
    expect(rendererSource).toContain('loadSearchHistory()');
    expect(rendererSource).toContain('recordSearchHistory');
    expect(rendererSource).toContain('showSearchHistory');
    expect(rendererSource).toContain('visibleSearchHistory');
    expect(rendererSource).toContain('removeOneSearchHistory');
    expect(rendererSource).not.toContain('<datalist');
  });

  test('file manager can create a folder in the current directory', () => {
    const adbSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const channelsSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const apiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');
    const filesSource = fs.readFileSync(path.join(root, 'src/renderer/components/FilesPanel.tsx'), 'utf-8');

    expect(adbSource).toContain('async createDeviceFolder');
    expect(adbSource).toContain("'mkdir'");
    expect(channelsSource).toContain("CREATE_DEVICE_FOLDER: 'adb:create-device-folder'");
    expect(mainSource).toContain('IPC_CHANNELS.CREATE_DEVICE_FOLDER');
    expect(prodSource).toContain('IPC_CHANNELS.CREATE_DEVICE_FOLDER');
    expect(preloadSource).toContain('createDeviceFolder:');
    expect(apiSource).toContain('createDeviceFolder:');
    expect(filesSource).toContain('handleCreateFolder');
  });

  test('file transfers survive closing the file manager and progress resumes on reopen', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/renderer/lib/fileTransferManager.ts'), 'utf-8');
    const filesSource = fs.readFileSync(path.join(root, 'src/renderer/components/FilesPanel.tsx'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    // 传输状态在模块单例里，进度订阅常驻，不随 FilesPanel 卸载消失
    expect(managerSource).toContain('export const startUpload');
    expect(managerSource).toContain('export const startPullFiles');
    expect(managerSource).toContain('export const subscribeTransfer');
    expect(managerSource).toContain('export const isTransferActive');
    // FilesPanel 改用管理器，不再持有本地上传/下载进度 setState
    expect(filesSource).toContain('subscribeTransfer');
    expect(filesSource).toContain('startUpload(');
    expect(filesSource).toContain('startPullFiles(');
    expect(filesSource).not.toContain('setUpload(');
    expect(filesSource).not.toContain('setPull(');
    // 关闭文件管理时若有传输进行中先确认
    expect(rendererSource).toContain('closeFileBrowser');
    expect(rendererSource).toContain('isTransferActive(fileBrowserDevice.id)');
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

  test('background device monitoring avoids heavy per-device adb probes', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const pollSource = managerSource.slice(managerSource.indexOf('private async pollDeviceChanges()'));

    expect(managerSource).toContain('private async getDeviceSummaries()');
    expect(pollSource).toContain('this.createDeviceSummarySnapshot(device)');
    expect(pollSource).toContain('const devices = await this.getDevices();');
    expect(pollSource.indexOf('const deviceSummaries = await this.getDeviceSummaries();')).toBeLessThan(
      pollSource.indexOf('const devices = await this.getDevices();')
    );
  });

  test('reboot treats expected adb transport disconnect as command sent', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');

    expect(managerSource).toContain("this.execAdbWithExitCode(['-s', deviceId, 'reboot']");
    expect(managerSource).toContain('isExpectedRebootDisconnect');
    expect(managerSource).toContain("output.includes('device not found')");
    expect(managerSource).toContain("output.includes('transport')");
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
    expect(managerSource).toContain('wifiLatencyCacheMs = 3000');
    expect(managerSource).toContain('refreshWifiLatencyForDevice');
    expect(managerSource).toContain('connectedWifiDevices');
    expect(managerSource).toContain('hasDeviceHealthChanged');
    expect(managerSource).toContain("this.execAdb(['-s', deviceId, 'get-state']");
    expect(managerSource).not.toContain('net.createConnection');
    expect(rendererSource).toContain('getWifiLatencyLabel');
    expect(rendererSource).toContain('延迟 ${device.latencyMs}ms');
    expect(rendererSource).toContain('连接不稳');
  });

  test('connected device health refreshes battery without full list changes', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');

    expect(managerSource).toContain('batteryLevelCache');
    expect(managerSource).toContain('batteryLevelCacheMs = 30000');
    expect(managerSource).toContain('refreshBatteryLevelForDevice');
    expect(managerSource).toContain("this.execAdb(['-s', deviceId, 'shell', 'dumpsys', 'battery']");
    expect(managerSource).toContain('hasDeviceHealthChanged');
    expect(managerSource).toContain('previousDevice?.batteryLevel !== device.batteryLevel');
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
    expect(picoSource).toContain('PxrMetric(?:\\(\\s*\\d+\\s*\\))?:\\s*(.*)$');
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
    expect(rendererSource).not.toContain('通用 Android Provider');
    expect(rendererSource).not.toContain('Pico Metrics 官方原始数据');
    expect(rendererSource).not.toContain('当前使用应用内置 ADB');
    expect(rendererSource).not.toContain('adbStatus: AdbStatus | null');
    expect(rendererSource).not.toContain('前台应用已检测到 XR Profiling Toolkit');
    expect(rendererSource).not.toContain('前台应用未检测到 XR Profiling Toolkit');
    expect(rendererSource).not.toContain('picoSupportMessage');
    expect(rendererSource).toContain('isLikelyPicoDevice');
    expect(rendererSource).toContain("identity.includes('a9210')");
    expect(rendererSource).toContain("identity.includes('sparrow')");
    expect(rendererSource).toContain("performance?.provider === 'pico' || (!performance && isLikelyPicoDevice(device))");
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
    const exportSource = fs.readFileSync(path.join(root, 'src/main/performanceSessionExport.ts'), 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');

    expect(managerSource).toContain('AdbScreenshotCapture');
    expect(managerSource).toContain('this.screenshotCapture.capture(deviceId)');
    expect(managerSource).not.toContain("'exec-out', 'screencap', '-p'");
    expect(fs.existsSync(path.join(root, 'src/main/adb/screenshotCapture.ts'))).toBe(true);
    const screenshotSource = fs.readFileSync(path.join(root, 'src/main/adb/screenshotCapture.ts'), 'utf-8');
    expect(screenshotSource).toContain("'adb-raw-framebuffer'");
    expect(screenshotSource).toContain("'adb-png-screencap'");
    expect(screenshotSource).toContain("['-s', deviceId, 'exec-out', 'screencap']");
    expect(screenshotSource).toContain("['-s', deviceId, 'exec-out', 'screencap', '-p']");
    expect(screenshotSource).toContain('decodeRawScreencap');
    expect(screenshotSource).toContain('convertRawPixelsToElectronBitmap');
    expect(managerSource).toContain('capturePerformanceSnapshot');
    expect(managerSource).toContain('currentMetrics?: PerformanceMetrics');
    expect(managerSource.indexOf('const screenState = await this.getScreenPowerState(deviceId)')).toBeLessThan(
      managerSource.indexOf('options.currentMetrics || await this.getPerformanceMetrics')
    );
    expect(managerSource).toContain("'dumpsys', 'power'");
    expect(managerSource).toContain('设备当前息屏，请先唤醒设备后再抓取性能快照。');
    expect(managerSource).not.toContain('screenshotSkippedReason');
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
    expect(snapshotStoreSource).toContain('nativeImage.createFromBitmap');
    expect(snapshotStoreSource).toContain('nativeImage.createFromBuffer');
    expect(snapshotStoreSource).not.toContain('SCREEN OFF - SCREENSHOT SKIPPED');
    expect(snapshotStoreSource).not.toContain('NO WAKEUP CAPTURE');
    expect(snapshotStoreSource).toContain('baseImage.crop');
    expect(snapshotStoreSource).toContain('buildSnapshotMetricLines');
    expect(snapshotStoreSource).toContain('CPU USAGE');
    expect(snapshotStoreSource).toContain('formatMemoryMb');
    expect(snapshotStoreSource).not.toContain("formatMetricValue(metrics.memoryUsage, 'KB')");
    expect(snapshotStoreSource).not.toContain('metrics.networkSpeed');
    expect(indexSource).toContain('CAPTURE_PERFORMANCE_SNAPSHOT');
    expect(indexSource).toContain('resolveRuntimeAppRoot(app)');
    expect(indexSource).not.toContain("app.getPath('userData')");
    expect(preloadSource).toContain('capturePerformanceSnapshot');
    expect(preloadSource).toContain('currentMetrics');
    expect(typeSource).toContain("trigger: 'manual' | 'fps_drop' | 'threshold'");
    expect(typeSource).toContain('screenshotPath?: string');
    expect(typeSource).not.toContain('screenshotSkippedReason?: string');
    expect(typeSource).not.toContain('networkSpeed: number');
    expect(rendererSource).toContain('抓取快照');
    expect(rendererSource).toContain('性能快照');
    expect(simpleAppSource).toContain('const deviceId = selectedDevice.id');
    expect(simpleAppSource).toContain('const currentPerformance = performanceByDeviceId[deviceId]');
    expect(simpleAppSource).not.toContain('请先开启当前设备的性能采集，再抓取性能快照。');
    expect(simpleAppSource).toContain('capturePerformanceSnapshot(deviceId, currentPerformance)');
    expect(simpleAppSource).toContain("id: `${deviceId}-${new Date(result.data!.capturedAt).getTime()}-snapshot`");
    expect(rendererSource).toContain('开启采集');
    expect(rendererSource).toContain('关闭采集');
    expect(rendererSource).toContain('本次采集报告');
    expect(rendererSource).toContain('hoveredSnapshotId');
    expect(rendererSource).toContain('hoverPoint');
    expect(rendererSource).toContain('getSampleValues');
    expect(rendererSource).toContain('updateHoverPoint');
    expect(rendererSource).toContain('previewSnapshot');
    expect(rendererSource).toContain('useEffect');
    expect(rendererSource).toContain("window.addEventListener('keydown', closeOnEscape)");
    expect(rendererSource).toContain('onClick');
    expect(rendererSource).toContain('点击查看大图');
    expect(rendererSource).toContain('性能快照大图预览');
    expect(rendererSource).toContain('snapshot-preview-');
    expect(rendererSource).toContain('关闭大图预览');
    expect(rendererSource).toContain("event.key === 'Escape'");
    expect(rendererSource).not.toContain('isPicoPreview');
    expect(simpleAppSource).toContain('visibleSessionSnapshots');
    expect(simpleAppSource).toContain('new Date(snapshot.capturedAt).getTime() >= sessionStartTime');
    expect(rendererSource).toContain('MEM MB');
    expect(rendererSource).toContain('GPU%');
    expect(rendererSource).toContain('memoryAxisMax');
    expect(rendererSource).not.toContain('networkSpeed');
    expect(rendererSource).toContain('导出报告');
    expect(simpleAppSource).toContain('performanceSamplesByDeviceId');
    expect(simpleAppSource).toContain('exportPerformanceSession');
    expect(exportSource).toContain('buildPerformanceSessionWorkbook');
    expect(exportSource).toContain('<?mso-application progid="Excel.Sheet"?>');
    expect(exportSource).toContain("worksheet('Summary'");
    expect(exportSource).toContain('Raw Data');
    expect(exportSource).toContain('GPU %');
    expect(exportSource).toContain('Pico Raw Line');
    expect(exportSource).toContain('Snapshots');
    expect(exportSource).not.toContain("worksheet('Chart Data'");
    expect(exportSource).not.toContain("worksheet('Pico Metrics'");
    expect(exportSource).not.toContain('buildPicoRows');
    expect(exportSource).not.toContain('NET KB/s');
    expect(exportSource).not.toContain('networkSpeed');
    expect(exportSource).toContain('snapshotMarkerForSample');
    expect(exportSource).toContain("'Time', 'FPS', 'CPU %', 'MEM MB', 'GPU %', 'MTP', 'FrmCpu', 'FrmGpu', 'ATWGPU'");
    expect(exportSource).toContain("'Provider', 'Package', 'Activity', 'Snapshot Marker', 'Pico Raw Line'");
    expect(exportSource.indexOf("'MEM MB'")).toBeLessThan(exportSource.indexOf("'GPU %'"));
    expect(channelSource).toContain('EXPORT_PERFORMANCE_SESSION');
    expect(rendererSource).toContain('性能采集已关闭。点击开启后才会获取当前设备的性能参数。');
    expect(rendererSource).not.toContain('screenshotSkippedReason');
    expect(rendererSource).toContain('CPU 占用率');
    expect(rendererSource).toContain('内存占用');
    expect(rendererSource).not.toContain("'GPU',\n        'GPU 使用率'");
    expect(rendererSource).toContain('formatMemoryMb');
    expect(rendererSource).not.toContain("'KB'");
    const picoMetricsSource = rendererSource.slice(
      rendererSource.indexOf('const renderPicoMetrics'),
      rendererSource.indexOf('const renderPicoFallbackMetrics')
    );
    expect(picoMetricsSource.indexOf('Pico 实时帧率')).toBeGreaterThanOrEqual(0);
    expect(picoMetricsSource.indexOf('CPU 占用率')).toBeGreaterThanOrEqual(0);
    expect(picoMetricsSource.indexOf('内存占用')).toBeGreaterThanOrEqual(0);
    expect(picoMetricsSource.indexOf('GPU 利用率')).toBeGreaterThanOrEqual(0);
    expect(picoMetricsSource.indexOf('Pico 实时帧率')).toBeLessThan(picoMetricsSource.indexOf('CPU 占用率'));
    expect(picoMetricsSource.indexOf('CPU 占用率')).toBeLessThan(picoMetricsSource.indexOf('内存占用'));
    expect(picoMetricsSource.indexOf('内存占用')).toBeLessThan(picoMetricsSource.indexOf('GPU 利用率'));
    expect(rendererSource).toContain("width: '200%'");
    expect(rendererSource).toContain("minWidth: '200%'");
    expect(rendererSource).toContain("objectPosition: 'left center'");
    expect(rendererSource).toContain("justifyContent: isPicoSnapshot ? 'flex-start' : 'center'");
    expect(rendererSource).toContain("justifyContent: 'center'");
    expect(simpleAppSource).toContain('setPerformanceSnapshots');
  });

  test('performance recording uses provider-specific screenrecord flow and surfaces recordings in renderer', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const recordingSource = fs.readFileSync(path.join(root, 'src/main/adb/performanceRecording.ts'), 'utf-8');
    const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/components/PerformancePanel.tsx'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const electronApiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');
    const mediaSource = fs.readFileSync(path.join(root, 'src/main/performanceMedia.ts'), 'utf-8');
    const packageSource = fs.readFileSync(path.join(root, 'package.json'), 'utf-8');

    expect(typeSource).toContain("export type PerformanceRecordingProvider = 'android-screenrecord' | 'pico-screenrecord' | 'pico-sdk'");
    expect(typeSource).toContain('export interface PerformanceRecordingOptions');
    expect(typeSource).toContain('export interface PerformanceRecording');
    expect(typeSource).toContain('videoRelativePath?: string');
    expect(typeSource).toContain('manifestRelativePath?: string');
    expect(typeSource).not.toContain('processedVideo: boolean');
    expect(typeSource).not.toContain('metricsBurnedIn: boolean');
    expect(typeSource).toContain('singleEyeVideo?: boolean');
    expect(typeSource).not.toContain('videoPath?: string');
    expect(typeSource).not.toContain('manifestPath?: string');
    expect(packageSource).not.toContain('"ffmpeg-static"');
    expect(packageSource).not.toContain('"to": "ffmpeg-static"');
    expect(channelSource).toContain("START_PERFORMANCE_RECORDING: 'adb:start-performance-recording'");
    expect(preloadSource).toContain('startPerformanceRecording');
    expect(electronApiSource).toContain('startPerformanceRecording: (deviceId: string, options: PerformanceRecordingOptions)');
    expect(indexSource).toContain('IPC_CHANNELS.START_PERFORMANCE_RECORDING');
    expect(indexSource).toContain('startPerformanceRecording(deviceId, resolveRuntimeAppRoot(app), options)');
    expect(indexSource).toContain('registerPerformanceMediaScheme();');
    expect(indexSource).toContain('registerPerformanceMediaProtocol(() => resolveRuntimeAppRoot(app))');
    expect(prodSource).toContain('IPC_CHANNELS.START_PERFORMANCE_RECORDING');
    expect(prodSource).toContain('registerPerformanceMediaScheme();');
    expect(prodSource).toContain('registerPerformanceMediaProtocol(() => resolveRuntimeAppRoot(app))');
    expect(mediaSource).toContain("export const PERFORMANCE_MEDIA_SCHEME = 'adm-media'");
    expect(mediaSource).toContain('registerPerformanceMediaScheme');
    expect(mediaSource).toContain('registerPerformanceMediaProtocol');
    expect(mediaSource).toContain("relativePath.startsWith('performance-recordings/')");
    expect(mediaSource).toContain('path.relative(recordingsRoot, resolvedPath)');
    expect(managerSource).toContain('PerformanceRecordingManager');
    expect(managerSource).toContain('isPico: this.isLikelyPicoDevice(deviceId)');
    expect(recordingSource).toContain("'screenrecord'");
    expect(recordingSource).toContain("'--time-limit'");
    expect(recordingSource).toContain("'--bit-rate'");
    expect(recordingSource).toContain("'pull'");
    expect(recordingSource).toContain("'performance-recordings'");
    expect(recordingSource).toContain("'pico-screenrecord'");
    expect(recordingSource).toContain("'android-screenrecord'");
    expect(recordingSource).toContain('writeManifest');
    expect(recordingSource).toContain('collectSamples');
    expect(recordingSource).toContain('signal.cancelled = true');
    expect(recordingSource).toContain('toPortablePath');
    expect(recordingSource).toContain('videoRelativePath,');
    expect(recordingSource).toContain('manifestRelativePath,');
    expect(recordingSource).toContain("['-s', input.deviceId, 'pull', remotePath, videoPath]");
    expect(recordingSource).not.toContain('processPerformanceRecordingVideo');
    expect(recordingSource).not.toContain('rawVideoFileName');
    expect(recordingSource).not.toContain('subtitleFileName');
    expect(recordingSource).not.toContain('cropToSingleEye: input.isPico');
    expect(recordingSource).not.toContain('metricsBurnedIn: true');
    expect(recordingSource).not.toContain('singleEyeVideo: input.isPico');
    expect(recordingSource).toContain('cleanupRemoteRecording');
    expect(recordingSource).toContain("'pkill', '-2', 'screenrecord'");
    expect(recordingSource).toContain("'killall', '-2', 'screenrecord'");
    expect(simpleAppSource).toContain('performanceRecordings');
    expect(simpleAppSource).toContain('recordingDeviceIds');
    expect(simpleAppSource).toContain('startPerformanceRecording');
    expect(simpleAppSource).toContain('bitRateMbps: 8');
    expect(simpleAppSource).not.toContain('请先开启当前设备的性能采集，再抓取性能快照。');
    expect(simpleAppSource).toContain('capturePerformanceSnapshot(deviceId, currentPerformance)');
    expect(simpleAppSource).toContain("id: `${deviceId}-${new Date(result.data!.capturedAt).getTime()}-snapshot`");
    expect(rendererSource).toContain('onStartRecording');
    expect(rendererSource).toContain('recordings');
    expect(rendererSource).toContain('Pico SDK');
    expect(rendererSource).toContain('Pico screenrecord');
    expect(rendererSource).toContain('Android screenrecord');
    expect(rendererSource).toContain('buildRecordingMediaUrl');
    expect(rendererSource).toContain('adm-media://');
    expect(rendererSource).toContain('videoRelativePath');
    expect(rendererSource).toContain('manifestRelativePath');
    expect(rendererSource).toContain('previewRecording');
    expect(rendererSource).toContain('recordingPlaybackTime');
    expect(rendererSource).toContain('findRecordingSampleAt');
    expect(rendererSource).toContain('renderRecordingMetricOverlay');
    expect(rendererSource).toContain('onTimeUpdate');
    expect(rendererSource).toContain('setPreviewRecording(recording)');
    expect(rendererSource).toContain('shouldCropRecordingInTool');
    expect(rendererSource).not.toContain('shouldOverlayRecordingMetricsInTool');
    expect(rendererSource).toContain("return isPicoRecording(recording) && !recording.singleEyeVideo");
    expect(rendererSource).not.toContain('recording.metricsBurnedIn');
    expect(rendererSource).toContain("style={getRecordingVideoStyle(shouldCropVideo, 'cover')}");
    expect(rendererSource).toContain("getRecordingVideoStyle(false, 'contain')");
    expect(rendererSource).toContain('{renderRecordingMetricOverlay(firstSample, true)}');
    expect(rendererSource).toContain('{renderRecordingMetricOverlay(previewRecordingSample)}');
    expect(rendererSource).toContain('disabled={isCapturingSnapshot}');
    expect(rendererSource).not.toContain('disabled={isCapturingSnapshot || !performance}');
    expect(rendererSource).toContain('性能录制播放预览');
    expect(rendererSource).toContain('关闭录制播放');
    expect(rendererSource).not.toContain('recording.videoPath &&');
    expect(rendererSource).not.toContain('recording.manifestPath &&');
    const snapshotSectionIndex = rendererSource.indexOf('>性能快照</div>');
    const recordingSectionIndex = rendererSource.indexOf('>性能录制</div>');
    expect(snapshotSectionIndex).toBeGreaterThanOrEqual(0);
    expect(recordingSectionIndex).toBeGreaterThanOrEqual(0);
    expect(snapshotSectionIndex).toBeLessThan(recordingSectionIndex);
  });

  test('network tab does not auto-trigger capture or show loading as an error toast', () => {
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(rendererSource).not.toContain("if (selectedDevice && activeTab === 'network') {\r\n      loadNetworkRequests();");
    expect(rendererSource).not.toContain("\\u6b63\\u5728\\u6293\\u53d6 HTTP \\u8bf7\\u6c42...");
  });

  test('mirror feature bundles scrcpy, spawns it with bundled adb, and reclaims child processes', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
    const prepareSource = fs.readFileSync(path.join(root, 'scripts/prepare-scrcpy.js'), 'utf-8');
    const binarySource = fs.readFileSync(path.join(root, 'src/main/scrcpy/scrcpyBinary.ts'), 'utf-8');
    const managerSource = fs.readFileSync(path.join(root, 'src/main/scrcpy/scrcpyManager.ts'), 'utf-8');
    const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const electronApiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');
    const mirrorPanelSource = fs.readFileSync(path.join(root, 'src/renderer/components/MirrorPanel.tsx'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    // 打包接线
    expect(pkg.scripts['scrcpy:prepare']).toContain('prepare-scrcpy.js');
    expect(pkg.scripts.pack).toContain('scrcpy:prepare');
    expect(pkg.scripts.dist).toContain('scrcpy:prepare');
    expect(pkg.build.extraResources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'vendor/scrcpy', to: 'scrcpy' }),
      ])
    );
    expect(prepareSource).toContain('scrcpy-win64');
    expect(binarySource).toContain('resolveBundledScrcpyBinaryPath');

    // scrcpy 复用内置 adb + 进程生命周期
    expect(managerSource).toContain('resolveBundledScrcpyBinaryPath');
    expect(managerSource).toContain('resolveBundledAdbBinaryPath');
    expect(managerSource).toContain('ADB: adbPath');
    expect(managerSource).toContain("['-s', deviceId, '--window-title', windowTitle, '--no-mouse-hover']");
    expect(managerSource).toContain('stopAll');
    expect(managerSource).toContain("child.on('exit'");

    // IPC 链路 + 退出回收
    expect(channelSource).toContain("MIRROR_START: 'mirror:start'");
    expect(channelSource).toContain("MIRROR_STATUS: 'mirror:status'");
    expect(preloadSource).toContain('startMirror');
    expect(preloadSource).toContain("ipcRenderer.on('mirror:status'");
    expect(electronApiSource).toContain('startMirror');
    expect(electronApiSource).toContain('onMirrorStatus');
    for (const source of [indexSource, prodSource]) {
      expect(source).toContain('IPC_CHANNELS.MIRROR_START');
      expect(source).toContain('scrcpyManager.stopAll()');
      expect(source).toContain('scrcpyManager.onStatus');
    }

    // 渲染层入口
    expect(mirrorPanelSource).toContain('开始投屏');
    expect(mirrorPanelSource).toContain('停止投屏');
    expect(simpleAppSource).toContain('handleStartMirror');
    expect(simpleAppSource).toContain('onMirrorStatus');
    expect(simpleAppSource).toContain("{ key: 'mirror' as TabType");
  });

  test('mirror supports launch params, Pico single-eye crop and shortcut cheatsheet', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/scrcpy/scrcpyManager.ts'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');
    const mirrorPanelSource = fs.readFileSync(path.join(root, 'src/renderer/components/MirrorPanel.tsx'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    // 启动参数拼装 + Pico 单眼裁切
    expect(managerSource).toContain("'--max-size'");
    expect(managerSource).toContain("'--video-bit-rate'");
    expect(managerSource).toContain("'--crop'");
    expect(managerSource).toContain('computePicoSingleEyeCrop');
    expect(managerSource).toContain('--no-mouse-hover');
    expect(managerSource).toContain("'shell', 'wm', 'size'");
    expect(managerSource).toContain('options.isPico');
    expect(managerSource).toContain('${halfWidth}:${height}:0:0');

    // 类型扩展
    expect(typeSource).toContain('isPico?: boolean');
    expect(typeSource).toContain('crop?: string');
    expect(typeSource).toContain('maxSize?: number');
    expect(typeSource).toContain('bitRate?: string');

    // 参数 UI + 快捷键速查 + Pico 边界提示
    expect(mirrorPanelSource).toContain('分辨率上限');
    expect(mirrorPanelSource).toContain('码率');
    expect(mirrorPanelSource).toContain('快捷键速查');
    expect(mirrorPanelSource).toContain('Alt + h');
    expect(mirrorPanelSource).toContain('6DoF 手柄无法操控');
    expect(mirrorPanelSource).toContain('单眼显示');

    // 渲染层 Pico 检测与传参
    expect(simpleAppSource).toContain('isLikelyPicoDevice');
    expect(simpleAppSource).toContain('isPico: isLikelyPicoDevice(selectedDevice)');
  });

  test('uninstall app flow goes through adb uninstall with confirm and process refresh', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const electronApiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(managerSource).toContain('async uninstallApp(deviceId: string, packageName: string)');
    expect(managerSource).toContain("['-s', deviceId, 'uninstall', cleanedPackage]");
    expect(managerSource).toContain('async listInstalledPackages(deviceId: string)');
    expect(managerSource).toContain("['-s', deviceId, 'shell', 'pm', 'list', 'packages', '-3']");
    expect(managerSource).toContain('async launchApp(deviceId: string, packageName: string)');
    expect(managerSource).toContain("'monkey', '-p', cleanedPackage");
    expect(managerSource).toContain('async forceStopApp(deviceId: string, packageName: string)');
    expect(managerSource).toContain("['-s', deviceId, 'shell', 'am', 'force-stop', cleanedPackage]");
    expect(channelSource).toContain("LAUNCH_APP: 'adb:launch-app'");
    expect(channelSource).toContain("FORCE_STOP_APP: 'adb:force-stop-app'");
    expect(preloadSource).toContain('launchApp');
    expect(preloadSource).toContain('forceStopApp');
    expect(electronApiSource).toContain('launchApp');
    expect(electronApiSource).toContain('forceStopApp');
    for (const source of [indexSource, prodSource]) {
      expect(source).toContain('IPC_CHANNELS.LAUNCH_APP');
      expect(source).toContain('IPC_CHANNELS.FORCE_STOP_APP');
      expect(source).toContain('adbManager.launchApp(deviceId, packageName)');
      expect(source).toContain('adbManager.forceStopApp(deviceId, packageName)');
    }
    expect(simpleAppSource).toContain('handleLaunchApp');
    expect(simpleAppSource).toContain('handleForceStopApp');
    expect(channelSource).toContain("UNINSTALL_APP: 'adb:uninstall-app'");
    expect(channelSource).toContain("LIST_INSTALLED_PACKAGES: 'adb:list-installed-packages'");
    expect(preloadSource).toContain('uninstallApp');
    expect(preloadSource).toContain('listInstalledPackages');
    expect(electronApiSource).toContain('uninstallApp');
    expect(electronApiSource).toContain('listInstalledPackages');
    for (const source of [indexSource, prodSource]) {
      expect(source).toContain('IPC_CHANNELS.UNINSTALL_APP');
      expect(source).toContain('adbManager.uninstallApp(deviceId, packageName)');
      expect(source).toContain('IPC_CHANNELS.LIST_INSTALLED_PACKAGES');
      expect(source).toContain('adbManager.listInstalledPackages(deviceId)');
    }
    expect(simpleAppSource).toContain('handleUninstallApp');
    expect(simpleAppSource).toContain('window.confirm');
    expect(simpleAppSource).toContain('uninstallApp(selectedDevice.id, packageName)');
    expect(simpleAppSource).toContain('loadInstalledPackages');
    expect(simpleAppSource).toContain('已安装应用');
  });

  test('unified install panel installs to one or many devices with per-device progress and concurrency', () => {
    expect(fs.existsSync(path.join(root, 'src/renderer/components/BatchInstallPanel.tsx'))).toBe(false);
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const electronApiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    // 安装模式（-r / -r -d）
    expect(managerSource).toContain("options?.allowDowngrade ? ['-r', '-d'] : ['-r']");
    expect(managerSource).toContain('async installApk(deviceId: string, apkPath: string, options?: { allowDowngrade?: boolean })');
    expect(preloadSource).toContain('installApk: (deviceId, apkPath, options)');
    expect(electronApiSource).toContain('options?: { allowDowngrade?: boolean }');

    // 统一安装面板：单/多设备 + 并发 + 每台队列进度条
    expect(simpleAppSource).toContain('renderUnifiedInstallPanel');
    expect(simpleAppSource).toContain('startUnifiedInstall');
    expect(simpleAppSource).toContain('installItemsOnDevice');
    expect(simpleAppSource).toContain('const limit = installConcurrency > 0 ? installConcurrency : targetIds.length');
    expect(simpleAppSource).toContain('installApk(deviceId, item.path, { allowDowngrade: installAllowDowngrade })');
    expect(simpleAppSource).toContain('pendingApks');
    expect(simpleAppSource).toContain('installTargets');
    expect(simpleAppSource).toContain('retryDeviceInstall');
    expect(simpleAppSource).toContain('应用安装');
    expect(simpleAppSource).toContain('目标设备');
    // 安装目标默认不勾选，由用户手动选择或全选
    expect(simpleAppSource).toContain("const [installTargets, setInstallTargets] = useState<Set<string>>(new Set())");
    expect(simpleAppSource).not.toContain('prev.size === 0 ? new Set([selectedDevice.id]) : prev');
  });
});
