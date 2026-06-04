# Pico Network Helper

Pico Network Helper is the Android-side helper APK for per-app weak-network control.

The first version targets a narrow scope:

- Target one Android package name.
- Apply latency, packet loss, upload limit, and download limit.
- Cover both TCP and UDP traffic.
- Avoid affecting the whole Pico device network.
- Avoid affecting WiFi ADB connectivity.

The desktop app remains the control surface. This helper owns the Android `VpnService` and traffic shaping runtime.

## Native tun2socks 内核

TUN 传输由预编译的 [hev-socks5-tunnel](https://github.com/heiher/hev-socks5-tunnel) 内核承载：
`TUN fd → hev → 本地 SOCKS5(WeakSocks5Proxy，在此做弱网整形) → 真实网络`。

- `.so` 已入库 `app/src/main/jniLibs/arm64-v8a/libhev-socks5-tunnel.so`，**构建无需 NDK**，
  任意机器 `gradlew assembleDebug` 直接出带 tun2socks 的 APK。
- 升级 hev 版本或新增 ABI 时，在装有 NDK 的机器上运行 `scripts/build-native.ps1` 重新生成 .so。
- 选型理由、JNI 绑定与 .so 来源版本见 `docs/adr/0003-hev-tun2socks-prebuilt-so.md`。
