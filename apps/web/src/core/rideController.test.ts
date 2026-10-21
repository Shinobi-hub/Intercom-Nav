import type { JoinResult, RideSnapshot, RiderState, SosAlert, VoiceDataMessage } from '@intercom/shared';
import { TIMING } from '@intercom/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRideController } from './rideController';
import type { LocationServiceApi, VoiceManagerApi } from './services';
import type { AppSocket } from './socket';
import { useLocalStore, useRideStore, useSettings } from './store';
import { createStubAudioEngine, createStubLocationService, createStubPlatform, createStubVoiceManager } from './stubs';

type Handler = (...args: unknown[]) => void;
type AckResponder = (event: string, payload: unknown) => unknown;

/** Just enough of a Socket.io client to drive the controller: server events via fire(), acks via respond. */
class FakeSocket {
  connected = false;
  autoConnect = true;
  private handlers = new Map<string, Set<Handler>>();
  sent: { event: string; payload: unknown; volatile: boolean }[] = [];
  respond: AckResponder = () => ({ ok: true });
  io = { on: vi.fn() };
  volatile = {
    emit: (event: string, payload: unknown) => {
      this.sent.push({ event, payload, volatile: true });
      return true;
    },
  };

  connect() {
    if (!this.connected && this.autoConnect) {
      this.connected = true;
      queueMicrotask(() => this.fire('connect'));
    }
    return this;
  }
  disconnect() {
    if (this.connected) {
      this.connected = false;
      this.fire('disconnect', 'io client disconnect');
    }
    return this;
  }
  on(event: string, fn: Handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn);
    return this;
  }
  off(event: string, fn: Handler) {
    this.handlers.get(event)?.delete(fn);
    return this;
  }
  emit(event: string, payload: unknown) {
    this.sent.push({ event, payload, volatile: false });
    return this;
  }
  timeout() {
    return {
      emitWithAck: async (event: string, payload: unknown) => {
        this.sent.push({ event, payload, volatile: false });
        return this.respond(event, payload);
      },
    };
  }
  fire(event: string, ...args: unknown[]) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) fn(...args);
  }
  sentEvents(event: string) {
    return this.sent.filter((s) => s.event === event);
  }
}

const SELF = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const CAROL = '33333333-3333-4333-8333-333333333333';

function rider(id: string, name: string, extra: Partial<RiderState> = {}): RiderState {
  return {
    id,
    name,
    color: '#0A84FF',
    role: 'rider',
    online: true,
    joinedAt: 1,
    lastSeenAt: 1,
    location: null,
    locationAt: null,
    micMode: 'vox',
    ...extra,
  };
}

function snapshot(extra: Partial<RideSnapshot> = {}): RideSnapshot {
  return {
    code: 'ABCD23',
    createdAt: 1,
    leaderId: SELF,
    voiceMode: 'livekit',
    maxRiders: 8,
    riders: [rider(SELF, 'Me', { role: 'leader' }), rider(BOB, 'Bob'), rider(CAROL, 'Carol')],
    route: null,
    activeSos: [],
    recentBreaks: [],
    serverNow: Date.now(),
    ...extra,
  };
}

function joinResult(extra: Partial<RideSnapshot> = {}): JoinResult {
  return {
    snapshot: snapshot(extra),
    selfId: SELF,
    voice: { mode: 'livekit', available: ['livekit', 'mesh'], livekit: { url: 'ws://lk', token: 't', room: 'ride-ABCD23' }, iceServers: [] },
    resumed: false,
  };
}

function sosFrom(riderId: string, id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'): SosAlert {
  return { id, riderId, location: { lat: 18.5, lng: 73.8, acc: 5, spd: 0, hdg: null, t: 1 }, raisedAt: 1, responders: [] };
}

function setup() {
  const socket = new FakeSocket();
  const audio = createStubAudioEngine();
  const net = { online: true, listeners: new Set<(online: boolean) => void>() };
  const platform = {
    ...createStubPlatform(),
    network: {
      isOnline: () => net.online,
      onChange: (cb: (online: boolean) => void) => {
        net.listeners.add(cb);
        return () => {
          net.listeners.delete(cb);
        };
      },
    },
  };
  const voiceStub = createStubVoiceManager();
  let dataHandler: ((from: string, msg: VoiceDataMessage) => void) | null = null;
  const voice: VoiceManagerApi = {
    ...voiceStub,
    start: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendData: vi.fn(),
    onData: (cb) => {
      dataHandler = cb;
      return () => {
        dataHandler = null;
      };
    },
  };
  let sendHandler: ((fix: import('@intercom/shared').LocationFix) => void) | null = null;
  const location: LocationServiceApi = {
    ...createStubLocationService(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    onSend: (cb) => {
      sendHandler = cb;
      return () => {
        sendHandler = null;
      };
    },
  };
  const spies = {
    unlock: vi.spyOn(audio, 'unlock'),
    setMicMode: vi.spyOn(audio, 'setMicMode'),
    setSosMode: vi.spyOn(audio, 'setSosMode'),
    applySettings: vi.spyOn(audio, 'applySettings'),
    startSiren: vi.spyOn(audio.alerts, 'startSiren'),
    stopSiren: vi.spyOn(audio.alerts, 'stopSiren'),
    chime: vi.spyOn(audio.alerts, 'chime'),
    announce: vi.spyOn(audio.alerts, 'announce'),
    vibrate: vi.spyOn(platform.haptics, 'vibrate'),
    wakeLock: vi.spyOn(platform.wakeLock, 'enable'),
    bgStart: vi.spyOn(platform.background, 'start'),
  };
  socket.respond = (event) => {
    if (event === 'ride:create' || event === 'ride:join') return { ok: true, ...joinResult() };
    if (event === 'time:sync') return { t0: 0, serverNow: Date.now() };
    return { ok: true };
  };
  const controller = createRideController({
    socket: socket as unknown as AppSocket,
    audio,
    voice,
    location,
    platform,
  });
  return {
    socket,
    audio,
    platform,
    voice,
    location,
    controller,
    spies,
    emitData: (from: string, msg: VoiceDataMessage) => dataHandler?.(from, msg),
    sendFix: (fix: import('@intercom/shared').LocationFix) => sendHandler?.(fix),
    /** The OS reports the network going down or coming back. */
    setOnline: (online: boolean) => {
      net.online = online;
      for (const cb of [...net.listeners]) cb(online);
    },
  };
}

/** Lets fire-and-forget promises inside the controller settle. */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

let current: ReturnType<typeof setup> | null = null;

beforeEach(() => {
  useRideStore.getState().reset();
  useLocalStore.getState().reset();
  useSettings.getState().update({ name: 'Me', announce: true, micMode: 'vox' });
  window.history.replaceState(null, '', '/');
});

afterEach(() => {
  current?.controller.dispose();
  current = null;
  vi.useRealTimers();
});

async function startedRide() {
  current = setup();
  const res = await current.controller.startRide({ kind: 'create' });
  await flush();
  expect(res).toEqual({ ok: true, code: 'ABCD23' });
  return current;
}

describe('startRide', () => {
  it('unlocks audio before awaiting anything (iOS gesture rule)', () => {
    current = setup();
    const promise = current.controller.startRide({ kind: 'create' });
    // Synchronous part only: no microtask has run yet.
    expect(current.spies.unlock).toHaveBeenCalledTimes(1);
    expect(current.spies.wakeLock).toHaveBeenCalledTimes(1);
    return promise;
  });

  it('creates a ride, mirrors the snapshot and starts every service', async () => {
    const { socket, spies, voice, location } = await startedRide();
    const create = socket.sentEvents('ride:create')[0]!.payload as { rider: { name: string; secret: string } };
    expect(create.rider.name).toBe('Me');
    expect(create.rider.secret.length).toBeGreaterThanOrEqual(16);

    const st = useRideStore.getState();
    expect(st.ride?.code).toBe('ABCD23');
    expect(st.selfId).toBe(SELF);
    expect(Object.keys(st.riders)).toHaveLength(3);
    expect(st.connection).toBe('connected');

    expect(location.start).toHaveBeenCalled();
    expect(spies.setMicMode).toHaveBeenCalledWith('vox');
    expect(voice.start).toHaveBeenCalledWith(expect.objectContaining({ mode: 'livekit' }), SELF);
    expect(spies.bgStart).toHaveBeenCalled();
    expect(socket.sentEvents('rider:update').at(-1)?.payload).toEqual({ micMode: 'vox' });
    expect(window.localStorage.getItem('intercom:lastRide')).toContain('ABCD23');
  });

  it('returns the server error and disconnects when joining fails', async () => {
    current = setup();
    current.socket.respond = () => ({ ok: false, error: 'ride_not_found' });
    const res = await current.controller.startRide({ kind: 'join', code: 'zzzz22' });
    expect(res).toMatchObject({ ok: false, error: 'ride_not_found' });
    expect(current.socket.connected).toBe(false);
    expect(useRideStore.getState().ride).toBeNull();
  });

  it('fails cleanly when the server is unreachable', async () => {
    vi.useFakeTimers();
    current = setup();
    current.socket.autoConnect = false;
    const promise = current.controller.startRide({ kind: 'create' });
    await vi.advanceTimersByTimeAsync(13_000);
    const res = await promise;
    expect(res.ok).toBe(false);
    expect(useRideStore.getState().connection).toBe('idle');
  });
});

describe('incoming alerts', () => {
  it('sounds the siren for another rider SOS, silences on acknowledge, stops on cancel', async () => {
    const { socket, spies, controller } = await startedRide();
    const sos = sosFrom(BOB);
    socket.fire('sos:raised', sos);

    expect(useRideStore.getState().sos[sos.id]?.source).toBe('server');
    expect(spies.startSiren).toHaveBeenCalledTimes(1);
    expect(spies.setSosMode).toHaveBeenLastCalledWith(true);
    expect(spies.vibrate).toHaveBeenCalled();
    expect(spies.announce).toHaveBeenCalledWith(expect.stringContaining('SOS from Bob'));
    expect(useLocalStore.getState().ui.focus?.riderId).toBe(BOB);

    controller.acknowledgeSos(sos.id);
    expect(spies.stopSiren).toHaveBeenCalledTimes(1);
    expect(spies.setSosMode).toHaveBeenLastCalledWith(false);

    socket.fire('sos:cancelled', { id: sos.id, riderId: BOB, by: BOB, at: 2 });
    expect(useRideStore.getState().sos[sos.id]).toBeUndefined();
    expect(useLocalStore.getState().ui.toasts.at(-1)?.title).toContain('Bob cancelled');
  });

  it('alerts once when the same SOS arrives over the voice channel and the server', async () => {
    const { socket, spies, emitData } = await startedRide();
    const sos = sosFrom(BOB);
    emitData(BOB, { type: 'sos', sos });
    socket.fire('sos:raised', sos);
    expect(spies.startSiren).toHaveBeenCalledTimes(1);
    expect(spies.vibrate).toHaveBeenCalledTimes(1);
    expect(useRideStore.getState().sos[sos.id]?.source).toBe('server');
  });

  it('ignores voice-channel alerts a rider sends on behalf of someone else', async () => {
    const { spies, emitData } = await startedRide();
    emitData(CAROL, { type: 'sos', sos: sosFrom(BOB) });
    expect(spies.startSiren).not.toHaveBeenCalled();
    expect(Object.keys(useRideStore.getState().sos)).toHaveLength(0);
  });

  it('alerts a late joiner about an SOS already in the snapshot', async () => {
    current = setup();
    const sos = sosFrom(BOB);
    current.socket.respond = (event) =>
      event === 'ride:join' ? { ok: true, ...joinResult({ activeSos: [sos] }) } : { ok: true };
    await current.controller.startRide({ kind: 'join', code: 'ABCD23' });
    expect(current.spies.startSiren).toHaveBeenCalledTimes(1);
  });

  it('chimes and toasts for other riders breaks, but not our own', async () => {
    const { socket, spies } = await startedRide();
    socket.fire('break:requested', { id: 'b1', riderId: BOB, kind: 'fuel', location: null, at: 5 });
    expect(spies.chime).toHaveBeenCalledWith('break');
    expect(useLocalStore.getState().ui.toasts.at(-1)).toMatchObject({ kind: 'break', title: 'Bob wants a fuel stop' });

    spies.chime.mockClear();
    socket.fire('break:requested', { id: 'b2', riderId: SELF, kind: 'break', location: null, at: 6 });
    socket.fire('break:requested', { id: 'b1', riderId: BOB, kind: 'fuel', location: null, at: 5 });
    expect(spies.chime).not.toHaveBeenCalled();
    expect(useRideStore.getState().breaks.map((b) => b.id)).toEqual(['b2', 'b1']);
  });

  it('tells the SOS raiser who is coming', async () => {
    const { socket, spies, controller } = await startedRide();
    socket.respond = (event, payload) =>
      event === 'sos:raise'
        ? { ok: true, sos: { ...sosFrom(SELF, (payload as { id: string }).id) } }
        : { ok: true };
    await controller.raiseSos();
    const own = Object.values(useRideStore.getState().sos)[0]!;
    socket.fire('sos:updated', { ...own, responders: [{ riderId: BOB, at: 9 }] });
    expect(spies.chime).toHaveBeenCalledWith('responder');
    expect(useLocalStore.getState().ui.toasts.at(-1)?.title).toBe('Bob is coming');
  });
});

describe('own SOS', () => {
  it('mirrors over the voice channel and retries until the server acks', async () => {
    const env = await startedRide();
    vi.useFakeTimers();
    let attempts = 0;
    env.socket.respond = (event, payload) => {
      if (event !== 'sos:raise') return { ok: true };
      attempts += 1;
      return attempts < 3 ? { ok: false, error: 'internal' } : { ok: true, sos: sosFrom(SELF, (payload as { id: string }).id) };
    };
    await env.controller.raiseSos();
    const id = Object.keys(useRideStore.getState().sos)[0]!;
    expect(useRideStore.getState().sos[id]?.source).toBe('local');
    expect(env.voice.sendData).toHaveBeenCalledWith(expect.objectContaining({ type: 'sos' }));
    expect(env.spies.startSiren).not.toHaveBeenCalled();
    expect(env.spies.setSosMode).toHaveBeenLastCalledWith(true);

    await vi.advanceTimersByTimeAsync(TIMING.sosRetryMs * 2 + 10);
    expect(attempts).toBe(3);
    expect(useRideStore.getState().sos[id]?.source).toBe('server');
    expect(env.spies.chime).toHaveBeenCalledWith('sent');

    // Raising again while one is active is a no-op.
    await env.controller.raiseSos();
    expect(Object.keys(useRideStore.getState().sos)).toHaveLength(1);
  });

  it('cancels locally at once and tells the server and the voice channel', async () => {
    const { socket, controller, voice, spies } = await startedRide();
    socket.respond = (event, payload) =>
      event === 'sos:raise' ? { ok: true, sos: sosFrom(SELF, (payload as { id: string }).id) } : { ok: true };
    await controller.raiseSos();
    const id = Object.keys(useRideStore.getState().sos)[0]!;
    await controller.cancelSos(id);
    expect(useRideStore.getState().sos[id]).toBeUndefined();
    expect(socket.sentEvents('sos:cancel').at(-1)?.payload).toEqual({ id });
    expect(voice.sendData).toHaveBeenCalledWith({ type: 'sos-cancel', id, riderId: SELF });
    expect(spies.setSosMode).toHaveBeenLastCalledWith(false);
  });
});

describe('breaks', () => {
  it('enforces the cooldown locally after a successful request', async () => {
    const { socket, controller } = await startedRide();
    socket.respond = (event, payload) =>
      event === 'break:request'
        ? { ok: true, alert: { id: (payload as { id: string }).id, riderId: SELF, kind: 'break', location: null, at: 1 } }
        : { ok: true };
    expect(await controller.requestBreak('break')).toEqual({ ok: true });
    const second = await controller.requestBreak('break');
    expect(second).toMatchObject({ ok: false, error: 'cooldown' });
    expect(socket.sentEvents('break:request')).toHaveLength(1);
  });
});

describe('connection lifecycle', () => {
  it('rejoins with the same identity after a reconnect and applies the new snapshot', async () => {
    const { socket, voice } = await startedRide();
    const firstAuth = (socket.sentEvents('ride:create')[0]!.payload as { rider: { id: string } }).rider;
    socket.disconnect();
    expect(useRideStore.getState().connection).toBe('reconnecting');

    socket.respond = (event) =>
      event === 'ride:join'
        ? { ok: true, ...joinResult({ riders: [rider(SELF, 'Me', { role: 'leader' }), rider(BOB, 'Bob')] }) }
        : { ok: true };
    socket.connect();
    await flush();
    const join = socket.sentEvents('ride:join').at(-1)!.payload as { code: string; rider: { id: string } };
    expect(join.code).toBe('ABCD23');
    expect(join.rider.id).toBe(firstAuth.id);
    expect(Object.keys(useRideStore.getState().riders)).toHaveLength(2);
    expect(useRideStore.getState().connection).toBe('connected');
    expect(voice.update).toHaveBeenCalled();
  });

  it('clears "offline" when the network returns and the socket survived the blip', async () => {
    const { socket, setOnline } = await startedRide();
    setOnline(false);
    expect(useRideStore.getState().connection).toBe('offline');
    // The browser only froze the socket, so it never saw a disconnect: nothing to rejoin.
    setOnline(true);
    await flush();
    expect(socket.connected).toBe(true);
    expect(useRideStore.getState().connection).toBe('connected');
    expect(socket.sentEvents('ride:join')).toHaveLength(0);
  });

  it('reconnects and rejoins when the network returns after the socket dropped', async () => {
    const { socket, setOnline } = await startedRide();
    setOnline(false);
    socket.disconnect();
    expect(useRideStore.getState().connection).toBe('offline');
    setOnline(true);
    await flush();
    expect(socket.connected).toBe(true);
    expect(socket.sentEvents('ride:join')).toHaveLength(1);
    expect(useRideStore.getState().connection).toBe('connected');
  });

  it('ends the ride locally when the server no longer knows it', async () => {
    const { socket, voice } = await startedRide();
    socket.disconnect();
    socket.respond = () => ({ ok: false, error: 'ride_not_found' });
    socket.connect();
    await flush();
    await flush();
    expect(useRideStore.getState().ride).toBeNull();
    expect(voice.stop).toHaveBeenCalled();
    expect(useLocalStore.getState().ui.toasts.at(-1)?.title).toBe('This ride has ended.');
  });

  it('goes inert when the session is replaced by another device', async () => {
    const { socket, voice } = await startedRide();
    socket.fire('session:replaced');
    await flush();
    expect(useLocalStore.getState().ui.sessionReplaced).toBe(true);
    expect(voice.stop).toHaveBeenCalled();
  });

  it('leaves: tells the server, stops services, clears state', async () => {
    const { socket, controller, voice, location } = await startedRide();
    await controller.leaveRide();
    expect(socket.sentEvents('ride:leave')).toHaveLength(1);
    expect(voice.stop).toHaveBeenCalled();
    expect(location.stop).toHaveBeenCalled();
    expect(useRideStore.getState().ride).toBeNull();
    expect(window.localStorage.getItem('intercom:lastRide')).toBeNull();
    expect(window.location.pathname).toBe('/');
  });
});

describe('roster, route, voice and location events', () => {
  it('tracks joins and leaves with sounds', async () => {
    const { socket, spies } = await startedRide();
    const dave = rider('44444444-4444-4444-8444-444444444444', 'Dave');
    socket.fire('rider:joined', dave);
    expect(useRideStore.getState().riders[dave.id]).toBeDefined();
    expect(spies.chime).toHaveBeenCalledWith('join');
    socket.fire('rider:left', { riderId: dave.id });
    expect(useRideStore.getState().riders[dave.id]).toBeUndefined();
    expect(spies.chime).toHaveBeenCalledWith('leave');
  });

  it('applies route, leader and voice-mode changes', async () => {
    const { socket, voice } = await startedRide();
    const route = {
      id: 'r1',
      destination: { name: 'Lonavala', lat: 18.75, lng: 73.4 },
      waypoints: [],
      geometry: [[73.85, 18.52], [73.4, 18.75]] as [number, number][],
      distanceM: 60_000,
      durationS: 3_600,
      provider: 'mock' as const,
      profile: 'motorcycle' as const,
      setBy: BOB,
      setAt: 1,
    };
    socket.fire('route:updated', { route, by: BOB });
    expect(useRideStore.getState().route?.id).toBe('r1');
    socket.fire('leader:changed', { leaderId: BOB, by: SELF });
    expect(useRideStore.getState().ride?.leaderId).toBe(BOB);
    expect(useRideStore.getState().riders[BOB]?.role).toBe('leader');
    const info = { mode: 'mesh' as const, available: ['livekit', 'mesh'] as ('livekit' | 'mesh')[], livekit: null, iceServers: [] };
    socket.fire('voice:mode', { voice: info, by: BOB });
    expect(useRideStore.getState().ride?.voiceMode).toBe('mesh');
    expect(voice.update).toHaveBeenCalledWith(info);
  });

  it('sends location fixes as volatile emits and keeps our own entry current', async () => {
    const { socket, sendFix } = await startedRide();
    const fix = { lat: 18.6, lng: 73.9, acc: 4, spd: 20, hdg: 90, t: Date.now() + 10 };
    sendFix(fix);
    expect(socket.sentEvents('loc:update').at(-1)).toMatchObject({ payload: fix, volatile: true });
    expect(useRideStore.getState().riders[SELF]?.location).toEqual(fix);
  });

  it('relays other riders positions into the store, ignoring stale fixes', async () => {
    const { socket } = await startedRide();
    const fix = { lat: 18.6, lng: 73.9, acc: 4, spd: 20, hdg: 90, t: 2_000 };
    socket.fire('loc:relay', { riderId: BOB, fix, rt: 5 });
    socket.fire('loc:relay', { riderId: BOB, fix: { ...fix, lat: 10, t: 1_000 }, rt: 6 });
    expect(useRideStore.getState().riders[BOB]?.location?.lat).toBe(18.6);
  });

  it('pushes audio settings to the engine when they change', async () => {
    const { spies } = await startedRide();
    spies.applySettings.mockClear();
    useSettings.getState().update({ duckLevel: 0.15 });
    expect(spies.applySettings).toHaveBeenCalledWith(expect.objectContaining({ duckLevel: 0.15 }));
    spies.applySettings.mockClear();
    useSettings.getState().update({ headingUp: true });
    expect(spies.applySettings).not.toHaveBeenCalled();
  });

  it('persists mic mode and reports it to the server during a ride', async () => {
    const { socket, controller, spies } = await startedRide();
    await controller.setMicMode('open');
    await controller.setMicMode('off');
    expect(useSettings.getState().micMode).toBe('off');
    // Unmuting restores the last live mode.
    expect(useSettings.getState().liveMicMode).toBe('open');
    expect(spies.setMicMode).toHaveBeenLastCalledWith('off');
    expect(socket.sentEvents('rider:update').at(-1)?.payload).toEqual({ micMode: 'off' });
  });
});
