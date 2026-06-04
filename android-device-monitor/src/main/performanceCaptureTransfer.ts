import AdmZip from 'adm-zip';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// 采集会话的导出/导入打包（Phase 14 迭代）。
// 导出：把整个会话目录打成 zip，zip 内顶层目录名 = sessionId，便于解压后还原成会话文件夹。
// 导入：解压到临时目录后，定位含 manifest.json 的会话目录交给 store 落地（store 负责 id 去重与改写）。

/** 把会话目录打包成 zip（顶层目录为 sessionId）。 */
export function zipSessionDir(sessionDir: string, destZipPath: string): void {
  const zip = new AdmZip();
  zip.addLocalFolder(sessionDir, path.basename(sessionDir));
  zip.writeZip(destZipPath);
}

/** 在 root 自身或其一层子目录中定位含 manifest.json 的会话目录。 */
async function locateManifestDir(root: string): Promise<string | null> {
  const hasManifest = async (dir: string) => {
    try {
      await fs.access(path.join(dir, 'manifest.json'));
      return true;
    } catch {
      return false;
    }
  };
  if (await hasManifest(root)) return root;
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && (await hasManifest(path.join(root, entry.name)))) {
      return path.join(root, entry.name);
    }
  }
  return null;
}

/** 解压 zip 到临时目录并定位会话目录；用完务必调用 cleanup 删临时目录。 */
export async function extractZipToSessionDir(
  zipPath: string
): Promise<{ sessionDir: string; cleanup: () => Promise<void> }> {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'adm-capture-import-'));
  const cleanup = () => fs.rm(tempRoot, { recursive: true, force: true });
  try {
    new AdmZip(zipPath).extractAllTo(tempRoot, true);
  } catch (error) {
    await cleanup();
    throw new Error(`zip 解压失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const sessionDir = await locateManifestDir(tempRoot);
  if (!sessionDir) {
    await cleanup();
    throw new Error('zip 内未找到采集会话（缺少 manifest.json）');
  }
  return { sessionDir, cleanup };
}
