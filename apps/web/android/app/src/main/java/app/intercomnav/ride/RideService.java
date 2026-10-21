package app.intercomnav.ride;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;
import app.intercomnav.R;

/**
 * "Ride in progress" foreground service, type location|microphone|mediaPlayback.
 *
 * While it runs:
 *  - the process stays at foreground-service priority, so it is neither frozen nor killed as a
 *    cached app, keeps network access in Doze, and keeps "while in use" location and microphone
 *    access with the screen off (the GeoProvider's FusedLocationProvider requests and WebRTC
 *    capture in the WebView both rely on this);
 *  - a partial wake lock keeps the CPU running between GPS fixes and audio buffers;
 *  - {@link RideState#isKeepAlive()} switches on the WebView keep-alive (RideWebView), which
 *    stops Chromium from freezing the page's JavaScript while the screen is off;
 *  - {@link BluetoothRouter} keeps call audio on a connected Bluetooth headset.
 *
 * Started with startForegroundService() while the app is in front (Android 14 only allows the
 * location/microphone types to start from the foreground). It claims only the types whose runtime
 * permissions are granted; ACTION_REFRESH re-enters the foreground with more types after the user
 * grants more permissions. START_NOT_STICKY: if the process dies there is no WebView left to serve.
 */
public class RideService extends Service {

    static final String ACTION_START = "app.intercomnav.ride.START";
    static final String ACTION_REFRESH = "app.intercomnav.ride.REFRESH";
    static final String ACTION_BLUETOOTH = "app.intercomnav.ride.BLUETOOTH";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_TEXT = "text";
    static final String EXTRA_BLUETOOTH = "bluetooth";
    static final String EXTRA_KEEP_ALIVE = "keepAlive";

    /** Keep in sync with RIDE_SERVICE_NOTIFICATION_ID in src/platform/common/notificationId.ts. */
    static final int NOTIFICATION_ID = 0x52494445;
    static final String CHANNEL_ID = "ride";
    private static final String TAG = "RideService";
    /** Ceiling in case the service is ever leaked; refreshed on every start/refresh. */
    private static final long WAKE_LOCK_TIMEOUT_MS = 12L * 60 * 60 * 1000;

    @Nullable
    private PowerManager.WakeLock wakeLock;
    @Nullable
    private BluetoothRouter router;
    private String title;
    private String text;
    private long startedAt;
    private boolean bluetoothRouting = true;
    private boolean webViewKeepAlive = true;

    /** Foreground-service types the current permissions allow. */
    static int allowedTypes(@NonNull Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0; // types don't exist yet
        int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK;
        if (granted(context, Manifest.permission.ACCESS_FINE_LOCATION) || granted(context, Manifest.permission.ACCESS_COARSE_LOCATION)) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && granted(context, Manifest.permission.RECORD_AUDIO)) {
            types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
        }
        return types;
    }

    private static boolean granted(Context context, String permission) {
        return ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED;
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null) {
            // Restarted by the system without an intent: there is no ride to serve.
            stopRide(null);
            return START_NOT_STICKY;
        }
        switch (action) {
            case ACTION_START:
                title = nonEmpty(intent.getStringExtra(EXTRA_TITLE), getString(R.string.ride_notification_title));
                text = nonEmpty(intent.getStringExtra(EXTRA_TEXT), getString(R.string.ride_notification_text));
                bluetoothRouting = intent.getBooleanExtra(EXTRA_BLUETOOTH, true);
                webViewKeepAlive = intent.getBooleanExtra(EXTRA_KEEP_ALIVE, true);
                if (!RideState.isRunning()) startedAt = System.currentTimeMillis();
                // Every startForegroundService() must be answered with startForeground(), even when running.
                if (!enterForeground()) return START_NOT_STICKY;
                break;
            case ACTION_REFRESH:
                if (!RideState.isRunning()) {
                    stopSelf(startId);
                    return START_NOT_STICKY;
                }
                refreshForeground();
                break;
            case ACTION_BLUETOOTH:
                bluetoothRouting = intent.getBooleanExtra(EXTRA_BLUETOOTH, true);
                if (!RideState.isRunning()) {
                    stopSelf(startId);
                    return START_NOT_STICKY;
                }
                break;
            default:
                Log.w(TAG, "unknown action " + action);
                return START_NOT_STICKY;
        }
        acquireWakeLock();
        if (router == null) router = new BluetoothRouter(this);
        router.setEnabled(bluetoothRouting);
        return START_NOT_STICKY;
    }

    /**
     * Enters the foreground with the types the current permissions allow. If Android refuses a
     * type (SecurityException on 14+ when its permission is missing or the start came from the
     * background), it retries with mediaPlayback alone, which needs no runtime permission: a service
     * started with startForegroundService() that stops without ever calling startForeground() crashes
     * the app.
     */
    private boolean enterForeground() {
        int types = allowedTypes(this);
        Notification notification = buildNotification();
        try {
            startForegroundWith(notification, types);
            return true;
        } catch (RuntimeException e) {
            Log.e(TAG, "startForeground(" + describeTypes(types) + ") refused", e);
            int fallback = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK : 0;
            if (fallback != types) {
                try {
                    startForegroundWith(notification, fallback);
                    return true;
                } catch (RuntimeException e2) {
                    Log.e(TAG, "startForeground(" + describeTypes(fallback) + ") refused", e2);
                }
            }
            stopRide(e.getClass().getSimpleName() + ": " + e.getMessage());
            return false;
        }
    }

    /** Claims additional types after the user granted more permissions; keeps the old ones on failure. */
    private void refreshForeground() {
        int types = allowedTypes(this);
        if (types == RideState.getForegroundTypes()) return;
        try {
            startForegroundWith(buildNotification(), types);
        } catch (RuntimeException e) {
            Log.w(TAG, "could not switch to " + describeTypes(types) + "; keeping " + describeTypes(RideState.getForegroundTypes()), e);
        }
    }

    private void startForegroundWith(@NonNull Notification notification, int types) {
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, types);
        Log.i(TAG, "in the foreground with types [" + describeTypes(types) + "]");
        RideState.setRunning(types, webViewKeepAlive);
    }

    @NonNull
    private Notification buildNotification() {
        if (title == null) title = getString(R.string.ride_notification_title);
        if (text == null) text = getString(R.string.ride_notification_text);
        ensureChannel();
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent content = null;
        if (open != null) {
            // Same as tapping the launcher icon: brings the existing task to the front.
            open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
            content = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        }
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_ride)
            .setColor(ContextCompat.getColor(this, R.color.ride_accent))
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(content)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setShowWhen(true)
            .setWhen(startedAt > 0 ? startedAt : System.currentTimeMillis())
            .setUsesChronometer(true)
            // Android 12+ otherwise delays foreground-service notifications by up to 10 s.
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        // Low importance: always visible in the shade and status bar, never makes a sound.
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.ride_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.ride_channel_description));
        channel.setShowBadge(false);
        nm.createNotificationChannel(channel);
    }

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "IntercomNav:ride");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(WAKE_LOCK_TIMEOUT_MS);
    }

    /** Swiping the app away destroys the WebView, so there is nothing left for the service to keep alive. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        Log.i(TAG, "task removed; ending the ride service");
        stopRide(null);
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        cleanUp(null);
        super.onDestroy();
    }

    private void stopRide(@Nullable String error) {
        cleanUp(error);
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    private void cleanUp(@Nullable String error) {
        if (router != null) {
            router.release();
            router = null;
        }
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (RideState.isRunning() || error != null) RideState.setStopped(error);
    }

    private static String nonEmpty(@Nullable String value, @NonNull String fallback) {
        return value == null || value.trim().isEmpty() ? fallback : value;
    }

    @NonNull
    static String describeTypes(int types) {
        StringBuilder sb = new StringBuilder();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            if ((types & ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION) != 0) sb.append("location,");
            if ((types & ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) != 0) sb.append("mediaPlayback,");
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && (types & ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE) != 0) {
            sb.append("microphone,");
        }
        if (sb.length() > 0) sb.setLength(sb.length() - 1);
        return sb.toString();
    }
}
