import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import type { LogEntry } from '../shared/types';
import { logger } from './logger';
import { resolveRuntimeAppRoot } from './runtimeAppRoot';

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

// 落盘行格式（本地时间）。在「导出当前可见日志」的基础上多存一列「进程归属包名」，
// 这样事后「按包名导出完整日志」才能复刻实时采集的关联匹配口径——应用自己打的日志正文里
// 往往不含包名，得靠 PID 反查出的归属包名才判得出归属。无归属时用 '-' 占位。
const formatLine = (log: LogEntry): string => {
  const d = new Date(log.timestamp);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  const pkg = log.packageName?.trim() || '-';
  return `${ts} ${log.deviceId} ${pkg} ${log.processId}/${log.threadId} ${log.level}/${log.tag}: ${log.message}`;
};

// 条目头行的时间戳前缀（formatLine 写出的格式）。用于把多行堆栈续行归并到同一条记录，
// 避免按包名切分时把堆栈续行当成独立行漏掉。
const ENTRY_HEAD_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /;

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

// 按包名从该设备的完整落盘日志切出一份完整子集，写到 destPath，返回命中的记录条数。
// 不重新采集：直接在「全量落盘文件」上做关联过滤。口径与实时采集一致——记录里任意位置
//（进程归属包名 / TAG / 消息体 / PID）出现该词即整条保留，多行堆栈整条不拆。
// 流式读写，避免长会话的大文件一次性读进内存。
export const exportByPackage = async (
  deviceId: string,
  packageName: string,
  destPath: string
): Promise<number> => {
  const src = filePaths.get(deviceId);
  if (!src || !fs.existsSync(src)) {
    throw new Error('没有可导出的完整日志，请先开始日志采集');
  }
  const needle = packageName.trim().toLowerCase();
  if (!needle) {
    throw new Error('请先在「应用/包名」里填写要导出的包名');
  }

  const out = fs.createWriteStream(destPath, { flags: 'w', encoding: 'utf-8' });
  const rl = readline.createInterface({
    input: fs.createReadStream(src, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let record: string[] = [];
  let keep = false;
  let matched = 0;

  const flush = () => {
    if (record.length && keep) {
      out.write(record.join('\n') + '\n');
      matched++;
    }
    record = [];
    keep = false;
  };

  for await (const line of rl) {
    if (ENTRY_HEAD_RE.test(line)) {
      flush(); // 新记录开始，先结算上一条
      record.push(line);
      keep = line.toLowerCase().includes(needle);
    } else {
      // 续行（多行堆栈等）：归并到当前记录，命中也算整条命中
      record.push(line);
      if (!keep && line.toLowerCase().includes(needle)) keep = true;
    }
  }
  flush();

  await new Promise<void>((resolve, reject) => {
    out.on('error', reject);
    out.end(() => resolve());
  });
  return matched;
};

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
