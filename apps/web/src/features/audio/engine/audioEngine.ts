/**
 * AudioEngineApi implementation: one AudioContext for voices, music, chimes and the siren, plus
 * mic capture with VOX gating, per-stream voice activity detection and music ducking.
 * The node graph is in ./graph.ts; it is built on first use (normally inside unlock()).
 */
import type { MicMode, RiderId } from '@intercom/shared';
import { AUDIO_DEFAULTS } from '@intercom/shared';
import { registerDebug, type VadDebugEntry } from '../../../core/debug';
import type { AudioDevices, AudioEngineApi, AudioSettings, PlatformApi, Unsubscribe } from '../../../core/services';
import { useLocalStore, useRideStore, type AudioContextStateEx, type AudioInfo, type MicState } from '../../../core/store';
import { AlertSounds } from '../alerts/alertSounds';
import { DuckController } from '../duck/duckController';
import { MusicPlayer } from '../music/musicPlayer';
import { createMusicStorage, type MusicStorage } from '../music/storage';
import { buildGraph, glide, type AudioGraph } from './graph';
import { useMicMeter } from './meterStore';
import { MicCapture } from './micCapture';
import { RemoteVoice } from './remoteVoice';
import { createVadMonitor, loadVadWorklet, type VadMonitor, type VadState } from './vadMonitor';

export interface AudioEngineOptions {
  platform: PlatformApi;
  storage?: MusicStorage;
  createContext?: () => AudioContext;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
}

type VadBackend = VadMonitor['backend'];
/** AudioContext.setSinkId is not in TypeScript's DOM lib yet. */
type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: unknown };

const DEFAULT_SETTINGS: AudioSettings = {
  voiceVolume: AUDIO_DEFAULTS.voiceVolume,
  musicVolume: AUDIO_DEFAULTS.musicVolume,
  duckLevel: AUDIO_DEFAULTS.duckLevel,
  duckOnOwnVoice: true,
  vadSensitivity: AUDIO_DEFAULTS.vadSensitivity,
  riderVolumes: {},
  inputDeviceId: null,
  outputDeviceId: null,
};

/** ctx.resume() can stay pending forever without a gesture; don't hold callers hostage. */
const RESUME_TIMEOUT_MS = 1_500;
const WORKLET_TIMEOUT_MS = 5_000;
const MIC_LEVEL_PUBLISH_MS = 100;
/** Gain changes from settings glide over ~3 time constants. */
const SETTINGS_GLIDE_S = 0.04;

const clampGain = (v: number, max = 2) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 1);
const round1 = (v: number) => Math.round(v * 10) / 10;

function settle<T>(p: Promise<T>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    p.then(
      () => resolve(),
      (err: unknown) => {
        console.warn('[audio]', err);
        resolve();
      },
    ).finally(() => clearTimeout(timer));
  });
}

export class AudioEngine implements AudioEngineApi {
  readonly music: MusicPlayer;
  readonly alerts: AlertSounds;

  private ctx: AudioContext | null = null;
  private graph: AudioGraph | null = null;
  private backend: Promise<VadBackend> | null = null;
  private backendNow: VadBackend | null = null;
  private settings: AudioSettings = DEFAULT_SETTINGS;
  private micMode: MicMode = 'off';
  private readonly mic: MicCapture;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private ownVad: VadMonitor | null = null;
  private gateWired = false;
  private ownSpeaking = false;
  private selfId: RiderId | null;
  private outgoing: MediaStreamTrack | null = null;
  private readonly trackListeners = new Set<(track: MediaStreamTrack | null) => void>();
  private readonly remotes = new Map<RiderId, RemoteVoice>();
  private readonly duck: DuckController;
  private readonly musicElement: HTMLAudioElement;
  private modeQueue: Promise<void> = Promise.resolve();
  private lastLevelPublish = 0;
  private published: Partial<AudioInfo> = {};
  private readonly unsubscribe: Unsubscribe;

  constructor(private readonly opts: AudioEngineOptions) {
    this.musicElement = document.createElement('audio');
    this.music = new MusicPlayer({
      element: this.musicElement,
      storage: opts.storage ?? createMusicStorage(),
      prepare: () => {
        const { ctx } = this.ensureGraph();
        if (ctx.state !== 'running') void ctx.resume().catch(() => {});
      },
      onState: (s) => this.publish({ musicPlaying: s.playing, nowPlaying: s.nowPlaying, error: s.error }),
      mediaSession: typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null,
    });
    this.alerts = new AlertSounds({
      outputs: () => {
        const g = this.ensureGraph();
        return { ctx: g.ctx, fxBus: g.fxBus, alertBus: g.alertGain };
      },
      onSirenChange: (active) => this.publish({ sirenActive: active }),
    });
    this.duck = new DuckController({
      duckLevel: this.settings.duckLevel,
      apply: (ramp) => {
        if (this.graph) glide(this.graph.duck.gain, ramp.target, this.graph.ctx, ramp.timeConstantS);
      },
      onActiveChange: (active) => this.publish({ duckActive: active }),
    });
    this.mic = new MicCapture({
      onStream: (stream) => this.onMicStream(stream),
      onState: (state, error) => this.onMicState(state, error),
      getUserMedia: opts.getUserMedia,
    });

    this.selfId = useRideStore.getState().selfId;
    this.unsubscribe = useRideStore.subscribe((s) => this.onSelfId(s.selfId));
    this.registerDebug();
  }

  // ---- context ----------------------------------------------------------------------------------

  unlock(): Promise<void> {
    // Everything up to resume() must stay synchronous: iOS only unlocks inside the gesture.
    const { ctx } = this.ensureGraph();
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    this.alerts.unlockSpeech();
    return settle(resumed, RESUME_TIMEOUT_MS).then(() => this.publishContextState());
  }

  resume(): Promise<boolean> {
    const { ctx } = this.ensureGraph();
    const resumed = ctx.state === 'running' ? Promise.resolve() : ctx.resume();
    return settle(resumed, RESUME_TIMEOUT_MS).then(() => {
      this.publishContextState();
      return ctx.state === 'running';
    });
  }

  private ensureGraph(): AudioGraph {
    if (this.graph) return this.graph;
    const ctx = this.opts.createContext?.() ?? new AudioContext({ latencyHint: 'interactive' });
    const graph = buildGraph(ctx, this.musicElement, {
      voiceVolume: clampGain(this.settings.voiceVolume),
      musicVolume: clampGain(this.settings.musicVolume),
    });
    graph.duck.gain.value = this.duck.target;
    this.ctx = ctx;
    this.graph = graph;
    ctx.addEventListener('statechange', () => this.publishContextState());
    this.publishContextState();
    this.applySinkId();
    this.backend = loadVadWorklet(ctx).then((ok) => {
      const backend: VadBackend = ok ? 'worklet' : 'analyser';
      if (this.graph === graph) this.onBackendReady(graph, backend);
      return backend;
    });
    return graph;
  }

  private onBackendReady(graph: AudioGraph, backend: VadBackend): void {
    this.backendNow = backend;
    this.ownVad = createVadMonitor(graph.ctx, graph.micIn, graph.analysisSink, backend, {
      sensitivity: this.settings.vadSensitivity,
      onSpeaking: (s) => this.onOwnSpeaking(s),
      onLevels: (st) => this.onOwnLevels(st),
    });
    this.wireGate();
    for (const voice of this.remotes.values()) this.attachRemoteVad(voice);
  }

  private publishContextState(): void {
    this.publish({ contextState: (this.ctx?.state ?? 'none') as AudioContextStateEx });
  }

  // ---- mic --------------------------------------------------------------------------------------

  get outgoingTrack(): MediaStreamTrack | null {
    return this.outgoing;
  }

  onOutgoingTrackChange(cb: (track: MediaStreamTrack | null) => void): Unsubscribe {
    this.trackListeners.add(cb);
    return () => this.trackListeners.delete(cb);
  }

  setMicMode(mode: MicMode): Promise<void> {
    const run = this.modeQueue.then(() => this.applyMicMode(mode));
    this.modeQueue = run.catch(() => {});
    return run;
  }

  private async applyMicMode(mode: MicMode): Promise<void> {
    this.micMode = mode;
    if (mode === 'off') {
      this.mic.stop();
      this.opts.platform.audioSession.setMode('playback');
      this.wireGate();
      this.onOwnSpeaking(false);
      this.setOutgoing(null);
      return;
    }
    const graph = this.ensureGraph();
    if (this.backend) await settle(this.backend, WORKLET_TIMEOUT_MS);
    this.wireGate();
    this.opts.platform.audioSession.setMode('play-and-record');
    await this.mic.start(this.settings.inputDeviceId);
    if (this.micMode !== mode || this.graph !== graph) return;
    if (this.mic.live) {
      this.setOutgoing(this.liveOutgoingTrack(graph));
    } else {
      this.opts.platform.audioSession.setMode('playback');
    }
  }

  /** The VOX gate follows the mode: envelope-driven (vox), fully open, or shut. */
  private wireGate(): void {
    const g = this.graph;
    if (!g) return;
    const envelope = this.ownVad?.gateOutput ?? null;
    const useEnvelope = this.micMode === 'vox' && envelope !== null;
    if (useEnvelope && !this.gateWired) envelope.connect(g.voxGate.gain);
    if (!useEnvelope && this.gateWired && envelope) envelope.disconnect(g.voxGate.gain);
    this.gateWired = useEnvelope;
    // With the envelope wired in, the param's own value is the floor it adds to: keep it at 0.
    const base = this.micMode === 'open' ? 1 : this.micMode === 'vox' && !envelope && this.ownSpeaking ? 1 : 0;
    glide(g.voxGate.gain, base, g.ctx, 0.005);
  }

  private liveOutgoingTrack(graph: AudioGraph): MediaStreamTrack {
    let track = graph.micOut.stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') {
      // Someone stopped our track (a transport unpublishing with stop=true): make a new one.
      graph.voxGate.disconnect(graph.micOut);
      const micOut = graph.ctx.createMediaStreamDestination();
      micOut.channelCount = 1;
      micOut.channelCountMode = 'explicit';
      graph.voxGate.connect(micOut);
      graph.micOut = micOut;
      track = micOut.stream.getAudioTracks()[0]!;
    }
    return track;
  }

  private setOutgoing(track: MediaStreamTrack | null): void {
    if (track === this.outgoing) return;
    this.outgoing = track;
    for (const cb of [...this.trackListeners]) {
      try {
        cb(track);
      } catch (err) {
        console.error('[audio] outgoing track listener failed', err);
      }
    }
  }

  private onMicStream(stream: MediaStream | null): void {
    this.micSource?.disconnect();
    this.micSource = null;
    const g = this.graph;
    if (stream && g) {
      this.micSource = g.ctx.createMediaStreamSource(stream);
      this.micSource.connect(g.micIn);
    }
  }

  private onMicState(state: MicState, error: string | null): void {
    this.publish({ micState: state, ...(state === 'live' ? {} : { micLevelDb: null }) });
    useMicMeter.setState(state === 'live' ? { error: null } : { error, levelDb: null, onDb: null, floorDb: null, speaking: false });
  }

  private onOwnSpeaking(speaking: boolean): void {
    const g = this.graph;
    // Fallback backend: no audio-rate envelope, so gate from here (the lookahead delay covers us).
    if (g && this.backendNow === 'analyser' && this.micMode === 'vox') {
      glide(g.voxGate.gain, speaking ? 1 : 0, g.ctx, speaking ? 0.002 : 0.02);
    }
    const next = speaking && this.micMode !== 'off';
    if (next === this.ownSpeaking) return;
    this.ownSpeaking = next;
    if (this.selfId) useLocalStore.getState().setSpeaking(this.selfId, next);
    useMicMeter.setState({ speaking: next });
    this.updateDuck();
  }

  private onOwnLevels(st: Readonly<VadState>): void {
    if (this.micMode === 'off' || !this.mic.live) return;
    useMicMeter.setState({ levelDb: st.levelDb, onDb: st.onDb, floorDb: st.floorDb });
    const now = performance.now();
    if (now - this.lastLevelPublish < MIC_LEVEL_PUBLISH_MS - 10) return;
    this.lastLevelPublish = now;
    this.publish({ micLevelDb: round1(st.levelDb) });
  }

  private onSelfId(id: RiderId | null): void {
    if (id === this.selfId) return;
    const local = useLocalStore.getState();
    if (this.selfId) local.clearSpeaking(this.selfId);
    this.selfId = id;
    if (id) local.setSpeaking(id, this.ownSpeaking);
  }

  // ---- remote voices ----------------------------------------------------------------------------

  addRemoteTrack(riderId: RiderId, track: MediaStreamTrack): void {
    const existing = this.remotes.get(riderId);
    if (existing?.track === track) return;
    if (existing) this.removeRemoteTrack(riderId);
    const graph = this.ensureGraph();
    const voice = new RemoteVoice(graph, riderId, track, clampGain(this.settings.riderVolumes[riderId] ?? 1));
    this.remotes.set(riderId, voice);
    track.addEventListener('ended', () => {
      if (this.remotes.get(riderId) === voice) this.removeRemoteTrack(riderId);
    });
    if (this.backendNow) this.attachRemoteVad(voice);
  }

  removeRemoteTrack(riderId: RiderId): void {
    const voice = this.remotes.get(riderId);
    if (!voice) return;
    this.remotes.delete(riderId);
    voice.dispose();
    useLocalStore.getState().clearSpeaking(riderId);
    this.updateDuck();
  }

  private attachRemoteVad(voice: RemoteVoice): void {
    voice.attachVad(this.backendNow!, this.settings.vadSensitivity, (speaking) => {
      if (this.remotes.get(voice.riderId) !== voice) return;
      useLocalStore.getState().setSpeaking(voice.riderId, speaking);
      this.updateDuck();
    });
  }

  private updateDuck(): void {
    let speech = this.settings.duckOnOwnVoice && this.ownSpeaking;
    for (const v of this.remotes.values()) speech ||= v.speaking;
    this.duck.setSpeech(speech);
  }

  // ---- settings, SOS, devices -------------------------------------------------------------------

  applySettings(s: AudioSettings): void {
    const prev = this.settings;
    this.settings = { ...s, riderVolumes: { ...s.riderVolumes } };
    this.duck.setDuckLevel(s.duckLevel);
    if (prev.duckOnOwnVoice !== s.duckOnOwnVoice) this.updateDuck();
    const g = this.graph;
    if (g) {
      glide(g.voiceVolume.gain, clampGain(s.voiceVolume), g.ctx, SETTINGS_GLIDE_S);
      glide(g.musicVolume.gain, clampGain(s.musicVolume), g.ctx, SETTINGS_GLIDE_S);
    }
    for (const [id, voice] of this.remotes) {
      const next = clampGain(s.riderVolumes[id] ?? 1);
      if (next !== clampGain(prev.riderVolumes[id] ?? 1)) voice.setVolume(next);
    }
    if (prev.vadSensitivity !== s.vadSensitivity) {
      this.ownVad?.setSensitivity(s.vadSensitivity);
      for (const voice of this.remotes.values()) voice.setSensitivity(s.vadSensitivity);
    }
    if (prev.inputDeviceId !== s.inputDeviceId && this.micMode !== 'off') void this.setMicMode(this.micMode);
    if (prev.outputDeviceId !== s.outputDeviceId) this.applySinkId();
  }

  setSosMode(active: boolean): void {
    this.duck.setSos(active);
  }

  async listDevices(): Promise<AudioDevices> {
    const devices = (await navigator.mediaDevices?.enumerateDevices?.().catch(() => [])) ?? [];
    return {
      inputs: devices.filter((d) => d.kind === 'audioinput'),
      outputs: devices.filter((d) => d.kind === 'audiooutput'),
      canSelectOutput: typeof AudioContext !== 'undefined' && typeof (AudioContext.prototype as SinkContext).setSinkId === 'function',
    };
  }

  private applySinkId(): void {
    const ctx = this.ctx as SinkContext | null;
    if (!ctx?.setSinkId) return;
    const id = this.settings.outputDeviceId ?? '';
    if ((typeof ctx.sinkId === 'string' ? ctx.sinkId : '') === id) return;
    ctx.setSinkId(id).catch((err: unknown) => console.warn('[audio] could not switch output device', err));
  }

  async dispose(): Promise<void> {
    this.unsubscribe();
    await this.setMicMode('off');
    for (const id of [...this.remotes.keys()]) this.removeRemoteTrack(id);
    this.alerts.dispose();
    this.music.dispose();
    this.duck.dispose();
    this.ownVad?.dispose();
    this.ownVad = null;
    const ctx = this.ctx;
    this.graph = null;
    this.ctx = null;
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
    this.publish({ contextState: 'closed' });
  }

  // ---- store + debug ----------------------------------------------------------------------------

  /** The live node graph, for the dev harness's signal taps. Not part of AudioEngineApi. */
  get debugGraph(): Readonly<AudioGraph> | null {
    return this.graph;
  }

  /** Which VAD implementation is running (null until the worklet module has loaded or failed). */
  get vadBackend(): VadBackend | null {
    return this.backendNow;
  }

  private publish(patch: Partial<AudioInfo>): void {
    const changed: Partial<AudioInfo> = {};
    let any = false;
    for (const [k, v] of Object.entries(patch) as [keyof AudioInfo, AudioInfo[keyof AudioInfo]][]) {
      if (this.published[k] === v && k in this.published) continue;
      (changed as Record<string, unknown>)[k] = v;
      any = true;
    }
    if (!any) return;
    Object.assign(this.published, changed);
    useLocalStore.getState().setAudio(changed);
  }

  private registerDebug(): void {
    const entry = (st: Readonly<VadState>): VadDebugEntry => ({ speaking: st.speaking, levelDb: st.levelDb, floorDb: st.floorDb });
    registerDebug('audio', {
      contextState: () => this.ctx?.state ?? 'none',
      duckGain: () => this.graph?.duck.gain.value ?? 1,
      musicGain: () => (this.graph ? this.graph.musicVolume.gain.value * this.graph.duck.gain.value : 0),
      alertGain: () => this.graph?.alertGain.gain.value ?? 0,
      sirenActive: () => this.alerts.sirenActive,
      vad: () => {
        const out: Record<string, VadDebugEntry> = {};
        if (this.ownVad && this.micMode !== 'off') out.self = entry(this.ownVad.state);
        for (const [id, voice] of this.remotes) {
          const st = voice.vadState;
          if (st) out[id] = entry(st);
        }
        return out;
      },
      remoteRiders: () => [...this.remotes.keys()],
      voxGate: () => {
        const g = this.graph;
        if (!g || this.micMode === 'off' || !this.mic.live) return 0;
        if (this.micMode === 'vox' && this.backendNow === 'worklet') return this.ownVad?.state.gate ?? 0;
        return g.voxGate.gain.value;
      },
      outgoingTrackState: () => (!this.outgoing ? 'none' : this.outgoing.readyState === 'live' ? 'live' : 'ended'),
      musicState: () => ({
        playing: !this.musicElement.paused,
        trackId: this.music.currentTrackId,
        currentTime: this.musicElement.currentTime,
      }),
    });
  }
}
