/**
 * App state, split three ways:
 *  - useRideStore:  mirror of server ride state (riders, route, SOS, breaks). Written by the ride controller.
 *  - useLocalStore: this device's runtime state (GPS, audio, voice, UI). Written by the service that owns
 *                   each slice (location service -> gps/selfFix, audio engine -> audio/speaking,
 *                   voice manager -> voice, UI -> ui).
 *  - useSettings:   user preferences, persisted to localStorage.
 * Services outside React use `useXStore.getState()` / `.subscribe()`; components use the hooks.
 */
import type {
  BreakAlert,
  LocationFix,
  MicMode,
  RideRoute,
  RideSnapshot,
  RiderId,
  RiderState,
  SosAlert,
  VoiceMode,
} from '@intercom/shared';
import { AUDIO_DEFAULTS, LIMITS, RIDER_COLORS, uuid } from '@intercom/shared';
import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline';
export type GpsStatus = 'off' | 'starting' | 'active' | 'denied' | 'unavailable' | 'error';
export type VoiceState = 'off' | 'connecting' | 'connected' | 'reconnecting' | 'failed';
export type PeerState = 'connecting' | 'connected' | 'failed';
export type MicState = 'off' | 'requesting' | 'live' | 'denied' | 'error';
export type AudioContextStateEx = 'none' | 'suspended' | 'running' | 'interrupted' | 'closed';
export type CameraMode = 'follow' | 'group' | 'free';
export type SheetId = 'music' | 'riders' | 'route' | 'settings' | 'share' | 'break';
export type Units = 'metric' | 'imperial';
export type MapTheme = 'auto' | 'day' | 'night';

// ---- ride (server mirror) -----------------------------------------------------------------

export interface RideInfo {
  code: string;
  leaderId: RiderId;
  voiceMode: VoiceMode;
  createdAt: number;
  maxRiders: number;
}

export interface TrackedSos extends SosAlert {
  /**
   * 'server': confirmed by the server. 'p2p': only seen on the voice data channel so far.
   * 'local': our own SOS, still waiting for the server's ack.
   */
  source: 'server' | 'p2p' | 'local';
}

interface RideState {
  connection: ConnectionState;
  /** serverNow - Date.now(); add to Date.now() to get server time. */
  clockOffsetMs: number;
  ride: RideInfo | null;
  selfId: RiderId | null;
  riders: Record<RiderId, RiderState>;
  route: RideRoute | null;
  /** Active SOS alerts by id. */
  sos: Record<string, TrackedSos>;
  /** Newest first, capped at LIMITS.recentBreaksKept. */
  breaks: BreakAlert[];
}

interface RideActions {
  setConnection(c: ConnectionState): void;
  setClockOffset(ms: number): void;
  /** Replaces server-owned state. Keeps 'local' and 'p2p' SOS entries the snapshot doesn't know yet. */
  applySnapshot(snapshot: RideSnapshot, selfId: RiderId): void;
  upsertRider(r: RiderState): void;
  removeRider(id: RiderId): void;
  /** Ignores unknown riders and fixes older than the one we have. */
  setRiderLocation(id: RiderId, fix: LocationFix, serverReceivedAt: number): void;
  setLeader(id: RiderId): void;
  setVoiceMode(mode: VoiceMode): void;
  setRoute(route: RideRoute | null): void;
  upsertSos(sos: SosAlert, source: TrackedSos['source']): void;
  removeSos(id: string): void;
  addBreak(b: BreakAlert): void;
  reset(): void;
}

const initialRide: RideState = {
  connection: 'idle',
  clockOffsetMs: 0,
  ride: null,
  selfId: null,
  riders: {},
  route: null,
  sos: {},
  breaks: [],
};

export const useRideStore = create<RideState & RideActions>()((set) => ({
  ...initialRide,
  setConnection: (connection) => set({ connection }),
  setClockOffset: (clockOffsetMs) => set({ clockOffsetMs }),
  applySnapshot: (s, selfId) =>
    set((st) => {
      const sos: Record<string, TrackedSos> = {};
      for (const [id, entry] of Object.entries(st.sos)) {
        if (entry.source !== 'server') sos[id] = entry;
      }
      for (const a of s.activeSos) sos[a.id] = { ...a, source: 'server' };
      return {
        ride: {
          code: s.code,
          leaderId: s.leaderId,
          voiceMode: s.voiceMode,
          createdAt: s.createdAt,
          maxRiders: s.maxRiders,
        },
        selfId,
        riders: Object.fromEntries(s.riders.map((r) => [r.id, r])),
        route: s.route,
        sos,
        breaks: s.recentBreaks.slice(0, LIMITS.recentBreaksKept),
      };
    }),
  upsertRider: (r) => set((st) => ({ riders: { ...st.riders, [r.id]: r } })),
  removeRider: (id) =>
    set((st) => {
      if (!st.riders[id]) return st;
      const riders = { ...st.riders };
      delete riders[id];
      return { riders };
    }),
  setRiderLocation: (id, fix, serverReceivedAt) =>
    set((st) => {
      const r = st.riders[id];
      if (!r) return st;
      if (r.location && fix.t <= r.location.t) return st;
      return {
        riders: {
          ...st.riders,
          [id]: { ...r, location: fix, locationAt: serverReceivedAt, lastSeenAt: serverReceivedAt },
        },
      };
    }),
  setLeader: (leaderId) =>
    set((st) => {
      if (!st.ride) return st;
      const riders: Record<RiderId, RiderState> = {};
      for (const [id, r] of Object.entries(st.riders)) {
        const role = id === leaderId ? 'leader' : 'rider';
        riders[id] = r.role === role ? r : { ...r, role };
      }
      return { ride: { ...st.ride, leaderId }, riders };
    }),
  setVoiceMode: (voiceMode) => set((st) => (st.ride ? { ride: { ...st.ride, voiceMode } } : st)),
  setRoute: (route) => set({ route }),
  upsertSos: (sos, source) =>
    set((st) => {
      const prev = st.sos[sos.id];
      // A server-confirmed entry never downgrades back to p2p/local.
      const nextSource = prev?.source === 'server' ? 'server' : source;
      return { sos: { ...st.sos, [sos.id]: { ...sos, source: nextSource } } };
    }),
  removeSos: (id) =>
    set((st) => {
      if (!st.sos[id]) return st;
      const sos = { ...st.sos };
      delete sos[id];
      return { sos };
    }),
  addBreak: (b) =>
    set((st) => {
      if (st.breaks.some((x) => x.id === b.id)) return st;
      return { breaks: [b, ...st.breaks].slice(0, LIMITS.recentBreaksKept) };
    }),
  reset: () => set({ ...initialRide }),
}));

// ---- local (this device) ------------------------------------------------------------------

export interface Toast {
  id: string;
  kind: 'info' | 'success' | 'warning' | 'error' | 'break' | 'sos';
  title: string;
  body?: string;
  riderId?: RiderId;
  createdAt: number;
  /** Auto-dismiss after this many ms; 0 keeps it until dismissed. */
  ttlMs: number;
}

export interface GpsInfo {
  status: GpsStatus;
  accuracyM: number | null;
  /** Date.now() of the last accepted fix. */
  lastFixAt: number | null;
  error: string | null;
}

export interface VoiceInfo {
  state: VoiceState;
  transport: VoiceMode | null;
  /** Per remote rider transport state (mesh: peer connection; LiveKit: subscription). */
  peers: Record<RiderId, PeerState>;
  error: string | null;
}

export interface AudioInfo {
  contextState: AudioContextStateEx;
  micState: MicState;
  /** Mic level in dBFS for meters, null when the mic is off. */
  micLevelDb: number | null;
  musicPlaying: boolean;
  nowPlaying: { id: string; title: string } | null;
  /** True while music is ducked for speech. */
  duckActive: boolean;
  sirenActive: boolean;
  error: string | null;
}

export interface UiInfo {
  cameraMode: CameraMode;
  /** Ask the map to fly to a rider (e.g. the one who raised SOS). `at` makes repeat requests distinct. */
  focus: { riderId: RiderId; at: number } | null;
  sheet: SheetId | null;
  toasts: Toast[];
  /** SOS ids this device has silenced. */
  acknowledgedSos: Record<string, true>;
  /** This rider id was opened on another tab/device; this one is now inert. */
  sessionReplaced: boolean;
}

interface LocalState {
  selfFix: LocationFix | null;
  gps: GpsInfo;
  /** Voice activity per rider, including selfId. */
  speaking: Record<RiderId, boolean>;
  voice: VoiceInfo;
  audio: AudioInfo;
  ui: UiInfo;
}

interface LocalActions {
  setSelfFix(fix: LocationFix | null): void;
  setGps(p: Partial<GpsInfo>): void;
  setSpeaking(id: RiderId, speaking: boolean): void;
  clearSpeaking(id: RiderId): void;
  setVoice(p: Partial<VoiceInfo>): void;
  setPeer(id: RiderId, state: PeerState | null): void;
  setAudio(p: Partial<AudioInfo>): void;
  setCameraMode(m: CameraMode): void;
  focusRider(id: RiderId | null): void;
  openSheet(id: SheetId | null): void;
  /** Returns the toast id. */
  pushToast(t: Omit<Toast, 'id' | 'createdAt' | 'ttlMs'> & { id?: string; ttlMs?: number }): string;
  dismissToast(id: string): void;
  acknowledgeSos(id: string): void;
  setSessionReplaced(v: boolean): void;
  reset(): void;
}

const initialLocal: LocalState = {
  selfFix: null,
  gps: { status: 'off', accuracyM: null, lastFixAt: null, error: null },
  speaking: {},
  voice: { state: 'off', transport: null, peers: {}, error: null },
  audio: {
    contextState: 'none',
    micState: 'off',
    micLevelDb: null,
    musicPlaying: false,
    nowPlaying: null,
    duckActive: false,
    sirenActive: false,
    error: null,
  },
  ui: { cameraMode: 'follow', focus: null, sheet: null, toasts: [], acknowledgedSos: {}, sessionReplaced: false },
};

const MAX_TOASTS = 4;

export const useLocalStore = create<LocalState & LocalActions>()((set) => ({
  ...initialLocal,
  setSelfFix: (selfFix) => set({ selfFix }),
  setGps: (p) => set((st) => ({ gps: { ...st.gps, ...p } })),
  setSpeaking: (id, speaking) =>
    set((st) => (st.speaking[id] === speaking ? st : { speaking: { ...st.speaking, [id]: speaking } })),
  clearSpeaking: (id) =>
    set((st) => {
      if (!(id in st.speaking)) return st;
      const speaking = { ...st.speaking };
      delete speaking[id];
      return { speaking };
    }),
  setVoice: (p) => set((st) => ({ voice: { ...st.voice, ...p } })),
  setPeer: (id, state) =>
    set((st) => {
      const peers = { ...st.voice.peers };
      if (state === null) delete peers[id];
      else peers[id] = state;
      return { voice: { ...st.voice, peers } };
    }),
  setAudio: (p) => set((st) => ({ audio: { ...st.audio, ...p } })),
  setCameraMode: (cameraMode) => set((st) => ({ ui: { ...st.ui, cameraMode } })),
  focusRider: (id) => set((st) => ({ ui: { ...st.ui, focus: id ? { riderId: id, at: Date.now() } : null } })),
  openSheet: (sheet) => set((st) => ({ ui: { ...st.ui, sheet } })),
  pushToast: (t) => {
    const toast: Toast = { ttlMs: 6_000, ...t, id: t.id ?? uuid(), createdAt: Date.now() };
    set((st) => ({
      ui: { ...st.ui, toasts: [...st.ui.toasts.filter((x) => x.id !== toast.id), toast].slice(-MAX_TOASTS) },
    }));
    return toast.id;
  },
  dismissToast: (id) => set((st) => ({ ui: { ...st.ui, toasts: st.ui.toasts.filter((x) => x.id !== id) } })),
  acknowledgeSos: (id) =>
    set((st) => ({ ui: { ...st.ui, acknowledgedSos: { ...st.ui.acknowledgedSos, [id]: true } } })),
  setSessionReplaced: (sessionReplaced) => set((st) => ({ ui: { ...st.ui, sessionReplaced } })),
  reset: () => set({ ...initialLocal }),
}));

// ---- settings (persisted) -------------------------------------------------------------------

export interface Settings {
  name: string;
  color: string;
  units: Units;
  micMode: MicMode;
  /** The mode the Mic button restores when unmuting (last non-off mode). */
  liveMicMode: Exclude<MicMode, 'off'>;
  /** 0..1, see AUDIO_DEFAULTS.vadSensitivity. */
  vadSensitivity: number;
  /** Music gain while someone talks, 0..1. */
  duckLevel: number;
  /** Duck music when I talk, not only when others do. */
  duckOnOwnVoice: boolean;
  voiceVolume: number;
  musicVolume: number;
  riderVolumes: Record<RiderId, number>;
  /** Speak alerts aloud (text-to-speech) through the helmet. */
  announce: boolean;
  headingUp: boolean;
  mapTheme: MapTheme;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
}

interface SettingsActions {
  update(p: Partial<Settings>): void;
  setRiderVolume(id: RiderId, volume: number): void;
}

function defaultUnits(): Units {
  const lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return /^(en-US|en-LR|my)/i.test(lang) ? 'imperial' : 'metric';
}

export const DEFAULT_SETTINGS: Settings = {
  name: '',
  color: RIDER_COLORS[Math.floor(Math.random() * RIDER_COLORS.length)]!,
  units: defaultUnits(),
  micMode: 'vox',
  liveMicMode: 'vox',
  vadSensitivity: AUDIO_DEFAULTS.vadSensitivity,
  duckLevel: AUDIO_DEFAULTS.duckLevel,
  duckOnOwnVoice: true,
  voiceVolume: AUDIO_DEFAULTS.voiceVolume,
  musicVolume: AUDIO_DEFAULTS.musicVolume,
  riderVolumes: {},
  announce: true,
  headingUp: false,
  mapTheme: 'auto',
  inputDeviceId: null,
  outputDeviceId: null,
};

/** localStorage that never throws (private mode, quota, disabled storage). */
const safeStorage: StateStorage = {
  getItem: (k) => {
    try {
      return window.localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      window.localStorage.setItem(k, v);
    } catch {
      /* settings just won't persist */
    }
  },
  removeItem: (k) => {
    try {
      window.localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

export const useSettings = create<Settings & SettingsActions>()(
  persist(
    (set) => ({
      ...DEFAULT_SETTINGS,
      update: (p) => set(p),
      setRiderVolume: (id, volume) => set((st) => ({ riderVolumes: { ...st.riderVolumes, [id]: volume } })),
    }),
    {
      name: 'intercom:settings',
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      partialize: ({ update: _u, setRiderVolume: _s, ...rest }) => rest,
    },
  ),
);

/** Plain-data snapshot of all stores (for debug hooks and tests). */
export function snapshotState() {
  const strip = <T extends object>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v !== 'function'));
  return {
    ride: strip(useRideStore.getState()),
    local: strip(useLocalStore.getState()),
    settings: strip(useSettings.getState()),
  };
}
