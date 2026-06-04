package com.androidtool.piconetworkhelper;

import android.app.Activity;
import android.content.Intent;
import android.net.VpnService;
import android.os.Bundle;
import android.widget.TextView;

public final class MainActivity extends Activity {
    private static final int VPN_PERMISSION_REQUEST = 1001;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        TextView view = new TextView(this);
        view.setText("Pico Network Helper\nVPN permission is required before desktop control can start.");
        view.setPadding(32, 32, 32, 32);
        setContentView(view);

        Intent prepareIntent = VpnService.prepare(this);
        if (prepareIntent != null) {
            startActivityForResult(prepareIntent, VPN_PERMISSION_REQUEST);
        }
    }
}
