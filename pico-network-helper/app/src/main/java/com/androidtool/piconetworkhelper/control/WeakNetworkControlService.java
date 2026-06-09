package com.androidtool.piconetworkhelper.control;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import com.androidtool.piconetworkhelper.R;
import com.androidtool.piconetworkhelper.model.WeakNetworkConfig;
import com.androidtool.piconetworkhelper.vpn.WeakNetworkVpnService;

public final class WeakNetworkControlService extends Service {
    public static final String ACTION_START = "com.androidtool.piconetworkhelper.START";
    public static final String ACTION_STOP = "com.androidtool.piconetworkhelper.STOP";
    public static final String ACTION_STATUS = "com.androidtool.piconetworkhelper.STATUS";
    public static final String EXTRA_PACKAGE_NAME = "packageName";
    public static final String EXTRA_LATENCY_MS = "latencyMs";
    public static final String EXTRA_JITTER_MS = "jitterMs";
    public static final String EXTRA_PACKET_LOSS_PERCENT = "packetLossPercent";
    public static final String EXTRA_UPLOAD_KBPS = "uploadKbps";
    public static final String EXTRA_DOWNLOAD_KBPS = "downloadKbps";

    private static final String CHANNEL_ID = "weak-network-control";
    private static final int NOTIFICATION_ID = 2001;

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification(false));
        String action = intent == null ? ACTION_STATUS : intent.getAction();
        if (ACTION_START.equals(action)) {
            WeakNetworkConfig config = WeakNetworkConfig.fromIntent(intent);
            WeakNetworkVpnService.start(this, config);
            startForeground(NOTIFICATION_ID, buildNotification(true));
        } else if (ACTION_STOP.equals(action)) {
            WeakNetworkVpnService.stop(this);
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification(boolean running) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return builder
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(running ? R.string.notification_text_running : R.string.notification_text_idle))
            .setOngoing(running)
            .build();
    }

    private void ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }
}
