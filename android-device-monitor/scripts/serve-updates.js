/* eslint-disable */
// 极简「热更新服务器」：把打包产物目录（默认项目内 dist/）通过 HTTP 暴露出去，
// 供朋友端 app 的 electron-updater 拉取 latest.yml 与安装包做自动更新。
//
// 用法（在 android-device-monitor/ 下）：
//   npm run serve:updates                 # 默认服务 update-releases/latest，端口 8384，监听 0.0.0.0
//   PORT=9000 npm run serve:updates       # 自定义端口
//   node ./scripts/serve-updates.js update-releases/latest 8384
//
// 要点：
//  - 监听 0.0.0.0，局域网/内网穿透均可访问；朋友端把更新源 URL 指到 http://<你的地址>:<端口>/
//  - 支持 HTTP Range（206），electron-updater 的差量下载依赖它
//  - 路径不硬编码：从 __dirname 推导项目目录（换机器/换盘符都不受影响）
//  - 只读静态服务，不暴露 dist 以外目录（防目录穿越）

const http = require('http');
const fs = require('fs');
const path = require('path');

// 默认服务 update-releases/latest（make-update-package 每次打包刷新它，只含最新一版的干净产物）。
const servedDirArg = process.argv[2] || 'update-releases/latest';
const port = Number(process.env.PORT || process.argv[3] || 8384);
// 从脚本所在位置推导项目根，再定位服务目录，不写死绝对路径。
const root = path.resolve(__dirname, '..', servedDirArg);

const CONTENT_TYPES = {
  '.yml': 'text/yaml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
  '.zip': 'application/zip',
  '.dmg': 'application/octet-stream',
  '.deb': 'application/octet-stream',
  '.json': 'application/json; charset=utf-8',
};

const server = http.createServer((req, res) => {
  // 取出 path 部分并解码，去掉查询串。
  let urlPath;
  try {
    urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  } catch {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  // 解析到服务目录内，拒绝目录穿越（解析结果必须仍在 root 下）。
  const resolved = path.resolve(root, '.' + urlPath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(resolved, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not Found');
      console.log(`404 ${urlPath}`);
      return;
    }

    const type = CONTENT_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;

    // 处理 Range 请求（差量下载需要）。
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
        if (start > end || end >= stat.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(resolved, { start, end }).pipe(res);
        console.log(`206 ${urlPath} [${start}-${end}]`);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(resolved).pipe(res);
    console.log(`200 ${urlPath}`);
  });
});

if (!fs.existsSync(root)) {
  console.warn(`[serve-updates] 警告：服务目录不存在：${root}\n  先执行 npm run dist 生成安装包与 latest.yml。`);
}

server.listen(port, '0.0.0.0', () => {
  console.log(`[serve-updates] 更新服务器已启动`);
  console.log(`  服务目录：${root}`);
  console.log(`  本机访问：http://127.0.0.1:${port}/`);
  console.log(`  局域网内朋友访问：http://<你这台电脑的局域网IP>:${port}/`);
  console.log(`  把朋友端 app 的更新源指向上面的地址即可（默认已配置 127.0.0.1，对外需改成可达地址）。`);
});
