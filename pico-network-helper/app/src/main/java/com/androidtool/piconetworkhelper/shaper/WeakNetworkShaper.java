package com.androidtool.piconetworkhelper.shaper;

import com.androidtool.piconetworkhelper.model.WeakNetworkConfig;

import java.util.Random;

public final class WeakNetworkShaper {
    private final WeakNetworkConfig config;
    private final Random random = new Random();
    private long nextUploadAtMs;
    private long nextDownloadAtMs;

    public WeakNetworkShaper(WeakNetworkConfig config) {
        this.config = config;
    }

    public synchronized PacketDecision decide(PacketDirection direction, int bytes) {
        WeakNetworkStats.getInstance().recordDecision(direction, bytes);
        if (shouldDrop()) {
            WeakNetworkStats.getInstance().recordDrop();
            return PacketDecision.drop();
        }

        long now = System.currentTimeMillis();
        long baseDelay = config.latencyMs + randomJitter();
        long throttleDelay = throttleDelay(direction, bytes, now);
        return PacketDecision.forward(baseDelay + throttleDelay);
    }

    private boolean shouldDrop() {
        return config.packetLossPercent > 0 && random.nextFloat() * 100 < config.packetLossPercent;
    }

    private int randomJitter() {
        if (config.jitterMs <= 0) {
            return 0;
        }
        return random.nextInt(config.jitterMs + 1);
    }

    private long throttleDelay(PacketDirection direction, int bytes, long now) {
        int kbps = direction == PacketDirection.UPLOAD ? config.uploadKbps : config.downloadKbps;
        if (kbps <= 0 || bytes <= 0) {
            return 0;
        }

        long durationMs = Math.max(1, Math.round(bytes * 8.0 / kbps));
        if (direction == PacketDirection.UPLOAD) {
            long startAt = Math.max(now, nextUploadAtMs);
            nextUploadAtMs = startAt + durationMs;
            return Math.max(0, startAt - now);
        }

        if (direction == PacketDirection.DOWNLOAD) {
            long startAt = Math.max(now, nextDownloadAtMs);
            nextDownloadAtMs = startAt + durationMs;
            return Math.max(0, startAt - now);
        }

        return 0;
    }
}
