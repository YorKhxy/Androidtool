import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import { ADBManager } from './adb/ADBManager';
import { LogEntry, PerformanceMetrics, PerformanceSessionExportPayload } from '../shared/types';
import { AdbCommandError } from './adb/adbError';
import { persistPerformanceSnapshot, resolveRuntimeAppRoot } from './performanceSnapshots';
import { buildPerformanceSessionWorkbook } from './performanceSessionExport';

let mainWindow: BrowserWindow | null = null;
let adbManager: ADBManager;

const LOG_BATCH_INTERVAL_MS = 250;
const LOG_BATCH_MAX_SIZE = 200;
const LOG_QUEUE_MAX_SIZE = 1000;

let logQueue: LogEntry[] = [];
let logFlushTimer: NodeJS.Timeout | null = null;

const clearLogQueue = () => {
  logQueue = [];
  if (logFlushTimer) {
    clearTimeout(logFlushTimer);
    logFlushTimer = null;
  }
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
    const rendererPath = path.join(__dirname, '..', 'renderer', 'index.html');
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
      adbManager.stopLogcat(deviceId);
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

app.on('before-quit', () => {
  clearLogQueue();
  if (adbManager) {
    adbManager.cleanup();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

import { IPC_CHANNELS } from '../shared/ipc/channels';
