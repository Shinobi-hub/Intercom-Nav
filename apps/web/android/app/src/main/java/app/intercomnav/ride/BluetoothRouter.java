package app.intercomnav.ride;

import android.content.Context;
import android.media.AudioDeviceCallback;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import java.util.List;

/**
 * Routes microphone + call audio to a connected Bluetooth headset (a helmet communicator) while a
 * ride runs.
 *
 * Chromium owns the audio mode: it switches to MODE_IN_COMMUNICATION when WebRTC capture starts
 * and back to MODE_NORMAL (clearing the communication device) when the mic is released. It only
 * picks a Bluetooth device itself if it held BLUETOOTH_CONNECT when its audio manager initialised,
 * which isn't true on a first run. So this router acts only while the mode is IN_COMMUNICATION: it
 * makes the Bluetooth headset the communication device (API 31+, setCommunicationDevice) or
 * starts SCO (older releases). In MODE_NORMAL (mic off) it leaves routing alone so the headset can
 * stay on A2DP for music.
 *
 * Main thread only.
 */
final class BluetoothRouter {

    private static final String TAG = "BluetoothRouter";
    /** Debounce for bursts of device/mode callbacks; also stops tug-of-war loops with other code. */
    private static final long UPDATE_DELAY_MS = 300;
    /** Pre-API 31 there is no mode listener, so the mode is polled while routing is enabled. */
    private static final long LEGACY_POLL_MS = 2_000;

    private final AudioManager audio;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable updateNow = this::update;
    private final Runnable legacyPoll = new Runnable() {
        @Override
        public void run() {
            update();
            if (enabled) main.postDelayed(this, LEGACY_POLL_MS);
        }
    };

    private boolean enabled;
    private boolean registered;
    /** API 31+: the device we selected, so we only ever clear our own choice. */
    @Nullable
    private AudioDeviceInfo selected;
    /** Pre-31: whether we started SCO. */
    private boolean scoStarted;

    private final AudioDeviceCallback deviceCallback = new AudioDeviceCallback() {
        @Override
        public void onAudioDevicesAdded(AudioDeviceInfo[] added) {
            scheduleUpdate();
        }

        @Override
        public void onAudioDevicesRemoved(AudioDeviceInfo[] removed) {
            scheduleUpdate();
        }
    };

    @Nullable
    private Object modeListener;
    @Nullable
    private Object communicationDeviceListener;

    BluetoothRouter(@NonNull Context context) {
        audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
    }

    void setEnabled(boolean on) {
        if (on != enabled) {
            enabled = on;
            if (on) register();
            else unregister();
        }
        update();
    }

    /** Stops routing and hands the communication device back. */
    void release() {
        setEnabled(false);
        RideState.setAudioRoute(null);
    }

    private void register() {
        if (registered) return;
        registered = true;
        audio.registerAudioDeviceCallback(deviceCallback, main);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) registerModernListeners();
        else main.postDelayed(legacyPoll, LEGACY_POLL_MS);
    }

    private void unregister() {
        if (!registered) return;
        registered = false;
        audio.unregisterAudioDeviceCallback(deviceCallback);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) unregisterModernListeners();
        main.removeCallbacks(legacyPoll);
        main.removeCallbacks(updateNow);
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private void registerModernListeners() {
        AudioManager.OnModeChangedListener onMode = mode -> scheduleUpdate();
        AudioManager.OnCommunicationDeviceChangedListener onDevice = device -> scheduleUpdate();
        try {
            audio.addOnModeChangedListener(main::post, onMode);
            audio.addOnCommunicationDeviceChangedListener(main::post, onDevice);
            modeListener = onMode;
            communicationDeviceListener = onDevice;
        } catch (RuntimeException e) {
            Log.w(TAG, "audio listeners unavailable", e);
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private void unregisterModernListeners() {
        try {
            if (modeListener != null) audio.removeOnModeChangedListener((AudioManager.OnModeChangedListener) modeListener);
            if (communicationDeviceListener != null) {
                audio.removeOnCommunicationDeviceChangedListener(
                    (AudioManager.OnCommunicationDeviceChangedListener) communicationDeviceListener
                );
            }
        } catch (RuntimeException e) {
            Log.w(TAG, "removing audio listeners failed", e);
        }
        modeListener = null;
        communicationDeviceListener = null;
    }

    private void scheduleUpdate() {
        main.removeCallbacks(updateNow);
        main.postDelayed(updateNow, UPDATE_DELAY_MS);
    }

    private void update() {
        boolean inCall = audio.getMode() == AudioManager.MODE_IN_COMMUNICATION;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) updateModern(enabled && inCall);
            else updateLegacy(enabled && inCall);
        } catch (RuntimeException e) {
            // SecurityException without BLUETOOTH_CONNECT on some builds, IllegalArgumentException for
            // a device that vanished mid-call. Routing is best effort.
            Log.w(TAG, "audio routing failed", e);
        }
        publish();
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private void updateModern(boolean wantBluetooth) {
        AudioDeviceInfo headset = findBluetoothCommunicationDevice();
        AudioDeviceInfo current = audio.getCommunicationDevice();
        if (wantBluetooth && headset != null) {
            if (current == null || current.getId() != headset.getId()) {
                if (audio.setCommunicationDevice(headset)) {
                    Log.i(TAG, "communication audio -> " + headset.getProductName());
                } else {
                    Log.w(TAG, "setCommunicationDevice refused " + headset.getProductName());
                    return;
                }
            }
            selected = headset;
        } else if (selected != null) {
            if (current != null && current.getId() == selected.getId()) audio.clearCommunicationDevice();
            selected = null;
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    @Nullable
    private AudioDeviceInfo findBluetoothCommunicationDevice() {
        List<AudioDeviceInfo> devices = audio.getAvailableCommunicationDevices();
        AudioDeviceInfo sco = null;
        for (AudioDeviceInfo d : devices) {
            int type = d.getType();
            // LE Audio first: better voice quality than classic HFP when the helmet supports it.
            if (type == AudioDeviceInfo.TYPE_BLE_HEADSET) return d;
            if (sco == null && (type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || type == AudioDeviceInfo.TYPE_BLE_SPEAKER)) sco = d;
        }
        return sco;
    }

    @SuppressWarnings("deprecation") // the SCO calls are the only option before API 31
    private void updateLegacy(boolean wantBluetooth) {
        boolean useSco = wantBluetooth && hasScoOutput() && audio.isBluetoothScoAvailableOffCall();
        if (useSco && !scoStarted) {
            audio.startBluetoothSco();
            audio.setBluetoothScoOn(true);
            scoStarted = true;
            Log.i(TAG, "Bluetooth SCO started");
        } else if (!useSco && scoStarted) {
            audio.setBluetoothScoOn(false);
            audio.stopBluetoothSco();
            scoStarted = false;
            Log.i(TAG, "Bluetooth SCO stopped");
        }
    }

    private boolean hasScoOutput() {
        for (AudioDeviceInfo d : audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
            if (d.getType() == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) return true;
        }
        return false;
    }

    private void publish() {
        boolean available;
        boolean active;
        String device = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            available = findBluetoothCommunicationDevice() != null;
            AudioDeviceInfo current = audio.getCommunicationDevice();
            active = current != null && isBluetooth(current.getType());
            if (current != null) device = String.valueOf(current.getProductName());
        } else {
            available = hasScoOutput();
            active = scoStarted;
        }
        RideState.setAudioRoute(new AudioRoute(enabled, available, active, device, modeName(audio.getMode())));
    }

    private static boolean isBluetooth(int type) {
        return (
            type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO ||
            type == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP ||
            type == AudioDeviceInfo.TYPE_BLE_HEADSET ||
            type == AudioDeviceInfo.TYPE_BLE_SPEAKER
        );
    }

    private static String modeName(int mode) {
        switch (mode) {
            case AudioManager.MODE_NORMAL:
                return "normal";
            case AudioManager.MODE_IN_COMMUNICATION:
                return "in_communication";
            case AudioManager.MODE_IN_CALL:
                return "in_call";
            case AudioManager.MODE_RINGTONE:
                return "ringtone";
            default:
                return "other";
        }
    }
}
