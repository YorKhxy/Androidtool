# UI Kit · 安卓设备监控 Desktop App

A high-fidelity, interactive recreation of the **安卓设备监控** (Android Device
Monitor) Electron desktop window. Open `index.html`.

> **Fidelity note.** Visual tokens are colour-sampled from real screenshots, and
> the **设备 / 日志 / 性能 / 投屏 tabs are verified against screenshots** of the
> running app (dark indigo + cornflower-blue `#5597DC`, green semantic-only).
> 性能 carries **Pico-VR metrics** (MTP, ATW, frame timings); 投屏 opens an
> external scrcpy window so the tab is controls + a Pico caveat, not a preview.
> Only the **网络 tab is an informed reconstruction**. Features, IPC surface, and
> Chinese copy are reverse-engineered from real source.

## What it does (click-through)
- **设备 Devices** (verified) — left sidebar lists connected devices (Pico VR
  headsets over WiFi); the tab body is `应用安装` (batch-install APKs to selected
  devices) + `已安装应用` (launch / stop / uninstall per package, with search).
- **日志 Logcat** — live colour-coded stream; filter by text, level, package;
  pause / clear / export; auto-scroll with a "scrolled up" indicator.
- **性能 Performance** — live FPS / CPU / memory / battery cards with updating
  charts; tabs for 进程, Activity 栈, 网络请求.
- **网络 Network** — captured request table (method / URL / status / size / time).
- **投屏 Mirror** — device framebuffer (neutral placeholder) letterboxed on
  near-black with a floating scrcpy control bar; resolution / bitrate / `声音转发`.
- **文件管理** opens as a modal from each device card's folder button.
- Click the **v1.0.12** version in the header for the release-notes modal.

## Files
| File | Role |
|---|---|
| `index.html` | Window chrome + CSS, loads React/Babel/Lucide + all scripts |
| `ui.jsx` | Primitives: `Icon` (Lucide), `Button`, `Badge`, `Tag`, `Empty`, `Segmented`, `LineChart` |
| `data.jsx` | Mock devices (Pico headsets), installed apps, processes, network, logcat generator, file tree |
| `app.jsx` | App shell: header, device sidebar, top tabs, router, files + release-notes modals |
| `Sidebar.jsx` | Connect form, device cards, 设备信息, 历史设备 |
| `DevicesTab.jsx` · `NetworkTab.jsx` | 设备 (apps) and 网络 tab bodies |
| `MirrorScreen.jsx` · `PerformanceScreen.jsx` · `LogcatScreen.jsx` · `FilesScreen.jsx` | 投屏 / 性能 / 日志 tabs + the file modal |

## Conventions
- Icons are **Lucide** (the app's real set) via the `Icon` component — never
  hand-drawn SVG or emoji.
- Each `<script type="text/babel">` has its own scope; shared components are
  published on `window` at the end of each file.
- All colour/spacing/type comes from `../../colors_and_type.css` variables.
