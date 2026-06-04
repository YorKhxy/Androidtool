import * as path from 'path';

type AppPathResolver = {
  getAppPath(): string;
  isPackaged: boolean;
};

/**
 * 解析工具运行时根目录（可写数据/产物落盘锚点）。
 * - 打包态：exe 同级目录。
 * - 开发态：根据编译产物位置回推到项目根。
 * 一切落盘路径都从这里推导，禁止硬编码绝对路径/盘符（见 CLAUDE.md 路径铁律）。
 */
export function resolveRuntimeAppRoot(app: AppPathResolver): string {
  if (app.isPackaged) {
    return path.dirname(process.execPath);
  }

  const appPath = path.normalize(app.getAppPath());
  const distMainSuffix = path.normalize(path.join('dist', 'main', 'main'));
  if (appPath.endsWith(distMainSuffix)) {
    return path.resolve(appPath, '..', '..', '..');
  }

  const distSuffix = path.normalize(path.join('dist', 'main'));
  if (appPath.endsWith(distSuffix)) {
    return path.resolve(appPath, '..', '..');
  }

  return appPath;
}
