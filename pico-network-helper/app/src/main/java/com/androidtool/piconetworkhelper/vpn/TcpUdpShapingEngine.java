package com.androidtool.piconetworkhelper.vpn;

import android.os.ParcelFileDescriptor;
import android.util.Log;

import com.androidtool.piconetworkhelper.model.WeakNetworkConfig;
import com.androidtool.piconetworkhelper.proxy.WeakSocks5Proxy;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;

/**
 * 用成熟的 native tun2socks 内核（hev-socks5-tunnel）承载 TUN 传输：
 *
 * <pre>
 *   TUN fd → hev(libhev-socks5-tunnel.so) → 本地 SOCKS5(127.0.0.1) → 真实网络
 * </pre>
 *
 * 弱网整形（延迟/抖动/丢包/限速）由本地 {@link WeakSocks5Proxy} 在 SOCKS5 层完成；hev 负责把
 * 设备应用的 TCP/UDP 流量可靠地转换并转发进这个本地代理。
 */
public final class TcpUdpShapingEngine implements TunTransportEngine {
    private static final String TAG = "TcpUdpShapingEngine";
    private static final String CONFIG_FILE_NAME = "hev-tunnel.conf";
    private static final int TASK_STACK_SIZE = 20480;

    private WeakSocks5Proxy proxy;
    private ParcelFileDescriptor tunInterface;
    private volatile boolean running;

    @Override
    public synchronized void start(
        ParcelFileDescriptor tunInterface,
        WeakNetworkConfig config,
        File workDir,
        int mtu
    ) {
        if (running) {
            return;
        }

        WeakSocks5Proxy localProxy = new WeakSocks5Proxy(config);
        try {
            int proxyPort = localProxy.start();
            File configFile = writeHevConfig(workDir, proxyPort, mtu);
            Log.i(TAG, "Starting hev tun2socks. TUN fd=" + tunInterface.getFd()
                + ", SOCKS5=127.0.0.1:" + proxyPort + ", config=" + configFile.getAbsolutePath());
            HevSocks5Tunnel.TProxyStartService(configFile.getAbsolutePath(), tunInterface.getFd());
        } catch (IOException | RuntimeException | UnsatisfiedLinkError error) {
            // 启动失败必须向上抛出，让 VpnService 感知并停止，而不是静默假装运行中。
            Log.e(TAG, "Failed to start hev tun2socks engine.", error);
            localProxy.stop();
            closeTun(tunInterface);
            throw new IllegalStateException("Failed to start hev tun2socks engine.", error);
        }

        this.proxy = localProxy;
        this.tunInterface = tunInterface;
        this.running = true;
    }

    @Override
    public synchronized void stop() {
        if (!running) {
            return;
        }
        running = false;
        try {
            HevSocks5Tunnel.TProxyStopService();
        } catch (Throwable error) {
            Log.w(TAG, "Failed to stop hev tun2socks service.", error);
        }
        if (proxy != null) {
            proxy.stop();
            proxy = null;
        }
        closeTun(tunInterface);
        tunInterface = null;
        Log.i(TAG, "hev tun2socks engine stopped.");
    }

    @Override
    public boolean isRunning() {
        return running;
    }

    /**
     * 生成 hev-socks5-tunnel 的 YAML 配置。{@code socks5.udp: 'udp'} 表示走标准 SOCKS5
     * UDP ASSOCIATE，因此本地代理必须实现 UDP ASSOCIATE 转发。
     */
    private File writeHevConfig(File workDir, int socksPort, int mtu) throws IOException {
        if (!workDir.exists() && !workDir.mkdirs()) {
            throw new IOException("Cannot create work dir: " + workDir.getAbsolutePath());
        }
        File configFile = new File(workDir, CONFIG_FILE_NAME);
        String yaml = "misc:\n"
            + "  task-stack-size: " + TASK_STACK_SIZE + "\n"
            + "tunnel:\n"
            + "  mtu: " + mtu + "\n"
            + "socks5:\n"
            + "  port: " + socksPort + "\n"
            + "  address: '127.0.0.1'\n"
            + "  udp: 'udp'\n";
        try (FileOutputStream out = new FileOutputStream(configFile, false)) {
            out.write(yaml.getBytes(StandardCharsets.UTF_8));
        }
        return configFile;
    }

    private void closeTun(ParcelFileDescriptor pfd) {
        if (pfd == null) {
            return;
        }
        try {
            pfd.close();
        } catch (Exception closeError) {
            Log.w(TAG, "Failed to close TUN interface.", closeError);
        }
    }
}
