/**
 * Peer-to-peer voice: one PeerLink per online remote rider, kept in step with the ride store
 * (joins, leaves, online/offline). Signaling goes through a SignalingChannel.
 */
import type { RiderId, RtcSignalData, VoiceDataMessage, VoiceJoinInfo } from '@intercom/shared';
import type { PeerStats, Unsubscribe, VoiceStats } from '../../../core/services';
import { useRideStore } from '../../../core/store';
import type { TransportCallbacks, VoiceTransport } from '../transport';
import { CONNECT_TIMEOUT_MS, OFFER_TIMEOUT_MS, PeerLink, type PeerLinkOptions } from './peerLink';
import type { SignalingChannel } from './signaling';

/** Who is in the ride. Defaults to useRideStore; tests pass their own. */
export interface RiderSource {
  get(): Record<RiderId, { online: boolean }>;
  subscribe(cb: () => void): Unsubscribe;
}

export const rideStoreRiders: RiderSource = {
  get: () => useRideStore.getState().riders,
  subscribe: (cb) => useRideStore.subscribe((s, prev) => s.riders !== prev.riders && cb()),
};

export interface MeshTransportOptions {
  selfId: RiderId;
  info: VoiceJoinInfo;
  signaling: SignalingChannel;
  callbacks: TransportCallbacks;
  riders?: RiderSource;
  /** Overrides for tests (fake RTCPeerConnection, faster timers). */
  link?: Partial<
    Pick<PeerLinkOptions, 'createPeerConnection' | 'disconnectedRestartMs' | 'failedRecreateMs' | 'offerTimeoutMs' | 'connectTimeoutMs'>
  >;
}

/** Each consecutive restart of a peer's connection waits twice as long (answer, connection), up to this. */
const MAX_RESTART_WAIT_MS = 60_000;

export class MeshTransport implements VoiceTransport {
  readonly mode = 'mesh' as const;
  private readonly links = new Map<RiderId, PeerLink>();
  /** Signals for one peer are handled strictly in order. */
  private readonly queues = new Map<RiderId, Promise<void>>();
  /** Restarts per peer since it was last connected (backs off the offer timeout). */
  private readonly restarts = new Map<RiderId, number>();
  private iceServers: RTCIceServer[];
  private track: MediaStreamTrack | null = null;
  private readonly riders: RiderSource;
  private unsubscribers: Unsubscribe[] = [];
  private running = false;

  constructor(private readonly opts: MeshTransportOptions) {
    this.iceServers = opts.info.iceServers as RTCIceServer[];
    this.riders = opts.riders ?? rideStoreRiders;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const { signaling } = this.opts;
    this.unsubscribers = [
      signaling.onSignal((from, data) => this.enqueue(from, data)),
      signaling.onReconnect?.(() => this.recreateFailed()) ?? (() => {}),
      this.riders.subscribe(() => this.reconcile()),
    ];
    this.opts.callbacks.onState('connected');
    this.reconcile();
  }

  async update(info: VoiceJoinInfo): Promise<void> {
    const next = info.iceServers as RTCIceServer[];
    if (JSON.stringify(next) === JSON.stringify(this.iceServers)) return;
    this.iceServers = next;
    for (const link of this.links.values()) link.setIceServers(next);
  }

  async setOutgoingTrack(track: MediaStreamTrack | null): Promise<void> {
    this.track = track;
    for (const link of this.links.values()) link.setTrack(track);
  }

  sendData(msg: VoiceDataMessage): void {
    for (const link of this.links.values()) link.sendData(msg);
  }

  async getStats(): Promise<VoiceStats> {
    const peers: Record<RiderId, PeerStats> = {};
    let bytesSent = 0;
    await Promise.all(
      [...this.links].map(async ([id, link]) => {
        const s = await link.getStats().catch(() => null);
        if (!s) return;
        peers[id] = s.peer;
        bytesSent += s.bytesSent;
      }),
    );
    return { transport: 'mesh', bytesSent, peers };
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
    for (const id of [...this.links.keys()]) this.drop(id);
    this.queues.clear();
    this.restarts.clear();
    this.opts.callbacks.onState('off');
  }

  /** Connected peers' ids (for tests and debugging). */
  get peerIds(): RiderId[] {
    return [...this.links.keys()];
  }

  peer(id: RiderId): PeerLink | undefined {
    return this.links.get(id);
  }

  private reconcile(): void {
    if (!this.running) return;
    const riders = this.riders.get();
    for (const [id, r] of Object.entries(riders)) {
      if (id === this.opts.selfId) continue;
      if (r.online && !this.links.has(id)) this.connect(id);
      else if (!r.online && this.links.has(id)) this.forget(id);
    }
    for (const id of [...this.links.keys()]) if (!riders[id]) this.forget(id);
  }

  private connect(peerId: RiderId): PeerLink {
    const { callbacks, signaling, selfId } = this.opts;
    const restarts = this.restarts.get(peerId) ?? 0;
    const link: PeerLink = new PeerLink({
      selfId,
      peerId,
      iceServers: this.iceServers,
      track: this.track,
      send: (data) => signaling.send(peerId, data),
      onState: (state) => {
        if (this.links.get(peerId) !== link) return;
        if (state === 'connected') this.restarts.delete(peerId);
        callbacks.onPeerState(peerId, state);
      },
      onTrack: (track) => this.links.get(peerId) === link && callbacks.onRemoteTrack(peerId, track),
      onData: (msg) => callbacks.onData(peerId, msg),
      onRecreate: () => {
        if (this.links.get(peerId) !== link) return;
        this.restarts.set(peerId, restarts + 1);
        this.recreate(peerId);
      },
      ...this.opts.link,
      offerTimeoutMs: Math.min(MAX_RESTART_WAIT_MS, (this.opts.link?.offerTimeoutMs ?? OFFER_TIMEOUT_MS) * 2 ** restarts),
      connectTimeoutMs: Math.min(MAX_RESTART_WAIT_MS, (this.opts.link?.connectTimeoutMs ?? CONNECT_TIMEOUT_MS) * 2 ** restarts),
    });
    this.links.set(peerId, link);
    callbacks.onPeerState(peerId, 'connecting');
    return link;
  }

  private drop(peerId: RiderId): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.links.delete(peerId);
    link.close();
    this.opts.callbacks.onRemoteTrack(peerId, null);
    this.opts.callbacks.onPeerState(peerId, null);
  }

  /** The rider left or went offline: drop the link and its restart history. */
  private forget(peerId: RiderId): void {
    this.drop(peerId);
    this.restarts.delete(peerId);
  }

  private recreate(peerId: RiderId): PeerLink {
    this.drop(peerId);
    return this.connect(peerId);
  }

  private recreateFailed(): void {
    for (const [id, link] of [...this.links]) if (link.state === 'failed') this.recreate(id);
  }

  private enqueue(from: RiderId, data: RtcSignalData): void {
    if (!this.running || from === this.opts.selfId) return;
    const prev = this.queues.get(from) ?? Promise.resolve();
    const next = prev.then(() => this.handle(from, data)).catch((err: unknown) => console.warn('[voice:mesh]', err));
    this.queues.set(from, next);
  }

  private async handle(from: RiderId, data: RtcSignalData): Promise<void> {
    if (!this.running) return;
    // The server only relays signals from riders in our ride, even if our store hasn't caught up.
    const link = this.links.get(from) ?? this.connect(from);
    if ((await link.handleSignal(data)) === 'recreate' && this.links.get(from) === link) {
      // They started a fresh connection (reload or their own recovery): follow suit.
      await this.recreate(from).handleSignal(data);
    }
  }
}
