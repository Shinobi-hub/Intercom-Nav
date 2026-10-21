package app.intercomnav;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;
import app.intercomnav.ride.PermissionGate;
import app.intercomnav.ride.RideServicePlugin;
import app.intercomnav.ride.RideState;
import app.intercomnav.web.RideWebChromeClient;
import com.getcapacitor.BridgeActivity;

/**
 * The WebView itself is {@link app.intercomnav.web.RideWebView} (res/layout/
 * capacitor_bridge_layout_main.xml overrides Capacitor's layout); it does the screen-off keep-alive.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(RideServicePlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = bridge.getWebView();
        // Voice, the SOS siren and music must be able to start without a fresh tap (an SOS can
        // arrive while the app is in the background). Capacitor sets this too; it's load-bearing here.
        webView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // The default, stated explicitly: the renderer keeps the app's (foreground-service)
            // priority even while the WebView isn't visible, instead of becoming an OOM-kill target.
            webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        // Must happen before onStart: the client registers activity-result launchers.
        webView.setWebChromeClient(new RideWebChromeClient(bridge));
    }

    @Override
    public void onPause() {
        super.onPause();
        keepWebViewRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewRunning();
    }

    @Override
    public void onDestroy() {
        PermissionGate.get().reset();
        super.onDestroy();
    }

    /**
     * During a ride, undo any explicit WebView pause: Capacitor's Cordova layer calls
     * pauseTimers() when the "KeepRunning" preference is false, and plugins may call
     * WebView.onPause(). Both would stop JavaScript or hide the page. Visibility-based freezing is
     * handled by RideWebView; this covers the explicit calls.
     */
    private void keepWebViewRunning() {
        if (bridge == null || !RideState.isKeepAlive()) return;
        WebView webView = bridge.getWebView();
        webView.onResume();
        webView.resumeTimers();
    }
}
