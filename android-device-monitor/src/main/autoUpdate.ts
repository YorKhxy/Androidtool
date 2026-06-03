import { app, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { autoUpdater } from 'electron-updater';
import { logger } from './logger';
import { IPC_CHANNELS } from '../shared/ipc/channels';
import type { UpdateStatus } from '../shared/types';

// 应用自动更新（热更新）。基于 electron-updater 的 generic provider：
// 朋友端的 app 定时向「更新服务器」（你自己 PC 上起的 HTTP 服务）拉取 latest.yml，
// 发现新版本就后台增量下载新安装包，提示用户重启即装上。打包内置的 adb/scrcpy 也随安装包整体更新。
//
// 更新源地址解析顺序（便于你换 IP / 内网穿透地址时无需重新打包发给朋友）：
//   1) 环境变量 UPDATE_FEED_URL（主要给开发期测试用）
//   2) userData/update-config.json 里的 { "url": "http://..." }
//   3) 打包时 package.json build.publish 写入的默认地址（app-update.yml）
// 推荐做法：用一个「稳定地址」当默认（局域网固定 IP，或带固定域名的内网穿透），这样最省事。

let configured = false;

const resolveFeedUrl = (): string | null => {
  if (process.env.UPDATE_FEED_URL) {
    return process.env.UPDATE_FEED_URL;
  }
  try {
    const raw = fs.readFileSync(path.join(app.getPath('userData'), 'update-config.json'), 'utf-8');
    const cfg: unknown = JSON.parse(raw);
    if (cfg && typeof cfg === 'object' && typeof (cfg as { url?: unknown }).url === 'string') {
      const url = (cfg as { url: string }).url;
      if (url) return url;
    }
  } catch {
    /* 配置不存在或损坏，回退到打包默认地址 */
  }
  return null;
};

const send = (getWindow: () => BrowserWindow | null, status: UpdateStatus): void => {
  getWindow()?.webContents.send(IPC_CHANNELS.UPDATE_STATUS, status);
};

// electron-updater 的 releaseNotes 可能是字符串，或 [{version, note}] 数组（多版本累计）；统一成纯文本。
const normalizeReleaseNotes = (notes: unknown): string | undefined => {
  if (!notes) return undefined;
  if (typeof notes === 'string') return notes.trim() || undefined;
  if (Array.isArray(notes)) {
    const text = notes
      .map((n) => {
        const item = n as { version?: string; note?: string | null };
        const head = item.version ? `v${item.version}` : '';
        return [head, item.note ?? ''].filter(Boolean).join('\n');
      })
      .filter(Boolean)
      .join('\n\n');
    return text.trim() || undefined;
  }
  return undefined;
};

// 初始化：配置 autoUpdater、覆盖更新源、绑定事件转发到渲染层。只执行一次。
export const initAutoUpdate = (getWindow: () => BrowserWindow | null): void => {
  if (configured) return;
  configured = true;

  autoUpdater.autoDownload = true; // 发现新版本即后台下载
  autoUpdater.autoInstallOnAppQuit = true; // 退出时自动安装已下好的更新
  // electron-updater 期望 logger 含 info/warn/error/debug，这里适配项目 logger。
  autoUpdater.logger = {
    info: (...args: unknown[]) => logger.log(...args),
    warn: (...args: unknown[]) => logger.warn(...args),
    error: (...args: unknown[]) => logger.error(...args),
    debug: () => undefined,
  } as unknown as typeof autoUpdater.logger;

  const overrideUrl = resolveFeedUrl();
  if (overrideUrl) {
    autoUpdater.setFeedURL({ provider: 'generic', url: overrideUrl });
    logger.log('autoUpdate: feed url overridden ->', overrideUrl);
  }

  autoUpdater.on('checking-for-update', () => send(getWindow, { state: 'checking' }));
  autoUpdater.on('update-available', (info) => send(getWindow, { state: 'available', version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) }));
  autoUpdater.on('update-not-available', () => send(getWindow, { state: 'not-available' }));
  autoUpdater.on('download-progress', (p) => send(getWindow, { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => send(getWindow, { state: 'downloaded', version: info.version, releaseNotes: normalizeReleaseNotes(info.releaseNotes) }));
  autoUpdater.on('error', (err) => send(getWindow, { state: 'error', error: err instanceof Error ? err.message : String(err) }));
};

// 触发一次检查。开发期（未打包）默认跳过，除非显式设了 UPDATE_FEED_URL 做联调。
export const checkForUpdates = (): void => {
  if (!app.isPackaged && !process.env.UPDATE_FEED_URL) {
    return;
  }
  if (!app.isPackaged) {
    // 开发期联调：用项目根目录的 dev-app-update.yml + 环境变量强制走更新逻辑。
    autoUpdater.forceDevUpdateConfig = true;
  }
  autoUpdater.checkForUpdates().catch((err) => logger.warn('autoUpdate: check failed:', err));
};

// 立即退出并安装已下载好的更新（由渲染层「重启更新」按钮触发）。
export const quitAndInstallUpdate = (): void => {
  autoUpdater.quitAndInstall();
};
