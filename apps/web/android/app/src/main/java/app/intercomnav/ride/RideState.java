package app.intercomnav.ride;

import android.os.Handler;
import android.os.Looper;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import java.util.concurrent.CopyOnWriteArraySet;

/**
 * Process-wide ride state shared by {@link RideService}, {@link RideServicePlugin} and the WebView
 * ({@link app.intercomnav.web.RideWebView}). Written by the service on the main thread; listeners
 * are always called on the main thread.
 */
public final class RideState {

    /** Notified whenever the service starts, stops, fails to start or the audio route changes. */
    public interface Listener {
        void onRideStateChanged();
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final CopyOnWriteArraySet<Listener> LISTENERS = new CopyOnWriteArraySet<>();

    private static volatile boolean running;
    private static volatile boolean keepAlive;
    private static volatile int foregroundTypes;
    @Nullable
    private static volatile String startError;
    @Nullable
    private static volatile AudioRoute audioRoute;

    private RideState() {}

    /** True while the ride foreground service runs. */
    public static boolean isRunning() {
        return running;
    }

    /**
     * The WebView keep-alive switch: while true the WebView reports itself visible so Chromium never
     * throttles or freezes the page (see RideWebView). On whenever the service runs, unless the ride
     * was started with keepAlive=false (only useful to demonstrate the freeze it prevents).
     */
    public static boolean isKeepAlive() {
        return running && keepAlive;
    }

    /** ServiceInfo.FOREGROUND_SERVICE_TYPE_* bits the service is currently running with. */
    public static int getForegroundTypes() {
        return foregroundTypes;
    }

    @Nullable
    public static String getStartError() {
        return startError;
    }

    @Nullable
    public static AudioRoute getAudioRoute() {
        return audioRoute;
    }

    static void setRunning(int types, boolean webViewKeepAlive) {
        running = true;
        keepAlive = webViewKeepAlive;
        foregroundTypes = types;
        startError = null;
        notifyListeners();
    }

    static void setStopped(@Nullable String error) {
        running = false;
        keepAlive = false;
        foregroundTypes = 0;
        startError = error;
        audioRoute = null;
        notifyListeners();
    }

    static void setAudioRoute(@Nullable AudioRoute route) {
        AudioRoute previous = audioRoute;
        audioRoute = route;
        if (previous == null ? route != null : !previous.equals(route)) notifyListeners();
    }

    static void clearStartError() {
        startError = null;
    }

    public static void addListener(@NonNull Listener listener) {
        LISTENERS.add(listener);
    }

    public static void removeListener(@NonNull Listener listener) {
        LISTENERS.remove(listener);
    }

    private static void notifyListeners() {
        Runnable dispatch = () -> {
            for (Listener l : LISTENERS) l.onRideStateChanged();
        };
        if (Looper.myLooper() == Looper.getMainLooper()) dispatch.run();
        else MAIN.post(dispatch);
    }
}
