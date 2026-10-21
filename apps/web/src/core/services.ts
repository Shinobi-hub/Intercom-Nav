/**
 * Service interfaces: the seams between features. Each feature exports a factory that returns one
 * of these; main.tsx wires them together and registers them here. Implementations publish their
 * state into the stores in ./store.ts (see the ownership notes there) and never import each other's
 * internals, only these interfaces.
 */
import type {
  BreakKind,
  LatLng,
  LiveKitJoinInfo,
  LocationFix,
  MicMode,
  Place,
  RideRoute,
  RiderId,
  Result,
  VoiceDataMessage,
  VoiceJoinInfo,
  VoiceMode,
} from '@intercom/shared';
import type { AppSocket } from './socket';
import type { PeerState } from './store';

export type Unsubscribe = () => void;

// ---- platform ---------------------------------------------------------------------------------

/** A position straight from the OS, before filtering. */
export interface RawFix {
  lat: number;
  lng: number;
  /** Meters. */
  accuracy: number;
  /** m/s or null. */
  speed: number | null;
  /** Degrees from north or null. */
  heading: number | null;
  altitude: number | null;
  /** ms since epoch. */
  timestamp: number;
}

export interface GeoError {
  code: 'denied' | 'unavailable' | 'timeout' | 'unknown';
  message: string;
}

/** Source of raw positions: navigator.geolocation on the web, a background-capable plugin on native. */
export interface GeoProvider {
  start(onFix: (fix: RawFix) => void, onError: (err: GeoError) => void): Promise<void>;
  stop(): Promise<void>;
}

export interface WakeLockApi {
  /** Keep the screen on. Re-acquired automatically when the app returns to the foreground. */
  enable(): Promise<void>;
  disable(): Promise<void>;
  readonly active: boolean;
}

export interface LifecycleApi {
  /** App came back to the foreground (tab visible / native resume). */
  onResume(cb: () => void): Unsubscribe;
  /** App went to the background (tab hidden / native pause). */
  onPause(cb: () => void): Unsubscribe;
  isForeground(): boolean;
}

export interface HapticsApi {
  /** Pattern in ms like navigator.vibrate. No-op where unsupported (iOS Safari). */
  vibrate(pattern: number | number[]): void;
}

export interface AudioSessionApi {
  /** iOS: maps to navigator.audioSession.type (web) or AVAudioSession (native). No-op elsewhere. */
  setMode(mode: 'auto' | 'playback' | 'play-and-record'): void;
}

export interface BackgroundApi {
  /** True when the app can keep GPS + voice alive with the screen off (native builds). */
  readonly supported: boolean;
  /** Start the native "ride in progress" foreground service / background modes. No-op on the web. */
  start(info: { title: string; text: string }): Promise<void>;
  stop(): Promise<void>;
  /** Local notification, used for alerts that arrive while the app is in the background. */
  notify(n: { id: string; title: string; body: string; urgent: boolean }): Promise<void>;
}

export interface NetworkApi {
  isOnline(): boolean;
  onChange(cb: (online: boolean) => void): Unsubscribe;
}

export interface PlatformApi {
  readonly kind: 'web' | 'android' | 'ios';
  readonly isNative: boolean;
  readonly geo: GeoProvider;
  readonly wakeLock: WakeLockApi;
  readonly lifecycle: LifecycleApi;
  readonly haptics: HapticsApi;
  readonly audioSession: AudioSessionApi;
  readonly background: BackgroundApi;
  readonly network: NetworkApi;
  /** Open a URL outside the app (maps directions). */
  openExternal(url: string): void;
  /** Native share sheet / navigator.share. Resolves false when unsupported or cancelled. */
  share(data: { title?: string; text?: string; url?: string }): Promise<boolean>;
}

// ---- location ---------------------------------------------------------------------------------

export interface LocationServiceApi {
  /** Starts the GeoProvider. Publishes useLocalStore.gps and .selfFix. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Every accepted (filtered, smoothed) fix. */
  onFix(cb: (fix: LocationFix) => void): Unsubscribe;
  /** Fixes that pass the send policy and should go to the server. */
  onSend(cb: (fix: LocationFix) => void): Unsubscribe;
  /** Feed a raw fix as if it came from the provider (tests, simulation). Works even when stopped. */
  inject(raw: RawFix): void;
}

// ---- audio ------------------------------------------------------------------------------------

export interface AudioSettings {
  voiceVolume: number;
  musicVolume: number;
  duckLevel: number;
  duckOnOwnVoice: boolean;
  vadSensitivity: number;
  riderVolumes: Record<RiderId, number>;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
}

export interface MusicTrack {
  id: string;
  title: string;
  kind: 'file' | 'stream';
  /** Stream URL (kind 'stream'). Files live in IndexedDB. */
  url?: string;
  sizeBytes?: number;
  addedAt: number;
}

export interface MusicPlayerApi {
  listTracks(): Promise<MusicTrack[]>;
  addFiles(files: File[]): Promise<MusicTrack[]>;
  /** The stream must allow CORS, or Web Audio would output silence. */
  addStream(url: string, title?: string): Promise<MusicTrack>;
  removeTrack(id: string): Promise<void>;
  play(id?: string): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  onTracksChanged(cb: (tracks: MusicTrack[]) => void): Unsubscribe;
}

export type ChimeKind = 'break' | 'join' | 'leave' | 'sent' | 'route' | 'error' | 'responder';

export interface AlertSoundsApi {
  /** Loud SOS siren on the alert bus: never ducked, ignores master volume. Loops until stopped. */
  startSiren(): void;
  stopSiren(): void;
  /** Short earcons through the normal mix. */
  chime(kind: ChimeKind): void;
  /** Tiny confirmation blip for button presses. */
  click(): void;
  /** Text-to-speech through the system output (cannot be routed through Web Audio). */
  announce(text: string): void;
}

export interface AudioDevices {
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
  /** AudioContext.setSinkId support. */
  canSelectOutput: boolean;
}

export interface AudioEngineApi {
  /**
   * Create/resume the AudioContext and unlock speech synthesis. Call it synchronously at the very
   * start of a user-gesture handler, before any await, or iOS will keep audio locked.
   */
  unlock(): Promise<void>;
  /** Resume after an interruption. Resolves true if the context is running. */
  resume(): Promise<boolean>;
  /** 'vox' and 'open' acquire the mic; 'off' releases the device so Bluetooth can return to A2DP. */
  setMicMode(mode: MicMode): Promise<void>;
  /** Processed (VOX-gated) mic track for the voice transport; null while the mic is off. */
  readonly outgoingTrack: MediaStreamTrack | null;
  onOutgoingTrackChange(cb: (track: MediaStreamTrack | null) => void): Unsubscribe;
  /** Route a remote rider's voice into the mix (and into that rider's VAD). Replaces any previous track. */
  addRemoteTrack(riderId: RiderId, track: MediaStreamTrack): void;
  removeRemoteTrack(riderId: RiderId): void;
  applySettings(s: AudioSettings): void;
  /** SOS active somewhere in the ride: music muted, siren unaffected by ducking. */
  setSosMode(active: boolean): void;
  listDevices(): Promise<AudioDevices>;
  readonly music: MusicPlayerApi;
  readonly alerts: AlertSoundsApi;
  dispose(): Promise<void>;
}

// ---- voice ------------------------------------------------------------------------------------

export interface PeerStats {
  state: PeerState;
  bytesReceived: number;
  packetsLost: number;
  jitterMs: number | null;
  rttMs: number | null;
  /** 0..1 from inbound-rtp audioLevel, when available. */
  audioLevel: number | null;
}

export interface VoiceStats {
  transport: VoiceMode | null;
  bytesSent: number;
  peers: Record<RiderId, PeerStats>;
}

export interface VoiceManagerApi {
  /** Connect with the transport named in `info.mode`, publish audio.outgoingTrack, and feed remote tracks to audio. */
  start(info: VoiceJoinInfo, selfId: RiderId): Promise<void>;
  /** Server changed the transport (voice:mode) or issued new credentials. Reconnects as needed. */
  update(info: VoiceJoinInfo): Promise<void>;
  stop(): Promise<void>;
  /** Best-effort broadcast over the transport's data channel (SOS redundancy). */
  sendData(msg: VoiceDataMessage): void;
  onData(cb: (from: RiderId, msg: VoiceDataMessage) => void): Unsubscribe;
  getStats(): Promise<VoiceStats>;
}

/** What the voice manager needs to fetch a fresh LiveKit token. */
export type LiveKitTokenFetcher = () => Promise<LiveKitJoinInfo | null>;

// ---- ride controller (the app's orchestration layer, used by the UI) ---------------------------

export type StartIntent = { kind: 'create' } | { kind: 'join'; code: string };

export interface RideControllerApi {
  /**
   * The "Start ride" tap. Unlocks audio synchronously, then connects, creates/joins, and starts GPS,
   * mic, voice, wake lock and (native) the background service. Resolves with the ride code.
   */
  startRide(intent: StartIntent): Promise<Result<{ code: string }>>;
  leaveRide(): Promise<void>;
  /** For the "Tap to resume audio" overlay (must run inside a tap). */
  resumeAudio(): Promise<void>;
  raiseSos(): Promise<void>;
  /** Only the raiser (or leader) can cancel. */
  cancelSos(id: string): Promise<void>;
  /** "I'm coming"; also silences the siren for this SOS. */
  respondSos(id: string): Promise<void>;
  /** Silence the siren locally; the SOS stays active. */
  acknowledgeSos(id: string): void;
  requestBreak(kind: BreakKind): Promise<Result>;
  searchPlaces(q: string, near?: LatLng): Promise<Result<{ results: Place[] }>>;
  setDestination(destination: Place, waypoints?: Place[]): Promise<Result<{ route: RideRoute }>>;
  clearRoute(): Promise<Result>;
  transferLeader(to: RiderId): Promise<Result>;
  setVoiceMode(mode: VoiceMode): Promise<Result>;
  setMicMode(mode: MicMode): Promise<void>;
  updateProfile(p: { name?: string; color?: string }): Promise<void>;
  /** Code of a ride this device was in recently and can rejoin, if any. */
  getResumableRide(): string | null;
}

// ---- registry ---------------------------------------------------------------------------------

export interface Services {
  platform: PlatformApi;
  socket: AppSocket;
  audio: AudioEngineApi;
  voice: VoiceManagerApi;
  location: LocationServiceApi;
  controller: RideControllerApi;
}

let current: Services | null = null;

export function setServices(s: Services): void {
  current = s;
}

export function getServices(): Services {
  if (!current) throw new Error('services not initialised (main.tsx must call setServices first)');
  return current;
}

/** Hook-style alias for components. Services are created once at startup and never change. */
export const useServices = getServices;
