/**
 * Voice through a LiveKit SFU: publish the engine's processed mic track, subscribe to every
 * rider's audio and hand the raw tracks to the engine (never attach(): the engine plays them).
 *
 * LiveKit recovers short outages itself (Reconnecting -> Reconnected). When it gives up
 * (Disconnected), we reconnect with backoff, fetching a fresh token when ours is stale.
 */
import type { LiveKitJoinInfo, RiderId, VoiceDataMessage, VoiceJoinInfo } from '@intercom/shared';
import {
  AudioPresets,
  ConnectionError,
  ConnectionErrorReason,
  ConnectionState,
  DisconnectReason,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  Room,
  RoomEvent,
  Track,
} from 'livekit-client';
import type { LiveKitTokenFetcher, PeerStats, VoiceStats } from '../../../core/services';
import type { PeerState } from '../../../core/store';
import { Backoff } from '../backoff';
import { ALERT_TOPIC, decodeData, encodeData } from '../dataMessages';
import { inboundAudio, outboundAudioBytes } from '../stats';
import type { TransportCallbacks, VoiceTransport } from '../transport';
import { tokenNeedsRefresh } from './token';

export interface LiveKitTransportOptions {
  join: LiveKitJoinInfo;
  callbacks: TransportCallbacks;
  fetchToken: LiveKitTokenFetcher;
  createRoom?: () => Room;
  backoff?: Backoff;
  /** Consecutive failed reconnects before the state reads 'failed' (retrying continues). */
  failAfter?: number;
}

/** Disconnects we must not fight by reconnecting. */
const FINAL_REASONS = new Set<DisconnectReason>([
  DisconnectReason.CLIENT_INITIATED,
  DisconnectReason.DUPLICATE_IDENTITY,
  DisconnectReason.PARTICIPANT_REMOVED,
  DisconnectReason.ROOM_DELETED,
]);

const FINAL_MESSAGES: Partial<Record<DisconnectReason, string>> = {
  [DisconnectReason.DUPLICATE_IDENTITY]: 'Voice moved to another tab or device.',
  [DisconnectReason.PARTICIPANT_REMOVED]: 'Removed from the voice room.',
  [DisconnectReason.ROOM_DELETED]: 'The voice room was closed.',
};

export class LiveKitTransport implements VoiceTransport {
  readonly mode = 'livekit' as const;
  private join: LiveKitJoinInfo;
  private room: Room | null = null;
  private outgoing: MediaStreamTrack | null = null;
  private publication: LocalTrackPublication | null = null;
  /** Publish/replace/unpublish run one at a time. */
  private publishing: Promise<void> = Promise.resolve();
  private readonly remoteTracks = new Map<RiderId, MediaStreamTrack>();
  private readonly failedSubscriptions = new Set<RiderId>();
  private readonly backoff: Backoff;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private tokenStale = false;
  private stopped = false;

  constructor(private readonly opts: LiveKitTransportOptions) {
    this.join = opts.join;
    this.backoff = opts.backoff ?? new Backoff(1_000, 30_000);
  }

  async start(): Promise<void> {
    await this.connect(true);
  }

  async update(info: VoiceJoinInfo): Promise<void> {
    const next = info.livekit;
    if (!next || this.stopped) return;
    const moved = next.url !== this.join.url || next.room !== this.join.room;
    this.join = next;
    this.tokenStale = false;
    if (moved) {
      await this.teardownRoom();
      await this.connect(false);
    } else if (!this.room && this.reconnectTimer) {
      // Waiting out a backoff with a token that may have been the problem: try now.
      this.clearReconnect();
      this.backoff.reset();
      await this.connect(false);
    }
    // Otherwise the live room keeps going; the new token is used for the next full reconnect.
  }

  async setOutgoingTrack(track: MediaStreamTrack | null): Promise<void> {
    this.outgoing = track;
    await this.syncPublication();
  }

  sendData(msg: VoiceDataMessage): void {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    room.localParticipant.publishData(encodeData(msg), { reliable: true, topic: ALERT_TOPIC }).catch(warn);
  }

  async getStats(): Promise<VoiceStats> {
    const peers: Record<RiderId, PeerStats> = {};
    const room = this.room;
    let bytesSent = 0;
    if (room) {
      await Promise.all(
        [...room.remoteParticipants.values()].map(async (p) => {
          const track = [...p.audioTrackPublications.values()].find((pub) => pub.track)?.track;
          const report = await track?.getRTCStatsReport().catch(() => undefined);
          peers[p.identity] = inboundAudio(report, this.peerState(p));
        }),
      );
      const sent = await this.publication?.track?.getRTCStatsReport().catch(() => undefined);
      bytesSent = outboundAudioBytes(sent);
    }
    return { transport: 'livekit', bytesSent, peers };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnect();
    await this.teardownRoom();
    this.opts.callbacks.onState('off');
  }

  // ---- connection -------------------------------------------------------------------------------

  private async connect(throwOnFailure: boolean): Promise<void> {
    if (this.stopped) return;
    const { callbacks } = this.opts;
    if (!this.room) callbacks.onState(this.backoff.attempts > 0 ? 'reconnecting' : 'connecting');
    if (this.tokenStale || tokenNeedsRefresh(this.join.token)) await this.refreshToken();
    const room =
      this.opts.createRoom?.() ??
      new Room({
        adaptiveStream: false,
        dynacast: false,
        // The engine owns the mic track: unpublishing or leaving must never stop it.
        stopLocalTrackOnUnpublish: false,
        webAudioMix: false,
        disconnectOnPageLeave: true,
      });
    this.room = room;
    this.publication = null;
    this.bindRoom(room);
    try {
      await room.connect(this.join.url, this.join.token, { autoSubscribe: true });
    } catch (err) {
      if (this.room !== room) return;
      this.room = null;
      room.removeAllListeners();
      if (err instanceof ConnectionError && err.reason === ConnectionErrorReason.NotAllowed) this.tokenStale = true;
      this.scheduleReconnect(describe(err));
      if (throwOnFailure) throw err;
      return;
    }
    if (this.room !== room || this.stopped) return;
    this.backoff.reset();
    callbacks.onState('connected');
    for (const p of room.remoteParticipants.values()) this.syncParticipant(p);
    await this.syncPublication();
  }

  private bindRoom(room: Room): void {
    const { callbacks } = this.opts;
    const mine = () => this.room === room && !this.stopped;
    room
      .on(RoomEvent.Reconnecting, () => mine() && callbacks.onState('reconnecting'))
      .on(RoomEvent.SignalReconnecting, () => mine() && callbacks.onState('reconnecting'))
      .on(RoomEvent.Reconnected, () => {
        if (!mine()) return;
        callbacks.onState('connected');
        void this.syncPublication();
      })
      .on(RoomEvent.Disconnected, (reason) => mine() && this.onDisconnected(reason))
      .on(RoomEvent.ParticipantConnected, (p) => mine() && this.syncParticipant(p))
      .on(RoomEvent.ParticipantDisconnected, (p) => mine() && this.forgetParticipant(p.identity))
      .on(RoomEvent.TrackPublished, (_pub, p) => mine() && this.syncParticipant(p))
      .on(RoomEvent.TrackUnpublished, (_pub, p) => mine() && this.syncParticipant(p))
      .on(RoomEvent.TrackSubscribed, (track, _pub, p) => mine() && this.onSubscribed(track, p))
      .on(RoomEvent.TrackUnsubscribed, (track, _pub, p) => mine() && this.onUnsubscribed(track, p))
      .on(RoomEvent.TrackSubscriptionFailed, (_sid, p) => {
        if (!mine()) return;
        this.failedSubscriptions.add(p.identity);
        this.syncParticipant(p);
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (!mine() || topic !== ALERT_TOPIC || !participant) return;
        const msg = decodeData(payload);
        if (msg) callbacks.onData(participant.identity, msg);
      });
  }

  private onDisconnected(reason: DisconnectReason | undefined): void {
    const room = this.room;
    this.room = null;
    this.publication = null;
    room?.removeAllListeners();
    this.forgetAll(room);
    if (reason !== undefined && FINAL_REASONS.has(reason)) {
      this.opts.callbacks.onState('failed', FINAL_MESSAGES[reason] ?? null);
      return;
    }
    this.scheduleReconnect('Voice connection lost');
  }

  private scheduleReconnect(error: string): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff.next();
    const failed = this.backoff.attempts > (this.opts.failAfter ?? 5);
    this.opts.callbacks.onState(failed ? 'failed' : 'reconnecting', error);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(false);
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async refreshToken(): Promise<void> {
    const fresh = await this.opts.fetchToken().catch(() => null);
    if (fresh) {
      this.join = fresh;
      this.tokenStale = false;
    }
  }

  private async teardownRoom(): Promise<void> {
    const room = this.room;
    this.room = null;
    this.publication = null;
    this.forgetAll(room);
    if (!room) return;
    room.removeAllListeners();
    // false: keep our (engine-owned) local tracks running.
    await room.disconnect(false).catch(warn);
  }

  // ---- publishing -------------------------------------------------------------------------------

  private syncPublication(): Promise<void> {
    const run = this.publishing.then(() => this.applyPublication());
    this.publishing = run.catch(warn);
    return this.publishing;
  }

  private async applyPublication(): Promise<void> {
    const room = this.room;
    if (!room || room.state !== ConnectionState.Connected) return;
    const track = this.outgoing;
    const published = this.publication?.track;
    if (published) {
      if (!track) {
        await room.localParticipant.unpublishTrack(published, false);
        this.publication = null;
      } else if (published.mediaStreamTrack !== track) {
        await published.replaceTrack(track, { userProvidedTrack: true });
      }
      return;
    }
    if (!track || track.readyState === 'ended') return;
    const pub = await room.localParticipant.publishTrack(track, {
      source: Track.Source.Microphone,
      name: 'mic',
      dtx: true,
      red: true,
      audioPreset: AudioPresets.speech,
      forceStereo: false,
    });
    if (this.room === room) this.publication = pub;
  }

  // ---- remote riders ----------------------------------------------------------------------------

  private onSubscribed(track: RemoteTrack, p: RemoteParticipant): void {
    if (track.kind !== Track.Kind.Audio) return;
    this.failedSubscriptions.delete(p.identity);
    const mst = track.mediaStreamTrack;
    if (this.remoteTracks.get(p.identity) !== mst) {
      this.remoteTracks.set(p.identity, mst);
      this.opts.callbacks.onRemoteTrack(p.identity, mst);
    }
    this.syncParticipant(p);
  }

  private onUnsubscribed(track: RemoteTrack, p: RemoteParticipant): void {
    if (this.remoteTracks.get(p.identity) === track.mediaStreamTrack) {
      this.remoteTracks.delete(p.identity);
      this.opts.callbacks.onRemoteTrack(p.identity, null);
    }
    this.syncParticipant(p);
  }

  private peerState(p: RemoteParticipant): PeerState {
    if (this.failedSubscriptions.has(p.identity)) return 'failed';
    const pubs = [...p.audioTrackPublications.values()];
    // In the room with nothing to receive yet (mic off) still counts as reachable.
    return pubs.some((pub) => pub.isDesired && !pub.isSubscribed) ? 'connecting' : 'connected';
  }

  private syncParticipant(p: RemoteParticipant): void {
    this.opts.callbacks.onPeerState(p.identity, this.peerState(p));
  }

  private forgetParticipant(id: RiderId): void {
    this.failedSubscriptions.delete(id);
    if (this.remoteTracks.delete(id)) this.opts.callbacks.onRemoteTrack(id, null);
    this.opts.callbacks.onPeerState(id, null);
  }

  private forgetAll(room: Room | null): void {
    const ids = new Set([...this.remoteTracks.keys(), ...[...(room?.remoteParticipants.values() ?? [])].map((p) => p.identity)]);
    for (const id of ids) this.forgetParticipant(id);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warn(err: unknown): void {
  console.warn('[voice:livekit]', err);
}
