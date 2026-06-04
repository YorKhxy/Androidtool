import * as path from 'path';
import { protocol } from 'electron';

export const PERFORMANCE_MEDIA_SCHEME = 'adm-media';

export function registerPerformanceMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: PERFORMANCE_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        // 开 CORS：让带 crossOrigin 的离屏 <video> 抓帧绘到 canvas 不被跨域污染（视频快捷截图）。
        corsEnabled: true,
      },
    },
  ]);
}

export function registerPerformanceMediaProtocol(resolveAppRoot: () => string): void {
  if (protocol.isProtocolRegistered(PERFORMANCE_MEDIA_SCHEME)) {
    return;
  }

  const registered = protocol.registerFileProtocol(PERFORMANCE_MEDIA_SCHEME, (request, callback) => {
    try {
      const url = new URL(request.url);
      const relativePath = decodeURIComponent(`${url.host}${url.pathname}`)
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');

      // 放行旧短时录制目录与新采集会话目录（视频分段 + 快捷截图）。
      const allowedRoots = ['performance-recordings', 'performance-captures'];
      const matchedRoot = allowedRoots.find((root) => relativePath.startsWith(`${root}/`));
      if (!matchedRoot) {
        callback({ error: -10 });
        return;
      }

      const appRoot = resolveAppRoot();
      const mediaRoot = path.resolve(appRoot, matchedRoot);
      const resolvedPath = path.resolve(appRoot, relativePath);
      const relativeToRoot = path.relative(mediaRoot, resolvedPath);

      if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
        callback({ error: -10 });
        return;
      }

      callback({ path: resolvedPath });
    } catch {
      callback({ error: -2 });
    }
  });

  if (!registered) {
    throw new Error('Performance media protocol registration failed');
  }
}
