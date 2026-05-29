# Android Device Monitor - 开发计划

## 1. 项目概述

基于 [Product-Spec.md](/G:/Androidtool/Product-Spec.md)，本项目是一个面向开发者的桌面端 Android 设备监控工具。

本文件已按 2026-05-27 的仓库真实实现回填，不再只描述理想规划，而是同时反映：
- 已完成能力
- 已落地但仍需补齐验收的能力
- 下一阶段待继续开发的缺口

**当前实现技术栈**
- Electron ^28.0.0
- TypeScript ^5.0.0
- React ^18.0.0
- Webpack ^5.0.0
- TailwindCSS ^3.0.0
- Lucide React ^0.290.0
- ADB 接入：内置 `platform-tools` 优先，回退系统 `adb` 命令 + Node.js `child_process`
- 仓库内保留 `adbkit` 依赖与类型声明文件，但当前主流程以 `adb` CLI 为准

**核心能力范围**
- 设备连接（USB / WiFi）
- 设备基础信息展示
- WiFi 设备链路延迟展示
- Logcat 抓取、过滤、导出
- Android / Pico 性能指标、性能快照、进程、Activity 栈查看
- 基础网络请求抓取
- 构建、打包、基础测试

---

## 2. 功能依赖图

```text
Phase 1 基础框架
  -> Phase 2 ADB 管理与设备连接
    -> Phase 3 日志采集与分析
      -> Phase 4 性能 / 进程 / Activity 监控
        -> Phase 5 网络请求抓取
          -> Phase 6 优化、测试与发布
```

依赖关系说明：
- Phase 2 是后续所有运行时功能的前置条件。
- Phase 3 已经沉淀了多设备日志缓存、批量推送、虚拟滚动等基础能力，Phase 4/5 继续复用同一套主界面和 IPC 通道。
- Phase 6 不是完全独立的新模块，而是对前面各 Phase 的质量补齐和可发布化收尾。

---

## 3. 分阶段开发计划

### Phase 1: 基础框架搭建

**状态**：已完成

**目标**：搭建 Electron + React 桌面应用骨架，建立主进程、渲染进程、预加载桥接和打包链路。

**交付清单**
- [x] Electron 主进程入口
- [x] React 渲染进程入口
- [x] TypeScript 编译配置
- [x] Webpack 构建配置
- [x] 预加载桥接与 IPC 基础结构
- [x] 可执行的基础窗口与页面框架

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/index.ts` | 开发态主进程入口 |
| `android-device-monitor/src/main/index-prod.ts` | 打包态主进程入口 |
| `android-device-monitor/src/main/preload.js` | 预加载桥接 |
| `android-device-monitor/src/renderer/index.tsx` | 渲染进程入口 |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 当前主界面实现 |
| `android-device-monitor/package.json` | 脚本、依赖、electron-builder 配置 |
| `android-device-monitor/webpack.config.js` | 渲染层打包配置 |

**验收标准**
- `npm run build` 可通过
- Electron 窗口可正常加载页面
- 预加载桥接可向渲染层暴露设备监控 API

---

### Phase 2: ADB 管理器

**状态**：已完成（Windows 便携版已验收）

**目标**：实现设备连接、设备列表与设备信息展示，打通 USB / WiFi 基础链路。

**已完成**
- [x] `adb devices -l` 设备列表解析
- [x] USB 刷新连接（`adb start-server` + 重新取设备）
- [x] WiFi 连接（`adb connect <ip>:5555`）
- [x] WiFi 断开连接
- [x] 设备属性读取（型号、厂商、Android 版本、API Level）
- [x] 设备列表展示与选中
- [x] 自定义设备显示名持久化
- [x] 启动期 ADB 可用性检测与缺失引导
- [x] 设备上下线轮询监听与设备列表变更事件
- [x] 更细的连接异常分类与授权提示
- [x] 内置 `platform-tools` 分发，优先使用应用自带 ADB，缺失时回退系统 ADB
- [x] Windows 真机验收完成（USB / WiFi / 无系统 ADB 环境）
- [x] WiFi 设备卡片展示工具到设备的链路延迟（10 秒缓存，USB 不显示）

**待补齐**
- [ ] 非 Windows 平台的内置 ADB 分发与真机验收
- [ ] 从轮询监听进一步升级为更实时的设备事件机制（如后续需要）

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/adb/ADBManager.ts` | 设备连接、属性读取、运行时采集总入口 |
| `android-device-monitor/src/main/adb/adbBinary.ts` | 内置 ADB 路径解析与系统 ADB 回退策略 |
| `android-device-monitor/src/main/adb/adbError.ts` | ADB 错误分类、提示文案与引导 |
| `android-device-monitor/src/main/adb/types.ts` | ADB 相关内部类型 |
| `android-device-monitor/src/main/preload.js` | 暴露设备相关 IPC API |
| `android-device-monitor/src/shared/ipc/channels.ts` | IPC 通道常量 |
| `android-device-monitor/src/shared/types/index.ts` | 设备与 IPC 共享类型 |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 设备列表、连接、断开、命名 UI |
| `android-device-monitor/scripts/prepare-platform-tools.js` | 打包前自动准备官方 platform-tools |

**验收标准**
- USB 设备可被识别并显示
- 输入 IP 后可发起 WiFi 连接
- 设备基础信息可正确展示
- WiFi 设备卡片可展示 `延迟 xxms`，超时时显示 `连接不稳`
- 断开 WiFi 设备后列表可同步刷新
- 无系统 ADB 的 Windows 机器可直接使用打包产物中的内置 ADB

---

### Phase 3: 日志模块

**状态**：主链路已完成

**目标**：实现 Logcat 抓取、解析、过滤、搜索、导出，并保证大日志量下仍可交互。

**已完成**
- [x] Logcat 启动 / 停止
- [x] 按日志级别启动采集
- [x] 包名 / PID 定向采集参数透传
- [x] Logcat 时间格式解析与兜底解析
- [x] 包名、TAG、级别、PID、关键词过滤
- [x] 正则搜索
- [x] 日志导出为文件
- [x] 多设备日志分桶存储
- [x] 主进程批量推送日志到渲染层
- [x] 日志数量上限控制、待刷新缓冲区上限控制
- [x] 虚拟滚动渲染，避免一次性绘制全部日志

**待补齐**
- [ ] 将日志采集与解析进一步拆分为独立模块，而不是继续堆在 `ADBManager.ts` / `SimpleApp.tsx`
- [ ] 用真实设备验证日志延迟、吞吐和极端场景稳定性
- [ ] 补更细颗粒度的日志功能测试，而不是只做 smoke 检查

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/adb/ADBManager.ts` | Logcat 启停、解析、包名映射、缓冲控制 |
| `android-device-monitor/src/main/index.ts` | 日志批量派发、导出 IPC |
| `android-device-monitor/src/main/index-prod.ts` | 打包态日志 IPC |
| `android-device-monitor/src/main/preload.js` | `startLogcat` / `stopLogcat` / `exportLogs` 桥接 |
| `android-device-monitor/src/shared/types/index.ts` | `LogEntry` 等共享类型 |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 日志过滤、搜索、虚拟滚动、导出 UI |

**验收标准**
- 单设备日志可正常开始 / 停止采集
- 包名、TAG、级别、PID、关键词过滤可用
- 导出文件内容可读
- 日志量达到 10000+ 时界面不出现明显卡死

---

### Phase 4: 性能监控

**状态**：主链路已落地，Pico 官方指标与快照链路已验收

**目标**：展示 CPU、内存、FPS、进程列表与 Activity 栈等运行态信息，并在性能模块内支持实时设备画面预览与性能快照截图。

**已完成**
- [x] CPU / 内存 / FPS 指标请求链路
- [x] 每秒轮询一次性能指标
- [x] 进程列表拉取与表格展示
- [x] Activity 栈拉取与包名过滤
- [x] 指标卡片式展示
- [x] FPS 口径改为前台应用渲染 FPS，使用 `dumpsys gfxinfo <package> framestats`
- [x] Android 通用 CPU / 内存解析兼容 Pico `top` 与 `dumpsys meminfo` 输出格式，内存统一以 MB 展示
- [x] Pico 设备切换独立 Provider，优先读取官方 `PxrMetric` 日志
- [x] Pico 官方指标展示 `FPS / MTP / FrmCpu / FrmGpu / ATWGPU / GPU`
- [x] Pico 性能页同时补充 Android 通用 CPU 占用率与内存占用，避免把 `FrmCpu` 误当 CPU 使用率
- [x] Android 性能页隐藏无可靠来源的 GPU 占位卡片
- [x] 手动性能快照：保存截图、时间、前台应用、Activity 与当时性能指标
- [x] Pico 快照截图不再触发系统双目截图按键，改为快照 provider 直接读取当前画面
- [x] 性能快照采集拆为 provider 链路，优先 raw framebuffer 快路径，失败时回退 PNG screencap；后续实时流 / SDK 截图通道可接入同一接口
- [x] Pico 快照缩略图裁切为单眼显示
- [x] 本地 PNG 快照文件写入性能指标条；Pico 本地快照同步裁切为单眼并写入指标
- [x] 快照落盘目录跟随运行目录，发布包可在应用目录下保存 `performance-snapshots`
- [x] 短时性能录制：普通 Android 使用设备端 `screenrecord` 录制 MP4，Pico 通过录制 provider 分流，第一版可回退 `pico-screenrecord`
- [x] 性能录制 manifest：保存录制 provider、设备 ID、起止时间、前台包名 / Activity 与录制期间性能采样序列
- [x] 性能录制媒体路径改为 `performance-recordings/...` 相对路径，并通过工具内媒体协议读取，避免 UI 依赖本机绝对路径
- [x] 性能录制缩略图与工具内播放器：单击缩略图播放，播放时按视频时间同步叠加性能采样指标
- [x] Pico 录制缩略图与播放画面按快照同样的单眼区域展示，避免显示双目并排画面
- [x] 性能录制最终 MP4 保留设备端原始视频，不将动态性能指标烧录或水印进视频文件
- [x] 录制完成后清理设备端录屏进程并等待 ADB 链路稳定，避免紧接着抓取快照失败
- [x] 性能页布局重排：新增“取证操作”区域，合并性能开关、快照和短时录制控制，减少顶部按钮拥挤
- [x] 性能页记录区顺序调整为快照在前、录制在后

**待补齐**
- [ ] 在性能模块内增加实时设备画面预览能力
- [ ] 基于 FPS 下跌或阈值的自动截图取证
- [ ] 为 Pico 官方指标增加更稳定的“仅支持已集成 `XR Profiling Toolkit` 应用”的识别与提示逻辑
- [ ] 引入 `XR Profiling Toolkit` 兼容层，复用官方 schema / 解析逻辑，而不是继续猜测私有系统服务协议
- [ ] 内存指标进一步区分“系统已用 / 前台应用占用 / 可用内存”三种口径
- [ ] 网络速度指标仍未真正实现，当前返回固定值
- [ ] 指标趋势图和历史序列尚未实现
- [ ] 进程 CPU / 内存字段需要结合不同 Android 机型输出继续校验

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/adb/ADBManager.ts` | 性能指标、FPS、截图、进程、Activity 栈采集 |
| `android-device-monitor/src/main/adb/runtimeInspector.ts` | Android / Pico 性能 Provider 分流、CPU / 内存 / FPS / 快照触发 |
| `android-device-monitor/src/main/adb/screenshotCapture.ts` | 性能快照截图 provider、raw framebuffer 解析与 PNG screencap 回退 |
| `android-device-monitor/src/main/adb/performanceRecording.ts` | Android / Pico 短时性能录制 provider、MP4 拉取与 manifest 产物 |
| `android-device-monitor/src/main/adb/picoMetrics.ts` | Pico 官方 `PxrMetric` 读取、解析与应用支持检测 |
| `android-device-monitor/src/main/performanceSnapshots.ts` | 性能快照落盘、本地 PNG 指标烙印、Pico 单眼裁切 |
| `android-device-monitor/src/main/performanceMedia.ts` | 录制视频相对路径到本地文件的安全媒体协议映射 |
| `android-device-monitor/src/main/index.ts` | 性能、截图、进程、Activity IPC |
| `android-device-monitor/src/main/preload.js` | `getPerformance` / `getProcesses` / `getActivityStack` / 画面与截图桥接 |
| `android-device-monitor/src/shared/types/index.ts` | `PerformanceMetrics` / `PerformanceSnapshot` / `ProcessInfo` / `ActivityStackEntry` |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 性能页挂载、性能快照状态、进程表格、Activity 表格 |
| `android-device-monitor/src/renderer/components/PerformancePanel.tsx` | Android / Pico 性能卡片、快照列表与缩略图展示 |

**验收标准**
- 切到性能页后每秒可刷新一次指标
- 可在性能页看到实时设备画面预览，且不阻塞主要操作
- 手动抓取性能快照后，可回看对应截图与时间点指标
- 本地快照 PNG 文件自身包含截图和关键性能指标
- 短时性能录制可选择 10 / 30 / 60 秒，完成后生成本地 MP4 与 JSON manifest
- Android 设备录制 provider 为 `android-screenrecord`，Pico 设备录制 provider 为 `pico-screenrecord` 或后续 `pico-sdk`
- 性能录制期间继续保留指标采样，并将采样序列写入 manifest
- 工具内可看到录制缩略图和指标，单击缩略图可播放视频；播放器中的指标随视频时间变化
- 录制视频和 manifest 在 UI 中使用相对路径，不暴露本机绝对路径
- 最终 MP4 文件必须保留设备端原始视频，不包含动态性能指标水印；Pico 只在工具内缩略图和播放器中按单眼区域展示
- 录制完成后立即抓取性能快照应可成功触发，不被上一段录制残留状态阻塞
- Pico 快照在 UI 与本地文件中均应呈现单眼画面，不再是双目并排图
- 进程列表与 Activity 栈可返回非空结果或明确错误
- Pico 官方指标读取成功时展示 `FPS / MTP / FrmCpu / FrmGpu / ATWGPU / GPU`，读取失败时回退 Android 通用采样
- 指标显示不会阻塞日志采集主流程

---

### Phase 5: 网络监控

**状态**：首版详情已落地，仍需补强抓包前检查与 HTTPS 策略

**目标**：抓取应用网络请求，并展示基础请求信息。

**已完成**
- [x] 通过 `adb shell tcpdump` 发起短时抓包
- [x] 从抓包文本中解析基础 HTTP 方法与 URL
- [x] 网络请求列表展示
- [x] 包名备注参数从前端透传到后端接口
- [x] 解析状态码、状态文本、请求头、响应头、请求体、响应体
- [x] 基于抓包时间戳推断请求耗时
- [x] 网络请求详情面板（状态 / 耗时 / Host / 时间 / Header / Body）

**待补齐**
- [ ] HTTPS 请求的稳定抓取与解码
- [ ] 更可靠的抓包前置条件检测（设备权限、`tcpdump` 是否存在）
- [ ] 响应与请求的关联规则仍是启发式，复杂并发场景需要继续校验
- [ ] 补更细颗粒度的网络抓包测试，而不是仅停留在 smoke 校验

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/adb/ADBManager.ts` | `tcpdump` 抓取、HTTP 请求/响应解析、状态码与耗时推断 |
| `android-device-monitor/src/main/index.ts` | 网络请求 IPC |
| `android-device-monitor/src/main/preload.js` | `getNetworkRequests` 桥接 |
| `android-device-monitor/src/shared/types/index.ts` | `NetworkRequest` 类型 |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 网络请求列表与详情面板 UI |
| `android-device-monitor/tests/smoke.test.js` | 网络抓包主链路 smoke 校验 |

**验收标准**
- 在满足设备权限前提下，可抓到基础 HTTP 请求列表
- 列表可展示方法、URL、状态码、耗时、时间
- 详情面板可展示 Host、请求头、响应头、请求体、响应体
- 抓包失败时可返回明确错误信息

---

### Phase 6: 优化测试

**状态**：持续推进中（Windows 发布链路已验收）

**目标**：补齐性能优化、测试、打包和发布能力，使项目进入可持续迭代状态。

**已完成**
- [x] 日志虚拟滚动
- [x] 主进程日志批量派发与队列上限控制
- [x] smoke 测试
- [x] `build` / `pack` / `dist` / `release` 脚本
- [x] electron-builder 基础配置
- [x] 产物目录已生成，存在 `dist/win-unpacked`
- [x] 打包前自动准备 `platform-tools`
- [x] Windows 便携版产物包含内置 `adb.exe`
- [x] Windows 本地发布产物真机验收通过
- [x] `build-and-package.bat` 改为稳定入口，转调 PowerShell 打包脚本，避免 cmd 编码 / 括号解析问题
- [x] 打包前检查 Electron 运行时，支持从 `.electron-*` 半下载缓存恢复，并在网络下载失败时明确报错
- [x] `npm run release-bat` 可产出可运行 Windows 便携包

**待补齐**
- [ ] 暗黑模式 Hook 与主题系统
- [ ] 集中的错误处理器，而不是分散在各函数里
- [ ] 更接近业务行为的自动化测试
- [ ] 覆盖率目标与测试基线
- [ ] 正式安装包验收（安装器形态）
- [ ] macOS / Linux 的内置 ADB 打包与真机验证

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 虚拟滚动、批量刷新、错误提示 |
| `android-device-monitor/tests/smoke.test.js` | 当前测试入口 |
| `android-device-monitor/package.json` | 构建、测试、打包脚本 |
| `android-device-monitor/scripts/prepare-platform-tools.js` | 下载并准备官方 platform-tools |
| `android-device-monitor/scripts/build-and-package.ps1` | Windows 打包脚本 |
| `android-device-monitor/scripts/build-and-package.bat` | 批处理打包脚本 |
| `android-device-monitor/scripts/ensure-electron-runtime.js` | Electron 运行时检查、下载与半下载缓存恢复 |
| `android-device-monitor/dist/` | 当前构建与打包产物 |
| `android-device-monitor/vendor/platform-tools/` | 内置 ADB 与配套平台工具缓存目录 |

**验收标准**
- `npm test -- --runInBand` 可通过
- `npm test` 可通过
- `npm run build` 可通过
- `npm run release-bat` 可产出 Windows 便携包
- 日志大数据量场景下仍可滚动和过滤
- 至少能产出一份本地可运行的打包结果
- Windows 发布目录中的 `resources/platform-tools/win/platform-tools/adb.exe` 存在且可用

---

## 4. 当前真实目录结构

```text
android-device-monitor/
├── src/
│   ├── main/
│   │   ├── adb/
│   │   │   ├── ADBManager.ts
│   │   │   ├── adbBinary.ts
│   │   │   ├── adbError.ts
│   │   │   ├── adbkit.d.ts
│   │   │   ├── picoMetrics.ts
│   │   │   ├── runtimeInspector.ts
│   │   │   └── types.ts
│   │   ├── index.ts
│   │   ├── index-prod.ts
│   │   ├── logger.ts
│   │   ├── performanceSnapshots.ts
│   │   └── preload.js
│   ├── renderer/
│   │   ├── components/
│   │   │   ├── NetworkPanel.tsx
│   │   │   └── PerformancePanel.tsx
│   │   ├── lib/
│   │   │   ├── electronApi.ts
│   │   │   └── logStore.ts
│   │   ├── index.tsx
│   │   ├── index.css
│   │   ├── SimpleApp.tsx
│   │   └── TestApp.tsx
│   └── shared/
│       ├── ipc/
│       │   └── channels.ts
│       └── types/
│           └── index.ts
├── tests/
│   └── smoke.test.js
├── scripts/
│   ├── build-and-package.ps1
│   ├── build-and-package.bat
│   ├── cleanup.bat
│   ├── copy-preload.js
│   ├── ensure-electron-runtime.js
│   ├── fix-pkg.js
│   └── prepare-platform-tools.js
├── dist/
├── package.json
├── package-lock.json
├── tsconfig.json
├── tsconfig.main.json
├── tsconfig.renderer.json
├── webpack.config.js
├── tailwind.config.js
└── index.html
```

说明：
- 性能面板和网络面板已经从 `SimpleApp.tsx` 拆到 `components/`，日志存储已拆到 `lib/logStore.ts`。
- 但 `SimpleApp.tsx` 仍承担设备、日志、性能、进程、Activity、网络等大量状态编排，仍是下一轮重构重点。
- 原计划中的 `LogcatManager.ts`、`PerformanceManager.ts`、`NetworkManager.ts`、`LogParser.ts` 目前没有完全独立成文件；性能采集已拆到 `runtimeInspector.ts` / `picoMetrics.ts`，网络与日志主体仍主要在 `ADBManager.ts`。

---

## 5. 关键技术实现要点

### 5.1 ADB 通信

当前实现以内置 `platform-tools` 优先、系统 `adb` 回退为主，通过 `exec`、`execFile`、`spawn` 调用：
- `adb devices -l`
- `adb start-server`
- `adb connect <ip>:5555`
- `adb disconnect <deviceId>`
- `adb -s <deviceId> shell getprop`
- `adb -s <deviceId> logcat -v time`
- WiFi 设备卡片延迟测量使用 Node.js TCP connect 到设备 `ip:port`，不依赖 ICMP ping 权限

这套方案已够支撑当前桌面工具主链路，目前又补上了两块关键能力：
- 启动期 ADB 可用性检测、错误分类与用户引导
- 内置 `platform-tools` 优先、系统 `adb` 回退的运行时路径策略

后续仍值得继续收口的是：
- 将散落命令封装成更稳定的能力边界
- 为非 Windows 平台补齐相同的内置分发与验收链路

### 5.2 日志解析

当前日志解析支持两层策略：
- 优先按 `MM-DD HH:mm:ss.SSS PID TID LEVEL TAG: message` 解析
- 解析失败时退回宽松匹配，避免整行日志直接丢失

同时还实现了：
- PID 到包名的缓存映射
- 分设备日志存储
- 批量刷新与日志数量上限

### 5.3 性能与运行态采集

当前已接入命令：

| 能力 | 当前命令 |
|------|----------|
| 性能指标 | `adb shell dumpsys meminfo` / `adb shell top -n 1` / `adb shell dumpsys gfxinfo` |
| Pico 官方指标 | `adb shell logcat -d -v time -s PxrMetric` |
| 快照截图 | 快照 provider 链路：raw framebuffer 优先，PNG screencap 回退 |
| 进程列表 | `adb shell ps` / `adb shell ps -A` |
| Activity 栈 | `adb shell dumpsys activity activities` |

注意：
- Android 通用性能页展示 FPS、CPU、MEM、NET；手机通用模式暂不展示 GPU，因为没有可靠统一来源。
- Pico 性能页展示 FPS、CPU、MEM、GPU，并保留 `MTP / FrmCpu / FrmGpu / ATWGPU` 官方口径。
- Pico `FrmCpu` 是帧耗时，不等于 CPU 占用率；CPU 占用率仍来自 Android 通用采样。
- 内存当前显示 MB，占用值来自 `dumpsys meminfo` 的 Used RAM 或兼容解析结果，后续仍需区分系统已用与前台应用占用。
- 性能快照已能落盘 PNG，并将关键指标写入图片底部信息条。

### 5.4 网络请求捕获

当前首版方案是：
1. 通过 `adb shell timeout 5 tcpdump -A -s 0 -c 80 tcp port 80` 抓短时流量
2. 从文本中提取 HTTP 请求 / 响应片段
3. 解析方法、URL、状态码、状态文本、Header、Body 和基础耗时
4. 在渲染层以列表 + 详情面板展示

当前限制：
- 主要覆盖明文 HTTP
- 响应关联仍是启发式，并发复杂场景需要继续验证

---

## 6. 风险与应对

| 风险 | 当前表现 | 应对措施 |
|------|----------|----------|
| ADB 环境不一致 | Windows 便携版已内置 ADB，但 macOS / Linux 仍未完成同等级分发验收 | 延续内置 `platform-tools` 策略，补跨平台打包与真机验证 |
| 渲染层单文件过大 | `SimpleApp.tsx` 承担过多职责 | 按设备、日志、性能、网络分拆组件与 hooks |
| 采集指标语义不稳定 | 不同 Android 机型命令输出差异大 | 为 CPU / 内存 / 进程字段补设备实测样本 |
| Pico 官方指标依赖系统日志 | 当前通过 `PxrMetric` logcat 读取，受固件和前台应用影响 | 保留 Android 通用回退采样，继续评估 XR Profiling Toolkit 官方兼容层 |
| Pico 截图源为双目画面 | Pico 当前画面源可能返回左右眼并排图 | UI 与本地 PNG 对 Pico 快照裁切为单眼展示 |
| 网络抓包门槛高 | 依赖 `tcpdump`、设备权限和命令可用性 | 补抓包前检查与降级提示 |
| 测试深度不足 | 当前主要是 smoke test | 补业务级单测和关键链路回归测试 |

---

## 7. 进度跟踪

| Phase | 当前状态 | 说明 |
|-------|----------|------|
| Phase 1: 基础框架 | 已完成 | 构建、运行、桥接、打包基础能力已具备 |
| Phase 2: ADB 管理器 | 已完成 | 启动检测、设备轮询监听、错误分类、WiFi 延迟展示、内置 ADB 分发与 Windows 真机验收已完成 |
| Phase 3: 日志模块 | 主链路完成 | 抓取、过滤、导出、虚拟滚动已落地 |
| Phase 4: 性能监控 | 主链路完成，继续校准 | Android / Pico 指标、前台 FPS、手动性能快照、本地 PNG 指标烙印已落地；实时预览、自动取证、趋势图仍待做 |
| Phase 5: 网络监控 | 开发中 | HTTP 请求详情首版已落地，仍待补抓包前检查与 HTTPS 范围决策 |
| Phase 6: 优化测试 | 持续推进中 | 虚拟滚动、构建、打包、Electron 运行时恢复、内置 ADB 分发、Windows 发布验收已完成，质量体系仍待补齐 |

**当前阶段判断**
- 项目已经越过“脚手架阶段”
- 当前最准确的说法是：`Phase 2 / 3 完成，Phase 4 主链路完成但仍需校准和增强，Phase 5 首版已接入，Phase 6 持续收口中`

---

## 8. 下一步开发建议

建议按下面顺序继续：

1. 收口 Phase 4
   - 实现性能模块实时画面预览，而不是只在快照中保存画面
   - 继续校准内存 / CPU / 进程字段语义，特别是“系统占用”和“前台应用占用”的区别
   - 增加 FPS 下跌或阈值触发的自动快照
   - 明确网络速度指标是否保留
   - 决定是否补趋势图

2. 收口 Phase 5
   - 明确目标只做 HTTP 调试，还是要追求 HTTPS/代理级方案
   - 补抓包前检查、权限提示和失败降级文案
   - 校验复杂并发请求下的响应匹配准确率

3. 补齐 Phase 6
   - 拆分 `SimpleApp.tsx`
   - 增加集中错误处理
   - 扩测试覆盖
   - 完成安装器形态与跨平台发布验收

**进入下一轮实现时，建议优先调用**：`/dev-builder`
