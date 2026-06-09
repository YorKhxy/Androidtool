package com.androidtool.piconetworkhelper.vpn;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import com.androidtool.piconetworkhelper.R;
import com.androidtool.piconetworkhelper.model.WeakNetworkConfig;

public final class WeakNetworkVpnService extends VpnService {
    private static final String TAG = "WeakNetworkVpnService";
    private static final String ACTION_START_VPN = "com.androidtool.piconetworkhelper.vpn.START";
    private static final String ACTION_STOP_VPN = "com.androidtool.piconetworkhelper.vpn.STOP";
    private static final String CHANNEL_ID = "weak-network-vpn";
    private static final int NOTIFICATION_ID = 2002;
    private static final int TUN_MTU = 1500;

    private TunTransportEngine engine;

    public static void start(Context context, WeakNetworkConfig config) {
        Intent intent = new Intent(context, WeakNetworkVpnService.class);
        intent.setAction(ACTION_START_VPN);
        intent.putExtra("packageName", config.packageName);
        intent.putExtra("latencyMs", config.latencyMs);
        intent.putExtra("jitterMs", config.jitterMs);
        intent.putExtra("packetLossPercent", config.packetLossPercent);
        intent.putExtra("uploadKbps", config.uploadKbps);
        intent.putExtra("downloadKbps", config.downloadKbps);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    public static void stop(Context context) {
        Intent intent = new Intent(context, WeakNetworkVpnService.class);
        intent.setAction(ACTION_STOP_VPN);
        context.startService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureNotificationChannel();
        engine = new TcpUdpShapingEngine();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP_VPN.equals(intent.getAction())) {
            stopEngine();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, buildNotification());
        try {
            WeakNetworkConfig config = WeakNetworkConfig.fromIntent(intent);
            startVpn(config);
        } catch (RuntimeException error) {
            // 启动失败：清理引擎与前台通知并退出，避免残留“运行中”假象。
            Log.e(TAG, "Failed to start weak-network VPN.", error);
            stopEngine();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf(startId);
            return START_NOT_STICKY;
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopEngine();
        super.onDestroy();
    }

    private void startVpn(WeakNetworkConfig config) {
        stopEngine();

        Builder builder = new Builder()
            .setSession("Pico weak network: " + config.packageName)
            .addAddress("10.88.0.2", 32)
            .addRoute("0.0.0.0", 0)
            .setMtu(TUN_MTU);

        try {
            builder.addAllowedApplication(config.packageName);
        } catch (PackageManager.NameNotFoundException error) {
            throw new IllegalArgumentException("Target package is not installed: " + config.packageName, error);
        }

        ParcelFileDescriptor tunInterface = builder.establish();
        if (tunInterface == null) {
            throw new IllegalStateException("VPN permission is not granted or TUN interface creation failed.");
        }
        engine.start(tunInterface, config, getCacheDir(), TUN_MTU);
    }

    private void stopEngine() {
        if (engine != null && engine.isRunning()) {
            engine.stop();
        }
    }

    private Notification buildNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        return builder
            .setSmallIcon(android.R.drawable.stat_sys_upload_done)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(getString(R.string.notification_text_running))
            .setOngoing(true)
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
