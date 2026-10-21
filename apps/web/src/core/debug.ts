/**
 * Test and diagnostics hooks, exposed as `window.__intercom` when DEBUG_ENABLED.
 * E2E tests drive and inspect the app through these, so keep the shapes stable.
 * Each feature registers its own section at startup with registerDebug().
 */
import type { LocationFix, RiderId, VoiceMode } from '@intercom/shared';
import { DEBUG_ENABLED } from './config';
import type { VoiceStats } from './services';
import { snapshotState } from './store';

export interface VadDebugEntry {
  speaking: boolean;
  levelDb: number;
  floorDb: number;
}

export interface AudioDebug {
  contextState(): string;
  /** Current value of the duck GainNode: 1 = not ducked, duckLevel = fully ducked. */
  duckGain(): number;
  /** Effective music gain: user music volume x duck gain x SOS mute. */
  musicGain(): number;
  /** Alert bus gain (siren). */
  alertGain(): number;
  sirenActive(): boolean;
  /** VAD state keyed by rider id; the local mic is under the key 'self'. */
  vad(): Record<RiderId | 'self', VadDebugEntry>;
  /** Riders whose audio is connected to the mix. */
  remoteRiders(): RiderId[];
  /** Current VOX gate gain on the outgoing mic, 0..1. */
  voxGate(): number;
  outgoingTrackState(): 'none' | 'live' | 'ended';
  musicState(): { playing: boolean; trackId: string | null; currentTime: number };
}

export interface VoiceDebug {
  transport(): VoiceMode | null;
  stats(): Promise<VoiceStats>;
}

export interface GeoDebug {
  /** Inject a raw fix (bypasses the OS provider). */
  inject(fix: {
    lat: number;
    lng: number;
    accuracy?: number;
    speed?: number | null;
    heading?: number | null;
    timestamp?: number;
  }): void;
  lastSent(): LocationFix | null;
}

export interface MapMarkerDebug {
  lat: number;
  lng: number;
  hdg: number | null;
  state: 'live' | 'stale' | 'lost';
  extrapolating: boolean;
}

export interface MapDebug {
  ready(): boolean;
  /** Rendered (interpolated) marker positions right now, keyed by rider id (includes self). */
  markers(): Record<RiderId, MapMarkerDebug>;
  cameraMode(): string;
  routeVisible(): boolean;
}

export interface DebugSections {
  audio: AudioDebug;
  voice: VoiceDebug;
  geo: GeoDebug;
  map: MapDebug;
}

const sections: Partial<DebugSections> = {};

export function registerDebug<K extends keyof DebugSections>(key: K, impl: DebugSections[K]): void {
  sections[key] = impl;
}

export interface IntercomDebugGlobal extends Partial<DebugSections> {
  version: 1;
  state(): ReturnType<typeof snapshotState>;
}

declare global {
  interface Window {
    __intercom?: IntercomDebugGlobal;
  }
}

export function installDebugGlobal(): void {
  if (!DEBUG_ENABLED) return;
  const api = { version: 1 as const, state: snapshotState };
  for (const key of ['audio', 'voice', 'geo', 'map'] as const) {
    // Getters, so sections registered after install still show up.
    Object.defineProperty(api, key, { get: () => sections[key], enumerable: true });
  }
  window.__intercom = api as IntercomDebugGlobal;
}
