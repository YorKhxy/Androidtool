此目录用于存放打包时随应用一起分发的 Android Platform Tools。

- 运行 `npm run adb:prepare` 会按当前构建平台自动下载官方 `platform-tools-latest-<platform>.zip`
- 下载完成后，实际可执行文件位于 `vendor/platform-tools/<platform>/platform-tools/`
- 打包产物会把这里的内容复制到 `resources/platform-tools/`
