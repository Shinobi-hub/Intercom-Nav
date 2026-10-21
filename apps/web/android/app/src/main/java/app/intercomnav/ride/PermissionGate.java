package app.intercomnav.ride;

import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import java.util.ArrayDeque;

/**
 * Serialises runtime-permission requests app-wide.
 *
 * Android can only show one permission request at a time: Activity.requestPermissions() while
 * another is pending is cancelled straight away with empty results. At ride start the JS layer
 * asks RideService for its permission batch while the audio engine's getUserMedia() makes the
 * WebView ask for RECORD_AUDIO, so one of them would lose. Worse, Capacitor's
 * BridgeWebChromeClient treats an empty result map as "granted" and grants the WebView capture
 * even though the OS permission was never given. Both request paths therefore take a ticket here
 * and run one after the other.
 *
 * All methods may be called from any thread; work runs on the main thread.
 */
public final class PermissionGate {

    private static final String TAG = "PermissionGate";
    /** Last-resort release if a holder never finishes (activity destroyed mid-dialog). */
    private static final long MAX_HOLD_MS = 120_000;
    private static final PermissionGate INSTANCE = new PermissionGate();

    /** Proof of holding the gate; releasing a stale ticket is a no-op. */
    public static final class Ticket {

        private Ticket() {}
    }

    public interface Task {
        void run(@NonNull Ticket ticket);
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ArrayDeque<Task> waiting = new ArrayDeque<>();
    private Ticket holder;
    private final Runnable expire = () -> {
        Log.w(TAG, "permission request never finished; releasing the gate");
        releaseNow(holder);
    };

    public static PermissionGate get() {
        return INSTANCE;
    }

    private PermissionGate() {}

    /** Runs {@code task} on the main thread once nobody else is requesting permissions. */
    public void acquire(@NonNull Task task) {
        main.post(() -> {
            if (holder == null) start(task);
            else waiting.add(task);
        });
    }

    public void release(Ticket ticket) {
        main.post(() -> releaseNow(ticket));
    }

    /** Drops queued requests and frees the gate (activity destroyed). */
    public void reset() {
        main.post(() -> {
            waiting.clear();
            releaseNow(holder);
        });
    }

    private void start(Task task) {
        Ticket ticket = new Ticket();
        holder = ticket;
        main.postDelayed(expire, MAX_HOLD_MS);
        try {
            task.run(ticket);
        } catch (RuntimeException e) {
            Log.e(TAG, "permission task failed", e);
            releaseNow(ticket);
        }
    }

    private void releaseNow(Ticket ticket) {
        if (ticket == null || ticket != holder) return;
        main.removeCallbacks(expire);
        holder = null;
        Task next = waiting.poll();
        if (next != null) start(next);
    }
}
