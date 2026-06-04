import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import * as path from 'path';
import * as nodeFs from 'fs';
import * as fs from 'fs/promises';
import { ADBManager } from './adb/ADBManager';
import { ScrcpyManager } from './scrcpy/scrcpyManager';
import { LogEntry, MirrorStartOptions, PerformanceRecordingOptions, PerformanceSessionExportPayload } from '../shared/types';
import { AdbCommandError } from './adb/adbError';
import { resolveRuntimeAppRoot } from './runtimeAppRoot';
import { buildPerformanceSessionWorkbook } from './performanceSessionExport';
import { registerPerformanceMediaProtocol, registerPerformanceMediaScheme } from './performanceMedia';
import { PerformanceCaptureStore } from './performanceCaptureStore';
import { PerformanceCaptureController } from './performanceCaptureController';
import type { PerformanceCaptureMarker } from '../shared/types';
import { initAutoUpdate, checkForUpdates, downloadUpdate, quitAndInstallUpdate, getLastUpdateStatus } from './autoUpdate';
import * as fullLogRecorder from './fullLogRecorder';
import * as transferJournal from './transferJournal';
import {
  buildUploadBatch,
  buildDownloadBatch,
  runUploadBatch,
  runDownloadBatch,
  discardBatch,
} from './transferRunner';

let mainWindow: BrowserWindow | null = null;
let adbManager: ADBManager;
let captureStore: PerformanceCaptureStore;
let captureController: PerformanceCaptureController;
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
    fullLogRecorder.stopAll();
    scrcpyManager.stopAll();
    if (captureController) {
      await captureController.stopAll();
    }
    if (adbManager) {
      // 先置位「退出中」：让被 SIGTERM 中断的传输保留为 transferring（可恢复），不被当成失败清出 journal。
      transferJournal.setQuitting(true);
      // 退出前终止正在跑的传输子进程（SIGTERM）；journal 已逐步落盘，崩溃/强杀靠它兜底恢复。
      adbManager.cancelActiveTransfers();
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

  const rendererPath = resolveRendererIndexPath();
  console.log('Loading renderer from:', rendererPath);
  mainWindow.loadFile(rendererPath);

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
      // 先开完整日志落盘文件（覆盖旧会话），再启动采集，保证第一行起就被记录。
      fullLogRecorder.start(deviceId);
      await adbManager.startLogcat(deviceId, (entry) => {
        fullLogRecorder.write(deviceId, entry); // 完整落盘（不受渲染层 2 万条上限/背压影响）
        enqueueLogForRenderer(entry);
      }, minLevel, packageName, pid);
      return { success: true };
    } catch (error) {
      fullLogRecorder.stop(deviceId);
      return toIpcErrorResponse(error, '启动日志采集失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.STOP_LOGCAT, async (_event, deviceId: string) => {
    try {
      await adbManager.stopLogcat(deviceId);
      fullLogRecorder.stop(deviceId);
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

  ipcMain.handle(IPC_CHANNELS.START_PERFORMANCE_RECORDING, async (_event, deviceId: string, options: PerformanceRecordingOptions) => {
    try {
      const recording = await adbManager.startPerformanceRecording(deviceId, resolveRuntimeAppRoot(app), options);
      return { success: true, data: recording };
    } catch (error) {
      return toIpcErrorResponse(error, '性能录制失败');
    }
  });

  // —— Phase 14 采集会话 —— //
  ipcMain.handle(IPC_CHANNELS.START_CAPTURE_SESSION, async (_event, deviceId: string) => {
    try {
      const session = await captureController.start(deviceId);
      return { success: true, data: session };
    } catch (error) {
      return toIpcErrorResponse(error, '开始采集失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.STOP_CAPTURE_SESSION, async (_event, deviceId: string) => {
    try {
      const session = await captureController.stop(deviceId);
      return { success: true, data: session };
    } catch (error) {
      return toIpcErrorResponse(error, '关闭采集失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.LIST_CAPTURE_SESSIONS, async () => {
    try {
      const sessions = await captureStore.listSessions();
      return { success: true, data: sessions };
    } catch (error) {
      return toIpcErrorResponse(error, '加载采集列表失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.LOAD_CAPTURE_SESSION, async (_event, sessionId: string) => {
    try {
      const detail = await captureStore.loadSession(sessionId);
      return { success: true, data: detail };
    } catch (error) {
      return toIpcErrorResponse(error, '加载采集记录失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DELETE_CAPTURE_SESSION, async (_event, sessionId: string) => {
    try {
      await captureStore.deleteSession(sessionId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '删除采集记录失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.RENAME_CAPTURE_SESSION, async (_event, sessionId: string, title: string) => {
    try {
      const session = await captureStore.renameSession(sessionId, title);
      return { success: true, data: session };
    } catch (error) {
      return toIpcErrorResponse(error, '重命名采集记录失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_CAPTURE_MARKERS, async (_event, sessionId: string, markers: PerformanceCaptureMarker[]) => {
    try {
      await captureStore.saveMarkers(sessionId, markers);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '保存过滤标记失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.SAVE_CAPTURE_FRAME, async (_event, sessionId: string, dataUrl: string) => {
    try {
      const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const relativePath = await captureStore.saveScreenshot(sessionId, Buffer.from(base64, 'base64'));
      return { success: true, data: relativePath };
    } catch (error) {
      return toIpcErrorResponse(error, '保存截图失败');
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

  ipcMain.handle(IPC_CHANNELS.GET_RUNNING_PACKAGES, async (_event, deviceId: string) => {
    try {
      const data = await adbManager.getRunningPackages(deviceId);
      return { success: true, data };
    } catch (error) {
      return toIpcErrorResponse(error, '获取运行中应用失败');
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

  ipcMain.handle(IPC_CHANNELS.CREATE_DEVICE_FOLDER, async (_event, deviceId: string, dirPath: string, name: string) => {
    try {
      const createdPath = await adbManager.createDeviceFolder(deviceId, dirPath, name);
      return { success: true, data: createdPath };
    } catch (error) {
      return toIpcErrorResponse(error, '创建文件夹失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.SHOW_ITEM_IN_FOLDER, async (_event, localPath: string) => {
    try {
      shell.showItemInFolder(localPath);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '打开文件位置失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.OPEN_PATH, async (_event, targetPath: string) => {
    try {
      const error = await shell.openPath(targetPath);
      if (error) return { success: false, error };
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '打开目录失败');
    }
  });

  ipcMain.handle(IPC_CHANNELS.GET_APP_VERSION, async () => {
    try {
      return { success: true, data: app.getVersion() };
    } catch (error) {
      return toIpcErrorResponse(error, '获取版本号失败');
    }
  });

  // 读取打进安装包的本版本更新日志（release-notes.md），供「更新日志」弹窗展示。读不到返回空串。
  ipcMain.handle(IPC_CHANNELS.GET_RELEASE_NOTES, async () => {
    try {
      const content = await fs.readFile(path.join(app.getAppPath(), 'release-notes.md'), 'utf-8');
      return { success: true, data: content };
    } catch {
      return { success: true, data: '' };
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
        // 先把整批任务落盘（pending），再逐个执行；中途崩溃靠 journal 恢复。
        const batch = buildDownloadBatch(deviceId, savedDir, items);
        transferJournal.createBatch(batch);
        const send = (channel: string, payload: unknown) =>
          mainWindow?.webContents.send(channel, payload);
        const { succeeded, failed } = await runDownloadBatch(adbManager, send, batch, pullId);
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
      try {
        const batch = buildUploadBatch(deviceId, remoteDir, localPaths);
        transferJournal.createBatch(batch);
        const send = (channel: string, payload: unknown) =>
          mainWindow?.webContents.send(channel, payload);
        // 新建上传保持「首个失败即中止整批」语义（stopOnError=true）。
        const { succeeded } = await runUploadBatch(adbManager, send, batch, uploadId, true);
        return { success: true, data: succeeded };
      } catch (error) {
        return toIpcErrorResponse(error, '上传文件失败');
      }
    }
  );

  // 恢复一批未完成传输：从 journal 取回任务，按方向走对应执行器（跳过已 done）。
  // transferId 由渲染层传入，作为进度通道的 uploadId/pullId，复用现有进度展示。
  ipcMain.handle(
    IPC_CHANNELS.RESUME_TRANSFERS,
    async (_event, batchId: string, transferId: string) => {
      try {
        const batch = transferJournal.getBatch(batchId);
        if (batch.length === 0) {
          return { success: false, error: '没有可恢复的任务' };
        }
        const send = (channel: string, payload: unknown) =>
          mainWindow?.webContents.send(channel, payload);
        const result = batch[0].direction === 'upload'
          ? await runUploadBatch(adbManager, send, batch, transferId, false)
          : await runDownloadBatch(adbManager, send, batch, transferId);
        return { success: true, data: result };
      } catch (error) {
        return toIpcErrorResponse(error, '恢复传输失败');
      }
    }
  );

  // 丢弃一批未完成传输：清理残留 .part 并移出 journal，下次启动不再提示。
  ipcMain.handle(IPC_CHANNELS.DISCARD_TRANSFERS, async (_event, batchId: string) => {
    try {
      await discardBatch(adbManager, batchId);
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '丢弃传输失败');
    }
  });

  // 渲染层挂载后主动拉取可恢复批次（拉取式，避免 did-finish-load 推送早于订阅的竞态）。
  ipcMain.handle(IPC_CHANNELS.GET_RESUME_BATCHES, async () => {
    try {
      return { success: true, data: transferJournal.getResumeBatches() };
    } catch (error) {
      return toIpcErrorResponse(error, '读取未完成传输失败');
    }
  });

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
        .map((log) => {
          // 导出用本地时间（与界面显示一致），不能用 toISOString()——它输出 UTC 会比本地少 8 小时
          const d = new Date(log.timestamp);
          const pad = (n: number, len = 2) => String(n).padStart(len, '0');
          const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
          return `${ts} ${log.deviceId} ${log.processId}/${log.threadId} ${log.level}/${log.tag}: ${log.message}`;
        })
        .join('\n');
      await fs.writeFile(result.filePath, content, 'utf-8');
      return { success: true, data: result.filePath };
    } catch (error) {
      return toIpcErrorResponse(error, '导出日志失败');
    }
  });

  // 导出完整原始日志：把该设备本次监控落盘的全量日志文件另存到用户选择的位置。
  // 不受渲染层 2 万条上限/筛选影响，是从监控第一行到当前的完整记录。
  ipcMain.handle(IPC_CHANNELS.EXPORT_FULL_LOGS, async (_event, deviceId: string) => {
    try {
      const src = fullLogRecorder.getPath(deviceId);
      if (!src || !nodeFs.existsSync(src)) {
        return { success: false, error: '没有可导出的完整日志，请先开始日志采集' };
      }
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '导出完整日志',
        defaultPath: `android-full-logs-${Date.now()}.log`,
        filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: '取消导出' };
      }
      await fs.copyFile(src, result.filePath);
      return { success: true, data: result.filePath };
    } catch (error) {
      return toIpcErrorResponse(error, '导出完整日志失败');
    }
  });

  // 按当前包名导出完整日志：在「全量落盘文件」基础上用用户填的包名做关联过滤，切出一份完整子集
  //（多行堆栈整条保留），不需要重新采集。0 命中时删掉空文件并提示。
  ipcMain.handle(IPC_CHANNELS.EXPORT_FULL_LOGS_BY_PACKAGE, async (_event, deviceId: string, packageName: string) => {
    try {
      const src = fullLogRecorder.getPath(deviceId);
      if (!src || !nodeFs.existsSync(src)) {
        return { success: false, error: '没有可导出的完整日志，请先开始日志采集' };
      }
      const pkg = (packageName || '').trim();
      if (!pkg) {
        return { success: false, error: '请先在「应用/包名」里填写要导出的包名' };
      }
      const safePkg = pkg.replace(/[^a-zA-Z0-9._-]/g, '_');
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: '按包名导出完整日志',
        defaultPath: `android-full-logs-${safePkg}-${Date.now()}.log`,
        filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: '取消导出' };
      }
      const matched = await fullLogRecorder.exportByPackage(deviceId, pkg, result.filePath);
      if (matched === 0) {
        try { await fs.unlink(result.filePath); } catch { /* noop */ }
        return { success: false, error: `「${pkg}」没有匹配到任何完整日志` };
      }
      return { success: true, data: result.filePath };
    } catch (error) {
      return toIpcErrorResponse(error, '按包名导出完整日志失败');
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

  // 投屏中实时切换音频去向（设备本机 / 电脑），不影响主视频窗口。
  ipcMain.handle(IPC_CHANNELS.MIRROR_SET_AUDIO, async (_event, deviceId: string, forward: boolean) => {
    try {
      const session = scrcpyManager.setAudioForward(deviceId, forward);
      return { success: true, data: session };
    } catch (error) {
      return toIpcErrorResponse(error, '切换投屏声音失败');
    }
  });

  // 手动触发检查更新（设置里「检查更新」按钮可用）。
  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    try {
      checkForUpdates();
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '检查更新失败');
    }
  });

  // 渲染层挂载后拉取最近一次更新状态：补回启动自动检查时因 push 早于订阅而丢失的「有新版本」提示。
  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATUS, async () => {
    try {
      return { success: true, data: getLastUpdateStatus() };
    } catch (error) {
      return toIpcErrorResponse(error, '获取更新状态失败');
    }
  });

  // 手动开始下载更新（autoDownload=false，由「立即更新」按钮触发）。
  ipcMain.handle(IPC_CHANNELS.UPDATE_DOWNLOAD, async () => {
    try {
      downloadUpdate();
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '下载更新失败');
    }
  });

  // 立即重启并安装已下载好的更新。
  ipcMain.handle(IPC_CHANNELS.UPDATE_QUIT_AND_INSTALL, async () => {
    try {
      quitAndInstallUpdate();
      return { success: true };
    } catch (error) {
      return toIpcErrorResponse(error, '安装更新失败');
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
  captureStore = new PerformanceCaptureStore(() => resolveRuntimeAppRoot(app));
  captureController = new PerformanceCaptureController(
    adbManager,
    captureStore,
    (channel, payload) => mainWindow?.webContents.send(channel, payload)
  );
  registerPerformanceMediaProtocol(() => resolveRuntimeAppRoot(app));
  createWindow();
  setupIpcHandlers();
  adbManager.startDeviceMonitoring();
  void adbManager.getAdbStatus(true);

  // 自动更新：初始化事件转发，并在启动后检查一次（开发期默认跳过）。
  initAutoUpdate(() => mainWindow);
  checkForUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', (event) => {
  console.log('Application is quitting, cleaning up...');
  if (isCleanupComplete) {
    return;
  }

  event.preventDefault();
  void cleanupBeforeQuit().finally(() => {
    app.quit();
  });
});

app.on('will-quit', () => {
  console.log('Application will quit');
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

import { IPC_CHANNELS } from '../shared/ipc/channels';
