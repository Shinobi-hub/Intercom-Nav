/**
 * Bindings for the two plugins without a JS entry point: the community background-geolocation
 * plugin (types only) and our own RideService plugin, implemented in
 * android/app/src/main/java/app/intercomnav/ride/RideServicePlugin.java and
 * ios/App/App/RideServicePlugin.swift.
 */
import { registerPlugin, type PermissionState, type PluginListenerHandle } from '@capacitor/core';
import type { BackgroundGeolocationPlugin } from '@capacitor-community/background-geolocation';

export const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

export type RidePermission = 'location' | 'microphone' | 'notifications' | 'bluetooth';

/**
 * Android runtime permission states. Permissions that don't exist on the running OS version
 * (notifications before 13, bluetooth before 12) report 'granted'.
 */
export interface RidePermissionStatus {
  location: PermissionState;
  /** False when the user chose "approximate" location. */
  preciseLocation: boolean;
  microphone: PermissionState;
  notifications: PermissionState;
  bluetooth: PermissionState;
}

/** Where communication audio (mic + voice) currently goes. Android only. */
export interface AudioRoute {
  /** Bluetooth routing requested for this ride. */
  enabled: boolean;
  /** A Bluetooth headset that can carry call audio is connected. */
  bluetoothAvailable: boolean;
  /** Mic + call audio are on the Bluetooth headset right now. */
  bluetoothActive: boolean;
  /** Product name of the current communication device, when known. */
  device: string | null;
  /** AudioManager mode: 'normal' | 'in_communication' | 'in_call' | 'ringtone' | 'other'. */
  mode: string;
}

export interface RideServiceStatus {
  running: boolean;
  /** Android: the WebView is being kept "visible" so its JS isn't frozen while the screen is off. */
  keepAlive: boolean;
  /** Android foreground-service types in effect, e.g. ['location', 'microphone', 'mediaPlayback']. */
  types: string[];
  route: AudioRoute | null;
}

export interface RideServicePlugin {
  /**
   * Android: start (or update) the "ride in progress" foreground service, its wake lock, WebView
   * keep-alive and, with bluetoothRouting, helmet routing. Must be called while the app is in the
   * foreground (Android 14 rules). iOS: marks the ride active and keeps the audio session configured.
   */
  start(options: {
    title: string;
    text: string;
    bluetoothRouting?: boolean;
    /**
     * Android, default true: keep the WebView "visible" so Chromium doesn't freeze JS with the
     * screen off. false exists only to demonstrate that freeze (docs/NATIVE.md).
     */
    keepAlive?: boolean;
  }): Promise<RideServiceStatus>;
  stop(): Promise<void>;
  getStatus(): Promise<RideServiceStatus>;
  /**
   * Android: requests the missing runtime permissions in one system dialog sequence, serialised with
   * the WebView's own microphone prompt. iOS: reports states without prompting.
   */
  ensurePermissions(options: { permissions: RidePermission[] }): Promise<RidePermissionStatus>;
  getPermissionStatus(): Promise<RidePermissionStatus>;
  /** Android: route communication audio to a Bluetooth headset while the ride runs. */
  setBluetoothRouting(options: { enabled: boolean }): Promise<AudioRoute>;
  /** iOS: AVAudioSession category/options. Android: no-op (Chromium manages the audio mode). */
  setAudioMode(options: { mode: 'auto' | 'playback' | 'play-and-record' }): Promise<void>;
  /** Open a URL with the OS (maps app, browser). */
  openUrl(options: { url: string }): Promise<void>;
  /** OS share sheet. `completed` is false when cancelled (Android can't tell, so it reports true). */
  share(options: { title?: string; text?: string; url?: string }): Promise<{ completed: boolean }>;
  addListener(event: 'audioRoute', listener: (route: AudioRoute) => void): Promise<PluginListenerHandle>;
}

export const RideService = registerPlugin<RideServicePlugin>('RideService');
