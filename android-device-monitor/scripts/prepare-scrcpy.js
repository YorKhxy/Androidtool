const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');
const { execFileSync } = require('child_process');

// scrcpy 官方仅提供 Windows 预编译包（win64）。
// macOS / Linux 由各自包管理器分发，暂不随应用打包，保持与项目“Windows 优先”的现状一致。
const SCRCPY_VERSION = '3.3.4';
const PROJECT_ROOT = path.resolve(__dirname, '..');

const WIN_ARCHIVE = `scrcpy-win64-v${SCRCPY_VERSION}.zip`;
const WIN_DOWNLOAD_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/${WIN_ARCHIVE}`;

const hostPlatform = process.platform;

if (hostPlatform !== 'win32') {
  console.warn(`[scrcpy:prepare] 当前平台 ${hostPlatform} 暂不随应用打包 scrcpy，跳过。`);
  process.exit(0);
}

const targetRoot = path.join(PROJECT_ROOT, 'vendor', 'scrcpy', 'win');
const archivePath = path.join(targetRoot, WIN_ARCHIVE);
const scrcpyExecutablePath = path.join(targetRoot, 'scrcpy.exe');

// 跟随重定向下载（GitHub release 会 302 到带签名的对象存储地址）。
const downloadToFile = (url, destPath, redirectsLeft = 5) =>
  new Promise((resolve, reject) => {
    if (redirectsLeft < 0) {
      reject(new Error('Too many redirects'));
      return;
    }

    https
      .get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadToFile(res.headers.location, destPath, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        pipeline(res, createWriteStream(destPath)).then(resolve, reject);
      })
      .on('error', reject);
  });

const extractArchive = () => {
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetRoot.replace(
        /'/g,
        "''"
      )}' -Force`,
    ],
    { stdio: 'inherit' }
  );
};

// Expand-Archive 解出的是顶层目录 scrcpy-win64-vX.Y.Z/，把其内容上提到 targetRoot，
// 使 scrcpy.exe 落在固定路径 vendor/scrcpy/win/scrcpy.exe，二进制定位不依赖版本号。
const flattenExtractedDir = () => {
  const extractedDir = path.join(targetRoot, `scrcpy-win64-v${SCRCPY_VERSION}`);
  if (!fs.existsSync(extractedDir)) {
    return;
  }

  for (const entry of fs.readdirSync(extractedDir)) {
    const sourcePath = path.join(extractedDir, entry);
    const destPath = path.join(targetRoot, entry);
    fs.rmSync(destPath, { recursive: true, force: true });
    fs.renameSync(sourcePath, destPath);
  }

  fs.rmSync(extractedDir, { recursive: true, force: true });
};

const main = async () => {
  if (fs.existsSync(scrcpyExecutablePath)) {
    console.log(`[scrcpy:prepare] 内置 scrcpy 已就绪：${scrcpyExecutablePath}`);
    return;
  }

  fs.mkdirSync(targetRoot, { recursive: true });
  console.log(`[scrcpy:prepare] 下载 ${WIN_DOWNLOAD_URL}`);
  await downloadToFile(WIN_DOWNLOAD_URL, archivePath);

  extractArchive();
  flattenExtractedDir();

  if (!fs.existsSync(scrcpyExecutablePath)) {
    throw new Error(`解压后未找到 scrcpy 可执行文件：${scrcpyExecutablePath}`);
  }

  fs.rmSync(archivePath, { force: true });
  console.log(`[scrcpy:prepare] 内置 scrcpy 准备完成：${scrcpyExecutablePath}`);
};

main().catch((error) => {
  console.error('[scrcpy:prepare] 准备内置 scrcpy 失败。');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
