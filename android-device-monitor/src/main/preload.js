const { ipcRenderer, contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getAdbStatus: () => ipcRenderer.invoke('adb:get-status'),
  getDevices: () => ipcRenderer.invoke('adb:get-devices'),
  connectWiFi: (ip) => ipcRenderer.invoke('adb:connect-wifi', ip),
  pairWiFi: (target, pairingCode) => ipcRenderer.invoke('adb:pair-wifi', target, pairingCode),
  disconnect: (deviceId) => ipcRenderer.invoke('adb:disconnect', deviceId),
  startLogcat: (deviceId, minLevel, packageName, pid) => ipcRenderer.invoke('adb:start-logcat', deviceId, minLevel, packageName, pid),
  stopLogcat: (deviceId) => ipcRenderer.invoke('adb:stop-logcat', deviceId),
  getPerformance: (deviceId) => ipcRenderer.invoke('adb:get-performance', deviceId),
  capturePerformanceSnapshot: (deviceId, currentMetrics) => ipcRenderer.invoke('adb:capture-performance-snapshot', deviceId, currentMetrics),
  startPerformanceRecording: (deviceId, options) => ipcRenderer.invoke('adb:start-performance-recording', deviceId, options),
  readSnapshotImage: (screenshotPath) => ipcRenderer.invoke('performance:read-snapshot-image', screenshotPath),
  getProcesses: (deviceId) => ipcRenderer.invoke('adb:get-processes', deviceId),
  connectUSB: () => ipcRenderer.invoke('adb:connect-usb'),
  getActivityStack: (deviceId, packageName) => ipcRenderer.invoke('adb:get-activity-stack', deviceId, packageName),
  getNetworkRequests: (deviceId, packageName) => ipcRenderer.invoke('adb:get-network-requests', deviceId, packageName),
  startMirror: (deviceId, options) => ipcRenderer.invoke('mirror:start', deviceId, options),
  stopMirror: (deviceId) => ipcRenderer.invoke('mirror:stop', deviceId),
  onMirrorStatus: (callback) => {
    const listener = (_, session) => callback(session);
    ipcRenderer.on('mirror:status', listener);
    return () => ipcRenderer.removeListener('mirror:status', listener);
  },
  selectApkFiles: () => ipcRenderer.invoke('adb:select-apk-files'),
  installApk: (deviceId, apkPath, options) => ipcRenderer.invoke('adb:install-apk', deviceId, apkPath, options),
  uninstallApp: (deviceId, packageName) => ipcRenderer.invoke('adb:uninstall-app', deviceId, packageName),
  listInstalledPackages: (deviceId) => ipcRenderer.invoke('adb:list-installed-packages', deviceId),
  listDeviceFiles: (deviceId, dirPath) => ipcRenderer.invoke('adb:list-device-files', deviceId, dirPath),
  pullDeviceFile: (deviceId, remotePath, name, isDir) => ipcRenderer.invoke('adb:pull-device-file', deviceId, remotePath, name, isDir),
  deleteDeviceFile: (deviceId, remotePath, isDir) => ipcRenderer.invoke('adb:delete-device-file', deviceId, remotePath, isDir),
  createDeviceFolder: (deviceId, dirPath, name) => ipcRenderer.invoke('adb:create-device-folder', deviceId, dirPath, name),
  showItemInFolder: (localPath) => ipcRenderer.invoke('app:show-item-in-folder', localPath),
  pullDeviceFiles: (deviceId, items, pullId) => ipcRenderer.invoke('adb:pull-device-files', deviceId, items, pullId),
  onPullProgress: (callback) => {
    const listener = (_, progress) => callback(progress);
    ipcRenderer.on('adb:pull-device-file-progress', listener);
    return () => ipcRenderer.removeListener('adb:pull-device-file-progress', listener);
  },
  selectUploadFiles: () => ipcRenderer.invoke('adb:select-upload-files'),
  pushDeviceFile: (deviceId, remoteDir, localPaths, uploadId) => ipcRenderer.invoke('adb:push-device-file', deviceId, remoteDir, localPaths, uploadId),
  onPushProgress: (callback) => {
    const listener = (_, progress) => callback(progress);
    ipcRenderer.on('adb:push-device-file-progress', listener);
    return () => ipcRenderer.removeListener('adb:push-device-file-progress', listener);
  },
  launchApp: (deviceId, packageName) => ipcRenderer.invoke('adb:launch-app', deviceId, packageName),
  forceStopApp: (deviceId, packageName) => ipcRenderer.invoke('adb:force-stop-app', deviceId, packageName),
  sleepDevice: (deviceId) => ipcRenderer.invoke('adb:sleep-device', deviceId),
  wakeDevice: (deviceId) => ipcRenderer.invoke('adb:wake-device', deviceId),
  unlockDevice: (deviceId) => ipcRenderer.invoke('adb:unlock-device', deviceId),
  rebootDevice: (deviceId) => ipcRenderer.invoke('adb:reboot-device', deviceId),
  exportLogs: (logs) => ipcRenderer.invoke('log:export', logs),
  exportPerformanceSession: (payload) => ipcRenderer.invoke('performance:export-session', payload),
  onLogEntry: (callback) => {
    const listener = (_, entry) => callback(entry);
    ipcRenderer.on('log:entry', listener);
    return () => ipcRenderer.removeListener('log:entry', listener);
  },
  onLogBatch: (callback) => {
    const listener = (_, entries) => callback(entries);
    ipcRenderer.on('log:batch', listener);
    return () => ipcRenderer.removeListener('log:batch', listener);
  },
  onAdbStatusChanged: (callback) => {
    const listener = (_, status) => callback(status);
    ipcRenderer.on('adb:status-changed', listener);
    return () => ipcRenderer.removeListener('adb:status-changed', listener);
  },
  onDeviceConnected: (callback) => {
    const listener = (_, device) => callback(device);
    ipcRenderer.on('device:connected', listener);
    return () => ipcRenderer.removeListener('device:connected', listener);
  },
  onDeviceDisconnected: (callback) => {
    const listener = (_, deviceId) => callback(deviceId);
    ipcRenderer.on('device:disconnected', listener);
    return () => ipcRenderer.removeListener('device:disconnected', listener);
  },
  onDeviceListChanged: (callback) => {
    const listener = (_, devices) => callback(devices);
    ipcRenderer.on('device:list-changed', listener);
    return () => ipcRenderer.removeListener('device:list-changed', listener);
  },
});
