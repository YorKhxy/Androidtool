package com.androidtool.piconetworkhelper.model;

import android.content.Intent;

import com.androidtool.piconetworkhelper.control.WeakNetworkControlService;

public final class WeakNetworkConfig {
    public final String packageName;
    public final int latencyMs;
    public final int jitterMs;
    public final float packetLossPercent;
    public final int uploadKbps;
    public final int downloadKbps;

    public WeakNetworkConfig(
        String packageName,
        int latencyMs,
        int jitterMs,
        float packetLossPercent,
        int uploadKbps,
        int downloadKbps
    ) {
        this.packageName = requirePackageName(packageName);
        this.latencyMs = clamp(latencyMs, 0, 60000);
        this.jitterMs = clamp(jitterMs, 0, 60000);
        this.packetLossPercent = Math.max(0, Math.min(packetLossPercent, 100));
        this.uploadKbps = Math.max(0, uploadKbps);
        this.downloadKbps = Math.max(0, downloadKbps);
    }

    public static WeakNetworkConfig fromIntent(Intent intent) {
        return new WeakNetworkConfig(
            intent.getStringExtra(WeakNetworkControlService.EXTRA_PACKAGE_NAME),
            intent.getIntExtra(WeakNetworkControlService.EXTRA_LATENCY_MS, 0),
            intent.getIntExtra(WeakNetworkControlService.EXTRA_JITTER_MS, 0),
            intent.getFloatExtra(WeakNetworkControlService.EXTRA_PACKET_LOSS_PERCENT, 0),
            intent.getIntExtra(WeakNetworkControlService.EXTRA_UPLOAD_KBPS, 0),
            intent.getIntExtra(WeakNetworkControlService.EXTRA_DOWNLOAD_KBPS, 0)
        );
    }

    private static String requirePackageName(String value) {
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException("Target package name is required.");
        }
        return value.trim();
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(value, max));
    }
}
