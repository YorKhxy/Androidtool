const fs = require('fs');
const path = require('path');
const https = require('https');
const { pipeline } = require('stream/promises');
const { createWriteStream } = require('fs');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const PLATFORM_TARGETS = {
  win32: { key: 'win', archive: 'platform-tools-latest-windows.zip' },
  darwin: { key: 'darwin', archive: 'platform-tools-latest-darwin.zip' },
  linux: { key: 'linux', archive: 'platform-tools-latest-linux.zip' },
};

const hostPlatform = process.platform;
const target = PLATFORM_TARGETS[hostPlatform];

if (!target) {
  console.warn(`[adb:prepare] Unsupported host platform: ${hostPlatform}. Skip preparing bundled adb.`);
  process.exit(0);
}

const targetRoot = path.join(PROJECT_ROOT, 'vendor', 'platform-tools', target.key);
const archivePath = path.join(targetRoot, target.archive);
const adbExecutablePath = path.join(targetRoot, 'platform-tools', hostPlatform === 'win32' ? 'adb.exe' : 'adb');
const downloadUrl = `https://dl.google.com/android/repository/${target.archive}`;

const runExtractor = () => {
  if (hostPlatform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `Expand-Archive -LiteralPath '${archivePath.replace(/'/g, "''")}' -DestinationPath '${targetRoot.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: 'inherit' }
    );
    return;
  }

  if (hostPlatform === 'darwin') {
    execFileSync('ditto', ['-x', '-k', archivePath, targetRoot], { stdio: 'inherit' });
    return;
  }

  try {
    execFileSync('unzip', ['-o', archivePath, '-d', targetRoot], { stdio: 'inherit' });
  } catch {
    execFileSync('python3', ['-m', 'zipfile', '-e', archivePath, targetRoot], { stdio: 'inherit' });
  }
};

const downloadArchive = async () => {
  fs.mkdirSync(targetRoot, { recursive: true });
  console.log(`[adb:prepare] Downloading ${downloadUrl}`);

  const response = await new Promise((resolve, reject) => {
    https
      .get(downloadUrl, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          https
            .get(res.headers.location, resolve)
            .on('error', reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        resolve(res);
      })
      .on('error', reject);
  });

  await pipeline(response, createWriteStream(archivePath));
};

const main = async () => {
  if (fs.existsSync(adbExecutablePath)) {
    console.log(`[adb:prepare] Bundled adb already ready: ${adbExecutablePath}`);
    return;
  }

  await downloadArchive();
  runExtractor();

  if (!fs.existsSync(adbExecutablePath)) {
    throw new Error(`Bundled adb missing after extraction: ${adbExecutablePath}`);
  }

  fs.rmSync(archivePath, { force: true });
  console.log(`[adb:prepare] Bundled adb prepared: ${adbExecutablePath}`);
};

main().catch((error) => {
  console.error('[adb:prepare] Failed to prepare bundled adb.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
