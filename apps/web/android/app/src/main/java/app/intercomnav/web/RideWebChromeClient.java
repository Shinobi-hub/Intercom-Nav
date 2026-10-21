package app.intercomnav.web;

import android.net.Uri;
import android.webkit.PermissionRequest;
import androidx.annotation.NonNull;
import app.intercomnav.ride.PermissionGate;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Capacitor's WebChromeClient with the WebView's own permission prompts (getUserMedia ->
 * RECORD_AUDIO) queued behind any RideService permission request through {@link PermissionGate},
 * so the two never ask Android at the same time. See PermissionGate for why that matters.
 */
public class RideWebChromeClient extends BridgeWebChromeClient {

    public RideWebChromeClient(Bridge bridge) {
        super(bridge);
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        PermissionGate.get().acquire((ticket) -> RideWebChromeClient.super.onPermissionRequest(new GatedRequest(request, ticket)));
    }

    /** Forwards to the WebView's request and frees the gate once it is answered (or cancelled). */
    private static final class GatedRequest extends PermissionRequest {

        private final PermissionRequest inner;
        private final PermissionGate.Ticket ticket;
        private final AtomicBoolean done = new AtomicBoolean(false);

        GatedRequest(PermissionRequest inner, PermissionGate.Ticket ticket) {
            this.inner = inner;
            this.ticket = ticket;
        }

        @NonNull
        @Override
        public Uri getOrigin() {
            return inner.getOrigin();
        }

        @NonNull
        @Override
        public String[] getResources() {
            return inner.getResources();
        }

        @Override
        public void grant(String[] resources) {
            try {
                inner.grant(resources);
            } finally {
                finish();
            }
        }

        @Override
        public void deny() {
            try {
                inner.deny();
            } finally {
                finish();
            }
        }

        private void finish() {
            if (done.compareAndSet(false, true)) PermissionGate.get().release(ticket);
        }
    }
}
