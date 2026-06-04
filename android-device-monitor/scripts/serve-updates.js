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

// ───────────────────────── 防滥用（纯内网信任环境，不做鉴权，只防刷爆）─────────────────────────
// 全部可被环境变量覆盖。默认值按「几个熟人偶尔检查/下载更新」给，正常用绰绰有余，恶意刷会被拦。
const RL_WINDOW_MS = Number(process.env.RL_WINDOW_MS || 60_000); // 滑动窗口长度（毫秒）
const RL_MAX = {
  check: Number(process.env.RL_CHECK_MAX || 60), // 每窗口每 IP「检查更新」(latest.yml) 次数
  download: Number(process.env.RL_DOWNLOAD_MAX || 30), // 每窗口每 IP「下载」(exe/blockmap…) 次数
  report: Number(process.env.RL_REPORT_MAX || 120), // 每窗口每 IP「/__report 上报」次数
  other: Number(process.env.RL_OTHER_MAX || 120), // 其它请求
};
const MAX_CONN = Number(process.env.MAX_CONN || 100); // 服务器最大并发连接（超出直接不 accept）
const MAX_DOWNLOADS = Number(process.env.MAX_DOWNLOADS || 16); // 全局并发下载流上限
const MAX_DOWNLOADS_PER_IP = Number(process.env.MAX_DOWNLOADS_PER_IP || 3); // 单 IP 并发下载流上限
const SOCKET_TIMEOUT_MS = Number(process.env.SOCKET_TIMEOUT_MS || 30_000); // 单连接空闲/整请求超时（防 slowloris）

const REPORT_MSG_MAX = 200; // /__report 文本字段截断长度（防日志洪水/注入）

// 把请求路径归类到限流桶。
const bucketFor = (urlPath) => {
  if (urlPath === '/__report') return 'report';
  if (/\.ya?ml$/i.test(urlPath)) return 'check';
  if (/\.(exe|blockmap|zip|dmg|deb)$/i.test(urlPath)) return 'download';
  return 'other';
};

// 每 IP 滑动窗口计数：Map<ip, {check:[],download:[],report:[],other:[]}>，数组存命中时间戳。
const hits = new Map();
const sweepWindow = (arr) => {
  const cutoff = Date.now() - RL_WINDOW_MS;
  let i = 0;
  while (i < arr.length && arr[i] < cutoff) i++;
  if (i > 0) arr.splice(0, i);
  return arr;
};
// 命中则记录并放行，超限返回 false。
const rateAllow = (ip, bucket) => {
  let rec = hits.get(ip);
  if (!rec) {
    rec = { check: [], download: [], report: [], other: [] };
    hits.set(ip, rec);
  }
  const arr = sweepWindow(rec[bucket]);
  if (arr.length >= RL_MAX[bucket]) return false;
  arr.push(Date.now());
  return true;
};
// 定期清理空 IP 条目，避免 hits 表无限膨胀（被海量随机源 IP 刷时也不爆内存）。
setInterval(() => {
  for (const [ip, rec] of hits) {
    let empty = true;
    for (const k of Object.keys(rec)) {
      if (sweepWindow(rec[k]).length) empty = false;
    }
    if (empty) hits.delete(ip);
  }
}, RL_WINDOW_MS).unref();

// 并发下载计数（保护带宽与文件句柄）。
let activeDownloads = 0;
const activeByIp = new Map();
const incDownload = (ip) => {
  activeDownloads++;
  activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
};
const decDownload = (ip) => {
  activeDownloads = Math.max(0, activeDownloads - 1);
  const n = (activeByIp.get(ip) || 1) - 1;
  if (n <= 0) activeByIp.delete(ip);
  else activeByIp.set(ip, n);
};
// 以「下载计数」管控地把文件流 pipe 给响应：连接结束（正常完成或客户端中断）只扣减一次。
const streamFile = (stream, res, ip, isDownload) => {
  if (isDownload) {
    incDownload(ip);
    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      decDownload(ip);
    };
    res.on('close', release);
    stream.on('error', release);
  }
  stream.on('error', () => {
    try {
      res.destroy();
    } catch {
      /* noop */
    }
  });
  stream.pipe(res);
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

  const ip = clientIp(req);
  const bucket = bucketFor(urlPath);

  // ① 每 IP 限流：超出窗口配额直接 429（带 Retry-After），不再触碰文件系统。
  if (!rateAllow(ip, bucket)) {
    res.writeHead(429, {
      'Retry-After': Math.ceil(RL_WINDOW_MS / 1000),
      'Content-Type': 'text/plain',
    });
    res.end('Too Many Requests');
    logReq(req, 429, urlPath, ` [限流:${bucket}]`);
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
    // 上报字段一律截断 + 去掉换行/回车，防止有人刷 /__report 拿超长 msg 灌爆日志或伪造日志行（日志注入）。
    const clean = (s) => (s == null ? s : String(s).replace(/[\r\n]+/g, ' ').slice(0, REPORT_MSG_MAX));
    const v = clean(q.get('v')) || '?';
    const e = clean(q.get('e')) || '?';
    const to = clean(q.get('to'));
    const msg = clean(q.get('msg'));
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
    const isDownload = bucket === 'download';

    // 下载类请求做并发上限：全局与单 IP 同时在跑的下载流过多时返回 503（带 Retry-After），
    // 防止有人并发狂拉大安装包把上行带宽和文件句柄占满。检查更新(latest.yml)很轻，不受此限。
    if (isDownload && (activeDownloads >= MAX_DOWNLOADS || (activeByIp.get(ip) || 0) >= MAX_DOWNLOADS_PER_IP)) {
      res.writeHead(503, { 'Retry-After': 5, 'Content-Type': 'text/plain' });
      res.end('Server Busy');
      logReq(req, 503, urlPath, ' [并发下载上限]');
      return;
    }

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
        streamFile(fs.createReadStream(resolved, { start, end }), res, ip, isDownload);
        logReq(req, 206, urlPath, ` [${start}-${end}]`);
        return;
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    streamFile(fs.createReadStream(resolved), res, ip, isDownload);
    logReq(req, 200, urlPath);
  });
});

// ③ 连接与超时硬上限：防 slowloris（慢连接挂着耗光 socket）与连接耗尽。
server.maxConnections = MAX_CONN; // 超过即停止 accept 新连接
server.requestTimeout = SOCKET_TIMEOUT_MS; // 单个请求从收到到完成的最长时间
server.headersTimeout = Math.min(SOCKET_TIMEOUT_MS, 15_000); // 收齐请求头的最长时间（慢发头直接踢）
server.keepAliveTimeout = 5_000; // 空闲 keep-alive 连接的存活上限
server.on('connection', (socket) => {
  // 兜底：任何连接静默/卡住超过阈值就销毁，不给 slowloris 占坑。
  socket.setTimeout(SOCKET_TIMEOUT_MS, () => socket.destroy());
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
  console.log(
    `  防滥用：每 IP/${RL_WINDOW_MS / 1000}s 检查≤${RL_MAX.check} 下载≤${RL_MAX.download} 上报≤${RL_MAX.report}；` +
      `并发连接≤${MAX_CONN}，并发下载≤${MAX_DOWNLOADS}(单IP≤${MAX_DOWNLOADS_PER_IP})，连接超时${SOCKET_TIMEOUT_MS / 1000}s。`
  );
  console.log(`  以上阈值均可用环境变量覆盖（RL_CHECK_MAX / RL_DOWNLOAD_MAX / MAX_CONN / SOCKET_TIMEOUT_MS …）。`);
});
