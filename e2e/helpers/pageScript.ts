/**
 * Installed into every rider page before the app loads (context.addInitScript). Must stay
 * self-contained: Playwright serializes the function, so it can't reference anything outside it.
 *
 *  - Turns the app's debug hooks on in any build (localStorage intercom:debug=1).
 *  - Seeds persisted settings once (zustand persist, key intercom:settings, version 1).
 *  - Records speechSynthesis utterances instead of speaking them (TTS on macOS bypasses
 *    --mute-audio and would talk out loud), firing start/end so the app's queue keeps moving.
 *  - Runs in-page samplers ("probes") at a fixed interval, so timing-sensitive measurements
 *    (duck gain, VAD, marker glide) aren't distorted by Node <-> browser round trips.
 */
import type { LocationFix } from '@intercom/shared';
import type { MapMarkerDebug, Settings } from './contract';

export interface AudioSample {
  /** Date.now() in the page (all riders share the machine clock). */
  t: number;
  duck: number;
  music: number;
  siren: boolean;
  /** VAD of the probed remote rider (false when absent). */
  remote: boolean;
  remoteDb: number | null;
  /** VAD of this rider's own mic. */
  self: boolean;
}

export interface MarkerSample {
  t: number;
  marker: MapMarkerDebug | null;
  /** Latest fix this page holds for the rider (store mirror). */
  fix: LocationFix | null;
}

export interface ProbeTypes {
  audio: { arg: string | null; sample: AudioSample };
  marker: { arg: string; sample: MarkerSample };
}
export type ProbeName = keyof ProbeTypes;

interface SamplerState {
  samples: unknown[];
  errors: string[];
  timer: number;
}

export interface E2EPage {
  spoken: string[];
  samplers: Record<string, SamplerState>;
  startSampler(key: string, probe: ProbeName, arg: unknown, intervalMs: number): void;
  stopSampler(key: string): void;
}

declare global {
  interface Window {
    __e2e?: E2EPage;
  }
}

export interface PageScriptOptions {
  settings: Partial<Settings> | null;
  recordSpeech: boolean;
}

export function installPageHelpers({ settings, recordSpeech }: PageScriptOptions): void {
  try {
    window.localStorage.setItem('intercom:debug', '1');
    if (settings && !window.localStorage.getItem('intercom:settings')) {
      window.localStorage.setItem('intercom:settings', JSON.stringify({ state: settings, version: 1 }));
    }
  } catch {
    /* storage disabled: debug hooks still on in dev builds */
  }

  const probes: Record<ProbeName, (arg: never) => unknown> = {
    audio: (remoteId: string | null) => {
      const audio = window.__intercom?.audio;
      if (!audio) throw new Error('window.__intercom.audio is not registered');
      const vad = audio.vad();
      const remote = remoteId ? vad[remoteId] : undefined;
      return {
        t: Date.now(),
        duck: audio.duckGain(),
        music: audio.musicGain(),
        siren: audio.sirenActive(),
        remote: remote?.speaking ?? false,
        remoteDb: remote?.levelDb ?? null,
        self: vad.self?.speaking ?? false,
      };
    },
    marker: (riderId: string) => {
      const g = window.__intercom;
      if (!g?.map) throw new Error('window.__intercom.map is not registered');
      const riders = (g.state().ride as { riders?: Record<string, { location: LocationFix | null }> }).riders;
      return { t: Date.now(), marker: g.map.markers()[riderId] ?? null, fix: riders?.[riderId]?.location ?? null };
    },
  };

  const e2e: E2EPage = {
    spoken: [],
    samplers: {},
    startSampler(key, probe, arg, intervalMs) {
      e2e.stopSampler(key);
      const state: SamplerState = { samples: [], errors: [], timer: 0 };
      const take = () => {
        try {
          state.samples.push(probes[probe](arg as never));
        } catch (err) {
          if (state.errors.length < 20) state.errors.push(String(err));
        }
      };
      take();
      state.timer = window.setInterval(take, intervalMs);
      e2e.samplers[key] = state;
    },
    stopSampler(key) {
      const s = e2e.samplers[key];
      if (s) window.clearInterval(s.timer);
    },
  };
  window.__e2e = e2e;

  if (recordSpeech && 'speechSynthesis' in window) {
    const synth = window.speechSynthesis;
    synth.speak = (utterance: SpeechSynthesisUtterance) => {
      e2e.spoken.push(utterance.text);
      window.setTimeout(() => {
        utterance.dispatchEvent(new Event('start'));
        utterance.dispatchEvent(new Event('end'));
      }, 0);
    };
  }
}
