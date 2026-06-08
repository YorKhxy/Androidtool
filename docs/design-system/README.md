# 安卓设备监控 · Android Device Monitor — Design System

A design system for **安卓设备监控** (*Android Device Monitor*) — a Windows
desktop utility for managing a **fleet of Android devices** (the real-world use
case seen in the build is **Pico VR headsets** connected over WiFi) from one
window: **batch-install APKs, launch / stop / uninstall apps, mirror the screen,
profile performance, stream logcat, browse files, and control the device**. It is
the GUI shell around `adb` (platform-tools) and `scrcpy`.

> **One-line pitch:** connect a rack of headsets/phones over WiFi and drive them
> all — push apps, mirror, profile, log, manage files — without touching a terminal.

> The sampled screenshot shows two **Pico A9210** headsets (custom-named “WiFi 4”,
> “WiFi 7”) connected by IP, with 52 installed packages — mostly VR titles
> (`com.DefaultCompany.PicoClient`, `com.CYY.StarToursVR_Neo3`, …). The tool is
> equally a generic Android-device manager, but **batch app deployment to many
> wireless devices is the spine of the UX**.

---

## Sources

This system was reverse-engineered from a packaged Electron build (read-only,
mounted as `android-device-monitor/`). The reader is not assumed to have it, but
for reference:

| Source | Path / detail |
|---|---|
| App binary | `android-device-monitor/安卓设备监控.exe` (Electron, Windows) |
| App bundle | `resources/app.asar` → `dist/renderer/bundle.js` (React, **minified**) |
| Main process | `app.asar/dist/main/**` — `index.js`, `adb/ADBManager.js`, `scrcpy/scrcpyManager.js`, `preload.js`, `shared/ipc/channels.js` |
| Bundled tools | `resources/platform-tools/win` (adb), `resources/scrcpy/win` (scrcpy) |
| `package.json` | name `android-device-monitor`, **v1.0.12**, deps: `react@18`, `react-dom@18`, **`lucide-react@0.290`**, `adbkit`, `electron-updater` |
| Update server | self-hosted `generic` provider (`app-update.yml`) |

### ⚠️ Fidelity note (read this) — v2, trued-up
The renderer ships as a **single minified, single-line `bundle.js`** with **no
CSS file**, so styles could not be lifted from source. The **feature surface,
data model, copy/tone, IPC contract, and window config are extracted from real
source** (`channels.js`, `index.js`, the Chinese release notes).

The **visual tokens are colour-sampled from real screenshots**, and the
**设备 / 日志 / 性能 / 投屏 tabs are now verified against screenshots of the running
app** — theme is **dark indigo** (`#15162B` base, `#1E2138` panels) with a
**cornflower-blue** primary accent (`#5597DC`); green is a *semantic* colour only
(已连接 / 启动), alongside amber (关闭) and coral red (断开 / 卸载). Only the **网络
tab is an informed reconstruction** (not yet screenshotted). Verified product
specifics: 性能 surfaces **Pico-VR metrics** (FPS, CPU, MEM, GPU, MTP, FrmCpu,
FrmGpu, ATWGPU) and is idle until 开启采集; 投屏 opens an **external scrcpy
window** (the tab is start + settings + a Pico 6DoF caveat + usage notes, not an
embedded preview); 日志 has a rich toolbar (开始/暂停/导出完整日志/崩溃·ANR/到底部/自动滚动)
with V/D/I/W/E/F count chips. See the ASK.

---

## What the product does (feature surface)

Extracted verbatim from `shared/ipc/channels.js` + main-process handlers:

| Area | Capabilities |
|---|---|
| **设备 Devices + Apps** | left sidebar: **内置 ADB 已就绪** status, WiFi connect/pair, device cards (battery / 延迟 / 息屏·唤醒·解锁·重启·断开 / 文件管理), 设备信息, 历史设备. Tab body: **drag-drop APK install** (concurrency, allow-downgrade, target-device picker) + **已安装应用** list (launch / stop / uninstall, 运行中 badge, search) |
| **投屏 Screen Mirror** | opens an **external scrcpy window** (not embedded); res cap (720/1280/1920) + bitrate + “pipe device audio to PC”; Pico 6DoF caveat (only 2D touch injectable), single-eye crop |
| **性能 Performance** | **Pico-VR diagnostics** — FPS / CPU / MEM / GPU / MTP (motion-to-photon) / FrmCpu / FrmGpu / ATWGPU; idle until 开启采集; snapshots, 10/30/60s recordings, session export |
| **日志 Logcat** | live stream; 开始/暂停/清空, filter (level / package / tag / PID / regex), V/D/I/W/E/F count chips, 崩溃·ANR, export logs + *full* raw logs + by package |
| **应用 Apps** | drag-drop / multi-select APK install to chosen devices (concurrency, allow-downgrade), uninstall, list installed packages, launch, force-stop |
| **文件 Files** | browse device fs, pull / push (with progress), delete (batch + confirm), create folder, **resumable transfers** (journal-backed) |
| **控制 Control** | sleep, wake, unlock, reboot |
| **更新 Update** | check / download / quit-and-install, in-app version + release-notes popup |

Window: native framed `BrowserWindow` **1200×800** (min 800×600), standard
Windows title bar. The app's own top **header bar** holds the title `安卓设备监控`,
the version (blue link → release-notes; **`v1.0.14`** in the latest build) and a
**`检查更新`** button.
Below it the screen splits into a fixed **left device sidebar** (connect form,
device cards, 设备信息, 历史设备) and a **main panel with top tabs**:
`设备 / 日志 / 性能 / 网络 / 投屏`. The **设备** tab is app-centric — `应用安装`
(batch APK install to selected devices) over `已安装应用` (launch / stop /
uninstall per package). File management opens from each device card's
`文件管理` button.

---

## CONTENT FUNDAMENTALS

The product UI and code are **Simplified Chinese (zh-CN)**. Voice is that of a
**pragmatic Chinese developer talking to a peer** — terse, concrete, a little
informal.

**Casing & script.** All UI copy is Chinese; technical nouns stay in their
original form — `ADB`, `WiFi`, `APK`, `FPS`, `Activity`, `logcat`, `scrcpy`.
No Title Case concept; Latin acronyms are uppercase. Numbers + units run
together tightly: `1280`, `4M`, `20万条`, `0.5s`.

**Tone — terse, action-first, peer-to-peer.** Buttons are bare verbs or
verb+noun: `连接`, `断开`, `投屏`, `安装`, `导出`, `检查更新`, `按当前包名导出完整日志`
("export full logs for the current package"). Status is plain: `已是最新` (already
latest), `连接失败` (connection failed), `初始化完成前禁止操作` (no actions until init
finishes).

**Error/status messages name the action that failed.** Pattern: `<动作>失败` —
`获取 ADB 状态失败`, `安装 APK 失败`, `删除设备文件失败`, `抓取性能快照失败`,
`快照图片路径不在允许目录内`. Helpful, blunt, no apology.

**Code comments (internal voice) are candid and casual** — they say `你`/`朋友`
(you / your friend), explain trade-offs, use 省事 ("saves hassle"): e.g. *"用一个
稳定地址当默认…这样最省事"*, *"崩溃/强杀靠它兜底恢复"* (crash/force-kill falls back to
this for recovery). This informality is the brand's true personality.

**No emoji** anywhere in the product. Meaning is carried by **Lucide line
icons + color**, never by emoji or decorative unicode.

**Examples to imitate:**
- Primary action: `投屏` · `连接设备` · `导出完整日志`
- Toggle/affordance: `声音转发` · `按当前包名` · `批量删除`
- Confirm: `确定删除选中的 3 个文件？` (no fluff, states the count)
- Empty/online state: `未连接设备` · `设备已连接` · `已是最新版本`

---

## VISUAL FOUNDATIONS

A **dark, dense, utilitarian developer tool**. Think Android Studio's device
panel / Chrome DevTools energy, in a cool **indigo** key.

**Theme & color vibe.** Single dark theme in layered **indigo/navy** (note the
blue-violet tint — blue channel sits above red≈green): window `#15162B` →
sidebar `#181A30` → panels `#1E2138` → elevated inputs/menus `#272A45`. The
**primary accent is cornflower blue `#5597DC`** — solid blue buttons (`连接`,
`选择 APK`, `刷新`, `快速连接`), the active tab underline, links (`点此配对`, `延迟`),
and the selected device-card border. **Green is semantic, not the brand** —
`#54C084` for `已连接` / `启动` / battery / FPS. The rest of the status set is
amber `#DCA844` (`关闭` / warn), coral red `#E0746C` (`断开` / `卸载` / error),
blue `#5E9FD6` (info / 延迟), gold `#E8B339` (the 文件管理 folder icon), purple
`#A78BFA` (memory). Logcat keeps its own V/D/I/W/E/F ramp. Outline buttons
(colored text + matching 1px border on transparent) carry the per-app
launch/stop/uninstall actions.

**Typography.** Native Windows stack — **Segoe UI** for Latin, **Microsoft
YaHei** for CJK, **Cascadia Code / Consolas** for mono. Compact 13px base with a
tight 4px-derived scale; mono everywhere data is dense (logcat lines, file
sizes, metric read-outs, serials). Big tabular-num metrics (FPS/CPU%) at ~22px.
*(Browser previews substitute Noto Sans SC + JetBrains Mono — see caveat.)*

**Spacing & density.** Information-dense but not cramped. 4px base unit; device
cards and panels have comfortable 13–16px padding; list rows ~44px. Built for a
1200×800 window: fixed top header + fixed 360px left device sidebar + a scrolling
main panel.

**Layout rules.** Fixed **top header bar** (title + version + 检查更新), fixed
**left device sidebar** (~360px — connect form, device cards, 设备信息 key-values,
历史设备), and a **rounded main panel with a top tab bar** whose body switches per
tab. The mirror view letterboxes the device framebuffer on near-black `#0B0C16`
with a floating control toolbar; charts and tables fill their panels edge-to-edge.

**Backgrounds.** Flat solid indigo fills only — **no gradients, no imagery, no
textures, no patterns**. Depth comes from layered surfaces + hairline borders,
not shadows. The mirror canvas is the one "image" surface (live video).

**Borders, cards & elevation.** Cards/panels are defined by **1px hairline
borders** (`#2A2C47`/`#343A5A`) on a raised surface, radius **10px**; buttons &
inputs **6px**; tags/chips **4px**; badges/dots **pill**. The **selected device
card** gets a blue `#4A90D9` border (+1px ring). Shadows are reserved for things
that truly float — menus/popovers (`0 10px 28px rgba(0,0,0,.48)`) and modals
(`0 24px 64px rgba(0,0,0,.58)`) over a `rgba(8,9,18,.66)` scrim. Resting cards
cast **no shadow**.

**Transparency & blur.** Used sparingly: tinted soft fills for selected/active
states (`#5597DC26`, status `…1F`), and the modal scrim. No glassmorphism /
backdrop-blur as a motif.

**Hover / press / focus states.**
- *Hover:* rows/list items lighten to a solid `#2C3052`; icon buttons get a
  subtle wash; text links go from secondary to primary or accent; outline
  buttons fill with their own colour at ~12% (`启动` → green wash, `卸载` → red wash).
- *Active/selected:* `#313E63` blue-tinted surface; the active tab gets a 2px
  blue underline; the selected device card gets a blue `#4A90D9` border.
- *Press:* primary (blue) button darkens `#5597DC → #4285CB`; controls may
  nudge 1px, no scale-bounce.
- *Focus:* 2px blue ring offset from the base (`--ring-focus`). Keyboard-first
  friendly (it's a power tool).

**Motion.** Quick and functional — `110–170ms`, ease-out / standard easing.
Fades and short slides for menus, toasts, and panel switches. **No bounces, no
decorative looping animation** in a utility this dense. The only continuous
motion is *data*: streaming log lines and live-updating charts/meters.

**Imagery color vibe.** The only imagery is the live mirrored screen (true
device colors) and performance snapshot thumbnails — shown as-is, framed on
near-black, no filters/grain.

---

## ICONOGRAPHY

**Icon system: [Lucide](https://lucide.dev) (`lucide-react@0.290`) — confirmed
in `package.json`.** Thin 2px-stroke, rounded-join line icons; no fills, no
duotone, no emoji, no unicode glyphs. This is *the* icon language of the product.

- **Stroke & size:** 2px stroke (Lucide default), rendered ~16px in dense rows /
  nav, ~18–20px for primary toolbar actions, ~14px inline with small text.
- **Color:** inherit `currentColor` — `--fg-secondary` at rest, `--fg-primary`
  or `--accent` (blue) when active/hover, semantic colors for status (green
  已连接/启动, coral red 断开/卸载, amber 关闭) and **gold `#E8B339` for the
  文件管理 folder icon**.
- **In previews/HTML:** load Lucide from CDN (`https://unpkg.com/lucide@latest`)
  and call `lucide.createIcons()`, or use inline `<svg>` with Lucide paths. Do
  **not** hand-draw replacement icons or substitute emoji.

**Representative icons by area** (Lucide names): `smartphone` / `tablet`
(device), `usb`, `wifi`, `monitor-smartphone` / `cast` (投屏), `activity` /
`gauge` (performance), `cpu`, `memory-stick`, `scroll-text` / `terminal`
(logcat), `package` (apps), `folder` / `folder-tree` / `file` (files),
`upload` / `download` (transfers), `power`, `lock`, `rotate-cw` (reboot),
`moon` (sleep), `download-cloud` / `refresh-cw` (update), `trash-2`, `search`,
`x`, `chevron-right`, `circle` (status dot).

**Logo / brand mark.** The product has **no distinct wordmark asset** in the
build (the window title is just the text 安卓设备监控). For the design system we
treat the app name set in the brand font, paired with a Lucide
`monitor-smartphone` glyph in the **cornflower-blue accent** (`#5597DC`), as the
lockup. See `assets/` and the Brand cards. *If you have an official logo, share
it — see ASK.*

---

## Index / manifest

Root files:
- **`README.md`** — this file (context, content, visual foundations, iconography).
- **`colors_and_type.css`** — all design tokens (color, type, spacing, radii,
  elevation, motion) as CSS vars + semantic base rules. Import this first.
- **`SKILL.md`** — Agent-Skill front-matter so this folder is usable in Claude Code.
- **`assets/`** — brand lockup mark + any product imagery.
- **`preview/`** — small HTML cards that populate the Design System tab
  (type, color, spacing, components, brand).
- **`ui_kits/desktop-app/`** — high-fidelity React recreation of the desktop
  app: `index.html` (interactive click-through) + JSX components.

UI kits:
- **`ui_kits/desktop-app/`** — the (only) product surface: the Electron desktop
  window. Tabs: 设备 (apps — pixel-verified), 日志, 性能, 网络, 投屏, plus the
  device sidebar and a 文件管理 modal.

---

*Reconstructed by reading the real Electron build + screenshots of the 设备 /
日志 / 性能 / 投屏 tabs. Those tabs, the palette, and the copy are verified; only
the 网络 tab is an informed reconstruction.*
