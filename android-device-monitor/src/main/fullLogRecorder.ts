import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import type { LogEntry } from '../shared/types';
import { logger } from './logger';
import { resolveRuntimeAppRoot } from './performanceSnapshots';

// 完整日志落盘：把 logcat 抓到的每一条（全等级、从监控第一行起）实时写进会话文件。
// 不受渲染层「每设备最多 2 万条」UI 上限影响，也先于主进程→渲染层的背压队列，因此能保证
// 「从监控开始到结束、一条不丢」。供「导出完整原始日志」使用。每次 startLogcat 开新文件（截断重来）。
//
// 落盘位置：exe 所在目录下的 device-logs\（打包时即安装目录，开发时即项目根目录），
// 文件夹名 device-logs 与工具自身日志区分。若该目录不可写（如装到 Program Files），兜底回 userData。

const DIR_NAME = 'device-logs';

const streams = new Map<string, fs.WriteStream>();
const filePaths = new Map<string, string>();

// 解析落盘目录：优先 exe 所在目录/device-logs；不可写则回退到 userData/device-logs。
const getDir = (): string => {
  const primary = path.join(resolveRuntimeAppRoot(app), DIR_NAME);
  try {
    fs.mkdirSync(primary, { recursive: true });
    fs.accessSync(primary, fs.constants.W_OK); // 确认可写（Program Files 等只读目录会抛）
    return primary;
  } catch {
    const fallback = path.join(app.getPath('userData'), DIR_NAME);
    try {
      fs.mkdirSync(fallback, { recursive: true });
    } catch {
      /* 兜底目录也建失败时，下方 createWriteStream 会报错并被吞 */
    }
    logger.warn('fullLogRecorder: exe 目录不可写，完整日志回退到 userData/device-logs');
    return fallback;
  }
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
