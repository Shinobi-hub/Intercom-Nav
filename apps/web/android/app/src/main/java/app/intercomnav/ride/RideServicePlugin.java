package app.intercomnav.ride;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONException;

/**
 * JS bridge for the ride: RideService start/stop, runtime permissions, Bluetooth routing, share
 * and open-URL. JS binding: src/platform/native/plugins.ts.
 */
@CapacitorPlugin(
    name = "RideService",
    permissions = {
        @Permission(alias = RideServicePlugin.LOCATION, strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION }),
        @Permission(alias = RideServicePlugin.MICROPHONE, strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = RideServicePlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS }),
        @Permission(alias = RideServicePlugin.BLUETOOTH, strings = { Manifest.permission.BLUETOOTH_CONNECT }),
    }
)
public class RideServicePlugin extends Plugin implements RideState.Listener {

    static final String LOCATION = "location";
    static final String MICROPHONE = "microphone";
    static final String NOTIFICATIONS = "notifications";
    static final String BLUETOOTH = "bluetooth";

    private static final String TAG = "RideServicePlugin";
    /** How long start() waits for the service to report that it is in the foreground. */
    private static final long START_TIMEOUT_MS = 8_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    @Nullable
    private PluginCall pendingStart;
    private final Runnable startTimeout = () -> {
        PluginCall call = pendingStart;
        pendingStart = null;
        if (call != null) call.reject("The ride service did not start in time", "START_TIMEOUT");
    };
    @Nullable
    private PermissionGate.Ticket permissionTicket;
    @Nullable
    private AudioRoute lastRoute;

    @Override
    public void load() {
        RideState.addListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        RideState.removeListener(this);
        PermissionGate.get().reset();
        super.handleOnDestroy();
    }

    /** Permissions granted in Settings while the ride runs: claim the matching service types. */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (RideState.isRunning() && RideService.allowedTypes(getContext()) != RideState.getForegroundTypes()) {
            sendToService(RideService.ACTION_REFRESH, null);
        }
    }

    // ---- ride service ---------------------------------------------------------------------------

    @PluginMethod
    public void start(PluginCall call) {
        boolean bluetoothRouting = Boolean.TRUE.equals(call.getBoolean("bluetoothRouting", true));
        boolean keepAlive = Boolean.TRUE.equals(call.getBoolean("keepAlive", true));
        Intent intent = serviceIntent(RideService.ACTION_START)
            .putExtra(RideService.EXTRA_TITLE, call.getString("title"))
            .putExtra(RideService.EXTRA_TEXT, call.getString("text"))
            .putExtra(RideService.EXTRA_BLUETOOTH, bluetoothRouting)
            .putExtra(RideService.EXTRA_KEEP_ALIVE, keepAlive);
        main.post(() -> {
            boolean alreadyRunning = RideState.isRunning();
            if (!alreadyRunning) {
                if (pendingStart != null) pendingStart.reject("Superseded by a newer start()", "START_SUPERSEDED");
                pendingStart = call;
                RideState.clearStartError();
                main.removeCallbacks(startTimeout);
                main.postDelayed(startTimeout, START_TIMEOUT_MS);
            }
            try {
                // Throws ForegroundServiceStartNotAllowedException (Android 12+) if the app isn't in front.
                ContextCompat.startForegroundService(getContext(), intent);
            } catch (RuntimeException e) {
                Log.e(TAG, "startForegroundService failed", e);
                if (pendingStart == call) {
                    pendingStart = null;
                    main.removeCallbacks(startTimeout);
                }
                call.reject("Could not start the ride service: " + e.getMessage(), "START_FAILED", e);
                return;
            }
            if (alreadyRunning) call.resolve(status());
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        main.post(() -> {
            if (pendingStart != null) {
                pendingStart.reject("Stopped before it started", "START_CANCELLED");
                pendingStart = null;
                main.removeCallbacks(startTimeout);
            }
            getContext().stopService(new Intent(getContext(), RideService.class));
            call.resolve();
        });
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void setBluetoothRouting(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", true));
        if (RideState.isRunning()) sendToService(RideService.ACTION_BLUETOOTH, enabled);
        AudioRoute route = RideState.getAudioRoute();
        call.resolve(route != null ? route.toJson() : new AudioRoute(enabled, false, false, null, "normal").toJson());
    }

    /** iOS-only concern (AVAudioSession); Chromium manages the Android audio mode itself. */
    @PluginMethod
    public void setAudioMode(PluginCall call) {
        call.resolve();
    }

    @Override
    public void onRideStateChanged() {
        if (pendingStart != null) {
            if (RideState.isRunning()) {
                PluginCall call = pendingStart;
                pendingStart = null;
                main.removeCallbacks(startTimeout);
                call.resolve(status());
            } else if (RideState.getStartError() != null) {
                PluginCall call = pendingStart;
                pendingStart = null;
                main.removeCallbacks(startTimeout);
                call.reject("The ride service could not start: " + RideState.getStartError(), "START_FAILED");
            }
        }
        AudioRoute route = RideState.getAudioRoute();
        if (route != null && !route.equals(lastRoute)) notifyListeners("audioRoute", route.toJson());
        lastRoute = route;
    }

    private JSObject status() {
        JSObject o = new JSObject();
        boolean running = RideState.isRunning();
        int types = RideState.getForegroundTypes();
        o.put("running", running);
        o.put("keepAlive", RideState.isKeepAlive());
        JSArray typeList = new JSArray();
        String described = RideService.describeTypes(types);
        if (!described.isEmpty()) for (String t : described.split(",")) typeList.put(t);
        o.put("types", typeList);
        AudioRoute route = RideState.getAudioRoute();
        o.put("route", route != null ? route.toJson() : null);
        return o;
    }

    private Intent serviceIntent(String action) {
        return new Intent(getContext(), RideService.class).setAction(action);
    }

    /** For a running (foreground) service only: plain startService is allowed then. */
    private void sendToService(String action, @Nullable Boolean bluetooth) {
        Intent intent = serviceIntent(action);
        if (bluetooth != null) intent.putExtra(RideService.EXTRA_BLUETOOTH, bluetooth.booleanValue());
        try {
            getContext().startService(intent);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not reach the ride service", e);
        }
    }

    // ---- permissions ----------------------------------------------------------------------------

    /**
     * Requests the missing runtime permissions among {@code permissions}, one system sequence at a
     * time (see PermissionGate). Permissions that don't exist on this Android version are skipped.
     * Resolves with the resulting states either way; it never rejects for "denied".
     */
    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        List<String> missing = new ArrayList<>();
        for (String alias : requestedAliases(call)) {
            if (!applicable(alias) || isGranted(alias)) continue;
            missing.add(alias);
        }
        if (missing.isEmpty()) {
            call.resolve(permissionStatus());
            return;
        }
        PermissionGate.get().acquire((ticket) -> {
            // Another request may have granted these while we waited.
            List<String> stillMissing = new ArrayList<>();
            for (String alias : missing) if (!isGranted(alias)) stillMissing.add(alias);
            if (stillMissing.isEmpty()) {
                PermissionGate.get().release(ticket);
                call.resolve(permissionStatus());
                return;
            }
            permissionTicket = ticket;
            requestPermissionForAliases(stillMissing.toArray(new String[0]), call, "onPermissionsResult");
        });
    }

    @PermissionCallback
    private void onPermissionsResult(PluginCall call) {
        PermissionGate.get().release(permissionTicket);
        permissionTicket = null;
        // Granted while the ride runs and we're in front: claim the newly allowed service types.
        if (RideState.isRunning() && RideService.allowedTypes(getContext()) != RideState.getForegroundTypes()) {
            sendToService(RideService.ACTION_REFRESH, null);
        }
        call.resolve(permissionStatus());
    }

    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        call.resolve(permissionStatus());
    }

    private List<String> requestedAliases(PluginCall call) {
        List<String> out = new ArrayList<>();
        JSArray list = call.getArray("permissions");
        if (list == null) return out;
        try {
            for (Object o : list.toList()) if (o instanceof String) out.add((String) o);
        } catch (JSONException e) {
            Log.w(TAG, "bad permissions list", e);
        }
        return out;
    }

    /** POST_NOTIFICATIONS exists from Android 13, BLUETOOTH_CONNECT from 12. */
    private static boolean applicable(String alias) {
        switch (alias) {
            case NOTIFICATIONS:
                return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU;
            case BLUETOOTH:
                return Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
            case LOCATION:
            case MICROPHONE:
                return true;
            default:
                return false;
        }
    }

    private boolean isGranted(String alias) {
        if (!applicable(alias)) return true;
        Context ctx = getContext();
        switch (alias) {
            case LOCATION:
                // "Approximate" (coarse only) is enough to run; JS sees preciseLocation=false.
                return granted(ctx, Manifest.permission.ACCESS_FINE_LOCATION) || granted(ctx, Manifest.permission.ACCESS_COARSE_LOCATION);
            case MICROPHONE:
                return granted(ctx, Manifest.permission.RECORD_AUDIO);
            case NOTIFICATIONS:
                return granted(ctx, Manifest.permission.POST_NOTIFICATIONS);
            case BLUETOOTH:
                return granted(ctx, Manifest.permission.BLUETOOTH_CONNECT);
            default:
                return false;
        }
    }

    private static boolean granted(Context ctx, String permission) {
        return ContextCompat.checkSelfPermission(ctx, permission) == PackageManager.PERMISSION_GRANTED;
    }

    private String stateOf(String alias) {
        if (isGranted(alias)) return PermissionState.GRANTED.toString();
        PermissionState state = getPermissionState(alias);
        return state != null ? state.toString() : PermissionState.PROMPT.toString();
    }

    private JSObject permissionStatus() {
        JSObject o = new JSObject();
        o.put(LOCATION, stateOf(LOCATION));
        o.put("preciseLocation", granted(getContext(), Manifest.permission.ACCESS_FINE_LOCATION));
        o.put(MICROPHONE, stateOf(MICROPHONE));
        o.put(NOTIFICATIONS, stateOf(NOTIFICATIONS));
        o.put(BLUETOOTH, stateOf(BLUETOOTH));
        return o;
    }

    // ---- share / open URL ---------------------------------------------------------------------

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("No app can open " + url, "NO_HANDLER", e);
        }
    }

    @PluginMethod
    public void share(PluginCall call) {
        String title = call.getString("title");
        String text = call.getString("text");
        String url = call.getString("url");
        String body = joinNonEmpty(text, url);
        if (body.isEmpty() && (title == null || title.isEmpty())) {
            call.reject("Nothing to share");
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, body.isEmpty() ? title : body);
        if (title != null) send.putExtra(Intent.EXTRA_SUBJECT, title);
        Intent chooser = Intent.createChooser(send, title).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(chooser);
            // Android doesn't report whether the user actually shared.
            JSObject result = new JSObject();
            result.put("completed", true);
            call.resolve(result);
        } catch (ActivityNotFoundException e) {
            call.reject("No app can share", "NO_HANDLER", e);
        }
    }

    @NonNull
    private static String joinNonEmpty(@Nullable String a, @Nullable String b) {
        boolean hasA = a != null && !a.isEmpty();
        boolean hasB = b != null && !b.isEmpty();
        if (hasA && hasB) return a + "\n" + b;
        if (hasA) return a;
        return hasB ? b : "";
    }
}
