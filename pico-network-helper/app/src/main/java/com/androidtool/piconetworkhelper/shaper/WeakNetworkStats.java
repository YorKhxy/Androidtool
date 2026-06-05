package com.androidtool.piconetworkhelper.shaper;

import java.util.concurrent.atomic.AtomicLong;

/**
 * 弱网整形的实时统计计数器（进程内单例）。
 *
 * <p>仅做计数与快照，不参与任何转发/整形决策逻辑。所有计数用 {@link AtomicLong} 持有，
 * 跨线程（多个 SOCKS5 pipe 线程、UDP 中继线程、connect 线程）并发累加安全。
 *
 * <p>弱网启动时调用 {@link #reset()} 清零，引擎里每秒读取 {@link #snapshotJson()} 打到 logcat，
 * 桌面端解析这些 key 还原真实丢包率 / RTT / 上下行字节。JSON 字段为对外契约，不可改名。
 */
public final class WeakNetworkStats {

    private static final WeakNetworkStats INSTANCE = new WeakNetworkStats();

    private final AtomicLong uploadBytes = new AtomicLong();
    private final AtomicLong downloadBytes = new AtomicLong();
    private final AtomicLong decidedPackets = new AtomicLong();
    private final AtomicLong droppedPackets = new AtomicLong();
    private final AtomicLong rttSumMs = new AtomicLong();
    private final AtomicLong rttSampleCount = new AtomicLong();

    private WeakNetworkStats() {
    }

    public static WeakNetworkStats getInstance() {
        return INSTANCE;
    }

    /** 弱网启动时清零所有计数。 */
    public void reset() {
        uploadBytes.set(0);
        downloadBytes.set(0);
        decidedPackets.set(0);
        droppedPackets.set(0);
        rttSumMs.set(0);
        rttSampleCount.set(0);
    }

    /** 记录一次整形决策：决策总数 +1，按方向累计字节。 */
    public void recordDecision(PacketDirection direction, int bytes) {
        decidedPackets.incrementAndGet();
        if (bytes <= 0) {
            return;
        }
        if (direction == PacketDirection.UPLOAD) {
            uploadBytes.addAndGet(bytes);
        } else if (direction == PacketDirection.DOWNLOAD) {
            downloadBytes.addAndGet(bytes);
        }
    }

    /** 决策结果为丢弃时调用，丢弃数 +1。 */
    public void recordDrop() {
        droppedPackets.incrementAndGet();
    }

    /** connect 成功时记录一次实际 RTT 采样。 */
    public void recordRtt(long rttMs) {
        if (rttMs < 0) {
            return;
        }
        rttSumMs.addAndGet(rttMs);
        rttSampleCount.incrementAndGet();
    }

    /**
     * 紧凑 JSON 快照。字段为对外契约，桌面端按这些 key 解析，不可改名：
     * up=上行字节、down=下行字节、fwd=决策总数、drop=丢弃数、rttMs=RTT 累计、rttN=RTT 采样数。
     */
    public String snapshotJson() {
        return "{\"up\":" + uploadBytes.get()
            + ",\"down\":" + downloadBytes.get()
            + ",\"fwd\":" + decidedPackets.get()
            + ",\"drop\":" + droppedPackets.get()
            + ",\"rttMs\":" + rttSumMs.get()
            + ",\"rttN\":" + rttSampleCount.get()
            + "}";
    }
}
