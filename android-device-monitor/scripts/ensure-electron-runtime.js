const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const electronExe = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
const installer = path.join(projectRoot, 'node_modules', 'electron', 'install.js');

function copyDirectory(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, destinationPath);
    } else {
      fs.copyFileSync(sourcePath, destinationPath);
    }
  }
}

function restoreFromTempElectronRuntime() {
  const nodeModules = path.join(projectRoot, 'node_modules');
  if (!fs.existsSync(nodeModules)) return false;

  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('.electron-')) continue;
    const candidateDist = path.join(nodeModules, entry.name, 'dist');
    const candidateExe = path.join(candidateDist, 'electron.exe');
    if (!fs.existsSync(candidateExe)) continue;

    console.log(`[electron] Restoring runtime from cache: ${candidateDist}`);
    copyDirectory(candidateDist, path.dirname(electronExe));
    fs.writeFileSync(path.join(projectRoot, 'node_modules', 'electron', 'path.txt'), 'electron.exe');
    return fs.existsSync(electronExe);
  }

  return false;
}

if (fs.existsSync(electronExe)) {
  console.log(`[electron] Runtime ready: ${electronExe}`);
  process.exit(0);
}

if (restoreFromTempElectronRuntime()) {
  console.log(`[electron] Runtime restored: ${electronExe}`);
  process.exit(0);
}

if (!fs.existsSync(installer)) {
  console.error(`[electron] Installer missing: ${installer}`);
  process.exit(1);
}

console.log('[electron] Runtime missing. Installing Electron runtime...');
const mirrors = [
  undefined,
  'https://npmmirror.com/mirrors/electron/',
];

let lastStatus = 1;
for (const mirror of mirrors) {
  const env = { ...process.env };
  if (mirror) {
    env.ELECTRON_MIRROR = mirror;
    console.log(`[electron] Retrying with mirror: ${mirror}`);
  }

  const result = spawnSync(process.execPath, [installer], {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    env,
    timeout: 120000,
  });
  lastStatus = result.status || 1;

  if (result.status === 0 && fs.existsSync(electronExe)) {
    console.log(`[electron] Runtime installed: ${electronExe}`);
    process.exit(0);
  }
}

if (!fs.existsSync(electronExe)) {
  console.error(`[electron] Runtime still missing: ${electronExe}`);
  console.error('[electron] Network download failed. Check proxy/network, then retry the BAT.');
  process.exit(lastStatus);
}

console.log(`[electron] Runtime installed: ${electronExe}`);
