const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const rendererUrl = process.env.DEV_SERVER_URL || 'http://localhost:3000';
const mainEntry = path.join(projectRoot, 'dist', 'main', 'main', 'index.js');
const preloadEntry = path.join(projectRoot, 'dist', 'main', 'main', 'preload.js');
const electronPath = require('electron');
const deadlineMs = Date.now() + Number(process.env.DEV_START_TIMEOUT_MS || 60000);

function isUrlReady(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('error', () => resolve(false));
    request.setTimeout(1000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function fileExists(filePath) {
  try {
    return require('fs').existsSync(filePath);
  } catch {
    return false;
  }
}

async function waitUntilReady() {
  while (Date.now() < deadlineMs) {
    const rendererReady = await isUrlReady(rendererUrl);
    const mainReady = fileExists(mainEntry);
    const preloadReady = fileExists(preloadEntry);

    if (rendererReady && mainReady && preloadReady) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Development startup timed out. Check ${rendererUrl} and ${mainEntry}.`);
}

(async () => {
  try {
    console.log(`[dev] Waiting for renderer: ${rendererUrl}`);
    await waitUntilReady();
    console.log('[dev] Starting Electron...');

    const child = spawn(electronPath, ['.'], {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        ELECTRON_IS_DEV: 'true',
      },
    });

    child.on('exit', (code) => {
      process.exit(code || 0);
    });
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
})();
