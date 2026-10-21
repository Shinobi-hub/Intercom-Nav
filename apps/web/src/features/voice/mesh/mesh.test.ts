// @vitest-environment node
import type { RiderId, VoiceDataMessage, VoiceJoinInfo } from '@intercom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerState } from '../../../core/store';
import type { TransportCallbacks } from '../transport';
import { FakePeerConnection } from './fakePeerConnection';
import { MeshTransport, type RiderSource } from './meshTransport';
import { OPUS_FMTP, mungeOpus, sessionIdOf } from './sdp';
import { bufferedSignaling, createSignalingHub } from './signaling';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const info: VoiceJoinInfo = { mode: 'mesh', available: ['mesh'], livekit: null, iceServers: [{ urls: 'stun:stun.example.org' }] };

async function waitFor(cond: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function riderSource(initial: Record<RiderId, boolean>) {
  let riders = Object.fromEntries(Object.entries(initial).map(([id, online]) => [id, { online }]));
  const subs = new Set<() => void>();
  const source: RiderSource = { get: () => riders, subscribe: (cb) => (subs.add(cb), () => subs.delete(cb)) };
  return {
    source,
    set(id: RiderId, online: boolean | null) {
      riders = { ...riders };
      if (online === null) delete riders[id];
      else riders[id] = { online };
      for (const cb of subs) cb();
    },
  };
}

function recorder() {
  const peers: Record<RiderId, PeerState | null> = {};
  const tracks: { id: RiderId; track: MediaStreamTrack | null }[] = [];
  const data: { from: RiderId; msg: VoiceDataMessage }[] = [];
  const callbacks: TransportCallbacks = {
    onState: () => {},
    onPeerState: (id, s) => (peers[id] = s),
    onRemoteTrack: (id, track) => tracks.push({ id, track }),
    onData: (from, msg) => data.push({ from, msg }),
  };
  return { peers, tracks, data, callbacks };
}

const transports: MeshTransport[] = [];
afterEach(async () => {
  await Promise.all(transports.splice(0).map((t) => t.stop()));
});

/** `buffered`: each rider's channel is wrapped for the whole test, as VoiceManager does. */
function setup(delay = () => Math.random() * 3, { buffered = false, offerTimeoutMs = 150 } = {}) {
  const hub = createSignalingHub(delay);
  const riders = riderSource({ [A]: true, [B]: true });
  const make = (selfId: RiderId) => {
    const rec = recorder();
    const transport = new MeshTransport({
      selfId,
      info,
      signaling: buffered ? bufferedSignaling(hub.channel(selfId)) : hub.channel(selfId),
      callbacks: rec.callbacks,
      riders: riders.source,
      link: { createPeerConnection: (c) => new FakePeerConnection(c) as unknown as RTCPeerConnection, failedRecreateMs: 200, offerTimeoutMs },
    });
    transports.push(transport);
    return { transport, ...rec };
  };
  return { hub, riders, a: make(A), b: make(B) };
}

const fakePc = (t: MeshTransport, id: RiderId) => FakePeerConnection.instances.filter((pc) => pc.signalingState !== 'closed').find((pc) => (t.peer(id) as unknown as { pc: unknown })?.pc === pc)!;

describe('MeshTransport (perfect negotiation)', () => {
  it('connects two riders who both offer at once, one remote track each', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    await waitFor(() => a.tracks.length > 0 && b.tracks.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(a.tracks.map((t) => t.id)).toEqual([B]);
    expect(b.tracks.map((t) => t.id)).toEqual([A]);
    expect(a.transport.peer(B)!.polite).toBe(false); // A < B
    expect(b.transport.peer(A)!.polite).toBe(true);
    for (const pc of [fakePc(a.transport, B), fakePc(b.transport, A)]) {
      expect(pc.signalingState).toBe('stable');
      expect(pc.config.iceServers).toEqual(info.iceServers);
    }
  });

  it('asks the remote Opus encoder for DTX, FEC and a voice bitrate', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    const received = fakePc(b.transport, A).remoteDescription!.sdp;
    expect(received).toMatch(/a=fmtp:111 .*usedtx=1/);
    expect(received).toMatch(/useinbandfec=1/);
    expect(received).toMatch(/maxaveragebitrate=32000/);
  });

  it('carries alert messages on the negotiated data channel', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    await waitFor(() => a.transport.peer(B)!.dataOpen && b.transport.peer(A)!.dataOpen);
    const msg: VoiceDataMessage = { type: 'sos-cancel', id: 'sos-1', riderId: A };
    a.transport.sendData(msg);
    await waitFor(() => b.data.length > 0);
    expect(b.data).toEqual([{ from: A, msg }]);
  });

  it('swaps the mic with replaceTrack, without renegotiating', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    await new Promise((r) => setTimeout(r, 30));
    const pc = fakePc(a.transport, B);
    const offers = pc.offersMade.length;
    const mic = { kind: 'audio', id: 'mic' } as unknown as MediaStreamTrack;
    await a.transport.setOutgoingTrack(mic);
    await new Promise((r) => setTimeout(r, 30));
    expect(pc.ownSender!.track).toBe(mic);
    await a.transport.setOutgoingTrack(null);
    await new Promise((r) => setTimeout(r, 30));
    expect(pc.ownSender!.track).toBeNull();
    expect(pc.offersMade.length).toBe(offers);
  });

  it('follows riders going offline, leaving and coming back', async () => {
    const { a, b, riders } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected');
    riders.set(B, false);
    expect(a.peers[B]).toBeNull();
    expect(a.tracks.at(-1)).toEqual({ id: B, track: null });
    expect(a.transport.peerIds).toEqual([]);
    riders.set(B, true);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    riders.set(B, null);
    expect(a.transport.peerIds).toEqual([]);
  });

  it('connects when the impolite rider offered before the other one was listening', async () => {
    // A (impolite) switches to mesh first and its offer reaches B before B's mesh listens, so it is
    // lost. B's own offer then collides with A's outstanding one, which A must ignore.
    const { a, b } = setup(() => 0);
    await a.transport.start();
    await waitFor(() => fakePc(a.transport, B)?.signalingState === 'have-local-offer');
    await new Promise((r) => setTimeout(r, 20));
    await b.transport.start();
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected', 3_000);
  });

  it('hands an offer that arrived before the mesh started to it, without a restart', async () => {
    const { a, b } = setup(() => 0, { buffered: true, offerTimeoutMs: 60_000 });
    await a.transport.start();
    await waitFor(() => fakePc(a.transport, B)?.signalingState === 'have-local-offer');
    const first = fakePc(a.transport, B);
    await new Promise((r) => setTimeout(r, 20));
    await b.transport.start();
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected', 1_000);
    expect(fakePc(a.transport, B)).toBe(first);
  });

  it('starts over when the other rider comes back with a fresh connection', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    const before = fakePc(a.transport, B);
    // B reloads: its old connection vanishes and a new one (new SDP session) offers to A.
    await b.transport.stop();
    await b.transport.start();
    await waitFor(() => fakePc(a.transport, B) !== before && a.peers[B] === 'connected' && b.peers[A] === 'connected');
    expect(before.signalingState).toBe('closed');
  });

  it('restarts ICE when the connection fails', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    const pc = fakePc(a.transport, B);
    const offers = pc.offersMade.length;
    pc.fail();
    expect(a.peers[B]).toBe('failed');
    expect(pc.restartIceCalls).toBe(1);
    await waitFor(() => pc.offersMade.length > offers && a.peers[B] === 'connected');
    expect(fakePc(a.transport, B)).toBe(pc);
  });

  it('rebuilds the connection when an ICE restart does not bring it back', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    const pc = fakePc(a.transport, B);
    pc.stuck = true;
    pc.fail();
    await waitFor(() => fakePc(a.transport, B) !== pc, 1_000);
    expect(pc.signalingState).toBe('closed');
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
  });

  it('recreates failed peers when signaling reconnects', async () => {
    const { a, b, hub } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
    const pc = fakePc(a.transport, B);
    pc.stuck = true;
    pc.fail();
    hub.reconnect(A);
    expect(fakePc(a.transport, B)).not.toBe(pc);
    await waitFor(() => a.peers[B] === 'connected' && b.peers[A] === 'connected');
  });

  it('reports per-peer stats', async () => {
    const { a, b } = setup();
    await Promise.all([a.transport.start(), b.transport.start()]);
    await waitFor(() => a.peers[B] === 'connected');
    const stats = await a.transport.getStats();
    expect(stats.transport).toBe('mesh');
    expect(stats.bytesSent).toBe(900);
    expect(stats.peers[B]).toEqual({ state: 'connected', bytesReceived: 1200, packetsLost: 1, jitterMs: 4, rttMs: 31, audioLevel: 0.2 });
  });
});

describe('bufferedSignaling', () => {
  it('holds signals until someone listens, hands them over in order, then passes them through', async () => {
    const hub = createSignalingHub(() => 0);
    const channel = bufferedSignaling(hub.channel(B));
    hub.channel(A).send(B, { candidate: null });
    hub.channel(A).send(B, { description: { type: 'offer', sdp: 'v=0' } });
    await new Promise((r) => setTimeout(r, 10));
    const got: unknown[] = [];
    const off = channel.onSignal((from, data) => got.push([from, data]));
    expect(got).toEqual([
      [A, { candidate: null }],
      [A, { description: { type: 'offer', sdp: 'v=0' } }],
    ]);
    hub.channel(A).send(B, { candidate: null });
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(3);
    off();
    channel.close();
  });

  it('drops held signals older than maxAgeMs', async () => {
    const hub = createSignalingHub(() => 0);
    const channel = bufferedSignaling(hub.channel(B), 20);
    hub.channel(A).send(B, { candidate: null });
    await new Promise((r) => setTimeout(r, 60));
    const got: unknown[] = [];
    channel.onSignal((from, data) => got.push([from, data]));
    expect(got).toEqual([]);
    channel.close();
  });
});

describe('SDP munging', () => {
  const offer = [
    'v=0',
    'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9',
    'a=rtpmap:111 opus/48000/2',
    'a=rtcp-fb:111 transport-cc',
    'a=fmtp:111 minptime=10;useinbandfec=1',
    'a=rtpmap:63 red/48000/2',
    'a=fmtp:63 111/111',
    'a=rtpmap:9 G722/8000',
    'm=audio 9 UDP/TLS/RTP/SAVPF 109',
    'a=rtpmap:109 opus/48000/2',
    '',
  ].join('\r\n');

  it('adds DTX, keeps FEC and existing params, leaves other codecs alone', () => {
    const out = mungeOpus(offer);
    expect(out).toContain('a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1;maxaveragebitrate=32000;stereo=0');
    expect(out).toContain('a=fmtp:63 111/111');
    expect(out.endsWith('\r\n')).toBe(true);
    expect(out.split('\r\n').length).toBe(offer.split('\r\n').length + 1);
  });

  it('adds an fmtp line where an Opus payload has none', () => {
    expect(mungeOpus(offer)).toContain('a=rtpmap:109 opus/48000/2\r\na=fmtp:109 usedtx=1;useinbandfec=1;maxaveragebitrate=32000;stereo=0');
  });

  it('is idempotent, handles LF-only SDP and SDP without Opus', () => {
    expect(mungeOpus(mungeOpus(offer))).toBe(mungeOpus(offer));
    const lf = offer.replace(/\r\n/g, '\n');
    expect(mungeOpus(lf)).not.toContain('\r');
    expect(mungeOpus(lf)).toContain('usedtx=1');
    const noOpus = 'v=0\r\nm=audio 9 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n';
    expect(mungeOpus(noOpus)).toBe(noOpus);
    expect(Object.keys(OPUS_FMTP)).toContain('usedtx');
  });

  it('reads the session id from the o= line', () => {
    expect(sessionIdOf(offer)).toBe('4611731400430051336');
    expect(sessionIdOf('v=0\r\n')).toBeNull();
  });
});
