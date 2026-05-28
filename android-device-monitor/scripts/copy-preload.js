const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
const sourcePath = path.join(projectRoot, 'src', 'main', 'preload.js');
const targetDir = path.join(projectRoot, 'dist', 'main', 'main');
const targetPath = path.join(targetDir, 'preload.js');

if (!fs.existsSync(sourcePath)) {
  throw new Error(`Preload source not found: ${sourcePath}`);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(sourcePath, targetPath);

console.log(`[copy-preload] Copied preload to ${targetPath}`);
