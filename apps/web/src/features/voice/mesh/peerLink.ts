/**
 * One RTCPeerConnection to one remote rider, negotiated with the W3C "perfect negotiation"
 * pattern so either side may (re)negotiate at any time, including both at once:
 * https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
 *
 * polite = selfId > peerId: on an offer collision the polite peer rolls back and accepts the
 * other offer, the impolite peer ignores the incoming one.
 *
 * An offer that stays unanswered (it or the answer was lost, e.g. the peer wasn't listening yet) would
 * leave both sides waiting forever when the lost offer was the impolite peer's: the polite peer's
 * own offer is ignored as a collision. So the link asks its owner to start over after offerTimeoutMs.
 *
 * Both peers add an audio transceiver up front and swap the mic in with replaceTrack, so mic
 * changes never renegotiate. (Each side sends on its own transceiver and receives on the one the
 * other side created: two audio m-lines, bundled on one transport.) Alerts use a negotiated data
 * channel with a fixed id on both ends.
 */
import type { RiderId, RtcSignalData, VoiceDataMessage } from '@intercom/shared';
import type { PeerStats } from '../../../core/services';
import type { PeerState } from '../../../core/store';
import { ALERT_CHANNEL_ID, ALERT_CHANNEL_LABEL, decodeData, encodeData } from '../dataMessages';
import { inboundAudio, outboundAudioBytes } from '../stats';
import { mungeOpus, sessionIdOf } from './sdp';

export interface PeerLinkOptions {
  selfId: RiderId;
  peerId: RiderId;
  iceServers: RTCIceServer[];
  send(data: RtcSignalData): void;
  track: MediaStreamTrack | null;
  onState(state: PeerState): void;
  onTrack(track: MediaStreamTrack | null): void;
  onData(msg: VoiceDataMessage): void;
  /** Recovery gave up on this connection; the owner should replace it with a fresh one. */
  onRecreate(): void;
  createPeerConnection?: (config: RTCConfiguration) => RTCPeerConnection;
  /** ICE restart after this long in 'disconnected'. */
  disconnectedRestartMs?: number;
  /** Start over with a new connection if still not connected this long after failing. */
  failedRecreateMs?: number;
  /** Start over with a new connection if our offer is still unanswered this long after sending it. */
  offerTimeoutMs?: number;
}

/** Default for PeerLinkOptions.offerTimeoutMs: an answer normally takes one signaling round trip. */
export const OFFER_TIMEOUT_MS = 5_000;

/** Outcome of handling a signal: 'recreate' means it belongs to a new session from the peer. */
export type SignalResult = 'ok' | 'recreate';

export class PeerLink {
  readonly polite: boolean;
  private readonly pc: RTCPeerConnection;
  private readonly transceiver: RTCRtpTransceiver;
  private readonly channel: RTCDataChannel;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private remoteSession: string | null = null;
  private remoteTrack: MediaStreamTrack | null = null;
  private stateValue: PeerState = 'connecting';
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private failedTimer: ReturnType<typeof setTimeout> | null = null;
  private offerTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly opts: PeerLinkOptions) {
    this.polite = opts.selfId > opts.peerId;
    const config: RTCConfiguration = { iceServers: opts.iceServers, bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
    const pc = opts.createPeerConnection?.(config) ?? new RTCPeerConnection(config);
    this.pc = pc;
    this.transceiver = pc.addTransceiver('audio', { direction: 'sendrecv' });
    if (opts.track) void this.transceiver.sender.replaceTrack(opts.track).catch(warn);
    this.channel = pc.createDataChannel(ALERT_CHANNEL_LABEL, { negotiated: true, id: ALERT_CHANNEL_ID, ordered: true });
    this.channel.binaryType = 'arraybuffer';
    this.channel.onmessage = (e: MessageEvent) => {
      const msg = decodeData(e.data as ArrayBuffer | string);
      if (msg) opts.onData(msg);
    };

    pc.onnegotiationneeded = () => void this.negotiate();
    pc.onicecandidate = ({ candidate: c }) => {
      if (this.closed) return;
      opts.send({
        candidate: c ? { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex, usernameFragment: c.usernameFragment } : null,
      });
    };
    pc.ontrack = (e) => {
      if (e.track.kind !== 'audio') return;
      // The remote audio arrives on the transceiver the other side created; only fall back to
      // our own one if a different implementation chose to send there.
      if (e.transceiver === this.transceiver && this.remoteTrack) return;
      this.remoteTrack = e.track;
      opts.onTrack(e.track);
    };
    pc.onconnectionstatechange = () => this.onConnectionState();
  }

  get state(): PeerState {
    return this.stateValue;
  }

  get dataOpen(): boolean {
    return this.channel.readyState === 'open';
  }

  setTrack(track: MediaStreamTrack | null): void {
    if (this.closed) return;
    void this.transceiver.sender.replaceTrack(track).catch(warn);
  }

  setIceServers(iceServers: RTCIceServer[]): void {
    if (this.closed) return;
    try {
      this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
    } catch (err) {
      warn(err);
    }
  }

  sendData(msg: VoiceDataMessage): boolean {
    if (this.channel.readyState !== 'open') return false;
    try {
      this.channel.send(encodeData(msg));
      return true;
    } catch (err) {
      warn(err);
      return false;
    }
  }

  /** Handles one message from the peer. Callers must await each before passing the next. */
  async handleSignal(data: RtcSignalData): Promise<SignalResult> {
    if (this.closed) return 'ok';
    const { description, candidate } = data;
    try {
      if (description) {
        const session = description.sdp ? sessionIdOf(description.sdp) : null;
        if (description.type === 'offer' && session && this.remoteSession && session !== this.remoteSession) return 'recreate';
        const readyForOffer = !this.makingOffer && (this.pc.signalingState === 'stable' || this.settingRemoteAnswer);
        const collision = description.type === 'offer' && !readyForOffer;
        this.ignoreOffer = !this.polite && collision;
        if (this.ignoreOffer) return 'ok';
        this.settingRemoteAnswer = description.type === 'answer';
        await this.pc.setRemoteDescription(description as RTCSessionDescriptionInit);
        this.settingRemoteAnswer = false;
        if (session) this.remoteSession = session;
        if (description.type === 'offer') {
          await this.pc.setLocalDescription();
          this.sendDescription();
        }
      } else if (candidate !== undefined) {
        try {
          await this.pc.addIceCandidate(candidate ?? undefined);
        } catch (err) {
          if (!this.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      this.settingRemoteAnswer = false;
      warn(err);
    }
    return 'ok';
  }

  async getStats(): Promise<{ peer: PeerStats; bytesSent: number }> {
    if (this.closed) return { peer: inboundAudio(null, this.stateValue), bytesSent: 0 };
    const report = await this.pc.getStats();
    return { peer: inboundAudio(report, this.stateValue), bytesSent: outboundAudioBytes(report) };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = null;
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onconnectionstatechange = null;
    this.channel.onmessage = null;
    this.channel.close();
    this.pc.close();
  }

  private async negotiate(): Promise<void> {
    if (this.closed) return;
    try {
      this.makingOffer = true;
      await this.pc.setLocalDescription();
      this.sendDescription();
    } catch (err) {
      warn(err);
    } finally {
      this.makingOffer = false;
    }
  }

  private sendDescription(): void {
    const d = this.pc.localDescription;
    if (!d || this.closed) return;
    this.opts.send({ description: { type: d.type, sdp: d.type === 'rollback' ? undefined : mungeOpus(d.sdp) } });
    if (d.type === 'offer') this.watchOffer();
  }

  private watchOffer(): void {
    if (this.offerTimer) clearTimeout(this.offerTimer);
    this.offerTimer = setTimeout(() => {
      this.offerTimer = null;
      if (!this.closed && this.pc.signalingState === 'have-local-offer') this.opts.onRecreate();
    }, this.opts.offerTimeoutMs ?? OFFER_TIMEOUT_MS);
  }

  private onConnectionState(): void {
    if (this.closed) return;
    switch (this.pc.connectionState) {
      case 'connected':
        this.clearTimers();
        this.setState('connected');
        break;
      case 'failed':
        this.setState('failed');
        this.pc.restartIce();
        this.failedTimer ??= setTimeout(() => {
          this.failedTimer = null;
          if (!this.closed && this.pc.connectionState !== 'connected') this.opts.onRecreate();
        }, this.opts.failedRecreateMs ?? 15_000);
        break;
      case 'disconnected':
        // Often recovers by itself (a brief radio dropout); restart ICE if it doesn't.
        this.disconnectTimer ??= setTimeout(() => {
          this.disconnectTimer = null;
          if (!this.closed && this.pc.connectionState === 'disconnected') this.pc.restartIce();
        }, this.opts.disconnectedRestartMs ?? 4_000);
        break;
      default:
        break;
    }
  }

  private setState(state: PeerState): void {
    if (state === this.stateValue) return;
    this.stateValue = state;
    this.opts.onState(state);
  }

  private clearTimers(): void {
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    if (this.failedTimer) clearTimeout(this.failedTimer);
    this.disconnectTimer = this.failedTimer = null;
  }
}

function warn(err: unknown): void {
  console.warn('[voice:mesh]', err);
}
