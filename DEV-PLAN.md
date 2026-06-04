# Android Device Monitor - 开发计划

## 1. 项目概述

基于 [Product-Spec.md](/G:/Androidtool/Product-Spec.md)，本项目是一个面向开发者的桌面端 Android 设备监控工具。

本文件已按 2026-06-01 的仓库真实实现持续回填，不再只描述理想规划，而是同时反映：
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
- 历史 WiFi 设备保存与一键快速重连（IP 变更就地输入重连、手动移除）【规划中，Phase 12】
- 设备基础信息展示（含 SN 序列号）、卡片稳定排序、断开/重启二次确认
- WiFi 设备链路延迟展示
- Logcat 抓取、过滤、导出（本地时间 + 打开导出位置）
- Android / Pico 性能指标、性能快照、短时录制、进程、Activity 栈查看
- 基础网络请求抓取
- 投屏镜像与反向操控（scrcpy）
- 第三方应用卸载与单 APK 批量安装
- 设备文件管理（浏览 / 上传 / 下载 / 多选批量下载 / 删除 / 打开所在文件夹）
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
    -> Phase 7 投屏镜像与操控（普通设备一键投屏）
      -> Phase 8 投屏参数配置 + Pico 单眼裁切 + 快捷键速查
    -> Phase 9 卸载应用
    -> Phase 10 批量安装
    -> Phase 11 设备文件管理
    -> Phase 12 历史设备保存与快速重连
    -> Phase 13 文件传输中断恢复
    -> Phase 14 Pico 弱网控制桌面集成
```

依赖关系说明：
- Phase 2 是后续所有运行时功能的前置条件。
- Phase 3 已经沉淀了多设备日志缓存、批量推送、虚拟滚动等基础能力，Phase 4/5 继续复用同一套主界面和 IPC 通道。
- Phase 6 不是完全独立的新模块，而是对前面各 Phase 的质量补齐和可发布化收尾。
- Phase 7/8 是新增的「投屏镜像与设备操控」模块（Product-Spec 2.5）。只依赖 Phase 2 的设备连接与内置 ADB 分发能力，与 Phase 4 的 Pico 检测能力复用同一套判定，不依赖 Phase 5/6。Phase 7 先打通普通 Android 的一键投屏与操控；Phase 8 在其上补参数配置、Pico 单眼裁切与快捷键速查。
- Phase 9（卸载）、Phase 10（批量安装）、Phase 11（设备文件管理）都是设备运维类功能，只依赖 Phase 2 的设备连接与内置 ADB，彼此独立，复用同一套主界面页签和 IPC 通道模式，不依赖 Phase 4/5/6/7/8。
- Phase 13（文件传输中断恢复）是对 Phase 11 设备文件管理的可靠性增强，依赖其上传/下载链路，引入主进程 journal 持久化 + 临时名原子落地。
- Phase 14（Pico 弱网控制桌面集成）是把桌面工具接成 `pico-network-helper` 助手 APK 的控制台（Product-Spec 2.6/2.7）。只依赖 Phase 2 的设备连接与内置 ADB、以及已落地的应用安装（`INSTALL_APK`）与已安装列表（`LIST_INSTALLED_PACKAGES`）能力，复用 platform-tools/scrcpy 的随包分发模式，与 Phase 4/5/6/7/8/9/10/11/12/13 互不依赖。助手端 APK 代码已完成，本 Phase 仅覆盖桌面端。
- Phase 12（历史设备保存与快速重连）是对 Phase 2 设备连接体验的增量增强，只依赖 Phase 2 已有的 WiFi 连接（`CONNECT_WIFI`）能力与 `DeviceInfo.serialNo` 字段，不引入新的主进程 ADB 命令，几乎是纯渲染层 + 本地持久化，与 Phase 4/5/6/7/8/9/10/11 互不依赖。Phase 2 已标记完成不再改动，本能力以独立 Phase 落地。

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
- [x] 设备卡片展示 SN 序列号
- [x] 设备卡片稳定排序，避免上下线时列表跳动
- [x] 断开设备行内二次确认（确认断开 / 取消）
- [x] 设备卡片「重启」行内二次确认（确认重启 / 取消），与断开确认互斥
- [x] 配对按钮在窄空间下文字不换行修复

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
- [x] 日志导出时间使用本地时间（修复原 `toISOString()` 输出 UTC 比本地少 8 小时），格式 `YYYY-MM-DD HH:mm:ss.SSS`
- [x] 导出成功后在工具栏提供「📂 打开位置」按钮，一键定位到保存的日志文件
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

### Phase 7: 投屏镜像与操控（普通设备一键投屏）

**状态**：已落地（编译/测试/构建通过，投屏交互待真机验收）

**目标**：在工具内打包 scrcpy 二进制，主进程以子进程方式 `spawn` scrcpy 调起其原生窗口，实现普通 Android 设备的高帧率低延迟镜像与反向操控（触屏、文字、物理键）。第一版采用 Product-Spec 2.5 的路线 A——不内嵌解码，调起 scrcpy 独立窗口，关闭窗口或点「停止」即结束子进程。

**交付清单**
- [ ] 打包随附 scrcpy：新增 `scripts/prepare-scrcpy.js`，下载对应 OS 的 scrcpy 发行包（含 `scrcpy.exe`、`scrcpy-server`、依赖 dll）到 `vendor/scrcpy/<os>/`，已存在则跳过；在 `package.json` 的 `electron-builder` `extraResources` 中加入 `scrcpy/` 目录，并把 `prepare-scrcpy` 接入 `pack` / `dist` / `release` 前置步骤（与 `prepare-platform-tools` 同级）
- [ ] scrcpy 二进制定位：新增 `src/main/scrcpy/scrcpyBinary.ts`，仿照 `adbBinary.ts`，开发态从 `vendor/scrcpy/<os>/` 解析、打包态从 `process.resourcesPath/scrcpy/` 解析 scrcpy 可执行文件路径
- [ ] scrcpy 进程管理器：新增 `src/main/scrcpy/scrcpyManager.ts`，提供 `startMirror(deviceId, options)` 与 `stopMirror(deviceId)`；用 `child_process.spawn` 启动 scrcpy，传入 `-s <deviceId>`、`--window-title`，并通过设置子进程环境变量 `ADB` 指向内置 adb（`adbBinary.ts` 解析出的路径），避免 scrcpy 另起一个与主程序冲突的 adb server；记录 `deviceId -> ChildProcess` 映射，进程 `exit` / `error` 时清理映射并向渲染层回传状态
- [ ] 生命周期与异常回收：用户关闭 scrcpy 窗口（子进程自然退出）或在工具内点「停止投屏」时，结束并回收对应子进程；应用退出（`app.before-quit`）时统一 kill 所有存活的 scrcpy 子进程，不残留僵尸进程；scrcpy 启动失败（找不到设备 / 二进制缺失）时返回结构化错误供 UI 提示
- [ ] IPC 打通：在 `src/shared/ipc/channels.ts` 新增 `MIRROR_START` / `MIRROR_STOP` / `MIRROR_STATUS` 通道；在 `index.ts` 与 `index-prod.ts` 注册对应 `ipcMain.handle` 并委托给 `ScrcpyManager`；在 `preload.js` 暴露 `startMirror` / `stopMirror` / `onMirrorStatus`；在 `src/renderer/lib/electronApi.ts` 增加类型化封装
- [ ] 共享类型：在 `src/shared/types/index.ts` 新增 `MirrorSession`（`deviceId`、`status: 'starting'|'running'|'stopped'|'failed'`、`startedAt?`、`error?` 等，与 Product-Spec 5.6 对齐）
- [ ] 最小投屏入口 UI：新增 `src/renderer/components/MirrorPanel.tsx`，提供「投屏」「停止投屏」按钮与当前会话状态（启动中 / 镜像中 / 已停止 / 失败 + 错误文案），在 `SimpleApp.tsx` 中以新页签 / 区域挂载，作用于当前选中设备

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/scripts/prepare-scrcpy.js` | 打包前下载并准备对应 OS 的 scrcpy 发行包到 `vendor/scrcpy/<os>/` |
| `android-device-monitor/src/main/scrcpy/scrcpyBinary.ts` | 内置 scrcpy 可执行文件路径解析（开发态 / 打包态） |
| `android-device-monitor/src/main/scrcpy/scrcpyManager.ts` | spawn scrcpy、参数拼装、`ADB` 环境注入、进程生命周期与回收 |
| `android-device-monitor/src/main/adb/adbBinary.ts` | 复用：解析内置 adb 路径，注入到 scrcpy 子进程 `ADB` 环境变量 |
| `android-device-monitor/src/main/index.ts` | 开发态投屏 IPC handler，应用退出时回收 scrcpy 子进程 |
| `android-device-monitor/src/main/index-prod.ts` | 打包态投屏 IPC handler（与 index.ts 保持一致） |
| `android-device-monitor/src/main/preload.js` | `startMirror` / `stopMirror` / `onMirrorStatus` 桥接 |
| `android-device-monitor/src/renderer/lib/electronApi.ts` | 渲染层投屏 API 类型化封装 |
| `android-device-monitor/src/shared/ipc/channels.ts` | 新增 `MIRROR_START` / `MIRROR_STOP` / `MIRROR_STATUS` 通道常量 |
| `android-device-monitor/src/shared/types/index.ts` | 新增 `MirrorSession` 类型 |
| `android-device-monitor/src/renderer/components/MirrorPanel.tsx` | 投屏控制 UI（启动 / 停止 / 状态） |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 挂载投屏面板，绑定当前选中设备 |
| `android-device-monitor/package.json` | `extraResources` 加入 `scrcpy/`，`pack`/`dist`/`release` 前置接入 `prepare-scrcpy` |

**验收标准**
- `npm run build` 通过；`npm test` 通过
- 选中一台 USB / WiFi 连接的普通 Android 设备，点「投屏」可弹出 scrcpy 镜像窗口，画面高帧率低延迟
- 在镜像窗口内鼠标点击 / 拖拽可操作设备触屏，键盘可输入文字
- 通过 scrcpy 原生快捷键（MOD+h Home、MOD+b 返回、MOD+s 最近任务、MOD+p 电源、MOD+↑/↓ 音量）可触发对应物理键
- 关闭 scrcpy 窗口或点「停止投屏」后，主进程对应子进程被回收（任务管理器中无残留 scrcpy 进程）
- 设备未连接 / scrcpy 缺失时，UI 显示明确错误，不静默失败
- scrcpy 使用的是内置 adb（不依赖系统 PATH 中的 adb），不与主程序的 adb server 冲突

---

### Phase 8: 投屏参数配置 + Pico 单眼裁切 + 快捷键速查

**状态**：待开发

**目标**：在 Phase 7 的基础上，补齐启动参数配置（码率 / 分辨率上限 / 裁切）、Pico 设备自动单眼裁切、以及工具内物理键快捷键速查表，使投屏在 Pico 设备上呈现单眼画面并降低用户记忆成本。

**交付清单**
- [ ] 启动参数配置 UI：在 `MirrorPanel.tsx` 增加可选参数控件——分辨率上限（`--max-size`，如 1280 / 1600 / 不限）、码率（`--video-bit-rate`，如 4M / 8M / 16M）；参数随 `MIRROR_START` 传入，由 `scrcpyManager.ts` 拼装到 scrcpy 命令行
- [ ] Pico 检测与单眼裁切：复用现有 Pico 判定（`runtimeInspector.ts` / `picoMetrics.ts` 中的 Pico 识别逻辑）判断当前设备是否 Pico；是 Pico 时，先用 `adb shell wm size`（或复用 `screenshotCapture.ts` 的 raw framebuffer 头部尺寸）取设备分辨率，计算单眼裁切区域并自动附加 `--crop <W/2>:<H>:0:0`（左眼），使 scrcpy 窗口只显示单眼画面，与性能快照 / 录制的单眼口径一致
- [ ] 裁切坐标映射说明：在 `scrcpyManager.ts` 中明确 Pico 裁切后操控坐标由 scrcpy 基于裁切区域自动换算，无需额外处理；将该约束以注释和 `MirrorSession.crop` 字段记录
- [ ] `MirrorSession` 扩展：在 `src/shared/types/index.ts` 为 `MirrorSession` 补 `isPico`、`crop?`、`maxSize?`、`bitRate?` 字段（与 Product-Spec 5.6 完整对齐）
- [ ] 快捷键速查表：在 `MirrorPanel.tsx` 增加可折叠「快捷键速查」区域，列出物理键映射（MOD+h=Home、MOD+b=返回、MOD+s=最近任务、MOD+p=电源、MOD+↑/↓=音量、MOD+r=旋转），并标注 MOD 默认为左 Alt / 左 Super
- [ ] 能力边界提示：在 Pico 设备的投屏面板显著位置标注「仅支持 2D 界面触屏操控，VR 沉浸场景 6DoF 手柄无法操控」，与 Product-Spec 2.5 能力边界一致，避免用户误期望

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/scrcpy/scrcpyManager.ts` | 拼装 `--max-size` / `--video-bit-rate` / `--crop`，Pico 单眼裁切计算 |
| `android-device-monitor/src/main/adb/runtimeInspector.ts` | 复用：Pico 设备识别判定 |
| `android-device-monitor/src/main/adb/picoMetrics.ts` | 复用：Pico 设备识别辅助 |
| `android-device-monitor/src/main/adb/screenshotCapture.ts` | 复用：raw framebuffer 头部分辨率，用于计算 Pico 单眼裁切区域 |
| `android-device-monitor/src/shared/types/index.ts` | `MirrorSession` 补 `isPico` / `crop` / `maxSize` / `bitRate` 字段 |
| `android-device-monitor/src/renderer/components/MirrorPanel.tsx` | 参数配置控件、快捷键速查表、Pico 能力边界提示 |

**验收标准**
- `npm run build` 通过；`npm test` 通过
- 可在投屏前选择分辨率上限与码率，所选参数实际作用于 scrcpy 启动命令
- 选中 Pico 设备点投屏，scrcpy 窗口呈现单眼画面（非双目并排），且单眼区域内点击操控位置正确
- 选中普通 Android 设备点投屏，画面为完整设备屏幕，不被裁切
- 投屏面板可展开查看物理键快捷键速查表，内容与 scrcpy 实际快捷键一致
- Pico 投屏面板显示「仅支持 2D 界面操控、6DoF 手柄不可控」的能力边界提示
- `MirrorSession` 在 UI 中可反映 `isPico` 与裁切 / 码率 / 分辨率配置

---

### Phase 9: 卸载应用

**状态**：待开发

**目标**：在设备页签展示设备所有第三方已安装应用，对指定应用经确认后通过 `adb uninstall <包名>` 卸载，绕开投屏/VR 界面的手动操作，手机与 Pico 通用。

**交付清单**
- [x] 主进程卸载能力：`ADBManager.uninstallApp(deviceId, packageName)` 执行 `adb -s <deviceId> uninstall <packageName>`，解析成功/失败输出，失败抛结构化错误
- [x] 主进程已安装应用列表：`ADBManager.listInstalledPackages(deviceId)` 执行 `adb -s <deviceId> shell pm list packages -3`，解析 `package:` 前缀，返回排序去重后的包名数组
- [x] IPC 打通：`channels.ts` 新增 `UNINSTALL_APP` / `LIST_INSTALLED_PACKAGES`；`index.ts`/`index-prod.ts` 注册 handler；`preload.js` 暴露 `uninstallApp` / `listInstalledPackages`；`electronApi.ts` 类型封装
- [x] 设备页 UI：设备页签下方新增「已安装应用」面板，进入设备页自动加载，支持搜索过滤；每个应用带「卸载」按钮，点击经 `window.confirm` 二次确认后调用卸载，成功后从列表移除
- [x] 进程页不再承载卸载入口（已撤销原「操作」列）

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/adb/ADBManager.ts` | `uninstallApp` / `listInstalledPackages` 方法 |
| `android-device-monitor/src/main/index.ts` / `index-prod.ts` | 卸载与列表 IPC handler |
| `android-device-monitor/src/main/preload.js` | `uninstallApp` / `listInstalledPackages` 桥接 |
| `android-device-monitor/src/renderer/lib/electronApi.ts` | 卸载与列表 API 类型 |
| `android-device-monitor/src/shared/ipc/channels.ts` | `UNINSTALL_APP` / `LIST_INSTALLED_PACKAGES` 通道 |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 设备页「已安装应用」列表、搜索、卸载、确认、刷新 |

**验收标准**
- `npm run build` 通过；`npm test` 通过
- 设备页签展示第三方已安装应用列表，可搜索过滤
- 每个应用有「卸载」按钮，点击弹确认框
- 确认后应用被卸载，列表移除该项；失败有明确错误提示

---

### Phase 10: 批量安装

**状态**：待开发

**目标**：选择单个 APK 并行安装到多台已连接设备，并发限流、故障隔离、逐台状态与重试。

**整合修订**：单设备安装与批量安装已整合为同一个「应用安装」面板（设备页），复用 per-device 队列 + 进度计时器，每台设备独立展示安装队列与进度条；移除独立 BatchInstallPanel 组件。统一面板：选 1+ APK + 勾选 1+ 设备（默认当前）+ 并发上限 + 安装模式，并发池逐台安装，逐台进度条/状态/重试。

**交付清单**
- [x] 后端安装模式：`ADBManager.installApk` 增可选 `{ allowDowngrade }`，开启时安装参数加 `-d`（`install -r -d`，含 `--no-streaming` 兜底同步）；IPC/preload/electronApi 透传 options，向后兼容
- [x] 并发编排 UI：`components/BatchInstallPanel.tsx` —— 选 APK、并发数(2/4/8/不限)、安装模式(保留数据/允许降级)、设备多选(在线可选/离线禁用/全选清空)、开始按钮；并发池(默认4)对每台调 `installApk`，逐台状态(排队/安装中/成功/失败+原因)、顶部汇总(完成/成功/失败)、失败行单独重试
- [x] 设备页挂载：`SimpleApp.tsx` 设备页签底部挂载 `BatchInstallPanel`，传入全局 `devices` 列表

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/adb/ADBManager.ts` | `installApk` 安装模式选项（-r / -r -d）|
| `android-device-monitor/src/main/index.ts` / `index-prod.ts` | INSTALL_APK handler 透传 options |
| `android-device-monitor/src/main/preload.js` / `src/renderer/lib/electronApi.ts` | installApk options 透传与类型 |
| `android-device-monitor/src/renderer/components/BatchInstallPanel.tsx` | 批量安装并发编排 UI |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 设备页挂载 BatchInstallPanel |

**验收标准**
- `npm run build` 通过；`npm test` 通过
- 选 APK + 勾选多台设备 + 开始 → 各设备并行安装，受并发数限制
- 单台失败不阻塞其他，失败行可单独重试，顶部汇总正确
- 离线设备不可勾选；安装进行中控件禁用

**后续扩展**
- 「卸载后清数据全新安装」需读取 APK 包名（解析 APK 或加解析依赖），暂未实现
- 多个 APK → 多设备（队列）暂未实现

---

### Phase 11: 设备文件管理

**状态**：已落地（编译/类型检查通过，文件读写交互待真机回归）

**目标**：在设备页提供「文件管理」入口，弹出设备文件浏览器，支持浏览设备公共存储目录、上传文件到设备、从设备下载文件到 PC（单个与多选批量）、删除设备文件，并提供常用目录快捷入口；免 root 访问 `/sdcard` 公共存储，受限目录给出明确提示。手机与 Pico 通用。

**已完成**
- [x] 后端目录列举：`ADBManager.listDeviceFiles(deviceId, dirPath)` 解析设备目录条目（名称、大小、修改时间、是否目录/符号链接）
- [x] 后端下载：`ADBManager.pullDeviceFile(deviceId, remotePath, localPath)` 单文件/目录拉取到 PC
- [x] 后端批量下载：多选文件并发拉取到 PC 同一文件夹，逐个回传 `PULL_DEVICE_FILE_PROGRESS` 进度（文件名、序号、总数、状态）
- [x] 后端上传：`ADBManager.pushDeviceFile` 推送本地文件到设备目录，回传 `PUSH_DEVICE_FILE_PROGRESS` 进度
- [x] 后端删除：`ADBManager.deleteDeviceFile(deviceId, remotePath, isDir)`（目录走 `rm -rf`，可删空/非空文件夹）
- [x] 后端新建文件夹：`ADBManager.createDeviceFolder(deviceId, dirPath, name)` 执行 `shell mkdir`，名称校验（非空、禁含 `/ \`），同名/无权限给明确错误；`CREATE_DEVICE_FOLDER` 通道，UI 工具栏「📁+ 新建文件夹」行内输入名称后创建并刷新当前目录
- [x] 打开所在文件夹：`SHOW_ITEM_IN_FOLDER` 通过 `shell.showItemInFolder` 在系统文件管理器定位下载结果
- [x] IPC 打通：`channels.ts` 新增 `LIST_DEVICE_FILES` / `PULL_DEVICE_FILE` / `PULL_DEVICE_FILES` / `PULL_DEVICE_FILE_PROGRESS` / `DELETE_DEVICE_FILE` / `PUSH_DEVICE_FILE` / `PUSH_DEVICE_FILE_PROGRESS` / `SELECT_UPLOAD_FILES` / `SHOW_ITEM_IN_FOLDER`；`index.ts`/`index-prod.ts` 注册 handler；`preload.js` 暴露；`electronApi.ts` 类型封装
- [x] 共享类型：`PushProgress` / `PullProgress` / `PullFilesResult` / `DeviceFileEntry` / `DeviceFileList`
- [x] 文件浏览器 UI：`components/FilesPanel.tsx` —— 目录列表、面包屑、上一级、当前目录文件名搜索、单文件下载/删除（行内二次确认）、上传（含拖拽上传）、多选批量下载 + 进度条
- [x] 快捷入口：内部存储 / 相机 / 图片 / 影片 / 下载；点击不存在的目录（如 Pico 无 `/sdcard/DCIM/Camera`）时保留当前列表并给温和琥珀色提示，不弹全局红色报错
- [x] 下载完成后提供「打开所在文件夹」快捷按钮，切换目录时清除旧的下载定位

**待补齐**
- [ ] 应用私有数据 `/data/data` 在有 root 的设备上的访问与受限提示打磨
- [ ] 大文件/大目录批量传输的取消与失败重试
- [ ] 目录批量下载（当前批量仅针对文件，目录用行内单独「下载」按钮）

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/adb/ADBManager.ts` | `listDeviceFiles` / `pullDeviceFile` / `pushDeviceFile` / `deleteDeviceFile` 等设备文件方法 |
| `android-device-monitor/src/main/index.ts` / `index-prod.ts` | 文件列举/上传/下载/批量下载/删除/打开所在文件夹 IPC handler |
| `android-device-monitor/src/main/preload.js` | `listDeviceFiles` / `pullDeviceFile(s)` / `pushDeviceFile` / `deleteDeviceFile` / `showItemInFolder` / `selectUploadFiles` 桥接 |
| `android-device-monitor/src/renderer/lib/electronApi.ts` | 设备文件 API 类型化封装与进度订阅 |
| `android-device-monitor/src/shared/ipc/channels.ts` | 设备文件相关通道常量 |
| `android-device-monitor/src/shared/types/index.ts` | `DeviceFileEntry` / `DeviceFileList` / `PushProgress` / `PullProgress` / `PullFilesResult` |
| `android-device-monitor/src/renderer/components/FilesPanel.tsx` | 设备文件浏览器 UI（浏览/搜索/上传/下载/批量下载/删除/快捷入口） |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 设备卡片「📁 文件管理」入口，挂载 FilesPanel |

**验收标准**
- `npm run build` 通过；`npm test` 通过
- 设备卡片点「文件管理」弹出文件浏览器，可浏览 `/sdcard` 目录、进入子目录、返回上一级
- 单文件可下载到 PC，目录可整体下载；多选文件可批量下载到同一文件夹并显示进度
- 可上传本地文件（含拖拽）到当前设备目录，显示上传进度
- 可删除设备文件（行内二次确认）
- 点击不存在的快捷目录不弹红色报错，仅温和提示并保留当前列表
- 下载完成后「打开所在文件夹」可在系统文件管理器定位到文件

---

### Phase 12: 历史设备保存与快速重连

**状态**：待开发

**目标**：把通过 WiFi 成功连过的设备记下来，在设备连接区域以「历史设备卡片」列表呈现，下次一键快速重连；设备 IP 变更导致快速连接失败时，在卡片内就地输入新 IP 重连；支持手动移除历史卡片。对齐 Product-Spec 功能需求 2.1 / 2.1.1、用户流程 4.1、数据模型 5.1.1。USB 设备即插即识别，不进历史。

**设计约束（复用现有实现，不另造轮子）**
- 持久化沿用现有「自定义设备显示名」的渲染层 `localStorage` 方式（参考 `SimpleApp.tsx` 中 `DEVICE_NAME_STORAGE_KEY` / `loadStoredDeviceNames` / `setItem` 的写法），物理上落在 Electron userData 目录下，UI 不暴露宿主绝对路径。
- 快速重连复用现有 `CONNECT_WIFI` IPC（`channels.ts` 的 `CONNECT_WIFI: 'adb:connect-wifi'`，渲染层经 `electronApi.ts` 调用），传入历史记录的 `lastAddress`（`ip:端口`）。**不新增主进程 ADB 命令，不新增 IPC 通道。**
- WiFi 设备的 `DeviceInfo.id` 即 `ip:端口`，`serialNo` 为设备序列号；历史去重以 `serialNo` 为唯一键。
- 在线状态不持久化，由当前 `devices` 列表按 `serialNo` 匹配实时计算（匹配到且 `status==='connected'` 即在线）。

**交付清单**
- [ ] 共享类型：在 `src/shared/types/index.ts` 新增 `HistoryDevice`（`serialNo: string`、`model: string`、`lastAddress: string`、`lastConnectedAt: number`），与 Product-Spec 5.1.1 对齐
- [ ] 历史存储工具：在 `src/renderer/lib/` 新增 `historyDeviceStore.ts`，提供 `loadHistoryDevices(): HistoryDevice[]`、`saveHistoryDevices(list)`、`upsertHistoryDevice(device)`（按 `serialNo` 去重更新 `lastAddress`/`lastConnectedAt`）、`removeHistoryDevice(serialNo)`；用独立 `localStorage` key（如 `adm.historyDevices.v1`），解析失败时容错返回空数组（参照 `SimpleApp.tsx` 现有 `loadStoredDeviceNames` 的 try/catch 兜底写法）
- [ ] 写入时机：在 `SimpleApp.tsx` 的 WiFi 连接成功路径里，连接成功后用返回/刷新得到的设备信息（`connectionType==='wifi'`）调用 `upsertHistoryDevice`，记录 `serialNo`/`model`/`lastAddress`(=`ip:端口`)/`lastConnectedAt`(=当前时间戳)；USB 连接路径不写入
- [ ] 历史卡片列表 UI：在设备连接区域新增「历史设备」列表区，按 `lastConnectedAt` 倒序渲染，每张卡片展示：设备型号、`serialNo`、上次 `ip:端口`、上次连接时间（本地时间格式，复用项目已有的本地时间格式化习惯）、在线/离线状态徽标
- [ ] 快速连接：卡片上「快速连接」按钮，调用现有 WiFi 连接逻辑并传入 `lastAddress`；连接进行中按钮禁用并显示「连接中…」即时反馈；成功后刷新该卡片状态为在线并以最新 `ip:端口`/时间 `upsert` 覆盖
- [ ] 失败就地重连：快速连接失败时，卡片就地展开 IP 输入框（预填 `lastAddress` 便于改端口/IP），用户确认后用新地址再次发起 `CONNECT_WIFI`；成功则用新地址 `upsert` 覆盖历史；仍失败则在卡片内显示失败文案并保留输入框，不删除历史记录
- [ ] 手动移除：每张卡片「移除」入口，点击弹行内二次确认（确认移除 / 取消，复用项目现有行内二次确认交互模式，如断开/删除文件的二次确认），确认后调用 `removeHistoryDevice` 并从列表移除；仅删历史记忆，不影响当前已建立的连接
- [ ] 空状态：无历史设备时，历史区显示温和的空状态提示（如「暂无历史 WiFi 设备，成功连接一次后会自动出现在这里」），不显示空白

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/shared/types/index.ts` | 新增 `HistoryDevice` 类型 |
| `android-device-monitor/src/renderer/lib/historyDeviceStore.ts` | 历史设备 localStorage 读写、按 `serialNo` 去重 upsert、移除、容错解析 |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | WiFi 连接成功写入历史；历史卡片列表区（倒序/在线状态/快速连接/失败就地输入重连/移除二次确认/空状态）；复用现有 `CONNECT_WIFI` 调用与本地时间格式化 |
| `android-device-monitor/src/renderer/lib/electronApi.ts` | 复用：现有 WiFi 连接 API（快速连接传入历史 `lastAddress`），无需新增通道 |

**验收标准**
- `npm run build` 通过；`npm test` 通过
- 通过 WiFi 成功连接一台设备后，设备连接区域出现对应历史卡片；USB 连接的设备不出现在历史中
- 历史卡片按最近连接时间倒序排列，展示型号、SN、上次 IP:端口、上次连接时间与在线/离线状态
- 点「快速连接」用记录的 IP:端口直接发起连接，连接中按钮有即时禁用/加载反馈，成功后卡片变为在线并刷新时间
- 设备 IP 变更导致快速连接失败时，卡片就地出现预填上次 IP 的输入框，改成新 IP 确认后可重连成功，并用新地址覆盖历史
- 重连仍失败时卡片显示失败提示且保留输入框与历史记录，不被删除
- 点「移除」经二次确认后该历史卡片消失，且不影响当前已连接设备；刷新/重启应用后历史保持（localStorage 持久化）
- 无历史设备时显示空状态提示，不是空白区域

---

### Phase 14: Pico 弱网控制桌面集成

**状态**：待开发

**目标**：把桌面工具做成 Pico 弱网助手（`pico-network-helper` APK）的控制台：一键安装助手、选目标应用包名、设置弱网参数（延迟/抖动/丢包/上行/下行限速）、启动/停止弱网、展示助手运行状态。对齐 Product-Spec 功能需求 2.7、用户流程 4.5、数据模型 5.8。助手端 APK 代码已完成，本 Phase 只做桌面端集成。架构见 `docs/adr/0002`，tun2socks 内核见 `docs/adr/0003`。

**设计约束（复用现有实现，不另造轮子）**
- 助手 APK 随包分发沿用 `platform-tools` / `scrcpy` 的「`vendor/` 暂存 + `extraResources` 拷贝 + `prepare` 脚本」模式；运行时定位沿用 `src/main/scrcpy/scrcpyBinary.ts` 的 `process.resourcesPath`（生产）+ `path.resolve(__dirname, ...)`（开发）双路径回退，**禁止硬编码绝对路径**（CLAUDE.md 路径规范）。
- 安装助手复用现有 `INSTALL_APK`（`adb:install-apk`）链路，不新增安装命令；目标包名选择复用现有 `LIST_INSTALLED_PACKAGES`（`adb:list-installed-packages`）。
- 弱网控制为新增 IPC，必须**三处同步**：`src/shared/ipc/channels.ts` 定义通道 → `src/main/preload.js` 暴露 → `src/renderer/lib/electronApi.ts` 包装；主进程 handler 必须在 `src/main/index.ts` 与 `src/main/index-prod.ts` **两处同步注册**，业务逻辑落在 `ADBManager`。
- 起停通过 `adb shell am start-foreground-service` 下发到助手 exported 的 `WeakNetworkControlService`（action `com.androidtool.piconetworkhelper.START/STOP`，extras：`packageName/latencyMs/jitterMs/packetLossPercent/uploadKbps/downloadKbps`，其中 `packetLossPercent` 用 `--ef` 浮点、其余 `--ei` 整数、包名用 `--es`）。
- 状态查询用 `adb shell dumpsys`（查助手 `WeakNetworkVpnService` 是否在运行 / VPN 是否建立）推断，**不改动助手 APK**。
- VPN 授权引导：检测到「待授权/未就绪」时，用 `am start -n com.androidtool.piconetworkhelper/.MainActivity` 拉起助手触发系统 VPN 授权弹窗（在头显内确认）。

**交付清单**
- [ ] 助手 APK 暂存脚本：新增 `android-device-monitor/scripts/prepare-helper-apk.js`，把 `pico-network-helper` 的构建产物（`app/build/outputs/apk/debug/app-debug.apk`，路径用 `path.resolve(__dirname, ...)` 从脚本锚点推导到仓库根）复制到 `android-device-monitor/vendor/pico-helper/pico-network-helper.apk`；源 APK 不存在时打印明确指引（先在 `pico-network-helper/` 执行 `gradlew assembleDebug`）并以非零码退出，参照 `scripts/prepare-scrcpy.js` 的结构与日志风格
- [ ] 打包配置：`android-device-monitor/package.json` 的 `build.extraResources` 增加 `{ from: 'vendor/pico-helper', to: 'pico-helper', filter: ['**/*'] }`；新增脚本 `helper:prepare = node ./scripts/prepare-helper-apk.js`；并把 `helper:prepare` 串进 `pack` 与 `dist`（即 `npm run adb:prepare && npm run scrcpy:prepare && npm run helper:prepare && electron-builder ...`）
- [ ] 助手 APK 运行时定位：新增 `android-device-monitor/src/main/adb/helperApkBinary.ts`，导出 `resolveHelperApkPath(): string`，按 `process.resourcesPath` 下 `pico-helper/pico-network-helper.apk`（生产）与 `path.resolve(__dirname, '../../../../vendor/pico-helper/pico-network-helper.apk')`（开发）双候选回退，返回首个存在者，全部缺失时抛出带两条候选路径的错误，完全照搬 `scrcpyBinary.ts` 的写法
- [ ] IPC 通道定义：`src/shared/ipc/channels.ts` 的 `IPC_CHANNELS` 新增 `INSTALL_WEAKNET_HELPER: 'weaknet:install-helper'`、`START_WEAKNET: 'weaknet:start'`、`STOP_WEAKNET: 'weaknet:stop'`、`QUERY_WEAKNET_STATUS: 'weaknet:status'`
- [ ] 共享类型：`src/shared/types/index.ts` 新增 `WeakNetworkProfile`（`packageName/latencyMs/jitterMs/packetLossPercent/uploadKbps/downloadKbps`）、`WeakNetworkPreset`（`id/label/values`）、`WeakNetworkHelperStatus`（`'not-installed'|'idle'|'need-vpn-permission'|'running'|'stopped'|'error'`），与 Product-Spec 5.8 对齐；并导出内置预设常量 `WEAK_NETWORK_PRESETS`（弱 WiFi / 3G / 高丢包 / 高延迟四档具体数值）
- [ ] ADBManager 能力：`src/main/adb/ADBManager.ts` 新增 ① `installWeakNetworkHelper(deviceId)` —— 用 `resolveHelperApkPath()` 复用现有安装实现（`-r` 重装覆盖）；② `startWeakNetwork(deviceId, profile)` —— 拼装并执行 `am start-foreground-service` START（`--es packageName` + `--ei`/`--ef` 各参数），下发前对参数做范围裁剪（与助手端 `WeakNetworkConfig` 一致：latency/jitter 0–60000、loss 0–100、kbps≥0）；③ `stopWeakNetwork(deviceId)` —— 下发 STOP；④ `queryWeakNetworkStatus(deviceId): Promise<WeakNetworkHelperStatus>` —— 先用现有 `LIST_INSTALLED_PACKAGES` 逻辑判断助手是否安装（未装→`not-installed`），再 `dumpsys activity services com.androidtool.piconetworkhelper` / `dumpsys` 查 `WeakNetworkVpnService` 是否在跑（在跑→`running`，否则→`idle`），命令异常→`error`；⑤ `prepareWeakNetworkVpnPermission(deviceId)` —— `am start` 拉起助手 `MainActivity` 触发授权弹窗
- [ ] 主进程 handler（两处同步）：`src/main/index.ts` 与 `src/main/index-prod.ts` 各新增 `ipcMain.handle` 注册 `INSTALL_WEAKNET_HELPER`/`START_WEAKNET`/`STOP_WEAKNET`/`QUERY_WEAKNET_STATUS`，分别委托到上述 `ADBManager` 方法，并用现有 `AdbCommandError`/`classifyAdbError` 模式把错误转成结构化 IPC 响应（参照现有 install/uninstall handler 的写法）
- [ ] preload 暴露：`src/main/preload.js` 在 `window.electronAPI` 上新增 `installWeakNetHelper(deviceId)`、`startWeakNet(deviceId, profile)`、`stopWeakNet(deviceId)`、`queryWeakNetStatus(deviceId)` 的 invoke 包装
- [ ] 渲染层 API：`src/renderer/lib/electronApi.ts` 增加对应的 typed 包装方法，入参/出参用上面的共享类型
- [ ] 弱网面板组件：新增 `src/renderer/components/WeakNetPanel.tsx`，包含：目标应用选择（下拉，数据来自已安装应用列表）、预设档位按钮组（点击填入参数）、5 个参数的手动输入/滑块（受控，超范围即时校正）、「安装助手」按钮（助手未安装时高亮）、「启动弱网 / 停止弱网」主按钮（按状态切换）、状态徽标（未安装/已就绪/待授权/运行中/已停止/异常）、待授权时的「在设备上授权」引导按钮；props 经 `SimpleApp` 注入回调与状态
- [ ] 标签页接入：`src/renderer/SimpleApp.tsx` 的 `TabType` 增加 `'weaknet'`，标签栏（现 `devices/logs/performance/network/mirror` 数组）新增 `{ key: 'weaknet', label: '弱网' }`，并在面板区 `activeTab === 'weaknet'` 时挂载 `WeakNetPanel`；进入该标签或切换设备时调用 `queryWeakNetStatus` 拉取状态，起停/安装后刷新状态
- [ ] 测试断言同步：`tests/smoke.test.js` 增加结构断言——4 个新 IPC 通道在 `channels.ts`、`preload.js`、`electronApi.ts` 三处均存在；`package.json` 的 `pack`/`dist` 含 `helper:prepare`；`extraResources` 含 `pico-helper` 条目；`WeakNetPanel.tsx`/`helperApkBinary.ts`/`prepare-helper-apk.js` 文件存在

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/scripts/prepare-helper-apk.js` | 新增：把 pico-network-helper 构建产物暂存到 `vendor/pico-helper/`（路径从 `__dirname` 推导，缺产物时报错指引） |
| `android-device-monitor/package.json` | 修改：`extraResources` 增 `pico-helper`；新增 `helper:prepare` 脚本并串入 `pack`/`dist` |
| `android-device-monitor/src/main/adb/helperApkBinary.ts` | 新增：助手 APK 运行时定位（resourcesPath + __dirname 双回退） |
| `android-device-monitor/src/shared/ipc/channels.ts` | 修改：新增 4 个弱网 IPC 通道 |
| `android-device-monitor/src/shared/types/index.ts` | 修改：`WeakNetworkProfile`/`WeakNetworkPreset`/`WeakNetworkHelperStatus` + `WEAK_NETWORK_PRESETS` |
| `android-device-monitor/src/main/adb/ADBManager.ts` | 修改：安装助手、START/STOP 下发、状态查询、参数裁剪 |
| `android-device-monitor/src/main/index.ts` | 修改：注册 4 个弱网 IPC handler |
| `android-device-monitor/src/main/index-prod.ts` | 修改：与 index.ts 同步注册 4 个弱网 IPC handler |
| `android-device-monitor/src/main/preload.js` | 修改：暴露 4 个弱网 invoke 包装 |
| `android-device-monitor/src/renderer/lib/electronApi.ts` | 修改：4 个 typed 渲染层 API |
| `android-device-monitor/src/renderer/components/WeakNetPanel.tsx` | 新增：弱网控制面板（选包名/预设档位/手动参数/安装/起停/状态/授权引导） |
| `android-device-monitor/src/renderer/SimpleApp.tsx` | 修改：`TabType` 加 `weaknet`、标签栏加「弱网」、挂载面板、状态拉取与刷新 |
| `android-device-monitor/tests/smoke.test.js` | 修改：IPC 三处同步、打包脚本/资源、组件与脚本文件存在性断言 |

**验收标准**
- `npm run build` 通过；`npm test` 通过（含新增结构断言）
- 4 个弱网 IPC 通道在 `channels.ts` / `preload.js` / `electronApi.ts` 三处一致存在；`index.ts` 与 `index-prod.ts` 的 handler 注册一致
- 「弱网」标签页可见并可切换；进入时按当前设备拉取并展示助手状态
- 助手未安装时，点「安装助手」用内置 APK 成功 `adb install`，状态刷新为「已就绪」
- 目标应用下拉来自真实已安装列表；选预设档位即时填入 5 个参数，手动改参数超范围被裁剪
- 点「启动弱网」下发 START 后状态变「运行中」；点「停止」下发 STOP 后状态变「已停止/已就绪」
- 状态查询用 VPN 隧道地址（`10.88.0.2`）判据，停止后立即反映为已就绪
- 打包（`npm run dist`）时 `helper:prepare` 把助手 APK 纳入 `extraResources`，安装包内含 `pico-helper/pico-network-helper.apk`
- 全程无硬编码绝对路径；真机（Pico）端到端验证目标 App 弱网生效列为本 Phase 的真机验收项
- 已知降级项（待真机细化）：助手状态查询仅可靠产出「未安装/已就绪/运行中/异常」四态；`need-vpn-permission`（待授权）与 `stopped` 无法仅凭 adb 稳定推断，首次授权改由 UI 的「在设备上授权 VPN」按钮手动触发

---

### Phase 13: 文件传输中断恢复

**状态**：待开发

**目标**：让文件批量上传/下载在被进程崩溃、任务管理器强杀打断后，重启应用能识别未完成任务并文件级续传。对齐 Product-Spec 功能需求 2.6「传输中断恢复」。解决两个现存缺陷：(1) 传输被打断时当前文件传成半截、且用最终文件名无法区分完整与损坏；(2) 批量任务清单只在内存（IPC handler 的 for 循环 + 渲染层 `fileTransferManager.ts`），进程一被杀就丢、无法恢复。**不做单文件字节级断点续传**（adb 协议不支持指定偏移续传，成本高收益窄）。

**设计约束（复用现有结构，不另造轮子）**
- journal 落在**主进程**（传输实际跑在主进程），物理路径用 `app.getPath('userData')` 下的 `transfer-journal.json`，UI 不暴露宿主绝对路径（遵循 CONTEXT.md 与 CLAUDE.md 路径规范，禁止硬编码绝对路径）。
- 批量循环已在 `index.ts` / `index-prod.ts` 的 `PUSH_DEVICE_FILE`、`PULL_DEVICE_FILES` handler 内逐文件调用 `ADBManager`，journal 的写入埋点就接在这两个循环里，不改动 `ADBManager` 的批量职责划分。
- 恢复语义 = **仅崩溃/被杀残留**：只有状态停留在 `pending`/`transferring`（没来得及了结就被杀）的任务算需恢复；用户主动取消、传输报错 `failed` 的任务在了结时即从 journal 移除，不进恢复队列、不弹窗。
- 恢复以**原设备**为前提：任务绑定原 `deviceId`，恢复时原设备未连接则等待，不允许改投其他设备。
- `index.ts` / `index-prod.ts` 两个入口的 handler 与生命周期钩子必须同步修改（项目既有约定）。

**Task 13.1 — journal 持久化模块（主进程）**
- [ ] 共享类型：`src/shared/types/index.ts` 新增 `TransferDirection`（`'upload' | 'download'`）、`TransferTaskStatus`（`'pending' | 'transferring' | 'done' | 'failed'`）、`TransferTask`（`id: string`、`batchId: string`、`direction`、`deviceId: string`、`sourcePath: string`（上传=本地路径/下载=设备路径）、`targetPath: string`（上传=设备目录/下载=本地保存目录）、`fileName: string`、`size: number`、`status`、`createdAt: number`、`updatedAt: number`）
- [ ] 新增 `src/main/transferJournal.ts`：单例，封装对 `path.join(app.getPath('userData'), 'transfer-journal.json')` 的读写。提供 `createBatch(tasks: TransferTask[]): void`（写入一批 `pending` 任务）、`markStatus(taskId, status)`（更新单任务状态与 `updatedAt`）、`removeBatch(batchId)`、`removeTask(taskId)`、`loadUnfinished(): TransferTask[]`（返回 `pending`/`transferring` 的任务，按 batchId 分组用）、`clearAll()`。写盘用**原子方式**：先写 `transfer-journal.json.tmp` 再 `fs.renameSync` 覆盖，避免写一半崩溃损坏 journal。读盘解析失败时容错返回空（参照项目 `historyDeviceStore.ts` / `loadStoredDeviceNames` 的 try/catch 兜底写法）。

**Task 13.2 — 临时名 + 原子落地（ADBManager）**
- [ ] `ADBManager.pushDeviceFile`：改为先 `adb push` 到设备端临时名（同目录 `.<fileName>.part`），push 成功后 `adb shell mv` 临时名→最终名；任一步失败保留 `.part`（可识别可清理），不污染最终文件名。进度轮询的 `stat` 目标路径同步改成 `.part` 路径。push 前若残留同名 `.part` 先 `rm -f` 清掉再传（支持重传）。
- [ ] `ADBManager.pullDeviceFile` / `runAdbPull`：统一走「先拉到临时文件再 rename」——把现有「盘根用系统临时目录中转」的方案（`pullDeviceFile` 已有的 `isDriveRoot` 分支）推广到**所有**下载：始终 pull 到目标同目录的 `.<fileName>.part`（盘根场景仍用系统临时目录），完成后校验大小>0 再 rename 成最终名；rename 跨卷失败时沿用现有 copy+rm 兜底。pull 前清理残留 `.part`。
- [ ] 不改这两个方法的对外签名（`index.ts` 调用处不动），仅内部实现改造。

**Task 13.3 — 批量 handler 接入 journal + 文件级续传 + 恢复入口**
- [ ] `index.ts` / `index-prod.ts` 的 `PUSH_DEVICE_FILE` handler：进入循环前 `createBatch`（按 `localPaths` 生成 `upload` 任务，`targetPath`=remoteDir）；每个文件传输前 `markStatus(taskId,'transferring')`，成功 `markStatus('done')`，失败 `markStatus('failed')`；整批结束（正常跑完或抛错了结）后把本批 `done`/`failed` 任务 `removeBatch` 清出 journal。
- [ ] `PULL_DEVICE_FILES` handler：把 `savedDir` 的获取与传输循环**解耦**——新建传输时仍弹 dialog 选目录，并把 `savedDir` 作为每个 `download` 任务的 `targetPath` 写进 journal；恢复传输时**不弹 dialog**，直接用 journal 里记录的 `targetPath`。其余 journal 埋点同上。
- [ ] 新增续传执行函数（主进程内复用）：给定一批未完成任务，跳过 `done`，对 `pending`/`transferring`/被打断的逐个重传（重传即从头，Task 13.2 已保证清理半截 `.part`），过程照常回传 `PUSH_DEVICE_FILE_PROGRESS` / `PULL_DEVICE_FILE_PROGRESS` 进度。
- [ ] 新增 IPC 通道 `RESUME_TRANSFERS`（`'adb:resume-transfers'`）：入参 batchId（或全部未完成），调用续传执行函数；`DISCARD_TRANSFERS`（`'adb:discard-transfers'`）：`removeBatch` 并清理设备端/本地残留 `.part`。`channels.ts` 加常量、`index.ts`/`index-prod.ts` 注册 handler。

**Task 13.4 — 恢复提示（进入设备文件管理时触发）+ IPC 契约 + 渲染层**

> 设计修订（2026-06-03）：原方案「应用启动即全局弹窗」存在硬伤——WiFi 设备启动时尚未连接（需手动重连），且启动时主进程 `did-finish-load` 推送早于渲染层订阅会丢事件。改为**拉取式 + 进入设备文件管理时就地提示**：用户点开某设备的文件管理时，该设备必然已连上、且正处于传输语境，此刻再提示「继续/丢弃」最自然。废弃 `TRANSFER_RESUME_AVAILABLE` 推送通道，改用 `GET_RESUME_BATCHES` invoke 主动拉取。

- [ ] 新增 IPC 通道 `GET_RESUME_BATCHES`（`'adb:get-resume-batches'`）：返回 `transferJournal.getResumeBatches()`（按 batch 聚合的摘要：`batchId`、`direction`、`deviceId`、未完成文件数、文件名样例）。`index.ts`/`index-prod.ts` 注册 handler。
- [ ] IPC 契约三件套同步：`channels.ts` 新增 `RESUME_TRANSFERS`/`DISCARD_TRANSFERS`/`GET_RESUME_BATCHES`；`preload.js` 暴露 `resumeTransfers(batchId, transferId)`/`discardTransfers(batchId)`/`getResumeBatches()`；`electronApi.ts` 类型化封装。
- [ ] 渲染层提示：在 `FilesPanel.tsx` 中，进入/切换设备时 `getResumeBatches()` 并过滤出本设备的未完成批次，在面板顶部就地展示提示条「上次有 N 个文件未上传/下载完，继续 / 丢弃」。
  - 「继续」：调 `resumeTransfers(batchId, transferId)`，进度复用现有 `fileTransferManager` 进度条展示；传输进行中时「继续」按钮禁用。任务绑定原 `deviceId`，提示只在该设备的文件管理里出现，天然不改投其他设备。
  - 「丢弃」：调 `discardTransfers(batchId)`，清理残留 `.part` 并移出 journal。
- [ ] `fileTransferManager.ts`：扩展 `startResumeTransfer`，复用现有 `activeUploadId`/`activePullId` + `onPushProgress`/`onPullProgress` 订阅机制，恢复传输复用同一套 uploadId/pullId 进度通道。

**Task 13.5 — 优雅关闭兜底 + 残留语义收口**
- [ ] `index.ts` app `before-quit`（`index-prod.ts` 同步）：若当前有传输在进行，先 `transferJournal` flush（确保最新状态落盘），再向正在跑的 adb 子进程发 SIGTERM。需要 `ADBManager` 暴露「取消/终止当前传输子进程」的能力（如 `cancelActiveTransfers()`，记录 push/pull 的 `child` 引用并 `child.kill('SIGTERM')`）。注意 SIGKILL（强杀/崩溃）拦不住，最终兜底仍是 journal。
- [ ] 收口残留语义：确认「用户主动取消传输」「传输报错 failed」两条路径都会把对应任务从 journal 移除（`removeTask`），只有未及了结即被杀的 `pending`/`transferring` 残留进 `loadUnfinished`。

**关键文件**
| 文件路径 | 说明 |
|----------|------|
| `android-device-monitor/src/main/transferJournal.ts` | 新增：传输日志持久化（userData/transfer-journal.json，原子写盘、未完成任务加载、容错解析） |
| `android-device-monitor/src/main/adb/ADBManager.ts` | `pushDeviceFile`/`pullDeviceFile`/`runAdbPull` 改临时名+原子 rename；新增 `cancelActiveTransfers()` |
| `android-device-monitor/src/main/transferRunner.ts` | 新增：双入口共用的批量传输执行核心（buildUploadBatch/buildDownloadBatch/runUploadBatch/runDownloadBatch/discardBatch + journal 埋点） |
| `android-device-monitor/src/main/index.ts` / `index-prod.ts` | `PUSH_DEVICE_FILE`/`PULL_DEVICE_FILES` handler 接入 journal 埋点；新增 `RESUME_TRANSFERS`/`DISCARD_TRANSFERS`/`GET_RESUME_BATCHES` handler；`before-quit` cancelActiveTransfers（journal 每步原子落盘即最新状态）+SIGTERM |
| `android-device-monitor/src/shared/ipc/channels.ts` | 新增 `RESUME_TRANSFERS`/`DISCARD_TRANSFERS`/`GET_RESUME_BATCHES` 通道常量 |
| `android-device-monitor/src/main/preload.js` | 暴露 `resumeTransfers`/`discardTransfers`/`getResumeBatches` |
| `android-device-monitor/src/renderer/lib/electronApi.ts` | 恢复相关 API 类型化封装 |
| `android-device-monitor/src/renderer/lib/fileTransferManager.ts` | `startResumeTransfer` 复用现有 uploadId/pullId 进度通道 |
| `android-device-monitor/src/renderer/components/FilesPanel.tsx` | 进入设备文件管理时拉取本设备未完成批次，顶部就地提示「继续/丢弃」 |
| `android-device-monitor/src/shared/types/index.ts` | 新增 `TransferDirection`/`TransferTaskStatus`/`TransferTask`/`TransferResumeBatch`/`TransferBatchResult` |

**验收标准**
- `npm run build` 通过；`npm test` 通过
- 上传/下载进行中强杀进程（任务管理器结束进程），设备端/本地不残留**最终文件名**的半截文件——半截产物均为 `.part`（可识别）
- 重启应用、进入该设备的文件管理 → 顶部提示「上次有 N 个文件未上传/下载完，继续/丢弃」
- 点「继续」→ 跳过已完成文件，重传被打断的与剩余文件，进度条正常显示，全部完成后 journal 清空、提示消失
- 点「丢弃」→ 任务从 journal 移除、残留 `.part` 被清理，再进文件管理不再提示
- 用户主动取消的传输、传输报错失败的任务，重启后进文件管理**不**触发恢复提示
- 正常退出（关闭窗口/退出应用）时若有传输在跑，journal 为最新状态、adb 子进程被终止

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
│   │   │   ├── performanceRecording.ts
│   │   │   ├── picoMetrics.ts
│   │   │   ├── runtimeInspector.ts
│   │   │   ├── screenshotCapture.ts
│   │   │   └── types.ts
│   │   ├── scrcpy/
│   │   │   ├── scrcpyBinary.ts
│   │   │   └── scrcpyManager.ts
│   │   ├── index.ts
│   │   ├── index-prod.ts
│   │   ├── logger.ts
│   │   ├── performanceSnapshots.ts
│   │   ├── performanceSessionExport.ts
│   │   ├── performanceMedia.ts
│   │   └── preload.js
│   ├── renderer/
│   │   ├── components/
│   │   │   ├── FilesPanel.tsx
│   │   │   ├── MirrorPanel.tsx
│   │   │   ├── NetworkPanel.tsx
│   │   │   └── PerformancePanel.tsx
│   │   ├── lib/
│   │   │   ├── electronApi.ts
│   │   │   ├── historyDeviceStore.ts   （Phase 12 规划新增）
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
| Phase 7: 投屏镜像与操控 | 已落地待真机验收 | 打包 scrcpy、主进程 spawn 调起独立窗口、普通 Android 一键投屏与触屏/文字/物理键操控、子进程生命周期回收已落地，投屏交互待真机验收 |
| Phase 8: 投屏参数 + Pico 单眼 + 快捷键速查 | 待开发 | 启动参数配置、Pico 自动 `--crop` 单眼裁切、物理键快捷键速查表与能力边界提示 |
| Phase 9: 卸载应用 | 已落地 | 第三方应用列表、搜索、`adb uninstall` 卸载与二次确认已落地 |
| Phase 10: 批量安装 | 已落地 | 单 APK 多设备并发安装、并发限流、逐台状态与重试已落地（已整合进设备页安装面板） |
| Phase 11: 设备文件管理 | 已落地待真机回归 | 设备文件浏览/上传/下载/多选批量下载/删除/打开所在文件夹/快捷入口容错已落地 |
| Phase 12: 历史设备保存与快速重连 | 待开发 | WiFi 历史设备卡片、一键快速重连、IP 变更就地输入重连、移除二次确认；复用现有 `CONNECT_WIFI` 与 localStorage 持久化，无新增 IPC |
| Phase 13: 文件传输中断恢复 | 待开发 | 主进程 journal 持久化 + 临时名原子落地，进程被杀后重启可识别未完成任务并文件级续传 |
| Phase 14: Pico 弱网控制桌面集成 | 待开发 | 「弱网」标签页、内置助手 APK 一键安装、目标包名选择、预设档位+手动参数、START/STOP 下发、tun 地址状态查询、VPN 授权引导；新增 4 个弱网 IPC（三处同步 + 双 entry 注册），助手端 APK 已完成 |

**当前阶段判断**
- 项目已经越过“脚手架阶段”
- 当前最准确的说法是：`Phase 2 / 3 完成，Phase 4 主链路完成但仍需校准和增强，Phase 5 首版已接入，Phase 6 持续收口中，Phase 7 投屏已落地待真机验收、Phase 8 待开发，Phase 9 卸载 / Phase 10 批量安装 / Phase 11 设备文件管理均已落地`

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

4. 开发 Phase 7 / 8（投屏镜像与操控，新增模块）
   - 先做 Phase 7：打包 scrcpy、主进程 spawn 调起独立窗口、普通 Android 一键投屏与操控、子进程生命周期回收
   - 再做 Phase 8：启动参数配置、Pico 单眼裁切、物理键快捷键速查与能力边界提示
   - 注意：scrcpy 子进程必须通过 `ADB` 环境变量复用内置 adb，避免与主程序 adb server 冲突

**进入下一轮实现时，建议优先调用**：`/dev-builder`
