/* Mock data for the 安卓设备监控 UI kit. */

/* The real fleet is Pico VR headsets managed over WiFi (custom-named). */
const DEVICES_SEED = [
  { id: "192.168.1.39:5555", name: "WiFi 4", model: "A9210", brand: "Pico",
    type: "headset", conn: "wifi", android: "14", api: 34, abi: "arm64-v8a",
    battery: 100, latency: 48, serial: "PA9410MGK3220149G" },
  { id: "192.168.1.60:5555", name: "WiFi 7", model: "A9210", brand: "Pico",
    type: "headset", conn: "wifi", android: "14", api: 34, abi: "arm64-v8a",
    battery: 27, latency: 60, serial: "PA9410MGJB250251G" },
];

const HISTORY = [
  { name: "sparrow", serial: "PA9410MGJ9270415G", lastAddr: "192.168.1.10:5555", lastSeen: "2026-06-02 14:33" },
  { name: "Quest-Lab-02", serial: "1WMHHA10K2031C", lastAddr: "192.168.1.22:5555", lastSeen: "2026-05-31 19:08" },
];

const INSTALLED_APPS = [
  { pkg: "cn.com.1bekeepserver", running: true }, { pkg: "com.CloudM.GenZheZou6X10" },
  { pkg: "com.CYY.StarToursVR_Neo3", running: true }, { pkg: "com.DefaultCompany.PicoClient" },
  { pkg: "com.DefaultCompany.VRUtils" }, { pkg: "com.easyar.mega.xrtest" },
  { pkg: "com.LCYM.OperationThunderbolt.LargeSpace.PvP.Device" }, { pkg: "com.mobis.AgeOfDinosaurs" },
  { pkg: "com.mobis.DeoxysDive" }, { pkg: "com.mobis.MCut_Boxing" }, { pkg: "com.mobis.MCut_Tennis" },
  { pkg: "com.pico.ToBControlCenter", running: true }, { pkg: "com.picovr.assistantphone" },
  { pkg: "com.picoxr.BusinessSettings" }, { pkg: "com.unity.template.vr" },
  { pkg: "com.YVR.ParadiseVR" }, { pkg: "com.zhiyun.LightSaberVR" }, { pkg: "com.skyworth.launcher" },
  { pkg: "com.android.chrome" }, { pkg: "com.htc.vr.unity" }, { pkg: "com.oculus.vrshell" },
  { pkg: "com.syc.SuperHotVR" },
];

const PACKAGES = [
  { pkg: "com.example.shop", label: "示例商城", pid: 8841, fg: true },
  { pkg: "com.android.chrome", label: "Chrome", pid: 7210, fg: false },
  { pkg: "com.tencent.mm", label: "微信", pid: 6633, fg: false },
  { pkg: "com.example.player", label: "视频播放器", pid: 9102, fg: false },
];

const PROCESSES = [
  { name: "com.example.shop", pid: 8841, cpu: 23.4, mem: 418, threads: 42, state: "fg" },
  { name: "system_server", pid: 1422, cpu: 11.2, mem: 286, threads: 188, state: "sys" },
  { name: "com.android.systemui", pid: 1880, cpu: 6.8, mem: 204, threads: 64, state: "sys" },
  { name: "surfaceflinger", pid: 612, cpu: 5.1, mem: 96, threads: 24, state: "sys" },
  { name: "com.android.chrome", pid: 7210, cpu: 3.4, mem: 332, threads: 51, state: "bg" },
  { name: "com.tencent.mm", pid: 6633, cpu: 1.2, mem: 298, threads: 73, state: "bg" },
];

const ACTIVITY_STACK = [
  { name: "com.example.shop/.CheckoutActivity", state: "RESUMED", top: true },
  { name: "com.example.shop/.CartActivity", state: "STOPPED" },
  { name: "com.example.shop/.ProductActivity", state: "STOPPED" },
  { name: "com.example.shop/.MainActivity", state: "STOPPED" },
];

const NETWORK = [
  { method: "GET", code: 200, url: "/v2/feed?page=1", size: "18.4 KB", ms: 142 },
  { method: "POST", code: 200, url: "/v2/cart/add", size: "0.4 KB", ms: 88 },
  { method: "GET", code: 304, url: "/v2/profile", size: "0 KB", ms: 31 },
  { method: "GET", code: 500, url: "/v2/recommend", size: "1.1 KB", ms: 612 },
  { method: "GET", code: 200, url: "/img/p/8841.webp", size: "44.2 KB", ms: 209 },
];

const LOG_TAGS = ["ActivityManager", "Choreographer", "OkHttp", "AndroidRuntime",
  "InputDispatcher", "WindowManager", "art", "GraphicsEnv", "ViewRootImpl", "BufferQueue"];
const LOG_LEVELS = ["V", "D", "I", "I", "I", "W", "D", "E"];
const LOG_MSGS = [
  "Displayed com.example.shop/.CheckoutActivity: +312ms",
  "Skipped 31 frames! Main thread doing too much work.",
  "--> GET https://api.example.com/v2/feed (18.4KB)",
  "onMeasure width=1080 height=2400",
  "dispatchPointer MotionEvent ACTION_DOWN (412, 980)",
  "relayoutWindow result=0x7 surface valid",
  "GC freed 4821 objects, 1.2MB in 6ms",
  "Compiler allocated 3MB to compile void run()",
  "Background concurrent copying GC freed 12MB",
  "WIFI scan results updated: 14 networks",
];

let _logSeq = 0;
function makeLogLine(ts) {
  const lvl = LOG_LEVELS[(Math.random() * LOG_LEVELS.length) | 0];
  const tag = LOG_TAGS[(Math.random() * LOG_TAGS.length) | 0];
  const msg = LOG_MSGS[(Math.random() * LOG_MSGS.length) | 0];
  const d = ts || new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return { id: ++_logSeq, ts: `${hh}:${mm}:${ss}.${ms}`, lvl, tag, msg, pid: 8841 };
}
const INITIAL_LOGS = Array.from({ length: 16 }, () => makeLogLine());

const LOG_COLORS = {
  V: "var(--log-verbose)", D: "var(--log-debug)", I: "var(--log-info)",
  W: "var(--log-warn)", E: "var(--log-error)", F: "var(--log-fatal)",
};

const FILES = {
  "/sdcard": [
    { name: "DCIM", dir: true, size: "—", mtime: "2026-06-01 09:12" },
    { name: "Download", dir: true, size: "—", mtime: "2026-06-03 18:44" },
    { name: "Android", dir: true, size: "—", mtime: "2026-05-28 11:02" },
    { name: "Pictures", dir: true, size: "—", mtime: "2026-06-02 21:30" },
    { name: "Movies", dir: true, size: "—", mtime: "2026-05-20 14:18" },
    { name: "backup-0604.zip", dir: false, size: "248 MB", mtime: "2026-06-04 08:55" },
    { name: "scrcpy-rec.mp4", dir: false, size: "82.4 MB", mtime: "2026-06-04 10:21" },
    { name: "config.json", dir: false, size: "2.1 KB", mtime: "2026-06-01 07:40" },
  ],
  "/sdcard/Download": [
    { name: "app-release.apk", dir: false, size: "44.8 MB", mtime: "2026-06-03 18:44" },
    { name: "invoice-2026.pdf", dir: false, size: "318 KB", mtime: "2026-06-03 12:10" },
    { name: "report.csv", dir: false, size: "96 KB", mtime: "2026-06-02 16:03" },
  ],
  "/sdcard/DCIM": [
    { name: "Camera", dir: true, size: "—", mtime: "2026-06-04 07:30" },
    { name: "Screenshots", dir: true, size: "—", mtime: "2026-06-04 10:02" },
  ],
};

function genSeries(n, base, jitter, min, max) {
  const out = []; let v = base;
  for (let i = 0; i < n; i++) {
    v += (Math.random() - 0.5) * jitter;
    v = Math.max(min, Math.min(max, v));
    out.push(Math.round(v * 10) / 10);
  }
  return out;
}

Object.assign(window, {
  DEVICES_SEED, HISTORY, INSTALLED_APPS, PACKAGES, PROCESSES, ACTIVITY_STACK, NETWORK,
  INITIAL_LOGS, LOG_COLORS, makeLogLine, FILES, genSeries,
});
