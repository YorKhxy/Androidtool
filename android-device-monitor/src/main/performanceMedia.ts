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

      if (!relativePath.startsWith('performance-recordings/')) {
        callback({ error: -10 });
        return;
      }

      const appRoot = resolveAppRoot();
      const recordingsRoot = path.resolve(appRoot, 'performance-recordings');
      const resolvedPath = path.resolve(appRoot, relativePath);
      const relativeToRoot = path.relative(recordingsRoot, resolvedPath);

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
