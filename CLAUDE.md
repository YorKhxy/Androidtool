# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

The git root is `G:\Androidtool`, but the actual application is the npm project in `android-device-monitor/`. **Run all `npm` commands from inside `android-device-monitor/`**, not the repo root.

The repo root holds product/process docs only: `Product-Spec.md` (requirements), `CONTEXT.md` (domain glossary — read this before touching performance/Pico semantics), `DEV-PLAN.md`, `docs/adr/`. `AGENTS.md` is a Codex CLI skill-pack config (gitignored) and is unrelated to working with the application code.

Code, comments, product docs, and commit messages are written in **Chinese** — match that convention.

## 路径规范（共同开发约定）

本仓库由多人协作，每个人的克隆位置不同（一个人在 `G:\Androidtool`，另一个人可能在 `D:\projects\xxx` 或 `~/androidtool`）。**禁止在源码、脚本、配置、测试中硬编码任何绝对路径或盘符**（如 `G:\Androidtool\...`、`C:\Users\...`、`/Users/...`、`/home/...`），否则换一台机器就会因为路径找不到而崩溃——无论是开发运行还是打包发布。

铁律：

- **一切路径都从锚点动态推导**，不写死。常用锚点：
  - 仓库/模块内的文件 → `path.join(__dirname, ...)` 或 `path.resolve(__dirname, '..', ...)`（`scripts/` 和 `src/main` 已有大量这种写法，照抄）
  - Electron 运行时资源（打包后的 `extraResources`，如 bundled adb / scrcpy / platform-tools）→ `process.resourcesPath`（生产）与开发期的相对回退，二者都要覆盖，参考 `src/main/adb/adbBinary.ts`
  - 用户数据 / 录制 / 快照等可写目录 → `app.getPath('userData')` 等 Electron API，绝不写死磁盘位置（见 `CONTEXT.md`：UI 永远不暴露宿主绝对路径）
- **跨平台拼接用 `path.join` / `path.resolve`**，不要手写 `\` 或 `/` 字符串拼接；需要落到磁盘的字符串路径用 `path.sep` 处理分隔符。
- **配置文件里同样禁止绝对路径**：`package.json`、`electron-builder` 配置、`tsconfig*.json` 的 `paths`、webpack 配置等，一律用相对路径或项目内别名（`@/*` 已映射到 `src/*`）。
- **例外（这些不算"路径"，可以写死）**：URL（`http://localhost:3000`、下载源 URL）、设备端的 Android 路径（adb shell 内 `/sdcard/...`、`pm path` 输出）、正则表达式、字符串字面量。
- 文档里出现绝对路径仅用于"举例说明本机位置"（如本文件开头的 git root 示例）是可以的，但**代码和脚本不行**。

新增或修改涉及文件/资源定位的代码时，先确认它在别人的机器上、以及打包成安装包后仍能正确解析。Code Review 时把"有没有硬编码绝对路径"作为必查项。

## Commands (run from `android-device-monitor/`)

| Task | Command |
|------|---------|
| Install deps | `npm install` |
| Dev (watch + Electron) | `npm run dev` |
| Build everything | `npm run build` |
| Build main only | `npm run build:main` |
| Build renderer only | `npm run build:renderer` |
| Run packaged-style locally | `npm start` (requires a prior `npm run build`) |
| All tests | `npm test` |
| Single test by name | `npx jest -t "package entry points are configured"` |
| Single test file | `npx jest tests/smoke.test.js` |
| Download/refresh bundled adb | `npm run adb:prepare` |
| Package (unpacked dir) | `npm run pack` |
| Full installer | `npm run dist` |
| Release (Windows, recommended) | `npm run release` (runs `scripts/build-and-package.ps1`) |

`npm run dev` orchestrates three processes via `concurrently`: `tsc --watch` for the main process, `webpack serve` for the renderer on **port 3000**, and `scripts/start-dev-electron.js`, which polls until both the renderer URL and the compiled `dist/main/main/index.js`/`preload.js` exist before spawning Electron. There is no HMR for the main process — `start-dev-electron.js` waits for a one-time `build:main` and then tsc watch keeps it fresh, but you must relaunch Electron to pick up main-process changes.

## Architecture

Electron app with a strict main/renderer split connected only through a typed IPC contract.

**Main process** (`src/main/`, TypeScript → compiled by `tsc` with `tsconfig.main.json` to `dist/main/`, preserving the `src/main` path so the entry lands at `dist/main/main/index.js` = `package.json` `main`):
- `index.ts` — app bootstrap, window creation, and registration of **all `ipcMain.handle` handlers**. This is the hub: every renderer-callable operation has a handler here that delegates into `ADBManager`. (`index-prod.ts` is a parallel production-oriented entry; keep the two in sync when adding handlers.)
- `adb/ADBManager.ts` — the core engine. An `EventEmitter` that resolves and invokes the bundled `adb` binary, tracks connected devices (with a polling device monitor), streams logcat, samples performance, and parses network traffic. It composes specialized helpers rather than doing everything inline:
  - `adb/runtimeInspector.ts` — processes, activity stack, performance metrics, snapshot capture
  - `adb/performanceRecording.ts` (`PerformanceRecordingManager`) — short device-side `screenrecord` clips + sample timelines
  - `adb/picoMetrics.ts` — Pico/XR official-metric parsing
  - `adb/screenshotCapture.ts` — raw-framebuffer fast path with PNG `screencap` fallback
  - `adb/adbBinary.ts` — locates the bundled adb; `adb/adbError.ts` — `AdbCommandError` + `classifyAdbError` (handlers convert these into structured IPC error responses)
- `performanceSnapshots.ts`, `performanceSessionExport.ts`, `performanceMedia.ts` — snapshot persistence, session export (xlsx-style workbook), and a **custom Electron protocol** that maps `performance-recordings/...` relative paths to on-disk files. The UI never sees host absolute paths (see `CONTEXT.md`).

**IPC contract** (the seam between processes — changing a channel means editing all three of these):
1. `src/shared/ipc/channels.ts` — the `IPC_CHANNELS` constant, the single source of truth for channel names.
2. `src/main/preload.js` — `contextBridge` exposes `window.electronAPI` with one method per channel (invoke wrappers + `on*` event subscriptions that return unsubscribe functions). **This is plain JS** and is copied to `dist` by `scripts/copy-preload.js` during `build:main`, not compiled by tsc.
3. `src/renderer/lib/electronApi.ts` — renderer-side typed wrapper over `window.electronAPI`.

**Renderer** (`src/renderer/`, React 18 + TailwindCSS, bundled by webpack with `tsconfig.renderer.json`): entry `index.tsx` mounts `SimpleApp.tsx` (the real root — `TestApp.tsx` is scratch). Feature UIs live in `components/` (`PerformancePanel.tsx`, `NetworkPanel.tsx`). `@/*` resolves to `src/*` in both tsconfigs and webpack.

**Shared types** (`src/shared/types/index.ts`) are imported by both sides; keep IPC payload types here.

## Bundled adb

The app ships its own `adb` rather than relying on the user's PATH. `scripts/prepare-platform-tools.js` downloads Google's `platform-tools` zip for the host OS into `vendor/platform-tools/<os>/` (skipped if already present), and `electron-builder` copies it as an `extraResources` `platform-tools/` folder. `vendor/platform-tools/**` is gitignored. `ADBManager`/`adbBinary.ts` resolve this bundled binary at runtime.

## Logcat batching

Logcat is high-volume, so the main process does not forward lines one-by-one. `index.ts` enqueues entries and flushes them to the renderer in batches (`LOG_BATCH` channel, max 200 per batch / 250ms interval, queue capped at 1000) — see `enqueueLogForRenderer`/`flushLogQueue`. When adding log-like streaming, follow this batching pattern instead of per-event `webContents.send`.

## Tests

Jest with `testEnvironment: node`. The existing `tests/smoke.test.js` asserts structural invariants (entry files exist, `package.json` scripts and the packaging scripts reference the right build steps) rather than behavior — when you change build wiring, entry points, or packaging scripts, update these assertions. `dist/`, `node_modules/`, and `src/release/` are excluded from test discovery.
