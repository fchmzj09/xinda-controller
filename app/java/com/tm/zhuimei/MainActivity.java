package com.tm.zhuimei;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

public class MainActivity extends Activity {
    private static final String TAG = "WXAPP";
    private static final int REQ_BLE = 1001;
    private static final int REQ_PICK = 1002;

    private WebView webView;
    private BleBridge ble;
    private int pendingPermId = -1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_PORTRAIT);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 23) {
            getWindow().setStatusBarColor(0xFFFFFFFF);
            getWindow().setNavigationBarColor(0xFFFFFFFF);
            View decor = getWindow().getDecorView();
            int flags = decor.getSystemUiVisibility();
            flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            if (Build.VERSION.SDK_INT >= 26) flags |= View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            decor.setSystemUiVisibility(flags);
        } else if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(0xFF000000);
            getWindow().setNavigationBarColor(0xFF000000);
        }
        if (Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        }
        Log.i(TAG, "onCreate start");

        webView = new WebView(this);
        webView.setBackgroundColor(0xFFFFFFFF);
        setContentView(webView);

        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setAllowContentAccess(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setTextZoom(100);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(false);
        if (Build.VERSION.SDK_INT >= 21) ws.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        if (Build.VERSION.SDK_INT >= 19) WebView.setWebContentsDebuggingEnabled(true);
        if (Build.VERSION.SDK_INT >= 26) {
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return url != null && !url.startsWith("file://");
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                Log.i(TAG, "console: " + cm.message() + " @" + cm.sourceId() + ":" + cm.lineNumber());
                return true;
            }
        });

        ble = new BleBridge(this, webView);
        webView.addJavascriptInterface(new BridgeInterface(), "NativeBridge");
        webView.loadUrl("file:///android_asset/wx/index.html");

        startDebugChannel();
        requestBlePermissions(-1);

        try {
            Intent svc = new Intent(this, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(svc);
            else startService(svc);
        } catch (Throwable t) {
            Log.w(TAG, "service start failed", t);
        }

        askIgnoreBatteryOnce();
    }

    private void askIgnoreBatteryOnce() {
        try {
            if (Build.VERSION.SDK_INT < 23) return;
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            if (pm == null || pm.isIgnoringBatteryOptimizations(getPackageName())) return;
            android.content.SharedPreferences sp = getSharedPreferences("tm", MODE_PRIVATE);
            if (sp.getBoolean("asked_battery", false)) return;
            sp.edit().putBoolean("asked_battery", true).apply();
            Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            i.setData(android.net.Uri.parse("package:" + getPackageName()));
            startActivity(i);
        } catch (Throwable t) {
            Log.w(TAG, "battery opt request failed", t);
        }
    }

    public void requestBlePermissions(int id) {
        pendingPermId = id;
        ArrayList<String> perms = new ArrayList<>();
        if (Build.VERSION.SDK_INT >= 31) {
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.BLUETOOTH_SCAN);
            }
            if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.BLUETOOTH_CONNECT);
            }
        } else {
            if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
                perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
            }
        }
        if (perms.isEmpty()) {
            if (id >= 0) ble.onPermissionResult(id, true);
            return;
        }
        requestPermissions(perms.toArray(new String[0]), REQ_BLE);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_BLE) return;
        boolean granted = BleBridge.hasBlePermissions(this);
        int id = pendingPermId;
        pendingPermId = -1;
        if (id >= 0) ble.onPermissionResult(id, granted);
    }

    /* ---------------- debug channel: eval commands from a file ---------------- */

    private volatile boolean debugRunning = true;

    private void startDebugChannel() {
        final File cmdFile = new File(getFilesDir(), "cmd.txt");
        final File resFile = new File(getFilesDir(), "result.txt");
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                while (debugRunning) {
                    try {
                        if (cmdFile.exists() && cmdFile.length() > 0) {
                            StringBuilder sb = new StringBuilder();
                            BufferedReader r = new BufferedReader(new FileReader(cmdFile));
                            String line;
                            while ((line = r.readLine()) != null) sb.append(line).append('\n');
                            r.close();
                            cmdFile.delete();
                            final String code = sb.toString();
                            runOnUiThread(new Runnable() {
                                @Override
                                public void run() {
                                    webView.evaluateJavascript(code, new android.webkit.ValueCallback<String>() {
                                        @Override
                                        public void onReceiveValue(String value) {
                                            try {
                                                String s = value == null ? "null" : value;
                                                FileOutputStream fos = new FileOutputStream(resFile);
                                                fos.write(s.getBytes("UTF-8"));
                                                fos.close();
                                            } catch (Throwable ignored) {
                                            }
                                        }
                                    });
                                }
                            });
                        }
                        Thread.sleep(300);
                    } catch (Throwable t) {
                        try { Thread.sleep(500); } catch (InterruptedException ignored) {}
                    }
                }
            }
        });
        t.setDaemon(true);
        t.start();
    }

    public String saveSnapshot() {
        final String[] out = new String[1];
        final CountDownLatch latch = new CountDownLatch(1);
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    int w = webView.getWidth();
                    int h = webView.getHeight();
                    if (w <= 0 || h <= 0) {
                        out[0] = "ERR size " + w + "x" + h;
                    } else {
                        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                        Canvas c = new Canvas(bmp);
                        webView.draw(c);
                        File f = new File(getFilesDir(), "snap.png");
                        FileOutputStream fos = new FileOutputStream(f);
                        bmp.compress(Bitmap.CompressFormat.PNG, 100, fos);
                        fos.close();
                        bmp.recycle();
                        out[0] = f.getAbsolutePath() + " " + w + "x" + h;
                    }
                } catch (Throwable t) {
                    out[0] = "ERR " + t;
                }
                latch.countDown();
            }
        });
        try { latch.await(15, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
        return out[0] == null ? "ERR timeout" : out[0];
    }

    public void pickFile() {        try {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.addCategory(Intent.CATEGORY_OPENABLE);
            i.setType("*/*");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_PICK);
        } catch (Throwable t) {
            Log.e(TAG, "pickFile", t);
            ble.onFilePicked(null);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK) {
            Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
            ble.onFilePicked(uri);
        }
    }

    @Override
    public void onBackPressed() {
        webView.evaluateJavascript("(function(){try{return window.__handleBack__?window.__handleBack__():false;}catch(e){return false;}})()", new android.webkit.ValueCallback<String>() {
            @Override
            public void onReceiveValue(String value) {
                if (!"true".equals(value)) {
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            finish();
                        }
                    });
                }
            }
        });
    }

    @Override
    protected void onDestroy() {
        if (ble != null) ble.destroy();
        if (webView != null) {
            webView.removeJavascriptInterface("NativeBridge");
            webView.loadUrl("about:blank");
            webView.destroy();
        }
        super.onDestroy();
    }

    public class BridgeInterface {
        @JavascriptInterface
        public void post(String json) {
            ble.post(json);
        }

        @JavascriptInterface
        public String systemInfo() {
            return ble.systemInfoJson();
        }

        @JavascriptInterface
        public void log(String msg) {
            Log.i(TAG, msg);
        }

        @JavascriptInterface
        public String snapshot() {
            return saveSnapshot();
        }

        @JavascriptInterface
        public void keepScreenOn(final boolean on) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
    }
}
