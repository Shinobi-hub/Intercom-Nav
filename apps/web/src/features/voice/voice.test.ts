import type { VoiceDataMessage, VoiceJoinInfo } from '@intercom/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AudioEngineApi } from '../../core/services';
import type { AppSocket } from '../../core/socket';
import { useLocalStore } from '../../core/store';
import { createStubAudioEngine } from '../../core/stubs';
import { Backoff } from './backoff';
import { decodeData, encodeData } from './dataMessages';
import { tokenExpiresAt, tokenNeedsRefresh } from './livekit/token';
import type { TransportCallbacks, VoiceTransport } from './transport';
import { VoiceManager } from './voiceManager';

const sos: VoiceDataMessage = {
  type: 'sos',
  sos: { id: 's1', riderId: 'r1', location: { lat: 18.5, lng: 73.8, acc: 5, spd: null, hdg: null, t: 1 }, raisedAt: 2, responders: [{ riderId: 'r2', at: 3 }] },
};

describe('voice data messages', () => {
  it('round-trips valid messages', () => {
    expect(decodeData(encodeData(sos))).toEqual(sos);
    const cancel: VoiceDataMessage = { type: 'sos-cancel', id: 's1', riderId: 'r1' };
    expect(decodeData(encodeData(cancel).buffer)).toEqual(cancel);
  });

  it('rejects anything malformed or oversized', () => {
    for (const bad of ['nope', '[]', '{"type":"sos"}', '{"type":"sos-cancel","id":""}', JSON.stringify({ ...sos, sos: { ...sos.sos, location: { lat: 99 } } }), JSON.stringify({ type: 'other' })]) {
      expect(decodeData(bad)).toBeNull();
    }
    expect(decodeData(new Uint8Array(20_000))).toBeNull();
  });
});

describe('Backoff', () => {
  it('doubles up to the cap, with jitter, and resets', () => {
    const b = new Backoff(1_000, 8_000, 0.25, () => 0.5);
    expect([b.next(), b.next(), b.next(), b.next(), b.next()]).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    b.reset();
    expect(b.next()).toBe(1_000);
    expect(new Backoff(1_000, 8_000, 0.25, () => 0).next()).toBe(750);
  });
});

describe('LiveKit token expiry', () => {
  const jwt = (payload: object) => `h.${btoa(JSON.stringify(payload)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;
  it('reads exp and decides when to refresh', () => {
    expect(tokenExpiresAt(jwt({ exp: 1_000 }))).toBe(1_000_000);
    expect(tokenNeedsRefresh(jwt({ exp: 1_000 }), 999_000)).toBe(true);
    expect(tokenNeedsRefresh(jwt({ exp: 1_000 }), 500_000)).toBe(false);
    expect(tokenNeedsRefresh('garbage')).toBe(false);
  });
});

class FakeTransport implements VoiceTransport {
  started = 0;
  stopped = 0;
  updates: VoiceJoinInfo[] = [];
  tracks: (MediaStreamTrack | null)[] = [];
  sent: VoiceDataMessage[] = [];
  constructor(
    readonly mode: VoiceJoinInfo['mode'],
    readonly cb: TransportCallbacks,
  ) {}
  async start() {
    this.started++;
    this.cb.onState('connected');
  }
  async update(info: VoiceJoinInfo) {
    this.updates.push(info);
  }
  async setOutgoingTrack(t: MediaStreamTrack | null) {
    this.tracks.push(t);
  }
  sendData(msg: VoiceDataMessage) {
    this.sent.push(msg);
  }
  async getStats() {
    return { transport: this.mode, bytesSent: 1, peers: {} };
  }
  async stop() {
    this.stopped++;
  }
}

describe('VoiceManager', () => {
  const mesh: VoiceJoinInfo = { mode: 'mesh', available: ['mesh', 'livekit'], livekit: null, iceServers: [] };
  const lk: VoiceJoinInfo = { mode: 'livekit', available: ['mesh', 'livekit'], livekit: { url: 'wss://x', token: 't', room: 'r' }, iceServers: [] };

  function setup() {
    let trackCb: ((t: MediaStreamTrack | null) => void) | null = null;
    const audio: AudioEngineApi = {
      ...createStubAudioEngine(),
      outgoingTrack: null,
      onOutgoingTrackChange: (cb) => ((trackCb = cb), () => (trackCb = null)),
      addRemoteTrack: vi.fn(),
      removeRemoteTrack: vi.fn(),
    };
    const made: FakeTransport[] = [];
    const manager = new VoiceManager({
      socket: {} as AppSocket,
      audio,
      signaling: { send: () => {}, onSignal: () => () => {} },
      createTransport: (info, _self, cb) => {
        const t = new FakeTransport(info.mode, cb);
        made.push(t);
        return t;
      },
    });
    return { manager, audio, made, setTrack: (t: MediaStreamTrack | null) => trackCb?.(t) };
  }

  it('starts the named transport, publishes state and follows the mic track', async () => {
    const { manager, made, setTrack } = setup();
    await manager.start(mesh, 'me');
    expect(made).toHaveLength(1);
    expect(made[0]!.mode).toBe('mesh');
    expect(useLocalStore.getState().voice).toMatchObject({ state: 'connected', transport: 'mesh' });
    const mic = { id: 'mic' } as MediaStreamTrack;
    setTrack(mic);
    expect(made[0]!.tracks.at(-1)).toBe(mic);
  });

  it('treats same-mode updates as credential refreshes and switches transports otherwise', async () => {
    const { manager, made } = setup();
    await manager.start(lk, 'me');
    await manager.update({ ...lk, livekit: { ...lk.livekit!, token: 't2' } });
    expect(made).toHaveLength(1);
    expect(made[0]!.updates).toHaveLength(1);
    await manager.update(mesh);
    expect(made).toHaveLength(2);
    expect(made[0]!.stopped).toBe(1);
    expect(made[1]!.mode).toBe('mesh');
  });

  it('feeds remote tracks to the engine, relays data and cleans up on stop', async () => {
    const { manager, audio, made } = setup();
    const got: unknown[] = [];
    manager.onData((from, msg) => got.push([from, msg]));
    await manager.start(mesh, 'me');
    const cb = made[0]!.cb;
    const track = { id: 'remote' } as MediaStreamTrack;
    cb.onRemoteTrack('r1', track);
    cb.onPeerState('r1', 'connected');
    cb.onData('r1', sos);
    expect(audio.addRemoteTrack).toHaveBeenCalledWith('r1', track);
    expect(useLocalStore.getState().voice.peers).toEqual({ r1: 'connected' });
    expect(got).toEqual([['r1', sos]]);
    manager.sendData(sos);
    expect(made[0]!.sent).toEqual([sos]);
    await manager.stop();
    expect(audio.removeRemoteTrack).toHaveBeenCalledWith('r1');
    expect(useLocalStore.getState().voice).toMatchObject({ state: 'off', transport: null, peers: {} });
    // Late events from the old transport are ignored.
    cb.onRemoteTrack('r2', track);
    expect(audio.addRemoteTrack).toHaveBeenCalledTimes(1);
    expect(await manager.getStats()).toEqual({ transport: null, bytesSent: 0, peers: {} });
  });
});
