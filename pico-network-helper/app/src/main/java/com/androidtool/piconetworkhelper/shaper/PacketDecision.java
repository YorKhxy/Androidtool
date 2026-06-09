package com.androidtool.piconetworkhelper.shaper;

public final class PacketDecision {
    public final boolean drop;
    public final long delayMs;

    private PacketDecision(boolean drop, long delayMs) {
        this.drop = drop;
        this.delayMs = Math.max(0, delayMs);
    }

    public static PacketDecision forward(long delayMs) {
        return new PacketDecision(false, delayMs);
    }

    public static PacketDecision drop() {
        return new PacketDecision(true, 0);
    }
}
