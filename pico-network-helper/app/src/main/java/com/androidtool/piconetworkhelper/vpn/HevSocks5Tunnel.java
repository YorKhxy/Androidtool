package com.androidtool.piconetworkhelper.vpn;

/**
 * hev-socks5-tunnel(native tun2socks) 的 JNI 桥接。
 *
 * <p>对应的 native 库 {@code libhev-socks5-tunnel.so} 由 heiher/hev-socks5-tunnel 源码编译，
 * 编译时通过 {@code -DPKGNAME=com/androidtool/piconetworkhelper/vpn -DCLSNAME=HevSocks5Tunnel}
 * 把 JNI 注册目标指向本类。库在 {@code JNI_OnLoad} 里用 {@code RegisterNatives} 动态绑定下面三个
 * 方法，因此方法名/签名必须与 native 侧保持一致，不能改。
 *
 * <p>{@code .so} 已预编译入库（{@code app/src/main/jniLibs/arm64-v8a/}），重新生成见
 * {@code scripts/build-native.ps1} 与 {@code docs/adr/0003-hev-tun2socks-prebuilt-so.md}。
 */
public final class HevSocks5Tunnel {

    static {
        System.loadLibrary("hev-socks5-tunnel");
    }

    private HevSocks5Tunnel() {
    }

    /**
     * 启动 tun2socks。native 侧会在自己的线程里跑 {@code hev_socks5_tunnel_main}，本调用立即返回。
     *
     * @param configPath hev YAML 配置文件的绝对路径
     * @param fd         VpnService 建立的 TUN 文件描述符（{@link android.os.ParcelFileDescriptor#getFd()}）
     */
    public static native void TProxyStartService(String configPath, int fd);

    /** 停止 tun2socks（内部调用 {@code hev_socks5_tunnel_quit} 并 join 工作线程）。 */
    public static native void TProxyStopService();

    /**
     * 读取流量统计。
     *
     * @return 长度为 4 的数组：[tx_packets, tx_bytes, rx_packets, rx_bytes]
     */
    public static native long[] TProxyGetStats();
}
