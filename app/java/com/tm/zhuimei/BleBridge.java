package com.tm.zhuimei;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanRecord;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.util.Log;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import java.util.UUID;

public class BleBridge {
    private static final String TAG = "WXAPP";
    private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    private final MainActivity activity;
    private final WebView webView;
    private final Handler main = new Handler(Looper.getMainLooper());

    private BluetoothAdapter adapter;
    private BluetoothLeScanner scanner;
    private BluetoothGatt gatt;
    private String connectedDeviceId;
    private boolean scanning = false;
    private boolean servicesDiscovered = false;
    private int mtu = 23;

    private int pendingConnectId = -1;
    private int pendingNotifyId = -1;
    private int pendingMtuId = -1;
    private int pendingReadId = -1;

    private final List<Runnable> discoveryWaiters = new ArrayList<>();
    private final ArrayDeque<WriteOp> writeQueue = new ArrayDeque<>();
    private boolean writeBusy = false;
    private WriteOp currentWrite;
    private int currentChunkLen = 0;

    private boolean receiverRegistered = false;

    private static class WriteOp {
        int id;
        BluetoothGattCharacteristic ch;
        byte[] data;
        int offset;
        boolean noResponse;
    }

    public BleBridge(MainActivity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        BluetoothManager bm = (BluetoothManager) activity.getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm != null) adapter = bm.getAdapter();
    }

    /* ------------------------------------------------------------------ */
    /* JS -> native                                                        */
    /* ------------------------------------------------------------------ */

    public void post(String json) {
        try {
            JSONObject o = new JSONObject(json);
            final int id = o.getInt("id");
            final String method = o.getString("method");
            final JSONObject args = o.optJSONObject("args");
            main.post(new Runnable() {
                @Override
                public void run() {
                    try {
                        handle(id, method, args == null ? new JSONObject() : args);
                    } catch (Throwable t) {
                        Log.e(TAG, "handle " + method, t);
                        fail(id, method + ":fail " + t.getMessage(), -1);
                    }
                }
            });
        } catch (Throwable t) {
            Log.e(TAG, "bad bridge message: " + json, t);
        }
    }

    private void handle(int id, String method, JSONObject args) {
        switch (method) {
            case "openAdapter": openAdapter(id); break;
            case "startScan": startScan(id); break;
            case "stopScan": stopScan(id); break;
            case "connect": connect(id, args); break;
            case "disconnect": disconnect(id); break;
            case "getServices": getServices(id); break;
            case "getCharacteristics": getCharacteristics(id, args); break;
            case "notify": notifyChar(id, args); break;
            case "setMtu": setMtu(id, args); break;
            case "write": write(id, args); break;
            case "getSetting": getSetting(id); break;
            case "requestPermissions": requestPermissions(id); break;
            case "openAppSettings": openAppSettings(id); break;
            case "openBluetoothSettings": openBluetoothSettings(id); break;
            case "chooseFile": chooseFile(id, args); break;
            case "readFile": readFile(id, args); break;
            default: fail(id, method + ":fail unknown method", -1);
        }
    }

    /* ------------------------------------------------------------------ */
    /* Responses / events                                                  */
    /* ------------------------------------------------------------------ */

    private void js(final String code) {
        webView.post(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.evaluateJavascript(code, null);
                } catch (Throwable t) {
                    Log.e(TAG, "evaluateJavascript failed", t);
                }
            }
        });
    }

    private void respond(int id, JSONObject data) {
        JSONObject r = new JSONObject();
        try {
            r.put("ok", true);
            r.put("data", data == null ? new JSONObject() : data);
        } catch (Exception ignored) {}
        js("__nativeDispatch(" + id + "," + JSONObject.quote(r.toString()) + ")");
    }

    private void fail(int id, String errMsg, int errCode) {
        JSONObject r = new JSONObject();
        try {
            r.put("ok", false);
            r.put("errMsg", errMsg);
            r.put("errCode", errCode);
        } catch (Exception ignored) {}
        js("__nativeDispatch(" + id + "," + JSONObject.quote(r.toString()) + ")");
    }

    private void event(String name, JSONObject data) {
        js("__nativeEvent(" + JSONObject.quote(name) + "," + JSONObject.quote(data.toString()) + ")");
    }

    /* ------------------------------------------------------------------ */
    /* Permissions / adapter                                               */
    /* ------------------------------------------------------------------ */

    public static boolean hasBlePermissions(Context ctx) {
        if (Build.VERSION.SDK_INT >= 31) {
            return ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED
                    && ctx.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
        }
        return ctx.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestPermissions(final int id) {
        if (hasBlePermissions(activity)) {
            JSONObject d = new JSONObject();
            try { d.put("granted", true); } catch (Exception ignored) {}
            respond(id, d);
            return;
        }
        activity.requestBlePermissions(id);
    }

    public void onPermissionResult(int requestId, boolean granted) {
        if (requestId < 0) return;
        JSONObject d = new JSONObject();
        try { d.put("granted", granted); } catch (Exception ignored) {}
        if (granted) respond(requestId, d);
        else fail(requestId, "authorize:fail auth deny", 10001);
    }

    private void openAdapter(int id) {
        if (adapter == null) {
            fail(id, "openBluetoothAdapter:fail not available", 10001);
            return;
        }
        if (!hasBlePermissions(activity)) {
            fail(id, "openBluetoothAdapter:fail not available", 10001);
            return;
        }
        registerReceiver();
        if (!adapter.isEnabled()) {
            fail(id, "openBluetoothAdapter:fail not available", 10001);
            return;
        }
        respond(id, new JSONObject());
    }

    private void registerReceiver() {
        if (receiverRegistered) return;
        try {
            activity.registerReceiver(adapterReceiver, new IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED));
            receiverRegistered = true;
        } catch (Throwable t) {
            Log.w(TAG, "receiver", t);
        }
    }

    private final BroadcastReceiver adapterReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (BluetoothAdapter.ACTION_STATE_CHANGED.equals(intent.getAction())) {
                boolean on = adapter != null && adapter.isEnabled();
                try {
                    JSONObject d = new JSONObject();
                    d.put("available", on);
                    d.put("discovering", scanning);
                    event("bleAdapterStateChange", d);
                } catch (Exception ignored) {}
            }
        }
    };

    /* ------------------------------------------------------------------ */
    /* Scanning                                                            */
    /* ------------------------------------------------------------------ */

    private void startScan(int id) {
        if (adapter == null || !adapter.isEnabled()) {
            fail(id, "startBluetoothDevicesDiscovery:fail not available", 10001);
            return;
        }
        if (!hasBlePermissions(activity)) {
            fail(id, "startBluetoothDevicesDiscovery:fail no permission", 10001);
            return;
        }
        try {
            scanner = adapter.getBluetoothLeScanner();
            if (scanner == null) {
                fail(id, "startBluetoothDevicesDiscovery:fail not available", 10001);
                return;
            }
            if (!scanning) {
                ScanSettings settings = new ScanSettings.Builder()
                        .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                        .build();
                scanner.startScan(null, settings, scanCallback);
                scanning = true;
            }
            respond(id, new JSONObject());
        } catch (Throwable t) {
            fail(id, "startBluetoothDevicesDiscovery:fail " + t.getMessage(), 10008);
        }
    }

    private void stopScan(int id) {
        try {
            if (scanner != null && scanning) scanner.stopScan(scanCallback);
        } catch (Throwable t) {
            Log.w(TAG, "stopScan", t);
        }
        scanning = false;
        respond(id, new JSONObject());
    }

    private final ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            emitDevice(result);
        }

        @Override
        public void onBatchScanResults(List<ScanResult> results) {
            for (ScanResult r : results) emitDevice(r);
        }

        @Override
        public void onScanFailed(int errorCode) {
            Log.w(TAG, "scan failed " + errorCode);
            try {
                JSONObject d = new JSONObject();
                d.put("available", true);
                d.put("discovering", false);
                event("bleAdapterStateChange", d);
            } catch (Exception ignored) {}
        }
    };

    private void emitDevice(ScanResult result) {
        try {
            BluetoothDevice d = result.getDevice();
            String name = "";
            try { name = d.getName(); } catch (Throwable ignored) {}
            String localName = "";
            ScanRecord rec = result.getScanRecord();
            if (rec != null) {
                String n = rec.getDeviceName();
                if (n != null) localName = n;
            }
            JSONObject dev = new JSONObject();
            dev.put("deviceId", d.getAddress());
            dev.put("name", name == null ? "" : name);
            dev.put("localName", localName);
            dev.put("RSSI", result.getRssi());
            JSONArray arr = new JSONArray();
            arr.put(dev);
            JSONObject data = new JSONObject();
            data.put("devices", arr);
            event("bleDeviceFound", data);
        } catch (Throwable t) {
            Log.w(TAG, "emitDevice", t);
        }
    }

    /* ------------------------------------------------------------------ */
    /* GATT                                                                */
    /* ------------------------------------------------------------------ */

    private void connect(int id, JSONObject args) {
        String deviceId = args.optString("deviceId", "");
        int timeout = args.optInt("timeout", 10000);
        if (adapter == null || !adapter.isEnabled()) {
            fail(id, "createBLEConnection:fail not available", 10001);
            return;
        }
        if (!hasBlePermissions(activity)) {
            fail(id, "createBLEConnection:fail no permission", 10001);
            return;
        }
        if (deviceId.isEmpty()) {
            fail(id, "createBLEConnection:fail invalid deviceId", 10002);
            return;
        }
        if (gatt != null && deviceId.equalsIgnoreCase(connectedDeviceId)) {
            try {
                JSONObject d = new JSONObject();
                d.put("deviceId", deviceId);
                d.put("connected", true);
                event("bleConnectionStateChange", d);
            } catch (Exception ignored) {}
            respond(id, new JSONObject());
            return;
        }
        closeGatt();
        pendingConnectId = id;
        final BluetoothDevice device;
        try {
            device = adapter.getRemoteDevice(deviceId);
        } catch (Throwable t) {
            pendingConnectId = -1;
            fail(id, "createBLEConnection:fail invalid deviceId", 10002);
            return;
        }
        try {
            if (Build.VERSION.SDK_INT >= 23) {
                gatt = device.connectGatt(activity, false, gattCallback, BluetoothDevice.TRANSPORT_LE);
            } else {
                gatt = device.connectGatt(activity, false, gattCallback);
            }
        } catch (Throwable t) {
            pendingConnectId = -1;
            fail(id, "createBLEConnection:fail " + t.getMessage(), 10003);
            return;
        }
        final int connectId = id;
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (pendingConnectId == connectId) {
                    pendingConnectId = -1;
                    fail(connectId, "createBLEConnection:fail timeout", 10012);
                    closeGatt();
                }
            }
        }, Math.max(timeout, 5000));
    }

    private void disconnect(int id) {
        closeGatt();
        respond(id, new JSONObject());
    }

    private void closeGatt() {
        servicesDiscovered = false;
        discoveryWaiters.clear();
        writeQueue.clear();
        writeBusy = false;
        currentWrite = null;
        if (gatt != null) {
            try { gatt.disconnect(); } catch (Throwable ignored) {}
            try { gatt.close(); } catch (Throwable ignored) {}
            gatt = null;
        }
        connectedDeviceId = null;
    }

    private final BluetoothGattCallback gattCallback = new BluetoothGattCallback() {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            if (newState == BluetoothProfile.STATE_CONNECTED) {
                connectedDeviceId = g.getDevice().getAddress();
                servicesDiscovered = false;
                mtu = 23;
                int id = pendingConnectId;
                pendingConnectId = -1;
                try {
                    JSONObject d = new JSONObject();
                    d.put("deviceId", connectedDeviceId);
                    d.put("connected", true);
                    event("bleConnectionStateChange", d);
                } catch (Exception ignored) {}
                if (id >= 0) respond(id, new JSONObject());
                try { g.discoverServices(); } catch (Throwable t) { Log.w(TAG, "discoverServices", t); }
            } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
                String idStr = connectedDeviceId;
                closeGatt();
                int id = pendingConnectId;
                pendingConnectId = -1;
                if (id >= 0) fail(id, "createBLEConnection:fail connection fail", 10003);
                try {
                    JSONObject d = new JSONObject();
                    d.put("deviceId", idStr == null ? "" : idStr);
                    d.put("connected", false);
                    event("bleConnectionStateChange", d);
                } catch (Exception ignored) {}
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            servicesDiscovered = true;
            List<Runnable> waiters = new ArrayList<>(discoveryWaiters);
            discoveryWaiters.clear();
            for (Runnable r : waiters) {
                try { r.run(); } catch (Throwable t) { Log.w(TAG, "discovery waiter", t); }
            }
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch) {
            emitValue(ch, ch.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic ch, byte[] value) {
            emitValue(ch, value);
        }

        @Override
        public void onCharacteristicWrite(BluetoothGatt g, BluetoothGattCharacteristic ch, int status) {
            WriteOp op = currentWrite;
            writeBusy = false;
            currentWrite = null;
            if (op == null) return;
            if (status != BluetoothGatt.GATT_SUCCESS) {
                writeQueue.poll();
                fail(op.id, "writeBLECharacteristicValue:fail write fail", 10008);
                pumpWrites();
                return;
            }
            op.offset += currentChunkLen;
            if (op.offset >= op.data.length) {
                writeQueue.poll();
                respond(op.id, new JSONObject());
            }
            pumpWrites();
        }

        @Override
        public void onDescriptorWrite(BluetoothGatt g, BluetoothGattDescriptor descriptor, int status) {
            int id = pendingNotifyId;
            pendingNotifyId = -1;
            if (id >= 0) {
                if (status == BluetoothGatt.GATT_SUCCESS) respond(id, new JSONObject());
                else fail(id, "notifyBLECharacteristicValueChange:fail write descriptor", 10008);
            }
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int newMtu, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS && newMtu > 23) mtu = newMtu;
            int id = pendingMtuId;
            pendingMtuId = -1;
            if (id >= 0) {
                JSONObject d = new JSONObject();
                try { d.put("mtu", mtu); } catch (Exception ignored) {}
                respond(id, d);
            }
        }
    };

    private void emitValue(BluetoothGattCharacteristic ch, byte[] value) {
        if (value == null) value = new byte[0];
        try {
            JSONObject d = new JSONObject();
            d.put("deviceId", connectedDeviceId == null ? "" : connectedDeviceId);
            d.put("serviceId", ch.getService().getUuid().toString().toUpperCase(Locale.US));
            d.put("characteristicId", ch.getUuid().toString().toUpperCase(Locale.US));
            d.put("value", Base64.encodeToString(value, Base64.NO_WRAP));
            event("bleCharacteristicValueChange", d);
        } catch (Throwable t) {
            Log.w(TAG, "emitValue", t);
        }
    }

    private void whenDiscovered(final int id, final String api, final Runnable action) {
        if (servicesDiscovered) {
            action.run();
            return;
        }
        if (gatt == null) {
            fail(id, api + ":fail no connection", 10006);
            return;
        }
        final Runnable[] holder = new Runnable[1];
        holder[0] = new Runnable() {
            @Override
            public void run() {
                discoveryWaiters.remove(holder[0]);
                action.run();
            }
        };
        discoveryWaiters.add(holder[0]);
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (discoveryWaiters.remove(holder[0])) {
                    fail(id, api + ":fail timeout", 10012);
                }
            }
        }, 8000);
    }

    private void getServices(final int id) {
        whenDiscovered(id, "getBLEDeviceServices", new Runnable() {
            @Override
            public void run() {
                try {
                    JSONArray arr = new JSONArray();
                    if (gatt != null) {
                        for (BluetoothGattService s : gatt.getServices()) {
                            JSONObject o = new JSONObject();
                            o.put("uuid", s.getUuid().toString().toUpperCase(Locale.US));
                            o.put("isPrimary", s.getType() == BluetoothGattService.SERVICE_TYPE_PRIMARY);
                            arr.put(o);
                        }
                    }
                    JSONObject d = new JSONObject();
                    d.put("services", arr);
                    respond(id, d);
                } catch (Throwable t) {
                    fail(id, "getBLEDeviceServices:fail " + t.getMessage(), -1);
                }
            }
        });
    }

    private BluetoothGattService findService(String serviceId) {
        if (gatt == null || serviceId == null) return null;
        for (BluetoothGattService s : gatt.getServices()) {
            if (s.getUuid().toString().equalsIgnoreCase(serviceId)) return s;
        }
        try {
            return gatt.getService(UUID.fromString(serviceId));
        } catch (Throwable ignored) {
        }
        return null;
    }

    private BluetoothGattCharacteristic findChar(String serviceId, String charId) {
        BluetoothGattService s = findService(serviceId);
        if (s == null || charId == null) return null;
        for (BluetoothGattCharacteristic c : s.getCharacteristics()) {
            if (c.getUuid().toString().equalsIgnoreCase(charId)) return c;
        }
        try {
            return s.getCharacteristic(UUID.fromString(charId));
        } catch (Throwable ignored) {
        }
        return null;
    }

    private void getCharacteristics(final int id, JSONObject args) {
        final String serviceId = args.optString("serviceId", "");
        whenDiscovered(id, "getBLEDeviceCharacteristics", new Runnable() {
            @Override
            public void run() {
                try {
                    JSONArray arr = new JSONArray();
                    BluetoothGattService svc = findService(serviceId);
                    if (svc != null) {
                        for (BluetoothGattCharacteristic c : svc.getCharacteristics()) {
                            JSONObject o = new JSONObject();
                            o.put("uuid", c.getUuid().toString().toUpperCase(Locale.US));
                            int props = c.getProperties();
                            JSONObject p = new JSONObject();
                            p.put("read", (props & BluetoothGattCharacteristic.PROPERTY_READ) != 0);
                            p.put("write", (props & (BluetoothGattCharacteristic.PROPERTY_WRITE | BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE)) != 0);
                            p.put("notify", (props & BluetoothGattCharacteristic.PROPERTY_NOTIFY) != 0);
                            p.put("indicate", (props & BluetoothGattCharacteristic.PROPERTY_INDICATE) != 0);
                            o.put("properties", p);
                            arr.put(o);
                        }
                    }
                    JSONObject d = new JSONObject();
                    d.put("characteristics", arr);
                    respond(id, d);
                } catch (Throwable t) {
                    fail(id, "getBLEDeviceCharacteristics:fail " + t.getMessage(), -1);
                }
            }
        });
    }

    private void notifyChar(final int id, JSONObject args) {
        final String serviceId = args.optString("serviceId", "");
        final String charId = args.optString("characteristicId", "");
        final boolean state = args.optBoolean("state", true);
        whenDiscovered(id, "notifyBLECharacteristicValueChange", new Runnable() {
            @Override
            public void run() {
                try {
                    BluetoothGattCharacteristic ch = findChar(serviceId, charId);
                    if (ch == null || gatt == null) {
                        fail(id, "notifyBLECharacteristicValueChange:fail no characteristic", 10005);
                        return;
                    }
                    boolean ok = gatt.setCharacteristicNotification(ch, state);
                    if (!ok) {
                        fail(id, "notifyBLECharacteristicValueChange:fail set notification", 10008);
                        return;
                    }
                    BluetoothGattDescriptor desc = ch.getDescriptor(CCCD);
                    if (desc == null) {
                        respond(id, new JSONObject());
                        return;
                    }
                    pendingNotifyId = id;
                    desc.setValue(state ? BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                            : BluetoothGattDescriptor.DISABLE_NOTIFICATION_VALUE);
                    if (!gatt.writeDescriptor(desc)) {
                        pendingNotifyId = -1;
                        fail(id, "notifyBLECharacteristicValueChange:fail write descriptor", 10008);
                    }
                } catch (Throwable t) {
                    fail(id, "notifyBLECharacteristicValueChange:fail " + t.getMessage(), -1);
                }
            }
        });
    }

    private void setMtu(int id, JSONObject args) {
        int want = args.optInt("mtu", 511);
        if (gatt == null) {
            fail(id, "setBLEMTU:fail no connection", 10006);
            return;
        }
        pendingMtuId = id;
        boolean ok = false;
        try { ok = gatt.requestMtu(want); } catch (Throwable t) { Log.w(TAG, "requestMtu", t); }
        if (!ok) {
            pendingMtuId = -1;
            JSONObject d = new JSONObject();
            try { d.put("mtu", mtu); } catch (Exception ignored) {}
            respond(id, d);
            return;
        }
        final int mtuId = id;
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (pendingMtuId == mtuId) {
                    pendingMtuId = -1;
                    JSONObject d = new JSONObject();
                    try { d.put("mtu", mtu); } catch (Exception ignored) {}
                    respond(mtuId, d);
                }
            }
        }, 3000);
    }

    private void write(int id, JSONObject args) {
        String serviceId = args.optString("serviceId", "");
        String charId = args.optString("characteristicId", "");
        String b64 = args.optString("value", "");
        boolean noResponse = "writeNoResponse".equals(args.optString("writeType", "write"));
        if (gatt == null) {
            fail(id, "writeBLECharacteristicValue:fail no connection", 10006);
            return;
        }
        BluetoothGattCharacteristic ch = findChar(serviceId, charId);
        if (ch == null) {
            fail(id, "writeBLECharacteristicValue:fail no characteristic", 10005);
            return;
        }
        byte[] data;
        try {
            data = Base64.decode(b64, Base64.DEFAULT);
        } catch (Throwable t) {
            fail(id, "writeBLECharacteristicValue:fail bad data", -1);
            return;
        }
        if (data.length == 0) {
            fail(id, "writeBLECharacteristicValue:fail data is null", -1);
            return;
        }
        WriteOp op = new WriteOp();
        op.id = id;
        op.ch = ch;
        op.data = data;
        op.noResponse = noResponse;
        writeQueue.add(op);
        pumpWrites();
    }

    private void pumpWrites() {
        if (writeBusy || gatt == null) return;
        WriteOp op = writeQueue.peek();
        if (op == null) return;
        int max = Math.max(20, mtu - 3);
        int remaining = op.data.length - op.offset;
        if (remaining <= 0) {
            writeQueue.poll();
            respond(op.id, new JSONObject());
            pumpWrites();
            return;
        }
        int len = Math.min(max, remaining);
        final byte[] chunk = Arrays.copyOfRange(op.data, op.offset, op.offset + len);
        boolean ok;
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                int type = op.noResponse ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                        : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT;
                ok = gatt.writeCharacteristic(op.ch, chunk, type) == BluetoothStatusCodes.SUCCESS;
            } else {
                op.ch.setWriteType(op.noResponse ? BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE
                        : BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT);
                op.ch.setValue(chunk);
                ok = gatt.writeCharacteristic(op.ch);
            }
        } catch (Throwable t) {
            Log.w(TAG, "writeCharacteristic", t);
            ok = false;
        }
        if (!ok) {
            writeQueue.poll();
            fail(op.id, "writeBLECharacteristicValue:fail write busy", 10008);
            pumpWrites();
            return;
        }
        currentWrite = op;
        currentChunkLen = len;
        writeBusy = true;
        final WriteOp fop = op;
        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                if (currentWrite == fop) {
                    currentWrite = null;
                    writeBusy = false;
                    writeQueue.poll();
                    fail(fop.id, "writeBLECharacteristicValue:fail timeout", 10012);
                    pumpWrites();
                }
            }
        }, 4000);
    }

    /* ------------------------------------------------------------------ */
    /* Misc native helpers                                                 */
    /* ------------------------------------------------------------------ */

    private void getSetting(int id) {
        JSONObject d = new JSONObject();
        try { d.put("granted", hasBlePermissions(activity)); } catch (Exception ignored) {}
        respond(id, d);
    }

    private void openAppSettings(int id) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.parse("package:" + activity.getPackageName()));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Throwable t) {
            Log.w(TAG, "openAppSettings", t);
        }
        respond(id, new JSONObject());
    }

    private void openBluetoothSettings(int id) {
        try {
            Intent i = new Intent(android.provider.Settings.ACTION_BLUETOOTH_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(i);
        } catch (Throwable t) {
            Log.w(TAG, "openBluetoothSettings", t);
        }
        respond(id, new JSONObject());
    }

    private void chooseFile(int id, JSONObject args) {
        pendingReadId = id;
        activity.pickFile();
    }

    public void onFilePicked(Uri uri) {
        int id = pendingReadId;
        pendingReadId = -1;
        if (id < 0) return;
        if (uri == null) {
            fail(id, "chooseMessageFile:fail cancel", -1);
            return;
        }
        try {
            String name = "file.bin";
            long size = -1;
            android.database.Cursor c = activity.getContentResolver().query(uri, null, null, null, null);
            if (c != null) {
                try {
                    int ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    int si = c.getColumnIndex(OpenableColumns.SIZE);
                    if (c.moveToFirst()) {
                        if (ni >= 0) name = c.getString(ni);
                        if (si >= 0) size = c.getLong(si);
                    }
                } finally {
                    c.close();
                }
            }
            File dir = new File(activity.getCacheDir(), "ota");
            if (!dir.exists()) dir.mkdirs();
            File out = new File(dir, name.replaceAll("[^A-Za-z0-9._-]", "_"));
            InputStream in = activity.getContentResolver().openInputStream(uri);
            if (in == null) throw new Exception("open stream failed");
            FileOutputStream fos = new FileOutputStream(out);
            byte[] buf = new byte[8192];
            long total = 0;
            int n;
            while ((n = in.read(buf)) > 0) {
                fos.write(buf, 0, n);
                total += n;
                if (total > 32 * 1024 * 1024) break;
            }
            fos.close();
            in.close();
            JSONObject file = new JSONObject();
            file.put("path", out.getAbsolutePath());
            file.put("name", name);
            file.put("size", size > 0 ? size : total);
            JSONArray arr = new JSONArray();
            arr.put(file);
            JSONObject d = new JSONObject();
            d.put("tempFiles", arr);
            respond(id, d);
        } catch (Throwable t) {
            Log.e(TAG, "file pick", t);
            fail(id, "chooseMessageFile:fail " + t.getMessage(), -1);
        }
    }

    private void readFile(int id, JSONObject args) {
        String path = args.optString("filePath", "");
        try {
            File f = new File(path);
            if (!f.isFile()) throw new Exception("no such file");
            if (f.length() > 32 * 1024 * 1024) throw new Exception("file too large");
            FileInputStream in = new FileInputStream(f);
            ByteArrayOutputStream bos = new ByteArrayOutputStream((int) f.length());
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            JSONObject d = new JSONObject();
            d.put("data", Base64.encodeToString(bos.toByteArray(), Base64.NO_WRAP));
            respond(id, d);
        } catch (Throwable t) {
            fail(id, "readFile:fail " + t.getMessage(), -1);
        }
    }

    /* ------------------------------------------------------------------ */

    @SuppressLint("NewApi")
    public String systemInfoJson() {
        try {
            JSONObject o = new JSONObject();
            DisplayMetrics dm = activity.getResources().getDisplayMetrics();
            int w = dm.widthPixels;
            int h = dm.heightPixels;
            float density = dm.density > 0 ? dm.density : 1f;
            int statusBar = 0;
            int rid = activity.getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (rid > 0) statusBar = activity.getResources().getDimensionPixelSize(rid);
            boolean bt = false;
            try { bt = adapter != null && adapter.isEnabled(); } catch (Throwable ignored) {}
            o.put("platform", "android");
            o.put("system", "Android " + Build.VERSION.RELEASE);
            o.put("brand", Build.BRAND);
            o.put("model", Build.MODEL);
            o.put("pixelRatio", (double) density);
            o.put("windowWidth", w / density);
            o.put("windowHeight", h / density);
            o.put("screenWidth", w / density);
            o.put("screenHeight", h / density);
            o.put("statusBarHeight", statusBar / density);
            o.put("SDKVersion", "3.5.0");
            o.put("version", "8.0.0");
            o.put("language", "zh_CN");
            o.put("bluetoothEnabled", bt);
            o.put("locationEnabled", true);
            o.put("locationAuthorized", true);
            o.put("deviceOrientation", "portrait");
            JSONObject safe = new JSONObject();
            safe.put("top", statusBar / density);
            safe.put("bottom", h / density);
            safe.put("left", 0);
            safe.put("right", w / density);
            safe.put("width", w / density);
            safe.put("height", (h - statusBar) / density);
            o.put("safeArea", safe);
            return o.toString();
        } catch (Throwable t) {
            return "{}";
        }
    }

    public void destroy() {
        try { if (scanner != null && scanning) scanner.stopScan(scanCallback); } catch (Throwable ignored) {}
        scanning = false;
        closeGatt();
        if (receiverRegistered) {
            try { activity.unregisterReceiver(adapterReceiver); } catch (Throwable ignored) {}
            receiverRegistered = false;
        }
    }
}
