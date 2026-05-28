# Product Spec Changelog

## 2026-05-28

- 性能快照：截图采集拆为 provider 链路，优先使用 raw framebuffer 快路径，失败时自动回退 PNG screencap，为后续实时流 / SDK 截图通道保留接入点。
- 性能采集：Android 与 Pico 性能页签不再采集或展示网络速度，网络抓包能力保留在网络页签。
- 性能导出：Raw Data 去掉 NET 字段，合并 Pico Metrics 数据，GPU % 排在 MEM MB 后面，不再单独生成 Pico Metrics 页签。

- 性能快照：补充单击快照缩略图打开大图预览的回看能力，支持遮罩、关闭按钮和 Esc 关闭预览。
