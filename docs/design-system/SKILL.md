---
name: android-device-monitor-design
description: Use this skill to generate well-branded interfaces and assets for 安卓设备监控 (Android Device Monitor) — a Windows desktop tool for mirroring, profiling, logging, and controlling Android devices — either for production or throwaway prototypes/mocks. Contains essential design guidelines, colors, type, fonts, Lucide iconography, and a desktop-app UI kit for prototyping.
user-invocable: true
---

Read the `README.md` file within this skill, and explore the other available files.

Start with `README.md` (product context, content/voice, visual foundations,
iconography) and `colors_and_type.css` (all design tokens). The `preview/` folder
has small specimen cards; `ui_kits/desktop-app/` is a full interactive React
recreation of the product you can lift components from.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy
assets out and create static HTML files for the user to view — import
`colors_and_type.css`, use **Lucide** icons (the app's real icon set) from CDN,
and follow the dark + Android-green system. If working on production code, copy
assets and read the rules here to become an expert in designing with this brand.

Key facts to honour:
- **zh-CN, terse peer-developer voice**; technical nouns stay in English
  (ADB, WiFi, APK, FPS, logcat). No emoji.
- **Dark INDIGO theme** (`#15162B` base, `#1E2138` panels); the single brand
  color is **cornflower blue `#5597DC`** (primary buttons, active tab, links).
  Green `#54C084` is *semantic only* (已连接 / 启动); plus amber `#DCA844` (关闭),
  coral red `#E0746C` (断开 / 卸载), gold `#E8B339` (folder). V/D/I/W/E/F logcat ramp.
- **Native Windows font stack** (Segoe UI + Microsoft YaHei; Cascadia Code mono).
  Browser previews substitute Noto Sans SC + JetBrains Mono.
- **Lucide line icons**, 2px stroke, `currentColor`. Never hand-draw icons.
- Layout: fixed top header + 360px **left device sidebar** + a rounded main panel
  with **top tabs** (设备 / 日志 / 性能 / 网络 / 投屏). The real-world fleet is Pico
  VR headsets connected over WiFi; batch APK install is the spine of the UX.
- ⚠️ Visual tokens are colour-sampled from real screenshots; the 设备/日志/性能/投屏
  tabs are screenshot-verified, only 网络 is inferred. 性能 = Pico-VR metrics
  (MTP/ATW/frame timings); 投屏 opens an external scrcpy window. Copy is authentic.

If the user invokes this skill without other guidance, ask them what they want to
build or design, ask a few questions, and act as an expert designer who outputs
HTML artifacts _or_ production code, depending on the need.
