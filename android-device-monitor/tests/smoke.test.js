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
    // 自动生成更新说明：releaseInfo 指向 release-notes.md，打包脚本调用生成器
    expect(pkg.build.releaseInfo).toBeDefined();
    expect(pkg.build.releaseInfo.releaseNotesFile).toBe('release-notes.md');
    expect(updatePackPs1).toContain('gen-release-notes.js');
    expect(updatePackBat).toContain('make-update-package.ps1');
    // 更新服务器脚本支持 Range（差量下载需要）
    expect(pkg.scripts['serve:updates']).toContain('serve-updates.js');
    expect(serveSource).toContain('206');
    expect(serveSource).toContain('Content-Range');
  });

  test('full log recorder captures all entries to disk and is exportable', () => {
    const recorder = fs.readFileSync(path.join(root, 'src/main/fullLogRecorder.ts'), 'utf-8');
    const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const channels = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const preload = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    // 落盘到 exe 所在目录的 device-logs（打包=安装目录/开发=项目根），不可写时回退 userData；流式写入
    expect(recorder).toContain('resolveRuntimeAppRoot');
    expect(recorder).toContain("'device-logs'");
    expect(recorder).toContain("app.getPath('userData')"); // 兜底
    expect(recorder).toContain('createWriteStream');
    expect(recorder).toContain('export const getPath');
    // 在 logcat 回调里先于渲染层队列写盘，保证不丢
    expect(indexSource).toContain('fullLogRecorder.write(deviceId, entry)');
    expect(indexSource).toContain('fullLogRecorder.start(deviceId)');
    expect(indexSource).toContain('fullLogRecorder.stopAll()');
    // IPC 契约：导出完整日志通道齐全
    expect(channels).toContain("EXPORT_FULL_LOGS: 'log:export-full'");
    expect(preload).toContain('exportFullLogs');
    // 按包名导出完整日志：事后在落盘文件上切一份，通道与落盘的切分函数齐全
    expect(channels).toContain("EXPORT_FULL_LOGS_BY_PACKAGE: 'log:export-full-by-package'");
    expect(preload).toContain('exportFullLogsByPackage');
    expect(recorder).toContain('export const exportByPackage');
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

  test('renderer avoids unbounded pending log and capture sample backlog', () => {
    const source = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    expect(source).toContain('MAX_PENDING_LOG_BUFFER');
    // 采样改由主进程编排并经 onCaptureSample 推送，渲染层不再自行轮询 getPerformance。
    expect(source).not.toContain('performanceRequestInFlightRef');
    expect(source).toContain('onCaptureSample');
    // 实时样本累积有上限，防长采集内存膨胀。
    expect(source).toContain('.slice(-7200)');
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
    // 健康轮询遍历全部已连接设备（屏幕状态 USB/WiFi 都刷），WiFi 延迟/电量仍按 connectionType 仅 WiFi 刷
    expect(managerSource).toContain('connectedDevices');
    expect(managerSource).toContain("refreshed.connectionType === 'wifi'");
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

  test('device card surfaces screen on/off state', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const inspectorSource = fs.readFileSync(path.join(root, 'src/main/adb/runtimeInspector.ts'), 'utf-8');
    const rendererSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');

    // 类型 + 多版本解析 + 带缓存采集 + 健康轮询纳入变更判断 + 动作后失效缓存 + 卡片徽标
    expect(typeSource).toContain("screenState?: 'on' | 'off' | 'unknown'");
    expect(inspectorSource).toContain('async getScreenState(deviceId: string)');
    expect(inspectorSource).toContain('mWakefulness=');
    expect(managerSource).toContain('refreshScreenStateForDevice');
    expect(managerSource).toContain('screenStateCacheMs = 3000');
    expect(managerSource).toContain('previousDevice?.screenState !== device.screenState');
    expect(managerSource).toContain('this.screenStateCache.delete(deviceId)');
    expect(rendererSource).toContain('renderScreenStateBadge');
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

  test('legacy short performance recording path is fully retired (engine/IPC/types/UI)', () => {
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const panelSource = fs.readFileSync(path.join(root, 'src/renderer/components/PerformancePanel.tsx'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const electronApiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');
    const packageSource = fs.readFileSync(path.join(root, 'package.json'), 'utf-8');

    // 旧短录制引擎文件已删除
    expect(fs.existsSync(path.join(root, 'src/main/adb/performanceRecording.ts'))).toBe(false);
    // 旧类型已移除
    expect(typeSource).not.toContain('export interface PerformanceRecording ');
    expect(typeSource).not.toContain('PerformanceRecordingOptions');
    expect(typeSource).not.toContain('PerformanceRecordingProvider');
    expect(typeSource).not.toContain('PerformanceRecordingStatus');
    // 旧 IPC 通道 / handler / 桥接已移除
    expect(channelSource).not.toContain('START_PERFORMANCE_RECORDING');
    expect(indexSource).not.toContain('START_PERFORMANCE_RECORDING');
    expect(prodSource).not.toContain('START_PERFORMANCE_RECORDING');
    expect(preloadSource).not.toContain('startPerformanceRecording');
    expect(electronApiSource).not.toContain('startPerformanceRecording');
    // 引擎与管理器已退役
    expect(managerSource).not.toContain('PerformanceRecordingManager');
    expect(managerSource).not.toContain('startPerformanceRecording');
    // 渲染层旧短录制状态 / 控件已退役
    expect(simpleAppSource).not.toContain('performanceRecordings');
    expect(simpleAppSource).not.toContain('recordingDeviceIds');
    expect(simpleAppSource).not.toContain('startPerformanceRecording');
    expect(panelSource).not.toContain('onStartRecording');
    expect(panelSource).not.toContain('buildRecordingMediaUrl');
    expect(panelSource).not.toContain('previewRecording');
    expect(panelSource).not.toContain('性能录制');
    expect(panelSource).not.toContain('s 录制');
    // 性能快照（14.1 已移除）仍不得回流
    expect(simpleAppSource).not.toContain('capturePerformanceSnapshot');
    expect(panelSource).not.toContain('>性能快照</div>');
    // 不引入 ffmpeg（持续录制不做本机转码）
    expect(packageSource).not.toContain('"ffmpeg-static"');
    expect(packageSource).not.toContain('"to": "ffmpeg-static"');
    // 导出会话能力保留
    expect(channelSource).toContain('EXPORT_PERFORMANCE_SESSION');
    expect(electronApiSource).toContain('exportPerformanceSession');
  });

  test('capture report UI: single capture switch, curve fill, merged video, timeline sync, soft-limit', () => {
    const panelSource = fs.readFileSync(path.join(root, 'src/renderer/components/PerformancePanel.tsx'), 'utf-8');
    const reportSource = fs.readFileSync(path.join(root, 'src/renderer/components/CaptureReport.tsx'), 'utf-8');
    const chartSource = fs.readFileSync(path.join(root, 'src/renderer/components/CaptureChart.tsx'), 'utf-8');
    const formatSource = fs.readFileSync(path.join(root, 'src/renderer/components/perfFormat.ts'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(fs.existsSync(path.join(root, 'src/renderer/components/CaptureReport.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/renderer/components/CaptureChart.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/renderer/components/perfFormat.ts'))).toBe(true);

    // 顶部单一采集开关 + 软上限提示 + 报告挂载
    expect(panelSource).toContain('开始采集');
    expect(panelSource).toContain('关闭采集');
    expect(panelSource).toContain('onToggleCapture');
    expect(panelSource).toContain('softLimitNotice');
    expect(panelSource).toContain('<CaptureReport');
    expect(panelSource).toContain('导出报告');

    // 报告：分段缝合连续时间轴 + 视频 seek 映射 + 反向驱动 + 单眼裁切 + 可拖时间轴
    expect(reportSource).toContain('buildSegmentMediaUrl');
    expect(reportSource).toContain('findSegmentIndex');
    expect(reportSource).toContain('seekTo');
    expect(reportSource).toContain('pendingSeekOffsetRef');
    expect(reportSource).toContain('activeSegmentIndex');
    expect(reportSource).toContain('onTimeUpdate');
    expect(reportSource).toContain('onEnded');
    expect(reportSource).toContain('shouldCropCaptureVideo');
    expect(reportSource).toContain('type="range"');
    expect(reportSource).toContain('录制中');

    // 曲线：时间轴 x 轴 + 面积填充 + 图例多选/隔离 + 波峰波谷 + 播放头
    expect(chartSource).toContain('selectedSeriesKeys');
    expect(chartSource).toContain('onToggleSeries');
    expect(chartSource).toContain('showPlayhead');
    expect(chartSource).toContain('-peak');
    expect(chartSource).toContain('-valley');
    expect(chartSource).toContain('-area');
    expect(chartSource).toContain('xForMs');

    // 共享格式化：分段媒体 URL + 单眼裁切判定 + 连续轴总时长
    expect(formatSource).toContain('buildSegmentMediaUrl');
    expect(formatSource).toContain('shouldCropCaptureVideo');
    expect(formatSource).toContain('captureTotalMs');
    expect(formatSource).toContain('adm-media://');

    // SimpleApp 接线新采集会话流
    expect(simpleAppSource).toContain('toggleCaptureSession');
    expect(simpleAppSource).toContain('startCaptureSession');
    expect(simpleAppSource).toContain('stopCaptureSession');
    expect(simpleAppSource).toContain('onCaptureSample');
    expect(simpleAppSource).toContain('onCaptureSizeLimit');
    expect(simpleAppSource).toContain('activeCaptureByDeviceId');
    expect(simpleAppSource).toContain('loadedReport'); // 停止后/回看加载的报告会话（14.7 统一取代 per-device 报告态）
    // 关闭采集走统一确认弹窗二次确认（开始采集不拦）
    expect(simpleAppSource).toContain('runCaptureToggle');
    expect(simpleAppSource).toContain('确定关闭采集吗');
  });

  test('capture filter marks AND-combined hits, persists markers, and jumps+pauses on marker click', () => {
    const formatSource = fs.readFileSync(path.join(root, 'src/renderer/components/perfFormat.ts'), 'utf-8');
    const filterSource = fs.readFileSync(path.join(root, 'src/renderer/components/CaptureFilterPanel.tsx'), 'utf-8');
    const chartSource = fs.readFileSync(path.join(root, 'src/renderer/components/CaptureChart.tsx'), 'utf-8');
    const reportSource = fs.readFileSync(path.join(root, 'src/renderer/components/CaptureReport.tsx'), 'utf-8');
    const panelSource = fs.readFileSync(path.join(root, 'src/renderer/components/PerformancePanel.tsx'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');

    expect(fs.existsSync(path.join(root, 'src/renderer/components/CaptureFilterPanel.tsx'))).toBe(true);

    // 求值与标记计算：指标取值 + 运算符 + 逐点求值 + AND 交集
    expect(formatSource).toContain('metricValueOf');
    expect(formatSource).toContain('evalCondition');
    expect(formatSource).toContain('computeMarkers');
    expect(formatSource).toContain('andHitTimes'); // AND 组合 = 各条件命中点交集
    expect(formatSource).toContain("case '>'");
    expect(formatSource).toContain("case '<'");
    expect(formatSource).toContain("case '='");

    // 过滤面板：指标/运算符/阈值 + 多条件 + GPU 仅 Pico + AND 说明
    expect(filterSource).toContain('添加条件');
    expect(filterSource).toContain('过滤');
    expect(filterSource).toContain('清除');
    expect(filterSource).toContain('AND');
    expect(filterSource).toContain("['fps', 'cpu', 'mem', 'gpu']"); // Pico
    expect(filterSource).toContain("['fps', 'cpu', 'mem']"); // 非 Pico 无 GPU
    // 阈值输入可留空/删空（默认 NaN 而非删不掉的 0），求值时跳过未填阈值的条件
    expect(filterSource).toContain('threshold: NaN');
    expect(filterSource).toContain("e.target.value === '' ? NaN : Number(e.target.value)");
    expect(formatSource).toContain('conditions.filter((condition) => Number.isFinite(condition.threshold))');

    // 曲线命中标记（独立样式）+ 点击回调
    expect(chartSource).toContain('markerHits');
    expect(chartSource).toContain('onMarkerClick');
    expect(chartSource).toContain('#fbbf24'); // 琥珀色，区别波峰波谷

    // 报告：应用过滤→持久化、清除、命中点击 seek+暂停
    expect(reportSource).toContain('computeMarkers');
    expect(reportSource).toContain('onSaveMarkers');
    expect(reportSource).toContain('seekAndPause');
    expect(reportSource).toContain('<CaptureFilterPanel');
    expect(reportSource).toContain('.pause()'); // 命中跳转时暂停视频
    // 防回归：hitTimes 的 useMemo 必须在 `if (!session)` early return 之前，
    // 否则 session 由 null↔非 null 切换时 hook 数量变化 → "Rendered more hooks than previous"。
    const memoIdx = reportSource.indexOf('useMemo(() => andHitTimes');
    const earlyReturnIdx = reportSource.indexOf('if (!session)');
    expect(memoIdx).toBeGreaterThan(-1);
    expect(earlyReturnIdx).toBeGreaterThan(-1);
    expect(memoIdx).toBeLessThan(earlyReturnIdx);

    // 接线：面板透传 + SimpleApp 持久化
    expect(panelSource).toContain('onSaveCaptureMarkers');
    expect(simpleAppSource).toContain('saveCaptureMarkers');
  });

  test('capture history list loads/renames/deletes sessions and report supports quick screenshot archiving', () => {
    const historySource = fs.readFileSync(path.join(root, 'src/renderer/components/CaptureHistoryList.tsx'), 'utf-8');
    const reportSource = fs.readFileSync(path.join(root, 'src/renderer/components/CaptureReport.tsx'), 'utf-8');
    const helperSource = fs.readFileSync(path.join(root, 'src/renderer/components/captureReportHelpers.tsx'), 'utf-8');
    const panelSource = fs.readFileSync(path.join(root, 'src/renderer/components/PerformancePanel.tsx'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const mediaSource = fs.readFileSync(path.join(root, 'src/main/performanceMedia.ts'), 'utf-8');

    expect(fs.existsSync(path.join(root, 'src/renderer/components/CaptureHistoryList.tsx'))).toBe(true);

    // 回看列表：SN+本地时间+时长、双击改名、删除行内二次确认、空状态
    expect(historySource).toContain('formatLocalDateTime');
    expect(historySource).toContain('formatDuration');
    expect(historySource).toContain('onDoubleClick');
    expect(historySource).toContain('confirmingDeleteId');
    expect(historySource).toContain('确认删除');
    expect(historySource).toContain('还没有采集记录'); // 空状态

    // SimpleApp 接线：列表/加载/改名/删除/截图 + 进性能页刷新
    expect(simpleAppSource).toContain('listCaptureSessions');
    expect(simpleAppSource).toContain('loadCaptureSession');
    expect(simpleAppSource).toContain('renameCaptureSession');
    expect(simpleAppSource).toContain('deleteCaptureSession');
    expect(simpleAppSource).toContain('saveCaptureFrame');
    expect(simpleAppSource).toContain('refreshCaptureSessions');
    expect(simpleAppSource).toContain('loadedReport');
    // 旧的 per-device 报告态已被统一的 loadedReport 取代
    expect(simpleAppSource).not.toContain('reportSessionByDeviceId');

    // 视频快捷截图：离屏 crossOrigin video 抓帧 + canvas toDataURL + 不弹系统保存框
    expect(helperSource).toContain('captureSegmentFrame');
    expect(helperSource).toContain("crossOrigin = 'anonymous'");
    expect(helperSource).toContain('toDataURL');
    expect(reportSource).toContain('handleCaptureFrame');
    expect(reportSource).toContain('onSaveFrame');
    expect(panelSource).toContain('onSaveCaptureFrame');
    // 媒体协议开 CORS，保证离屏抓帧 canvas 不被污染
    expect(mediaSource).toContain('corsEnabled: true');

    // 面板挂载回看列表
    expect(panelSource).toContain('<CaptureHistoryList');
    expect(panelSource).toContain('onSelectCaptureSession');
  });

  test('continuous capture recorder segments at 180s, finalizes via SIGINT and pulls each segment', () => {
    const recorderPath = path.join(root, 'src/main/adb/captureRecorder.ts');
    expect(fs.existsSync(recorderPath)).toBe(true);
    const recorderSource = fs.readFileSync(recorderPath, 'utf-8');

    // 持续分段：单段 180s 上限、按序号命名、逐段 pull 落盘并删除设备端临时文件
    expect(recorderSource).toContain('MAX_SEGMENT_SECONDS = 180');
    expect(recorderSource).toContain("'--time-limit', String(MAX_SEGMENT_SECONDS)");
    expect(recorderSource).toContain('seg-${index}.mp4');
    expect(recorderSource).toContain("'-s', input.deviceId, 'pull', remotePath, localPath");
    expect(recorderSource).toContain("'shell', 'rm', '-f', remotePath");
    // 停止：SIGINT(pkill -2) 让设备端 finalize 当前段，而非丢弃
    expect(recorderSource).toContain("'pkill', '-2', 'screenrecord'");
    expect(recorderSource).toContain('signalScreenrecordStop');
    // 上一段 pull 与下一段录制重叠，缩短接缝
    expect(recorderSource).toContain('pullJobs');
    expect(recorderSource).toContain('onSegment');
    expect(recorderSource).toContain('startMs');
    expect(recorderSource).toContain('endMs');
    // 累计体积上报（软上限）
    expect(recorderSource).toContain('onSizeBytes');
    // 空段（被打断未写出有效内容）不上报
    expect(recorderSource).toContain('if (sizeBytes <= 0)');
    expect(recorderSource).toContain('class PerformanceCaptureRecorder');
    expect(recorderSource).toContain('isRecording(deviceId: string): boolean');
    // 首段探测：设备端 screenrecord 瞬间失败时 start 抛错（不再静默吞掉 stderr）
    expect(recorderSource).toContain('assertSegmentAlive');
    expect(recorderSource).not.toContain("stdio: 'ignore'");
    // stop 期间二次检查，避免 stop 后产生幽灵段
    expect(recorderSource).toContain('if (state.stopRequested)');
    // 不在录制阶段做单眼裁切（播放时裁切）
    expect(recorderSource).not.toContain('--crop');
    // 首段失败文案：锁屏/熄屏(Encoder failed err=-38)给出「解锁手机屏幕」可操作指引
    expect(recorderSource).toContain('describeSegmentFailure');
    expect(recorderSource).toContain('err=-38');
    expect(recorderSource).toContain('请先解锁手机屏幕');
  });

  test('capture session store archives video/data/screenshots separately under tool root', () => {
    const storePath = path.join(root, 'src/main/performanceCaptureStore.ts');
    expect(fs.existsSync(storePath)).toBe(true);
    const storeSource = fs.readFileSync(storePath, 'utf-8');
    const typeSource = fs.readFileSync(path.join(root, 'src/shared/types/index.ts'), 'utf-8');
    const mediaSource = fs.readFileSync(path.join(root, 'src/main/performanceMedia.ts'), 'utf-8');

    // 会话类型
    expect(typeSource).toContain('interface PerformanceCaptureSession');
    expect(typeSource).toContain('interface PerformanceCaptureSegment');
    expect(typeSource).toContain('interface PerformanceCaptureMarker');
    expect(typeSource).toContain('interface PerformanceCaptureSessionDetail');
    expect(typeSource).toContain('deviceSn: string');
    expect(typeSource).toContain('videoSegments: PerformanceCaptureSegment[]');

    // 目录结构：根目录锚点 + video/data/screenshots 分离
    expect(storeSource).toContain("CAPTURES_DIR = 'performance-captures'");
    expect(storeSource).toContain('resolveAppRoot');
    expect(storeSource).not.toContain("app.getPath('userData')");
    expect(storeSource).toContain("'video'");
    expect(storeSource).toContain("'data'");
    expect(storeSource).toContain("'screenshots'");
    // 流式落盘 jsonl（防崩溃），manifest，标记
    expect(storeSource).toContain("SAMPLES_FILE = 'samples.jsonl'");
    expect(storeSource).toContain('appendSamples');
    expect(storeSource).toContain('fs.appendFile');
    expect(storeSource).toContain('MANIFEST_FILE');
    // 生命周期与回看
    expect(storeSource).toContain('createSession');
    expect(storeSource).toContain('appendSegment');
    expect(storeSource).toContain('finalizeSession');
    expect(storeSource).toContain('listSessions');
    expect(storeSource).toContain('loadSession');
    expect(storeSource).toContain('renameSession');
    expect(storeSource).toContain('saveMarkers');
    // 删除：递归删整个会话文件夹
    expect(storeSource).toContain('deleteSession');
    expect(storeSource).toContain('recursive: true, force: true');
    // manifest 读改写串行化，防并发丢更新
    expect(storeSource).toContain('mutateManifest');
    // sessionId 路径穿越校验（14.4 经 IPC 暴露后即外部可控）
    expect(storeSource).toContain('非法的采集会话 ID');
    expect(storeSource).toContain('path.relative(root, resolved)');
    // 媒体协议放行新会话目录
    expect(mediaSource).toContain('performance-captures');
    expect(mediaSource).toContain('performance-recordings');
  });

  test('capture session IPC contract and orchestration wired across main/preload/renderer', () => {
    const controllerPath = path.join(root, 'src/main/performanceCaptureController.ts');
    expect(fs.existsSync(controllerPath)).toBe(true);
    const controllerSource = fs.readFileSync(controllerPath, 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const indexSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf-8');
    const prodSource = fs.readFileSync(path.join(root, 'src/main/index-prod.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const electronApiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');

    // 通道常量
    const channels = [
      'START_CAPTURE_SESSION', 'STOP_CAPTURE_SESSION', 'LIST_CAPTURE_SESSIONS', 'LOAD_CAPTURE_SESSION',
      'DELETE_CAPTURE_SESSION', 'RENAME_CAPTURE_SESSION', 'SAVE_CAPTURE_MARKERS', 'SAVE_CAPTURE_FRAME',
      'CAPTURE_SAMPLE', 'CAPTURE_SIZE_LIMIT',
    ];
    channels.forEach((ch) => expect(channelSource).toContain(`${ch}:`));

    // ADBManager 暴露采集录制方法
    expect(managerSource).toContain('PerformanceCaptureRecorder');
    expect(managerSource).toContain('startCaptureRecording');
    expect(managerSource).toContain('stopCaptureRecording');
    expect(managerSource).toContain('getCaptureProvider');
    expect(managerSource).toContain('getDeviceSerial');

    // 编排：采样循环 + 录制同启 + 软上限 30min/2GB
    expect(controllerSource).toContain('class PerformanceCaptureController');
    expect(controllerSource).toContain('SAMPLE_INTERVAL_MS = 1000');
    expect(controllerSource).toContain('SOFT_LIMIT_DURATION_MS = 30 * 60 * 1000');
    expect(controllerSource).toContain('SOFT_LIMIT_SIZE_BYTES = 2 * 1024 * 1024 * 1024');
    expect(controllerSource).toContain('createSession');
    expect(controllerSource).toContain('startCaptureRecording');
    expect(controllerSource).toContain('appendSamples');
    expect(controllerSource).toContain('CAPTURE_SAMPLE');
    expect(controllerSource).toContain('CAPTURE_SIZE_LIMIT');
    expect(controllerSource).toContain('finalizeSession');
    expect(controllerSource).toContain('stopAll');

    // 两入口都注册 handler + 实例化 + 退出清理
    [indexSource, prodSource].forEach((src) => {
      expect(src).toContain('new PerformanceCaptureController');
      expect(src).toContain('captureController.start(deviceId)');
      expect(src).toContain('captureController.stop(deviceId)');
      expect(src).toContain('captureStore.listSessions()');
      expect(src).toContain('captureStore.deleteSession(sessionId)');
      expect(src).toContain('captureController.stopAll()');
      expect(src).toContain('saveScreenshot');
    });

    // preload + electronApi 暴露
    ['startCaptureSession', 'stopCaptureSession', 'listCaptureSessions', 'loadCaptureSession',
      'deleteCaptureSession', 'renameCaptureSession', 'saveCaptureMarkers', 'saveCaptureFrame',
      'onCaptureSample', 'onCaptureSizeLimit'].forEach((m) => {
      expect(preloadSource).toContain(m);
      expect(electronApiSource).toContain(m);
    });
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
    // 卸载二次确认走应用内自定义弹窗，不用原生 window.confirm（后者在 Electron 取消后会让网页丢键盘焦点）。
    expect(simpleAppSource).not.toContain('window.confirm(');
    expect(simpleAppSource).toContain('requestConfirm');
    expect(simpleAppSource).toContain('uninstallApp(device.id, packageName)');
    expect(simpleAppSource).toContain('loadInstalledPackages');
    expect(simpleAppSource).toContain('已安装应用');
  });

  test('unified install panel installs to one or many devices with per-device progress and concurrency', () => {
    expect(fs.existsSync(path.join(root, 'src/renderer/components/BatchInstallPanel.tsx'))).toBe(false);
    const managerSource = fs.readFileSync(path.join(root, 'src/main/adb/ADBManager.ts'), 'utf-8');
    const preloadSource = fs.readFileSync(path.join(root, 'src/main/preload.js'), 'utf-8');
    const electronApiSource = fs.readFileSync(path.join(root, 'src/renderer/lib/electronApi.ts'), 'utf-8');
    const simpleAppSource = fs.readFileSync(path.join(root, 'src/renderer/SimpleApp.tsx'), 'utf-8');
    const channelSource = fs.readFileSync(path.join(root, 'src/shared/ipc/channels.ts'), 'utf-8');

    // 安装模式（-r / -r -d）
    expect(managerSource).toContain("options?.allowDowngrade ? ['-r', '-d'] : ['-r']");
    expect(managerSource).toContain('async installApk(deviceId: string, apkPath: string, options?: { allowDowngrade?: boolean })');
    // 安装失败精准提示：识别签名不一致 / 降级等常见 INSTALL_FAILED_* 码
    expect(managerSource).toContain('classifyInstallFailure');
    expect(managerSource).toContain('INSTALL_FAILED_UPDATE_INCOMPATIBLE');
    expect(managerSource).toContain('签名不一致');
    expect(managerSource).toContain('INSTALL_FAILED_VERSION_DOWNGRADE');
    // 签名/降级冲突提示带上冲突包名
    expect(managerSource).toContain('pkgSuffix');
    expect(preloadSource).toContain('installApk: (deviceId, apkPath, options)');
    expect(electronApiSource).toContain('options?: { allowDowngrade?: boolean }');

    // 统一安装面板：单/多设备 + 并发 + 每台队列进度条
    expect(simpleAppSource).toContain('renderUnifiedInstallPanel');
    expect(simpleAppSource).toContain('startUnifiedInstall');
    expect(simpleAppSource).toContain('installItemsOnDevice');
    // 应用安装内分「操作区 / 安装详情」，详情含进度 + 错误 + 安装日志
    expect(simpleAppSource).toContain('安装详情');
    expect(simpleAppSource).toContain('appendInstallLog');
    expect(simpleAppSource).toContain('installLog');
    // 新装应用「NEW」标识：按设备存（批量装多台切设备不丢），每台装前后 diff 出新增包，并浮到列表顶部
    expect(simpleAppSource).toContain('newlyInstalledByDevice');
    expect(simpleAppSource).toContain("{'NEW'}");
    expect(simpleAppSource).toContain('const limit = installConcurrency > 0 ? installConcurrency : targetIds.length');
    expect(simpleAppSource).toContain('installApk(deviceId, item.path, { allowDowngrade: installAllowDowngrade })');
    expect(simpleAppSource).toContain('pendingApks');
    // 运行中应用：主进程按 ps -A 出运行包集合，渲染层轮询、标「运行中」、运行中禁止再次启动
    expect(channelSource).toContain("GET_RUNNING_PACKAGES: 'adb:get-running-packages'");
    expect(managerSource).toContain('async getRunningPackages(deviceId: string)');
    expect(preloadSource).toContain('getRunningPackages');
    expect(simpleAppSource).toContain('runningPackages');
    expect(simpleAppSource).toContain('loadRunningPackages');
    expect(simpleAppSource).toContain('disabled={isBusy || isRunning}');
    expect(simpleAppSource).toContain('已在运行，禁止重复启动');
    // 待安装支持拖拽 APK：共用 addApkFilesByPath、drop 取 File.path，并有全局守卫防拖偏导航
    expect(simpleAppSource).toContain('addApkFilesByPath');
    expect(simpleAppSource).toContain('handleApkDrop');
    expect(simpleAppSource).toContain("window.addEventListener('drop', prevent)");
    expect(simpleAppSource).toContain('installTargets');
    expect(simpleAppSource).toContain('retryDeviceInstall');
    expect(simpleAppSource).toContain('应用安装');
    expect(simpleAppSource).toContain('目标设备');
    // 安装目标默认不勾选，由用户手动选择或全选
    expect(simpleAppSource).toContain("const [installTargets, setInstallTargets] = useState<Set<string>>(new Set())");
    expect(simpleAppSource).not.toContain('prev.size === 0 ? new Set([selectedDevice.id]) : prev');
  });
});
