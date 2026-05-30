# Android Device Monitor - 产品需求文档

## 1. 产品概述

### 1.1 产品定位
一款面向开发者的桌面端 Android 设备监控工具，支持通过 USB 和 WiFi 两种方式连接设备，实时查看应用运行状态、性能数据、设备画面、网络请求，并抓取系统日志进行分析。

### 1.2 目标用户
**给自己用的开发/调试工具**，主要用于日常开发过程中的设备调试和问题排查。

### 1.3 核心价值
- **高效调试**：一站式查看设备状态和日志
- **灵活连接**：支持 USB 和 WiFi 两种连接方式
- **实时监控**：即时获取应用运行数据

---

## 2. 功能需求

### 2.1 设备连接模块

| 功能点 | 描述 | 优先级 |
|--------|------|--------|
| USB 连接 | 通过 ADB USB 模式连接设备 | P0 |
| WiFi 连接 | 通过 ADB WiFi 模式连接同一局域网设备 | P0 |
| 设备列表 | 显示已连接的所有设备 | P0 |
| 连接状态 | 实时显示连接状态（已连接/断开） | P0 |
| 设备信息 | 显示设备型号、系统版本、序列号 | P1 |

### 2.2 应用运行情况模块

| 功能点 | 描述 | 优先级 |
|--------|------|--------|
| 进程列表 | 显示当前运行的所有进程及包名 | P0 |
| Activity 栈 | 显示指定应用的 Activity 栈信息 | P0 |
| CPU 使用率 | 实时显示 CPU 占用率 | P0 |
| 内存使用 | 显示内存占用情况（已用/可用） | P0 |
| GPU 帧率 | 显示渲染帧率 (FPS) | P0 |
| 实时预览设备画面 | 在性能模块内实时查看当前设备画面 | P0 |
| 性能快照截图 | 将当前性能指标与设备截图绑定保存，便于排查卡顿场景 | P0 |
| 异常取证 | 支持在 FPS 下跌或性能异常时手动/自动截图 | P1 |
| 网络请求 | 显示应用发出的 HTTP/HTTPS 请求 | P0 |
| 请求详情 | 查看请求头、响应数据、耗时 | P1 |

### 2.3 日志抓取模块

| 功能点 | 描述 | 优先级 |
|--------|------|--------|
| Logcat 全局日志 | 抓取系统所有日志 | P0 |
| 应用专属日志 | 按包名过滤日志 | P0 |
| Crash/ANR 日志 | 专门捕获崩溃和 ANR 日志 | P0 |
| TAG 过滤 | 按 TAG 名称过滤日志 | P0 |
| 日志级别过滤 | 过滤 Verbose/Debug/Info/Warn/Error | P1 |
| 日志搜索 | 关键词搜索日志内容 | P1 |
| 日志导出 | 将日志导出为文件 | P1 |

### 2.4 用户界面

| 功能点 | 描述 | 优先级 |
|--------|------|--------|
| 多标签页 | 支持同时查看多个设备 | P1 |
| 实时刷新 | 日志和数据实时更新 | P0 |
| 快捷键支持 | 常用操作快捷键 | P2 |
| 暗黑模式 | 支持明暗主题切换 | P2 |

### 2.5 投屏镜像与设备操控模块

丝滑镜像设备画面并反向操控。第一版采用「调起 scrcpy 独立窗口」方案（路线 A）：工具内打包 scrcpy 二进制，一键启动其原生窗口，关闭窗口即停止。区别于性能模块内基于截图流的低帧率「实时预览」——预览只为看一眼，本模块面向高帧率、可操控的实操场景，二者并存互补。

| 功能点 | 描述 | 优先级 |
|--------|------|--------|
| 一键投屏 | 工具内点击「投屏」启动 scrcpy，调起独立镜像窗口，高帧率低延迟显示设备画面；关闭窗口即停止 | P0 |
| 触屏操控 | 在镜像窗口内用鼠标点击/拖拽 → 注入为设备触摸事件（点击、滑动） | P0 |
| 文字输入 | 电脑键盘输入 → 注入到设备当前输入框（中文/英文） | P0 |
| 物理键操控 | 通过 scrcpy 原生快捷键触发返回 / Home / 最近任务 / 电源 / 音量加减 | P0 |
| 快捷键速查 | 工具内提供 scrcpy 物理键快捷键对照表，降低记忆成本 | P1 |
| Pico 单眼镜像 | Pico/XR 设备启动 scrcpy 时通过 `--crop` 裁出单眼区域显示，避免双目并排画面；操控按单眼坐标映射 | P0 |
| 启动参数配置 | 可配置码率 / 分辨率上限 / 裁切区域等 scrcpy 启动参数，平衡画质与流畅度 | P1 |

**能力边界（必须如实告知用户，不画饼）：**
- ✅ 普通 Android 手机/平板：镜像 + 触屏/文字/物理键操控完整可用。
- ✅ Pico **2D 界面**（启动器、平面应用、设置面板）：镜像 + 触屏点击可操作（scrcpy 注入标准 Android 触摸/按键事件）。
- ❌ Pico **VR 沉浸场景的 6DoF 手柄**（空间定位 + 摇杆 + 扳机）：**第一版不支持**。VR 手柄输入走 VR runtime（OpenXR / Pico SDK），不是标准 Android input 事件，scrcpy 无法注入。底层 HID 转发（`/dev/input/eventX` + `EVIOCGRAB`）为研究性方案，风险高，留作后续探索，不纳入第一版承诺。
- ❌ **用虚拟键盘 / 虚拟摇杆替代手柄同样不可行**：瓶颈不在 PC 端的输入表达方式，而在「输入如何进入设备上正在运行的 VR runtime」。虚拟摇杆发出的仍是 Android 触摸/按键事件，进不了 OpenXR / Pico SDK 的手柄状态；且 6DoF 的三维空间 pose 无法由二维摇杆合成。市面上能模拟手柄的工具（Meta XR Simulator、Unity XR Device Simulator、OpenVR-InputEmulator）均运行在「PC 侧 VR runtime + 应用也跑在 PC」的开发调试架构下，无法远程操控真实 Pico 头显内已安装的应用。结论：换输入方式不改变可行性，VR 手柄操控不纳入本工具范围。

---

## 3. 技术方案

### 3.1 技术栈

| 分类 | 技术 | 版本 |
|------|------|------|
| 框架 | Electron | ^28.0.0 |
| 语言 | TypeScript | ^5.0.0 |
| UI 框架 | React | ^18.0.0 |
| 样式 | TailwindCSS | ^3.0.0 |
| 图标 | Lucide React | ^0.290.0 |
| ADB 通信 | node-adb-api | ^1.3.0 |

### 3.2 核心架构

```
┌─────────────────────────────────────────────────────────┐
│                    主窗口 (Electron)                   │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐       │
│  │ 设备连接    │ │ 应用监控    │ │ 日志查看    │       │
│  │ 面板        │ │ 面板        │ │ 面板        │       │
│  └─────────────┘ └─────────────┘ └─────────────┘       │
├─────────────────────────────────────────────────────────┤
│                    渲染进程 (React)                     │
├─────────────────────────────────────────────────────────┤
│              IPC 通信层                                 │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │              主进程 (Electron)                   │   │
│  │  ┌────────────┐  ┌────────────┐  ┌───────────┐  │   │
│  │  │ ADB Manager│  │ 日志解析器 │  │ 数据存储  │  │   │
│  │  └────────────┘  └────────────┘  └───────────┘  │   │
│  └─────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│                      Android 设备                       │
└─────────────────────────────────────────────────────────┘
```

### 3.3 关键模块设计

#### 3.3.1 ADB 管理器

**功能**：管理与 Android 设备的通信

**核心方法**：
- `connectDevice(type: 'usb' | 'wifi', ip?: string)` - 连接设备
- `disconnectDevice(deviceId: string)` - 断开设备
- `getDevices()` - 获取已连接设备列表
- `executeShellCommand(deviceId: string, command: string)` - 执行 shell 命令
- `startLogcat(deviceId: string, filters: LogcatFilters)` - 启动日志监听
- `stopLogcat(deviceId: string)` - 停止日志监听

#### 3.3.2 日志解析器

**功能**：解析和过滤 logcat 输出

**日志格式**：
```
[时间戳] [进程ID]:[线程ID] [级别]/[TAG]: [消息内容]
```

**过滤规则**：
- 按包名过滤
- 按 TAG 过滤
- 按日志级别过滤
- 关键词搜索

#### 3.3.3 性能监控器

**功能**：获取设备性能数据

**监控指标**：
- CPU 使用率：通过 `top` 命令获取
- 内存使用：通过 `dumpsys meminfo` 获取
- FPS：通过 `dumpsys gfxinfo` 等方式获取前台应用渲染帧率，默认定义为应用渲染 FPS，而不是屏幕刷新率
- Pico 官方指标：仅对“已集成 `XR Profiling Toolkit` 的 Pico 应用”承诺提供 `FPS / MTP / FrmCpu / FrmGpu / ATWGPU / GPU` 官方口径
- 实时预览设备画面：通过截图流或投屏能力，在性能模块中显示当前设备画面
- 投屏镜像与操控：打包 scrcpy 二进制（随 platform-tools 一并作为 extraResources），主进程以子进程方式 `spawn` scrcpy，传入目标设备序列号与启动参数（码率、分辨率上限、`--crop` 单眼裁切等），调起其原生窗口。镜像、触屏注入、文字输入、物理键映射均由 scrcpy 原生提供；工具侧负责设备选择、参数拼装、进程生命周期管理（启动/停止/异常退出回收）。第一版不做内嵌解码（路线 B 的 WebCodecs 内嵌镜像留作后续升级）。
- 性能快照：在指定时间点记录性能指标、前台应用、Activity 与对应截图
- 短时性能录制：在性能模块内录制 10 / 30 / 60 秒设备画面，并同步保存同一时间段的性能采样数据。普通 Android 优先使用设备端 `screenrecord` 生成 MP4，避免持续传输原始帧；Pico 设备通过录制 provider 分流，第一版使用可用的设备端录制通道，后续可替换为 Pico SDK / 实时流通道。录制功能不做通用无限录屏，只服务性能排障取证。
- 网络请求：通过 `tcpdump` 或应用层 hook

---

## 4. 用户流程

### 4.1 连接设备流程

```
1. 打开应用
    ↓
2. 选择连接方式 (USB/WiFi)
    ↓
3. USB: 插入设备并授权
   WiFi: 输入设备 IP 地址
    ↓
4. 连接成功，显示设备列表
    ↓
5. 选择目标设备
    ↓
6. 进入监控界面
```

### 4.2 查看日志流程

```
1. 进入日志面板
    ↓
2. 选择过滤条件 (包名/TAG/级别)
    ↓
3. 实时显示日志
    ↓
4. 可选：搜索关键词
    ↓
5. 可选：导出日志
```

---

### 4.3 性能诊断流程

```text
1. 进入性能面板
    -> 2. 观察 CPU / 内存 / FPS / Activity 等实时指标
    -> 3. 在同一界面实时预览设备画面
    -> 4. 发现卡顿、掉帧或异常波动时，手动抓取性能快照
    -> 5. 可选：开始短时性能录制，记录问题发生前后的视频与指标时间线
    -> 6. 可选：配置 FPS 阈值或异常条件，自动截图取证
    -> 7. 回看快照或录制中的截图、指标和时间点，支持单击快照缩略图打开大图预览，定位问题
```

### 4.4 投屏操控流程

```text
1. 选择目标设备
    -> 2. 点击「投屏」（Pico 设备自动附加 --crop 单眼裁切参数）
    -> 3. 弹出 scrcpy 镜像窗口，高帧率显示设备画面
    -> 4. 鼠标点击/拖拽操控触屏，键盘输入文字
    -> 5. 用快捷键触发返回 / Home / 电源 / 音量等物理键（工具内提供快捷键速查）
    -> 6. 关闭镜像窗口即停止投屏，主进程回收 scrcpy 子进程
```

## 5. 数据模型

### 5.1 设备信息

```typescript
interface DeviceInfo {
  id: string;
  name: string;
  model: string;
  manufacturer: string;
  androidVersion: string;
  apiLevel: number;
  connectionType: 'usb' | 'wifi';
  status: 'connected' | 'disconnected';
}
```

### 5.2 进程信息

```typescript
interface ProcessInfo {
  pid: number;
  ppid: number;
  name: string;
  packageName: string;
  cpuUsage: number;
  memoryUsage: number;
  status: 'running' | 'sleeping' | 'zombie';
}
```

### 5.3 性能指标

```typescript
interface PerformanceMetrics {
  cpuUsage: number;
  memoryUsage: number;
  fps: number; // 前台应用渲染 FPS
  gpuFps?: number; // 如保留，用于区分旧实现来源
  packageName?: string;
  activityName?: string;
  capturedAt: Date;
}
```

性能页签不采集、不展示网络速度；网络请求与抓包仍归属网络页签。

### 5.4 性能快照

```typescript
interface PerformanceSnapshot {
  id: string;
  deviceId: string;
  capturedAt: Date;
  metrics: PerformanceMetrics;
  screenshotPath?: string;
  packageName?: string;
  activityName?: string;
  trigger: 'manual' | 'fps_drop' | 'threshold';
  note?: string;
}
```

- 快照回看：用户可在性能面板单击快照缩略图打开大图预览，并可通过点击遮罩、关闭按钮或 Esc 退出预览。
- 快照采集源：性能快照优先使用 raw framebuffer 快路径以避开设备端 PNG 压缩耗时；当设备不支持 raw 输出或解析失败时，自动回退到 PNG screencap，后续实时流 / SDK 截图通道通过同一 provider 接口接入。

### 5.5 性能录制

```typescript
interface PerformanceRecording {
  id: string;
  deviceId: string;
  provider: 'android-screenrecord' | 'pico-screenrecord' | 'pico-sdk';
  status: 'completed' | 'failed';
  startedAt: Date;
  endedAt: Date;
  durationMs: number;
  videoRelativePath?: string;
  manifestRelativePath?: string;
  singleEyeVideo?: boolean;
  samples: PerformanceSample[];
  packageName?: string;
  activityName?: string;
  error?: string;
}
```

- 录制时长：第一版只提供 10 秒、30 秒、60 秒短录制，不提供无限录制。
- 普通 Android：优先使用 `adb shell screenrecord --time-limit --bit-rate` 在设备端编码 MP4，结束后再 `adb pull` 到本地，降低 USB / WiFi 传输压力。
- Pico：必须通过录制 provider 与普通 Android 区分。第一版可落到 `pico-screenrecord`，但 UI 和数据模型需要保留 `pico-sdk` 扩展位，后续接入 Pico SDK / 实时画面流时不改用户流程。
- 录制产物：本地保存 MP4 与 JSON manifest，manifest 包含设备 ID、provider、起止时间、前台包名 / Activity、性能采样序列与 Pico 原始指标；返回给渲染层的是 `performance-recordings/...` 相对路径，不向 UI 暴露本机绝对路径。
- 视频文件：录制结束后保留设备端录制下来的原始 MP4，不把性能指标烧录或水印进视频画面。
- 回看方式：性能页必须展示录制缩略图和关键性能指标；用户单击缩略图后在工具内播放视频，播放器按当前视频时间匹配最近的性能样本并动态叠加展示。
- Pico 画面：Pico 原始 MP4 不做后处理裁切；工具内缩略图与播放画面可按性能快照同样的单眼区域展示，避免工具回看时显示双目并排画面。
- UI 约束：性能页顶部只保留核心操作区，录制控制与快照控制合并到“取证操作”区域；指标卡、趋势图、快照/录制记录分区展示，记录区顺序为快照在前、录制在后，避免继续把按钮堆在一行。

### 5.6 投屏会话

```typescript
interface MirrorSession {
  deviceId: string;
  isPico: boolean;
  crop?: string;          // scrcpy --crop 参数，Pico 单眼裁切，如 "1920:1920:0:0"
  maxSize?: number;       // 分辨率上限（--max-size）
  bitRate?: string;       // 码率（--video-bit-rate），如 "8M"
  status: 'starting' | 'running' | 'stopped' | 'failed';
  startedAt?: Date;
  error?: string;
}
```

- 启动方式：主进程 `spawn` 打包的 scrcpy 二进制，传入 `-s <deviceId>` 与上述参数；不内嵌画面，调起 scrcpy 原生窗口。
- Pico 处理：检测到 Pico 设备自动附加 `--crop` 单眼裁切参数，与性能快照/录制的单眼显示口径保持一致。
- 进程生命周期：用户关闭镜像窗口或在工具内点「停止」即结束子进程；scrcpy 异常退出时回收并向 UI 反馈错误，不残留僵尸进程。
- 能力边界：仅注入标准 Android 触摸/按键/文本事件；不承诺 Pico 6DoF 手柄模拟。

### 5.7 日志条目

```typescript
interface LogEntry {
  id: string;
  timestamp: Date;
  processId: number;
  threadId: number;
  level: 'V' | 'D' | 'I' | 'W' | 'E' | 'F';
  tag: string;
  message: string;
  packageName?: string;
}
```

### 5.6 网络请求

```typescript
interface NetworkRequest {
  id: string;
  timestamp: Date;
  packageName: string;
  method: string;
  url: string;
  statusCode: number;
  requestBody?: string;
  responseBody?: string;
  headers: Record<string, string>;
  duration: number; // 毫秒
}
```

---

## 6. 非功能需求

### 6.1 性能要求
- 日志显示延迟 < 100ms
- 支持同时连接 5+ 设备
- 内存占用 < 200MB
- 性能指标轮询与实时画面预览同时开启时，主界面仍应保持可交互
- 性能快照截图应在用户触发后尽快落盘，并与对应时间点指标绑定

### 6.2 兼容性要求
- Windows 10+ / macOS 10.15+ / Linux
- Android 7.0+ 设备
- ADB 版本 >= 33.0.0

### 6.3 安全性要求
- 仅本地运行，不传输数据到云端
- 设备连接需要用户授权
- 日志数据本地存储，可手动清理

---

## 7. 开发计划

### Phase 1: 基础框架搭建（1周）
- Electron 项目初始化
- ADB 管理器核心功能
- 设备连接 UI

### Phase 2: 日志模块（1周）
- Logcat 实时抓取
- 日志过滤和搜索
- 日志导出功能

### Phase 3: 性能监控（1周）
- CPU/内存监控
- FPS 监控
- 实时预览设备画面
- 性能快照截图
- Activity 栈查看

### Phase 4: 网络监控（1周）
- 网络请求捕获
- 请求详情展示

### Phase 5: 优化和测试（1周）
- 性能优化
- 错误处理
- 单元测试

---

## 8. 风险评估

| 风险 | 描述 | 影响 | 缓解措施 |
|------|------|------|----------|
| ADB 兼容性 | 不同 ADB 版本可能行为不一致 | 设备连接失败 | 内置 ADB 工具，统一版本 |
| 权限问题 | 用户未授权 USB 调试 | 无法连接设备 | 提供清晰的授权指引 |
| 性能问题 | 大量日志导致界面卡顿 | 用户体验差 | 日志分页、虚拟滚动 |
| 画面采集开销 | 实时预览和截图会占用额外带宽与 CPU | 影响监控流畅度 | 限制预览分辨率/帧率，按需开启 |
| WiFi 连接 | 网络不稳定影响连接 | 数据传输中断 | 自动重连机制 |
| Pico 手柄操控 | scrcpy 无法注入 6DoF 手柄输入 | VR 场景内无法操作 | 明确告知边界，第一版只承诺 2D 界面触屏操控 |
| scrcpy 打包体积 | 捆绑 scrcpy 二进制增大安装包 | 安装包变大 | 按平台分发，仅打包对应 OS 的 scrcpy |
| scrcpy 进程残留 | 子进程异常未回收 | 占用资源/重复窗口 | 主进程统一管理生命周期，退出时强制回收 |
