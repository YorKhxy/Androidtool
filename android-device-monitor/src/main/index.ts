import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import { ADBManager } from './adb/ADBManager';
import { ScrcpyManager } from './scrcpy/scrcpyManager';
import { LogEntry, MirrorStartOptions, PerformanceMetrics, PerformanceRecordingOptions, PerformanceSessionExportPayload } from '../shared/types';
import { AdbCommandError } from './adb/adbError';
import { persistPerformanceSnapshot, resolveRuntimeAppRoot } from './performanceSnapshots';
import { buildPerformanceSessionWorkbook } from './performanceSessionExport';
import { registerPerformanceMediaProtocol, registerPerformanceMediaScheme } from './performanceMedia';

let mainWindow: BrowserWindow | null = null;
let adbManager: ADBManager;
const scrcpyManager = new ScrcpyManager();
let isCleanupComplete = false;
let cleanupPromise: Promise<void> | null = null;

const LOG_BATCH_INTERVAL_MS = 250;
const LOG_BATCH_MAX_SIZE = 200;
const LOG_QUEUE_MAX_SIZE = 1000;

registerPerformanceMediaScheme();

let logQueue: LogEntry[] = [];
let logFlushTimer: NodeJS.Timeout | null = null;

const clearLogQueue = () => {
  logQueue = [];
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
};

const cleanupBeforeQuit = async () => {
  if (cleanupPromise) {
    return cleanupPromise;
  }

  cleanupPromise = (async () => {
    clearLogQueue();
    scrcpyManager.stopAll();
    if (adbManager) {
      await adbManager.cleanup();
    }
    isCleanupComplete = true;
  })();

  return cleanupPromise;
};

const flushLogQueue = () => {
  if (!mainWindow || logQueue.length === 0) {
    logFlushTimer = null;
    return;
  }

  const batch = logQueue.splice(0, LOG_BATCH_MAX_SIZE);
  mainWindow.webContents.send(IPC_CHANNELS.LOG_BATCH, batch);

  if (logQueue.length > 0) {
    logFlushTimer = setTimeout(flushLogQueue, LOG_BATCH_INTERVAL_MS);
  } else {
    logFlushTimer = null;
  }
};

const enqueueLogForRenderer = (entry: LogEntry) => {
  logQueue.push(entry);
  if (logQueue.length > LOG_QUEUE_MAX_SIZE) {
    logQueue = logQueue.slice(-LOG_QUEUE_MAX_SIZE);
  }

  if (logQueue.length >= LOG_BATCH_MAX_SIZE) {
    if (logFlushTimer) {
      clearTimeout(logFlushTimer);
      logFlushTimer = null;
    }
    flushLogQueue();
    return;
  }

  if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogQueue, LOG_BATCH_INTERVAL_MS);
  }
};

const toIpcErrorResponse = (error: unknown, fallbackMessage: string) => {
  if (error instanceof AdbCommandError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      hint: error.hint,
      details: error.details,
    };
  }

  return {
    success: false,
    error: error instanceof Error ? error.message : fallbackMessage,
  };
};

const readSnapshotImageAsDataUrl = async (screenshotPath: string) => {
  const appRoot = resolveRuntimeAppRoot(app);
  const snapshotRoot = path.resolve(appRoot, 'performance-snapshots');
  const resolvedPath = path.resolve(screenshotPath);
  const relativePath = path.relative(snapshotRoot, resolvedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error('快照图片路径不在允许目录内');
  }

  const image = await fs.readFile(resolvedPath);
  return `data:image/png;base64,${image.toString('base64')}`;
};

const resolveRendererIndexPath = (): string => {
  const candidates = [
    path.join(__dirname, '..', 'renderer', 'index.html'),
    path.join(__dirname, '..', '..', 'renderer', 'index.html'),
    path.join(app.getAppPath(), 'renderer', 'index.html'),
    path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'),
  ];

  const rendererPath = candidates.find(candidate => nodeFs.existsSync(candidate));
  if (!rendererPath) {
    throw new Error(`Renderer entry not found. Tried: ${candidates.join(', ')}`);
  }

  return rendererPath;
};

const createWindow = () => {
  const preloadPath = path.join(__dirname, 'preload.js');
  console.log('Preload path:', preloadPath);
  
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: '\u5b89\u5353\u8bbe\u5907\u76d1\u63a7',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  const isDevelopment = process.env.NODE_ENV === 'development' || process.env.ELECTRON_IS_DEV === 'true';
  
  if (isDevelopment) {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    const rendererPath = resolveRendererIndexPath();
    console.log('Loading renderer from:', rendererPath);
    mainWindow.loadFile(rendererPath);
  }

  mainWindow.on('closed', () => {
    clearLogQueue();
    mainWindow = null;
  });
};

const setupIpcHandlers = () => {
  ipcMain.handle(IPC_CHANNELS.GET_ADB_STATUS, async () => {
    try {
      const status = await adbManager.getAdbStatus(true);
      return { success: true, data: status };
    } catch (error) {
      return toIpcErrorResponse(error, '获取 ADB 状态失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_DEVICES, async () => {
    try {
      const devices = await adbManager.getDevices();
      return { success: true, data: devices };
    } catch (error) {
      return toIpcErrorResponse(error, '加载设备失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONNECT_WIFI, async (_event, ip: string) => {
    try {
      const result = await adbManager.connectWiFi(ip);
      return { success: true, data: result };
    } catch (error) {
      return toIpcErrorResponse(error, 'WiFi 连接失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.PAIR_WIFI, async (_event, target: string, pairingCode: string) => {
    try {
      const result = await adbManager.pairDevice(target, pairingCode);
      return { success: true, data: result };
    } catch (error) {
      return toIpcErrorResponse(error, 'WiFi 配对失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CONNECT_USB, async () => {
    try {
      const devices = await adbManager.connectUSB();
      return { success: true, data: devices };
    } catch (error) {
      return toIpcErrorResponse(error, 'USB 刷新失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DISCONNECT, async (_event, deviceId: string) => {
    try {
      await adbManager.disconnect(deviceId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '断开设备失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.START_LOGCAT, async (_event, deviceId: string, minLevel: 'V' | 'D' | 'I' | 'W' | 'E' | 'F' = 'D', packageName?: string, pid?: string) => {
    try {
      await adbManager.startLogcat(deviceId, (entry) => {
        enqueueLogForRenderer(entry);
      }, minLevel, packageName, pid);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '启动日志采集失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.STOP_LOGCAT, async (_event, deviceId: string) => {
    try {
      await adbManager.stopLogcat(deviceId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '停止日志采集失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_PERFORMANCE, async (_event, deviceId: string) => {
    try {
      const metrics = await adbManager.getPerformanceMetrics(deviceId);
      return { success: true, data: metrics };
    } catch (error) {
      return toIpcErrorResponse(error, '获取性能数据失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.CAPTURE_PERFORMANCE_SNAPSHOT, async (_event, deviceId: string, currentMetrics?: PerformanceMetrics) => {
    try {
      const snapshotPayload = await adbManager.capturePerformanceSnapshot(deviceId, currentMetrics);
      const snapshot = await persistPerformanceSnapshot(resolveRuntimeAppRoot(app), {
        deviceId,
        snapshot: snapshotPayload,
        trigger: 'manual',
      });
      return { success: true, data: snapshot };
    } catch (error) {
      return toIpcErrorResponse(error, '抓取性能快照失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.START_PERFORMANCE_RECORDING, async (_event, deviceId: string, options: PerformanceRecordingOptions) => {
    try {
      const recording = await adbManager.startPerformanceRecording(deviceId, resolveRuntimeAppRoot(app), options);
      return { success: true, data: recording };
    } catch (error) {
      return toIpcErrorResponse(error, '性能录制失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.READ_SNAPSHOT_IMAGE, async (_event, screenshotPath: string) => {
    try {
      const dataUrl = await readSnapshotImageAsDataUrl(screenshotPath);
      return { success: true, data: dataUrl };
    } catch (error) {
      return toIpcErrorResponse(error, '读取快照图片失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_PROCESSES, async (_event, deviceId: string) => {
    try {
      const processes = await adbManager.getProcesses(deviceId);
      return { success: true, data: processes };
    } catch (error) {
      return toIpcErrorResponse(error, '获取进程列表失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_ACTIVITY_STACK, async (_event, deviceId: string, packageName?: string) => {
    try {
      const activities = await adbManager.getActivityStack(deviceId, packageName);
      return { success: true, data: activities };
    } catch (error) {
      return toIpcErrorResponse(error, '获取 Activity 栈失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_NETWORK_REQUESTS, async (_event, deviceId: string, packageName?: string) => {
    try {
      const requests = await adbManager.getNetworkRequests(deviceId, packageName);
      return { success: true, data: requests };
    } catch (error) {
      return toIpcErrorResponse(error, '抓取网络请求失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.SELECT_APK_FILES, async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '选择安装包',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Android 安装包', extensions: ['apk'] }],
      });

      if (result.canceled) {
        return { success: true, data: [] };
      }

      return { success: true, data: result.filePaths };
    } catch (error) {
      return toIpcErrorResponse(error, '选择安装包失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.INSTALL_APK, async (_event, deviceId: string, apkPath: string, options?: { allowDowngrade?: boolean }) => {
    try {
      const output = await adbManager.installApk(deviceId, apkPath, options);
      return { success: true, data: { apkPath, output } };
    } catch (error) {
      return toIpcErrorResponse(error, '安装 APK 失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIST_INSTALLED_PACKAGES, async (_event, deviceId: string) => {
    try {
      const packages = await adbManager.listInstalledPackages(deviceId);
      return { success: true, data: packages };
    } catch (error) {
      return toIpcErrorResponse(error, '获取已安装应用失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIST_DEVICE_FILES, async (_event, deviceId: string, dirPath: string) => {
    try {
      const list = await adbManager.listDeviceFiles(deviceId, dirPath);
      return { success: true, data: list };
    } catch (error) {
      return toIpcErrorResponse(error, '列出设备文件失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_DEVICE_FILE, async (_event, deviceId: string, remotePath: string, isDir: boolean) => {
    try {
      await adbManager.deleteDeviceFile(deviceId, remotePath, isDir);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '删除设备文件失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, async (_event, localPath: string) => {
    try {
      // 在系统文件管理器中定位并选中该文件
      shell.showItemInFolder(localPath);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '打开文件位置失败');
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PULL_DEVICE_FILE,
    async (_event, deviceId: string, remotePath: string, name: string, isDir: boolean) => {
      try {
        let localPath: string;
        if (isDir) {
          const result = await dialog.showOpenDialog(mainWindow!, {
            title: '选择保存到电脑的文件夹',
            properties: ['openDirectory', 'createDirectory'],
          });
          if (result.canceled || result.filePaths.length === 0) {
            return { success: false, error: '取消下载' };
          }
          localPath = path.join(result.filePaths[0], name);
        } else {
          const result = await dialog.showSaveDialog(mainWindow!, {
            title: '保存到电脑',
            defaultPath: name,
          });
          if (result.canceled || !result.filePath) {
            return { success: false, error: '取消下载' };
          }
          localPath = result.filePath;
        }
        await adbManager.pullDeviceFile(deviceId, remotePath, localPath);
        return { success: true, data: localPath };
      } catch (error) {
        return toIpcErrorResponse(error, '下载设备文件失败');
      }
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.PULL_DEVICE_FILES,
    async (_event, deviceId: string, items: { path: string; name: string }[], pullId: string) => {
      try {
        const dirResult = await dialog.showOpenDialog(mainWindow!, {
          title: '选择保存到电脑的文件夹',
          properties: ['openDirectory', 'createDirectory'],
        });
        if (dirResult.canceled || dirResult.filePaths.length === 0) {
          return { success: false, error: '取消下载' };
        }
        const savedDir = dirResult.filePaths[0];
        const total = items.length;
        let succeeded = 0;
        let failed = 0;

        for (let index = 0; index < total; index++) {
          const item = items[index];
          mainWindow?.webContents.send(IPC_CHANNELS.PULL_DEVICE_FILE_PROGRESS, {
            pullId, fileName: item.name, index, total, status: 'downloading',
          });
          try {
            await adbManager.pullDeviceFile(deviceId, item.path, path.join(savedDir, item.name));
            succeeded++;
            mainWindow?.webContents.send(IPC_CHANNELS.PULL_DEVICE_FILE_PROGRESS, {
              pullId, fileName: item.name, index, total, status: 'done',
            });
          } catch (err) {
            failed++;
            mainWindow?.webContents.send(IPC_CHANNELS.PULL_DEVICE_FILE_PROGRESS, {
              pullId, fileName: item.name, index, total, status: 'error', error: (err as Error).message,
            });
          }
        }
        return { success: true, data: { savedDir, succeeded, failed } };
      } catch (error) {
        return toIpcErrorResponse(error, '批量下载失败');
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.SELECT_UPLOAD_FILES, async () => {
    try {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: '选择要上传到设备的文件',
        properties: ['openFile', 'multiSelections'],
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, error: '取消选择' };
      }
      return { success: true, data: result.filePaths };
    } catch (error) {
      return toIpcErrorResponse(error, '选择上传文件失败');
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.PUSH_DEVICE_FILE,
    async (_event, deviceId: string, remoteDir: string, localPaths: string[], uploadId: string) => {
      const total = localPaths.length;
      try {
        for (let index = 0; index < total; index++) {
          const localPath = localPaths[index];
          const fileName = path.basename(localPath);
          try {
            await adbManager.pushDeviceFile(deviceId, localPath, remoteDir, fileName, (percent) => {
              mainWindow?.webContents.send(IPC_CHANNELS.PUSH_DEVICE_FILE_PROGRESS, {
                uploadId, fileName, index, total, percent, status: 'uploading',
              });
            });
            mainWindow?.webContents.send(IPC_CHANNELS.PUSH_DEVICE_FILE_PROGRESS, {
              uploadId, fileName, index, total, percent: 100, status: 'done',
            });
          } catch (err) {
            mainWindow?.webContents.send(IPC_CHANNELS.PUSH_DEVICE_FILE_PROGRESS, {
              uploadId, fileName, index, total, percent: 0, status: 'error',
              error: (err as Error).message,
            });
            throw err;
          }
        }
        return { success: true, data: total };
      } catch (error) {
        return toIpcErrorResponse(error, '上传文件失败');
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.UNINSTALL_APP, async (_event, deviceId: string, packageName: string) => {
    try {
      const output = await adbManager.uninstallApp(deviceId, packageName);
      return { success: true, data: { packageName, output } };
    } catch (error) {
      return toIpcErrorResponse(error, '卸载应用失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.LAUNCH_APP, async (_event, deviceId: string, packageName: string) => {
    try {
      const output = await adbManager.launchApp(deviceId, packageName);
      return { success: true, data: { packageName, output } };
    } catch (error) {
      return toIpcErrorResponse(error, '启动应用失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.FORCE_STOP_APP, async (_event, deviceId: string, packageName: string) => {
    try {
      await adbManager.forceStopApp(deviceId, packageName);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '关闭应用失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.SLEEP_DEVICE, async (_event, deviceId: string) => {
    try {
      await adbManager.sleepDevice(deviceId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '设备息屏失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.WAKE_DEVICE, async (_event, deviceId: string) => {
    try {
      await adbManager.wakeDevice(deviceId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '设备唤醒失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.UNLOCK_DEVICE, async (_event, deviceId: string) => {
    try {
      await adbManager.unlockDevice(deviceId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '设备解锁失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.REBOOT_DEVICE, async (_event, deviceId: string) => {
    try {
      await adbManager.rebootDevice(deviceId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '设备重启失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_LOGS, async (_event, logs: LogEntry[]) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '\u5bfc\u51fa\u65e5\u5fd7',
        defaultPath: `android-logs-${Date.now()}.log`,
        filters: [{ name: '\u65e5\u5fd7\u6587\u4ef6', extensions: ['log', 'txt'] }]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: '\u53d6\u6d88\u5bfc\u51fa' };
      }

      const content = logs
        .map((log) => `${new Date(log.timestamp).toISOString()} ${log.deviceId} ${log.processId}/${log.threadId} ${log.level}/${log.tag}: ${log.message}`)
        .join('\n');
      await fs.writeFile(result.filePath, content, 'utf-8');
      return { success: true, data: result.filePath };
    } catch (error) {
      return toIpcErrorResponse(error, '导出日志失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_PERFORMANCE_SESSION, async (_event, payload: PerformanceSessionExportPayload) => {
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出性能采集报告',
        defaultPath: `performance-session-${Date.now()}.xls`,
        filters: [{ name: 'Excel 文件', extensions: ['xls'] }]
      });

      if (result.canceled || !result.filePath) {
        return { success: false, error: '取消导出' };
      }

      await fs.writeFile(result.filePath, buildPerformanceSessionWorkbook(payload), 'utf-8');
      return { success: true, data: result.filePath };
    } catch (error) {
      return toIpcErrorResponse(error, '导出性能采集报告失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.MIRROR_START, async (_event, deviceId: string, options?: MirrorStartOptions) => {
    try {
      const session = await scrcpyManager.startMirror(deviceId, options ?? {});
      return { success: true, data: session };
    } catch (error) {
      return toIpcErrorResponse(error, '启动投屏失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.MIRROR_STOP, async (_event, deviceId: string) => {
    try {
      scrcpyManager.stopMirror(deviceId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '停止投屏失败');
    }
  });

  scrcpyManager.onStatus((session) => {
    mainWindow?.webContents.send(IPC_CHANNELS.MIRROR_STATUS, session);
  });

  adbManager.onAdbStatusChanged((status) => {
    mainWindow?.webContents.send(IPC_CHANNELS.ADB_STATUS_CHANGED, status);
  });

  adbManager.onDeviceConnected((device) => {
    mainWindow?.webContents.send(IPC_CHANNELS.DEVICE_CONNECTED, device);
  });

  adbManager.onDeviceDisconnected((deviceId) => {
    mainWindow?.webContents.send(IPC_CHANNELS.DEVICE_DISCONNECTED, deviceId);
  });

  adbManager.onDeviceListChanged((devices) => {
    mainWindow?.webContents.send(IPC_CHANNELS.DEVICE_LIST_CHANGED, devices);
  });
};

app.whenReady().then(() => {
  adbManager = new ADBManager();
  registerPerformanceMediaProtocol(() => resolveRuntimeAppRoot(app));
  createWindow();
  setupIpcHandlers();
  adbManager.startDeviceMonitoring();
  void adbManager.getAdbStatus(true);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  if (isCleanupComplete) {
    return;
  }

  event.preventDefault();
  void cleanupBeforeQuit().finally(() => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

import { IPC_CHANNELS } from '../shared/ipc/channels';
