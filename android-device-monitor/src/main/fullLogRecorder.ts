import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from '../shared/types';
import { logger } from './logger';

// 完整日志落盘：把 logcat 抓到的每一条（全等级、从监控第一行起）实时写进 userData 下的会话文件。
// 不受渲染层「每设备最多 2 万条」UI 上限影响，也先于主进程→渲染层的背压队列，因此能保证
// 「从监控开始到结束、一条不丢」。供「导出完整原始日志」使用。每次 startLogcat 开新文件（截断重来）。

const streams = new Map<string, fs.WriteStream>();
const filePaths = new Map<string, string>();

const getDir = (): string => {
  const dir = path.join(app.getPath('userData'), 'full-logs');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* 已存在或创建失败（失败时下方 createWriteStream 会报错并被吞） */
  }
  return dir;
};

// deviceId 可能含 ':' '/' 等不能做文件名的字符（如 wifi 的 ip:port），统一替换。
const sanitize = (deviceId: string): string => deviceId.replace(/[^a-zA-Z0-9._-]/g, '_');

// 与「导出当前可见日志」一致的行格式，便于两种导出对照阅读（本地时间）。
const formatLine = (log: LogEntry): string => {
  const d = new Date(log.timestamp);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${ts} ${log.deviceId} ${log.processId}/${log.threadId} ${log.level}/${log.tag}: ${log.message}`;
};

// 开始记录某设备的完整日志：开新文件（覆盖旧的），返回文件路径。
export const start = (deviceId: string): string => {
  stop(deviceId); // 若已有旧流先关掉
  const file = path.join(getDir(), `${sanitize(deviceId)}.log`);
  try {
    const stream = fs.createWriteStream(file, { flags: 'w', encoding: 'utf-8' });
    stream.on('error', (err) => logger.error('fullLogRecorder: stream error:', err));
    streams.set(deviceId, stream);
    filePaths.set(deviceId, file);
  } catch (error) {
    logger.error('fullLogRecorder: failed to open log file:', error);
  }
  return file;
};

// 写入一条日志（在 logcat 回调里调用，先于渲染层背压队列，保证不丢）。
export const write = (deviceId: string, entry: LogEntry): void => {
  const stream = streams.get(deviceId);
  if (stream && stream.writable) {
    stream.write(formatLine(entry) + '\n');
  }
};

// 停止记录并关闭文件流（保留文件，供导出）。
export const stop = (deviceId: string): void => {
  const stream = streams.get(deviceId);
  if (stream) {
    try {
      stream.end();
    } catch {
      /* noop */
    }
    streams.delete(deviceId);
  }
};

// 当前设备完整日志文件路径（无则 null）。
export const getPath = (deviceId: string): string | null => filePaths.get(deviceId) ?? null;

// 退出时关闭所有流。
export const stopAll = (): void => {
  for (const stream of streams.values()) {
    try {
      stream.end();
    } catch {
      /* noop */
    }
  }
  streams.clear();
};
