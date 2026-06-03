# 自动更新（热更新）使用说明

本工具基于 **electron-updater** 实现自动更新：朋友端的 app 启动时会向「更新服务器」拉取版本信息，发现新版本就**后台增量下载**新安装包，提示用户重启即装上。打包内置的 adb / scrcpy 也随安装包整体更新。

> 注意：这是「下载新安装包 + 重启安装」式的自动更新，不是改 JS 的活体热补丁——因为包里带了 adb/scrcpy 等原生二进制，只有走完整安装包才稳。electron-updater 对 NSIS 支持差量下载，没变的部分不会重复下载，所以每次更新通常只有几 MB。

---

## 一、整体架构

```
你的电脑（开发 + 更新服务器）                朋友的电脑
┌─────────────────────────────┐          ┌────────────────────────┐
│ npm run dist  → dist/        │          │ 已安装的 app            │
│   安卓设备监控 Setup x.y.z.exe │  HTTP    │  启动时检查更新 ───────┐ │
│   latest.yml                 │ ◀────────┤  发现新版→后台下载     │ │
│   *.blockmap                 │  拉取     │  下完提示「重启更新」  │ │
│ npm run serve:updates ───────┼─────────▶│                        │ │
└─────────────────────────────┘          └────────────────────────┘
```

---

## 二、每次发新版本的流程

在 `android-device-monitor/` 目录下：

1. **改版本号**：把 `package.json` 的 `version` 往上加（如 `1.0.0` → `1.0.1`）。
   > electron-updater 只在「服务器版本 > 本机已安装版本」时才更新，所以版本号必须递增。

2. **打包**：
   ```bash
   npm run dist
   ```
   产物落在 `dist/`：`安卓设备监控 Setup x.y.z.exe`、`latest.yml`、`*.blockmap`（这三类是自动更新必需的）。

3. **启动更新服务器**（在作为「更新服务器」的那台电脑上，一般就是你开发这台）：

   **方式 A：双击脚本（推荐，最快）**
   - 启动：双击 `scripts\update-server-start.bat` —— 弹出窗口跑着服务器、显示日志。
   - 关闭：双击 `scripts\update-server-stop.bat`（按端口结束进程），或直接关掉那个窗口 / 在窗口里按 Ctrl+C。

   **方式 B：命令行**
   ```bash
   npm run serve:updates
   ```
   默认服务 `dist/` 目录、端口 `8384`、监听 `0.0.0.0`（局域网/穿透都能访问）。
   保持窗口开着；朋友的 app 启动时就能拉到更新。

   > 改了端口的话，`update-server-stop.bat` 里的 `PORT` 也要同步改成一样的值。

4. **朋友端**：下次打开 app 即自动检测 → 后台下载 → 右下角提示「新版本已就绪，立即重启更新」。无需你再传文件。

---

## 三、配置「更新源地址」（关键）

朋友的 app 要能访问到你的更新服务器。地址在三处可设，**优先级从高到低**：

1. **环境变量** `UPDATE_FEED_URL`（主要给开发期联调）
2. **用户配置文件** `update-config.json`，放在 app 的 userData 目录
   （Windows：`%APPDATA%\安卓设备监控\update-config.json`），内容：
   ```json
   { "url": "http://192.168.1.20:8384/" }
   ```
3. **打包默认地址**：`package.json` 的 `build.publish[0].url`（当前默认 `http://127.0.0.1:8384/`，仅本机可用）

### 怎么选地址？

- **朋友和你同一局域网**（同公司/同 WiFi）：用你这台电脑的**局域网 IP**，例如 `http://192.168.1.20:8384/`。
  （查 IP：`ipconfig` 看 IPv4 地址。）
- **朋友在外地走公网**：家用宽带一般没固定公网 IP，需要**内网穿透**（frp / cpolar / ngrok 等）把 `8384` 端口映射出去，拿到一个**稳定域名**（如 `http://abc.cpolar.io/`）。**强烈建议用带固定域名的穿透**，这样你家 IP 变了朋友也不用重装。
- **临时改地址不想重打包**：让朋友在上面第 2 条的 `update-config.json` 填新地址即可（或你预置好）。

> 建议：把一个**稳定地址**（固定局域网 IP，或固定穿透域名）直接写进 `package.json` 的 `build.publish[0].url` 再打首版，最省事。

---

## 四、首次分发

第一版还是要**手动发给朋友安装一次**（把 `安卓设备监控 Setup 1.0.0.exe` 发过去装上）。装上之后，以后的版本就全自动了，不用再传文件。

---

## 五、Windows 安全提示（SmartScreen）

当前未做代码签名（`signAndEditExecutable: false`）。朋友安装/更新时 Windows 可能弹「未知发布者」提示，点「更多信息 → 仍要运行」即可，不影响使用。

想彻底去掉这个提示需要购买**代码签名证书**（约 ¥1000+/年），属可选项；朋友间小范围使用可以不签。

---

## 六、开发期测试自动更新

未打包（`npm run dev` / `npm start`）时 electron-updater 默认不工作。要联调：

1. 在项目根 `android-device-monitor/` 放一个 `dev-app-update.yml`：
   ```yaml
   provider: generic
   url: http://127.0.0.1:8384/
   ```
2. 起更新服务器：`npm run serve:updates`
3. 用 `UPDATE_FEED_URL` 环境变量启动，触发检查逻辑：
   ```bash
   set UPDATE_FEED_URL=http://127.0.0.1:8384/ && npm start   # Windows cmd
   ```
   （`autoUpdate.ts` 在未打包但设了该环境变量时会走 `forceDevUpdateConfig` 测试路径。）

> 真实验收建议直接打两个版本（1.0.0、1.0.1）走「四」「二」的真机流程，最贴近线上。

---

## 七、相关代码位置

| 文件 | 作用 |
|------|------|
| `src/main/autoUpdate.ts` | 更新逻辑：配置 autoUpdater、解析更新源地址、事件转发到渲染层 |
| `src/main/index.ts` / `index-prod.ts` | 启动时 `initAutoUpdate` + `checkForUpdates`；`update:check` / `update:quit-and-install` 两个 IPC handler |
| `src/main/preload.js` / `src/renderer/lib/electronApi.ts` | IPC 契约：`onUpdateStatus` / `checkForUpdate` / `quitAndInstallUpdate` |
| `src/renderer/SimpleApp.tsx` | 右下角更新提示条（下载进度 / 「立即重启更新」） |
| `scripts/serve-updates.js` | 极简静态更新服务器（支持 Range，差量下载用） |
| `scripts/update-server-start.bat` / `update-server-stop.bat` | 双击启动 / 停止更新服务器（停止按端口结束进程） |
| `package.json` `build.publish` | generic provider 默认更新源地址 |
