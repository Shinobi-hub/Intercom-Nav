package app.intercomnav.web;

import android.content.Context;
import android.util.AttributeSet;
import android.util.Log;
import android.view.View;
import app.intercomnav.ride.RideState;
import com.getcapacitor.CapacitorWebView;

/**
 * Capacitor's WebView, kept "visible" to Chromium while a ride runs.
 *
 * Why: Capacitor never pauses the WebView itself (BridgeActivity.onPause only pauses timers when
 * the Cordova "KeepRunning" preference is false), but Chromium derives the page's visibility from
 * the WebView's window visibility (AwContents: page visible = !paused && attached && window
 * visible). When the screen turns off the activity stops, the window becomes invisible, the page
 * becomes hidden, and Blink then throttles timers and, on Android, freezes every freezable task
 * queue of a hidden, silent page after a short delay ("stop in background", 1-5 minutes depending on
 * the Chromium version). A frozen page runs no JavaScript at all: location callbacks queue up
 * undelivered, Socket.io stops answering, the LiveKit signalling pings stop and the group drops the
 * rider. This is the "updates stop after 5 minutes" problem background-geolocation users hit.
 *
 * Fix: while {@link RideState#isKeepAlive()} (the ride foreground service is up), report VISIBLE
 * for the window, so the page is never hidden, throttled or frozen. Rendering still stops with the
 * screen off because Android doesn't draw an invisible window. When the ride ends, the real window
 * visibility is delivered again. JS must therefore use the native lifecycle (@capacitor/app),
 * not document.visibilityState, to know whether the app is in the background during a ride.
 *
 * Not every WebView hides the page this way: on the API 35 emulator (WebView 124) the page stayed
 * visible and running in the background even with the keep-alive off (docs/NATIVE.md). This guards the
 * builds that do hide and freeze it.
 */
public class RideWebView extends CapacitorWebView implements RideState.Listener {

    private static final String TAG = "RideWebView";

    /** The last window visibility Android actually reported. */
    private int actualVisibility = View.VISIBLE;
    private boolean keepAlive;

    public RideWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    @Override
    protected void onAttachedToWindow() {
        super.onAttachedToWindow();
        RideState.addListener(this);
        keepAlive = RideState.isKeepAlive();
    }

    @Override
    protected void onDetachedFromWindow() {
        RideState.removeListener(this);
        super.onDetachedFromWindow();
    }

    @Override
    protected void onWindowVisibilityChanged(int visibility) {
        actualVisibility = visibility;
        if (keepAlive && visibility != View.VISIBLE) {
            Log.d(TAG, "window visibility " + visibility + " ignored: ride keep-alive is on");
        }
        super.onWindowVisibilityChanged(keepAlive ? View.VISIBLE : visibility);
    }

    @Override
    public void onRideStateChanged() {
        boolean now = RideState.isKeepAlive();
        if (now == keepAlive) return;
        keepAlive = now;
        Log.i(TAG, "ride keep-alive " + (now ? "on" : "off") + " (window visibility " + actualVisibility + ")");
        // Re-deliver so Chromium's view of the window matches the new policy straight away.
        super.onWindowVisibilityChanged(now ? View.VISIBLE : actualVisibility);
    }
}
