/**
 * VoiceManagerApi: owns one transport at a time, feeds remote tracks to the audio engine, follows
 * the engine's outgoing mic track, and publishes useLocalStore.voice.
 */
import type { LiveKitJoinInfo, RiderId, VoiceDataMessage, VoiceJoinInfo } from '@intercom/shared';
import { registerDebug } from '../../core/debug';
import type { AudioEngineApi, LiveKitTokenFetcher, Unsubscribe, VoiceManagerApi, VoiceStats } from '../../core/services';
import type { AppSocket } from '../../core/socket';
import { useLocalStore } from '../../core/store';
import { LiveKitTransport } from './livekit/livekitTransport';
import { MeshTransport, type RiderSource } from './mesh/meshTransport';
import { bufferedSignaling, socketSignaling, type SignalingChannel } from './mesh/signaling';
import type { TransportCallbacks, VoiceTransport } from './transport';

export interface VoiceManagerOptions {
  socket: AppSocket;
  audio: AudioEngineApi;
  /** Mesh signaling; defaults to `rtc:signal` over the socket. */
  signaling?: SignalingChannel;
  /** Mesh peer list; defaults to useRideStore. */
  riders?: RiderSource;
  /** Fresh LiveKit credentials; defaults to `voice:token` over the socket. */
  fetchToken?: LiveKitTokenFetcher;
  /** Override transport construction (tests). */
  createTransport?: (info: VoiceJoinInfo, selfId: RiderId, callbacks: TransportCallbacks) => VoiceTransport;
}

const EMPTY_STATS: VoiceStats = { transport: null, bytesSent: 0, peers: {} };

export class VoiceManager implements VoiceManagerApi {
  private transport: VoiceTransport | null = null;
  private selfId: RiderId | null = null;
  private readonly dataListeners = new Set<(from: RiderId, msg: VoiceDataMessage) => void>();
  /** Riders whose audio we handed to the engine. */
  private readonly fed = new Set<RiderId>();
  private readonly offTrack: Unsubscribe;
  /** start/update/stop run one at a time. */
  private queue: Promise<void> = Promise.resolve();
  /** Buffered for the manager's lifetime, so offers sent while we switch transports aren't lost. */
  private readonly signaling: SignalingChannel & { close(): void };

  constructor(private readonly opts: VoiceManagerOptions) {
    this.signaling = bufferedSignaling(opts.signaling ?? socketSignaling(opts.socket));
    this.offTrack = opts.audio.onOutgoingTrackChange((track) => {
      void this.transport?.setOutgoingTrack(track).catch(warn);
    });
    registerDebug('voice', {
      transport: () => this.transport?.mode ?? null,
      stats: () => this.getStats(),
    });
  }

  start(info: VoiceJoinInfo, selfId: RiderId): Promise<void> {
    return this.serial(async () => {
      await this.teardown();
      this.selfId = selfId;
      await this.launch(info);
    });
  }

  update(info: VoiceJoinInfo): Promise<void> {
    return this.serial(async () => {
      if (!this.selfId) return;
      if (this.transport && this.transport.mode === info.mode) {
        await this.transport.update(info);
        return;
      }
      await this.teardown();
      await this.launch(info);
    });
  }

  stop(): Promise<void> {
    return this.serial(async () => {
      await this.teardown();
      this.selfId = null;
    });
  }

  sendData(msg: VoiceDataMessage): void {
    this.transport?.sendData(msg);
  }

  onData(cb: (from: RiderId, msg: VoiceDataMessage) => void): Unsubscribe {
    this.dataListeners.add(cb);
    return () => this.dataListeners.delete(cb);
  }

  async getStats(): Promise<VoiceStats> {
    return (await this.transport?.getStats().catch(() => null)) ?? EMPTY_STATS;
  }

  /** For tests and teardown of the whole app. */
  dispose(): Promise<void> {
    this.offTrack();
    this.signaling.close();
    return this.stop();
  }

  private serial(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => {});
    return run;
  }

  private async launch(info: VoiceJoinInfo): Promise<void> {
    const selfId = this.selfId!;
    const callbacks = this.callbacksFor(() => this.transport === transport);
    const transport = this.opts.createTransport?.(info, selfId, callbacks) ?? this.createTransport(info, selfId, callbacks);
    this.transport = transport;
    useLocalStore.getState().setVoice({ state: 'connecting', transport: transport.mode, peers: {}, error: null });
    await transport.setOutgoingTrack(this.opts.audio.outgoingTrack);
    try {
      await transport.start();
    } finally {
      // Covers a track that changed while we were connecting.
      if (this.transport === transport) await transport.setOutgoingTrack(this.opts.audio.outgoingTrack).catch(warn);
    }
  }

  private createTransport(info: VoiceJoinInfo, selfId: RiderId, callbacks: TransportCallbacks): VoiceTransport {
    if (info.mode === 'livekit') {
      if (!info.livekit) throw new Error('LiveKit voice was selected but no LiveKit credentials were provided');
      return new LiveKitTransport({ join: info.livekit, callbacks, fetchToken: this.opts.fetchToken ?? this.socketTokenFetcher() });
    }
    return new MeshTransport({ selfId, info, signaling: this.signaling, callbacks, riders: this.opts.riders });
  }

  private callbacksFor(current: () => boolean): TransportCallbacks {
    const local = () => useLocalStore.getState();
    const { audio } = this.opts;
    return {
      onState: (state, error) => current() && local().setVoice({ state, ...(error !== undefined ? { error } : state === 'connected' ? { error: null } : {}) }),
      onPeerState: (id, state) => current() && local().setPeer(id, state),
      onRemoteTrack: (id, track) => {
        if (!current()) return;
        if (track) {
          this.fed.add(id);
          audio.addRemoteTrack(id, track);
        } else if (this.fed.delete(id)) {
          audio.removeRemoteTrack(id);
        }
      },
      onData: (from, msg) => {
        if (!current()) return;
        for (const cb of [...this.dataListeners]) {
          try {
            cb(from, msg);
          } catch (err) {
            console.error('[voice] data listener failed', err);
          }
        }
      },
    };
  }

  private async teardown(): Promise<void> {
    const transport = this.transport;
    this.transport = null;
    if (transport) await transport.stop().catch(warn);
    for (const id of this.fed) this.opts.audio.removeRemoteTrack(id);
    this.fed.clear();
    useLocalStore.getState().setVoice({ state: 'off', transport: null, peers: {}, error: null });
  }

  private socketTokenFetcher(): LiveKitTokenFetcher {
    const { socket } = this.opts;
    return async (): Promise<LiveKitJoinInfo | null> => {
      if (!socket.connected) return null;
      const res = await socket.timeout(5_000).emitWithAck('voice:token', {});
      return res.ok ? res.livekit : null;
    };
  }
}

function warn(err: unknown): void {
  console.warn('[voice]', err);
}
