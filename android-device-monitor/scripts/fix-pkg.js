const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const winUnpackedDir = args[0];

if (!winUnpackedDir) {
  console.error('Usage: node fix-pkg.js <win-unpacked-dir>');
  process.exit(1);
}

const pkgPath = path.join(winUnpackedDir, 'resources', 'app', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.main = './main/index.js';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2), 'utf8');
console.log('Fixed package.json:', pkgPath);
