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

// 客户端 IP（去掉 IPv6 映射前缀 ::ffff:），用于显示是哪台 PC 来检查/下载更新。
const clientIp = (req) => {
  const ip = (req.socket && req.socket.remoteAddress) || '';
  return ip.replace(/^::ffff:/, '') || '未知IP';
};
const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
// 按请求路径+状态码标注客户端动作。注意：旧版 .blockmap 的 404 是 electron-updater 增量更新
// 探测旧版块图未命中、随后自动回退完整下载的正常现象，单独标注以免误以为出错。
const actionLabel = (urlPath, code) => {
  if (code === 404 && /\.blockmap$/i.test(urlPath)) return '   <= 增量探测未命中（正常，回退完整下载）';
  if (/latest.*\.yml$/i.test(urlPath)) return '   <= 检查更新';
  if (/\.exe$/i.test(urlPath) || /\.blockmap$/i.test(urlPath)) return '   <= 下载更新（热更中）';
  return '';
};
const logReq = (req, code, urlPath, extra) => {
  console.log(`[${stamp()}] ${clientIp(req)}  ${code} ${urlPath}${extra || ''}${actionLabel(urlPath, code)}`);
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

  // 客户端更新状态上报端点（不走文件服务，仅记录到控制台），用于判断朋友更新成功/失败。
  if (urlPath === '/__report') {
    let q;
    try {
      q = new URL(req.url, 'http://x').searchParams;
    } catch {
      q = new URLSearchParams();
    }
    const v = q.get('v') || '?';
    const e = q.get('e') || '?';
    const to = q.get('to');
    const msg = q.get('msg');
    let label;
    if (e === 'startup') label = `运行中 版本=${v}`;
    else if (e === 'downloaded') label = `已下载新版 目标=${to || '?'}（待重启安装）`;
    else if (e === 'error') label = `更新失败：${msg || ''}`;
    else label = `${e} 版本=${v}`;
    console.log(`[${stamp()}] ${clientIp(req)}  * 上报 ${label}`);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
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
      logReq(req, 404, urlPath);
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
        logReq(req, 206, urlPath, ` [${start}-${end}]`);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(resolved).pipe(res);
    logReq(req, 200, urlPath);
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
