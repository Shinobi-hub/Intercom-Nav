package app.intercomnav.ride;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import com.getcapacitor.JSObject;
import java.util.Objects;

/** Snapshot of where communication audio goes, reported to JS as the `audioRoute` event. */
public final class AudioRoute {

    /** Bluetooth routing was requested for this ride. */
    public final boolean enabled;
    /** A Bluetooth headset that can carry call audio (HFP/SCO or LE Audio) is connected. */
    public final boolean bluetoothAvailable;
    /** Mic and call audio currently go to that headset. */
    public final boolean bluetoothActive;
    /** Product name of the current communication device, when known. */
    @Nullable
    public final String device;
    /** AudioManager mode as text: normal, in_communication, in_call, ringtone, other. */
    @NonNull
    public final String mode;

    AudioRoute(boolean enabled, boolean bluetoothAvailable, boolean bluetoothActive, @Nullable String device, @NonNull String mode) {
        this.enabled = enabled;
        this.bluetoothAvailable = bluetoothAvailable;
        this.bluetoothActive = bluetoothActive;
        this.device = device;
        this.mode = mode;
    }

    @NonNull
    public JSObject toJson() {
        JSObject o = new JSObject();
        o.put("enabled", enabled);
        o.put("bluetoothAvailable", bluetoothAvailable);
        o.put("bluetoothActive", bluetoothActive);
        o.put("device", device);
        o.put("mode", mode);
        return o;
    }

    @Override
    public boolean equals(Object other) {
        if (this == other) return true;
        if (!(other instanceof AudioRoute)) return false;
        AudioRoute r = (AudioRoute) other;
        return (
            enabled == r.enabled &&
            bluetoothAvailable == r.bluetoothAvailable &&
            bluetoothActive == r.bluetoothActive &&
            Objects.equals(device, r.device) &&
            mode.equals(r.mode)
        );
    }

    @Override
    public int hashCode() {
        return Objects.hash(enabled, bluetoothAvailable, bluetoothActive, device, mode);
    }

    @NonNull
    @Override
    public String toString() {
        return "AudioRoute{enabled=" + enabled + ", bt=" + bluetoothAvailable + "/" + bluetoothActive + ", device=" + device + ", mode=" + mode + "}";
    }
}
