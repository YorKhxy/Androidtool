package com.androidtool.piconetworkhelper.vpn;

import android.os.ParcelFileDescriptor;

import com.androidtool.piconetworkhelper.model.WeakNetworkConfig;

import java.io.File;

public interface TunTransportEngine {
    /**
     * 启动 TUN 传输。
     *
     * @param tunInterface VpnService 建立的 TUN fd
     * @param config       弱网整形参数
     * @param workDir      可写工作目录（用于落地 native 内核所需的配置文件）
     * @param mtu          TUN 的 MTU，必须与 native 内核配置保持一致
     */
    void start(ParcelFileDescriptor tunInterface, WeakNetworkConfig config, File workDir, int mtu);

    void stop();

    boolean isRunning();
}
