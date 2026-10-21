/**
 * Test double for RTCPeerConnection: just enough of the offer/answer state machine (implicit
 * rollback, transceiver association by mid, negotiationneeded, data channel pairing) to run
 * PeerLink's perfect negotiation in Node. Not a media stack.
 */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
let nextSession = 4_000_000;
const registry = new Map<string, FakePeerConnection>();

interface FakeSdp {
  mids: string[];
  app: boolean;
}

function writeSdp(session: string, version: number, body: FakeSdp): string {
  return [
    'v=0',
    `o=- ${session} ${version} IN IP4 127.0.0.1`,
    's=-',
    'a=rtpmap:111 opus/48000/2',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    `a=x-fake:${JSON.stringify(body)}`,
    '',
  ].join('\r\n');
}

function readSdp(sdp: string): FakeSdp & { session: string } {
  const body = JSON.parse(/^a=x-fake:(.*)$/m.exec(sdp)![1]!) as FakeSdp;
  return { ...body, session: /^o=\S+ (\S+) /m.exec(sdp)![1]! };
}

export class FakeTransceiver {
  mid: string | null = null;
  readonly sender = {
    track: null as unknown,
    replaceTrack: async (t: unknown) => {
      this.sender.track = t;
    },
  };
  readonly receiver = { track: { kind: 'audio', id: `remote-${Math.random().toString(36).slice(2, 8)}` } };
  constructor(
    public direction: string,
    readonly createdBy: 'local' | 'remote',
  ) {}
}

export class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting';
  binaryType = 'blob';
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(private readonly owner: FakePeerConnection) {}
  send(data: unknown): void {
    if (this.readyState !== 'open') throw new Error('InvalidStateError: channel not open');
    const peer = this.owner.remoteSession ? registry.get(this.owner.remoteSession) : undefined;
    const target = peer?.channel;
    setTimeout(() => target?.readyState === 'open' && target.onmessage?.({ data }), 0);
  }
  close(): void {
    this.readyState = 'closed';
  }
}

export class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  remoteDescription: { type: RTCSdpType; sdp: string } | null = null;
  readonly transceivers: FakeTransceiver[] = [];
  channel: FakeDataChannel | null = null;
  remoteSession: string | null = null;
  readonly session = String(nextSession++);
  readonly offersMade: string[] = [];
  readonly candidatesAdded: unknown[] = [];
  restartIceCalls = 0;
  /** Test hook: when true, renegotiation never brings the connection back. */
  stuck = false;
  private nnQueued = false;
  private nnFired = false;
  onnegotiationneeded: (() => void) | null = null;
  onicecandidate: ((e: { candidate: unknown }) => void) | null = null;
  ontrack: ((e: { track: unknown; transceiver: FakeTransceiver }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private version = 0;
  private midCounter = 0;
  private pendingOffer: FakeTransceiver[] = [];
  private appNegotiated = false;
  private iceRestart = false;
  private closed = false;

  constructor(public config: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
    registry.set(this.session, this);
  }

  addTransceiver(_kind: string, init: { direction: string }): FakeTransceiver {
    const t = new FakeTransceiver(init.direction, 'local');
    this.transceivers.push(t);
    this.queueNegotiationNeeded();
    return t;
  }

  createDataChannel(): FakeDataChannel {
    this.channel = new FakeDataChannel(this);
    this.queueNegotiationNeeded();
    return this.channel;
  }

  getConfiguration(): RTCConfiguration {
    return this.config;
  }

  setConfiguration(config: RTCConfiguration): void {
    this.config = config;
  }

  restartIce(): void {
    this.restartIceCalls++;
    this.iceRestart = true;
    this.queueNegotiationNeeded();
  }

  async setLocalDescription(): Promise<void> {
    await tick();
    if (this.closed) throw new Error('InvalidStateError: closed');
    if (this.signalingState === 'stable') {
      this.pendingOffer = this.transceivers.filter((t) => t.mid === null && t.createdBy === 'local');
      for (const t of this.pendingOffer) t.mid = `${this.session}.${this.midCounter++}`;
      this.iceRestart = false;
      const sdp = writeSdp(this.session, ++this.version, { mids: this.mids(), app: this.channel !== null });
      this.localDescription = { type: 'offer', sdp };
      this.signalingState = 'have-local-offer';
      this.offersMade.push(sdp);
      this.emitCandidates();
    } else if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: writeSdp(this.session, ++this.version, { mids: this.mids(), app: this.channel !== null }) };
      this.signalingState = 'stable';
      this.becameStable();
      this.emitCandidates();
    } else {
      throw new Error(`InvalidStateError: setLocalDescription in ${this.signalingState}`);
    }
  }

  async setRemoteDescription(desc: { type: RTCSdpType; sdp?: string }): Promise<void> {
    await tick();
    if (this.closed) throw new Error('InvalidStateError: closed');
    const remote = readSdp(desc.sdp ?? '');
    if (desc.type === 'offer') {
      if (this.signalingState === 'have-local-offer') this.rollback();
      this.remoteSession = remote.session;
      for (const mid of remote.mids) {
        if (this.transceivers.some((t) => t.mid === mid)) continue;
        const t = new FakeTransceiver('recvonly', 'remote');
        t.mid = mid;
        this.transceivers.push(t);
        setTimeout(() => this.ontrack?.({ track: t.receiver.track, transceiver: t }), 0);
      }
      this.remoteDescription = { type: 'offer', sdp: desc.sdp ?? '' };
      this.signalingState = 'have-remote-offer';
    } else if (desc.type === 'answer') {
      if (this.signalingState !== 'have-local-offer') throw new Error(`InvalidStateError: answer in ${this.signalingState}`);
      this.remoteSession = remote.session;
      this.remoteDescription = { type: 'answer', sdp: desc.sdp ?? '' };
      this.pendingOffer = [];
      this.signalingState = 'stable';
      this.becameStable();
    }
  }

  async addIceCandidate(candidate?: unknown): Promise<void> {
    await tick();
    if (!this.remoteDescription) throw new Error('InvalidStateError: no remote description');
    this.candidatesAdded.push(candidate ?? null);
  }

  async getStats(): Promise<Map<string, Record<string, unknown>>> {
    return new Map([
      ['in', { id: 'in', type: 'inbound-rtp', kind: 'audio', bytesReceived: 1200, packetsLost: 1, jitter: 0.004, audioLevel: 0.2 }],
      ['out', { id: 'out', type: 'outbound-rtp', kind: 'audio', bytesSent: 900 }],
      ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'cp' }],
      ['cp', { id: 'cp', type: 'candidate-pair', currentRoundTripTime: 0.031 }],
    ]);
  }

  /** Test hook: simulate the network dropping. */
  fail(): void {
    this.connectionState = 'failed';
    this.onconnectionstatechange?.();
  }

  close(): void {
    this.closed = true;
    this.signalingState = 'closed';
    this.connectionState = 'closed';
    registry.delete(this.session);
  }

  get ownSender(): FakeTransceiver['sender'] | undefined {
    return this.transceivers.find((t) => t.createdBy === 'local')?.sender;
  }

  private mids(): string[] {
    return this.transceivers.filter((t) => t.mid !== null).map((t) => t.mid!);
  }

  private rollback(): void {
    for (const t of this.pendingOffer) t.mid = null;
    this.pendingOffer = [];
    this.localDescription = null;
    this.signalingState = 'stable';
    this.nnFired = false;
  }

  private becameStable(): void {
    this.appNegotiated ||= this.channel !== null;
    if (this.channel && this.appNegotiated && this.channel.readyState === 'connecting') this.channel.readyState = 'open';
    this.nnFired = false;
    if (this.connectionState !== 'connected' && !this.stuck) {
      this.connectionState = 'connected';
      setTimeout(() => !this.closed && this.onconnectionstatechange?.(), 0);
    }
    this.queueNegotiationNeeded();
  }

  private needsNegotiation(): boolean {
    return this.iceRestart || this.transceivers.some((t) => t.createdBy === 'local' && t.mid === null) || (this.channel !== null && !this.appNegotiated);
  }

  /** Like browsers: one event per pending need, re-armed once signaling is stable again. */
  private queueNegotiationNeeded(): void {
    if (this.nnQueued) return;
    this.nnQueued = true;
    setTimeout(() => {
      this.nnQueued = false;
      if (this.closed || this.nnFired || this.signalingState !== 'stable' || !this.needsNegotiation()) return;
      this.nnFired = true;
      this.onnegotiationneeded?.();
    }, 0);
  }

  private emitCandidates(): void {
    setTimeout(() => {
      if (this.closed) return;
      this.onicecandidate?.({ candidate: { candidate: `candidate:${this.session} 1 udp 1 127.0.0.1 9 typ host`, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' } });
      this.onicecandidate?.({ candidate: null });
    }, 1);
  }
}
