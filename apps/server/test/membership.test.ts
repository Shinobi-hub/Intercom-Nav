import { isValidRideCode, TIMING } from '@intercom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  call,
  closeAllServers,
  createRide,
  flush,
  joinRide,
  newRider,
  nextEvent,
  ok,
  record,
  rideWith,
  startServer,
  waitForDisconnect,
} from './support/harness';

afterEach(closeAllServers);

describe('ride:create', () => {
  it('creates a ride led by its creator', async () => {
    const t = await startServer();
    const { join, auth } = await createRide(t, 'Alice');
    expect(isValidRideCode(join.snapshot.code)).toBe(true);
    expect(join.selfId).toBe(auth.id);
    expect(join.resumed).toBe(false);
    expect(join.snapshot).toMatchObject({
      leaderId: auth.id,
      voiceMode: 'mesh',
      maxRiders: 8,
      route: null,
      activeSos: [],
      recentBreaks: [],
      createdAt: t.clock.t,
      serverNow: t.clock.t,
    });
    expect(join.snapshot.riders).toEqual([
      {
        id: auth.id,
        name: 'Alice',
        color: auth.color,
        role: 'leader',
        online: true,
        joinedAt: t.clock.t,
        lastSeenAt: t.clock.t,
        location: null,
        locationAt: null,
        micMode: 'vox',
      },
    ]);
    // No LiveKit configured: mesh only, with the default STUN server.
    expect(join.voice).toEqual({
      mode: 'mesh',
      available: ['mesh'],
      livekit: null,
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    expect(JSON.stringify(join)).not.toContain(auth.secret);
  });

  it('allocates distinct codes', async () => {
    const t = await startServer();
    const codes = new Set<string>();
    for (let i = 0; i < 5; i++) codes.add((await createRide(t)).join.snapshot.code);
    expect(codes.size).toBe(5);
  });

  it('retries when a generated code is taken', async () => {
    const codes = ['AAAAAA', 'AAAAAA', 'BBBBBB'];
    const t = await startServer({}, { generateRideCode: () => codes.shift() ?? 'CCCCCC' });
    expect((await createRide(t)).join.snapshot.code).toBe('AAAAAA');
    expect((await createRide(t)).join.snapshot.code).toBe('BBBBBB');
  });
});

describe('ride:join', () => {
  it('adds the rider and tells everyone, the joiner after its ack', async () => {
    const t = await startServer();
    const leader = await createRide(t, 'Alice');
    const leaderEvents = record(leader.socket);
    const socket = await t.connect();
    const joinerEvents = record(socket);
    const auth = newRider('Bob');
    // Codes are case- and separator-insensitive.
    const code = leader.join.snapshot.code;
    const join = ok(await call(socket, 'ride:join', { code: `${code.slice(0, 3)}-${code.slice(3)}`.toLowerCase(), rider: auth }));
    expect(join.resumed).toBe(false);
    expect(join.snapshot.riders.map((r) => [r.name, r.role])).toEqual([
      ['Alice', 'leader'],
      ['Bob', 'rider'],
    ]);
    await flush(socket, leader.socket);
    const joinedForLeader = leaderEvents.of('rider:joined');
    expect(joinedForLeader).toEqual([expect.objectContaining({ id: auth.id, name: 'Bob', online: true, role: 'rider' })]);
    expect(joinerEvents.of('rider:joined')).toEqual(joinedForLeader);
  });

  it('rejects unknown and malformed codes', async () => {
    const t = await startServer();
    const socket = await t.connect();
    expect(await call(socket, 'ride:join', { code: 'ZZZZZZ', rider: newRider() })).toMatchObject({
      ok: false,
      error: 'ride_not_found',
    });
    expect(await call(socket, 'ride:join', { code: 'ABC0O1', rider: newRider() })).toEqual({ ok: false, error: 'invalid_payload' });
  });

  it('resumes after a disconnect with a fresh snapshot', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const offline = nextEvent(leader.socket, 'rider:updated');
    t.clock.advance(1_000);
    bob.socket.disconnect();
    expect(await offline).toMatchObject({ id: bob.auth.id, online: false, lastSeenAt: t.clock.t });

    t.clock.advance(5_000);
    const online = nextEvent(leader.socket, 'rider:updated');
    const again = await joinRide(t, code, 'Bob', { ...bob.auth, name: 'Bobby' });
    expect(again.join.resumed).toBe(true);
    expect(again.join.selfId).toBe(bob.auth.id);
    expect(await online).toMatchObject({ id: bob.auth.id, online: true, name: 'Bobby', lastSeenAt: t.clock.t });
    const me = again.join.snapshot.riders.find((r) => r.id === bob.auth.id);
    expect(me).toMatchObject({ online: true, joinedAt: bob.join.snapshot.riders[1]!.joinedAt });
    expect(again.join.snapshot.riders).toHaveLength(2);
  });

  it('refuses a known rider id with the wrong secret', async () => {
    const t = await startServer();
    const { code, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const mallory = await t.connect();
    expect(await call(mallory, 'ride:join', { code, rider: { ...bob.auth, secret: 'definitely-not-bobs-secret' } })).toMatchObject({
      ok: false,
      error: 'rider_conflict',
    });
    // Bob is untouched and still connected.
    expect(bob.socket.connected).toBe(true);
    ok(await call(bob.socket, 'rider:update', { micMode: 'open' }));
  });

  it('replaces the old session when the same rider joins from another socket', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    const replaced = nextEvent(bob.socket, 'session:replaced');
    const disconnected = waitForDisconnect(bob.socket);

    const second = await joinRide(t, code, 'Bob', bob.auth);
    expect(second.join.resumed).toBe(true);
    await replaced;
    expect(await disconnected).toBe('io server disconnect');

    // The old socket going away must not flip Bob offline.
    await flush(second.socket, leader.socket);
    const updates = leaderEvents.of('rider:updated').filter((r) => r.id === bob.auth.id);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((r) => r.online)).toBe(true);
    const snapshot = (await joinRide(t, code, 'Carol')).join.snapshot;
    expect(snapshot.riders.find((r) => r.id === bob.auth.id)?.online).toBe(true);
    ok(await call(second.socket, 'rider:update', { name: 'Bob 2' }));
  });

  it('is full at MAX_RIDERS, until riders offline longer than riderPruneMs are pruned', async () => {
    const t = await startServer({ MAX_RIDERS: '3' });
    const { code, leader, riders } = await rideWith(t, 2);
    const [bob] = riders;
    expect(await call(await t.connect(), 'ride:join', { code, rider: newRider() })).toMatchObject({
      ok: false,
      error: 'ride_full',
    });

    bob!.socket.disconnect();
    await nextEvent(leader.socket, 'rider:updated');
    t.clock.advance(TIMING.riderPruneMs);
    expect(await call(await t.connect(), 'ride:join', { code, rider: newRider() })).toMatchObject({ error: 'ride_full' });

    t.clock.advance(1);
    const leaderEvents = record(leader.socket);
    const dave = await joinRide(t, code, 'Dave');
    expect(dave.join.snapshot.riders.map((r) => r.name)).toEqual(['Leader', 'Rider 2', 'Dave']);
    await flush(dave.socket, leader.socket);
    expect(leaderEvents.events.map((e) => e.event)).toEqual(['rider:left', 'rider:joined']);
    expect(leaderEvents.of('rider:left')).toEqual([{ riderId: bob!.auth.id }]);

    // The pruned rider's slot is gone: coming back is a fresh join (and the ride is full again).
    expect(await call(await t.connect(), 'ride:join', { code, rider: bob!.auth })).toMatchObject({ error: 'ride_full' });
  });
});

describe('ride:leave', () => {
  it('removes the rider, hands leadership to the earliest-joined online rider and ends empty rides', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 2);
    const [bob, carol] = riders as [(typeof riders)[0], (typeof riders)[0]];
    const leaderEvents = record(leader.socket);
    const carolEvents = record(carol.socket);

    expect(await call(leader.socket, 'ride:leave', {})).toEqual({ ok: true });
    await flush(bob.socket, carol.socket);
    expect(carolEvents.names()).toEqual(['rider:left', 'leader:changed', 'rider:updated']);
    expect(carolEvents.of('rider:left')).toEqual([{ riderId: leader.auth.id }]);
    expect(carolEvents.of('leader:changed')).toEqual([{ leaderId: bob.auth.id, by: null }]);
    expect(carolEvents.of('rider:updated')[0]).toMatchObject({ id: bob.auth.id, role: 'leader' });
    // The leaver is out of the room: it never hears about its own departure.
    await flush(leader.socket);
    expect(leaderEvents.events).toEqual([]);
    expect(await call(leader.socket, 'rider:update', { micMode: 'off' })).toMatchObject({ ok: false, error: 'not_in_ride' });

    ok(await call(bob.socket, 'ride:leave'));
    ok(await call(carol.socket, 'ride:leave', {}));
    expect(await call(await t.connect(), 'ride:join', { code, rider: newRider() })).toMatchObject({
      error: 'ride_not_found',
    });
    expect(t.server.store.rideCount).toBe(0);
  });

  it('prefers an online rider over an offline earlier joiner', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 2);
    const [bob, carol] = riders as [(typeof riders)[0], (typeof riders)[0]];
    bob.socket.disconnect();
    await nextEvent(carol.socket, 'rider:updated');
    const changed = nextEvent(carol.socket, 'leader:changed');
    ok(await call(leader.socket, 'ride:leave', {}));
    expect(await changed).toEqual({ leaderId: carol.auth.id, by: null });
  });

  it('answers not_in_ride when not in a ride', async () => {
    const t = await startServer();
    expect(await call(await t.connect(), 'ride:leave', {})).toEqual({ ok: false, error: 'not_in_ride' });
  });
});

describe('one ride per socket', () => {
  it('leaves the first ride when the socket creates or joins another', async () => {
    const t = await startServer();
    const first = await rideWith(t, 1);
    const bob = first.riders[0]!;
    const leaderEvents = record(first.leader.socket);

    const created = ok(await call(bob.socket, 'ride:create', { rider: bob.auth }));
    expect(created.snapshot.code).not.toBe(first.code);
    expect(created.snapshot.leaderId).toBe(bob.auth.id);
    await flush(bob.socket, first.leader.socket);
    expect(leaderEvents.of('rider:left')).toEqual([{ riderId: bob.auth.id }]);

    // Events in the old ride no longer reach Bob.
    const bobEvents = record(bob.socket);
    ok(await call(first.leader.socket, 'rider:update', { name: 'Renamed' }));
    await flush(first.leader.socket, bob.socket);
    expect(bobEvents.events).toEqual([]);

    // Joining back moves Bob again, out of his own ride (which then ends).
    const rejoined = ok(await call(bob.socket, 'ride:join', { code: first.code, rider: bob.auth }));
    expect(rejoined.resumed).toBe(false);
    expect(t.server.store.get(created.snapshot.code)).toBeUndefined();
  });

  it('re-joining the same ride on the same socket is a harmless resume', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    const again = ok(await call(bob.socket, 'ride:join', { code, rider: bob.auth }));
    expect(again.resumed).toBe(true);
    expect(bob.socket.connected).toBe(true);
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.names()).toEqual(['rider:updated']);
    expect(leaderEvents.of('rider:updated')[0]).toMatchObject({ id: bob.auth.id, online: true });
  });
});

describe('rider:update', () => {
  it('updates the profile and broadcasts only real changes', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    const res = ok(await call(bob.socket, 'rider:update', { name: '  Bob B  ', color: '#30D158', micMode: 'off' }));
    expect(res.rider).toMatchObject({ id: bob.auth.id, name: 'Bob B', color: '#30D158', micMode: 'off', role: 'rider' });
    ok(await call(bob.socket, 'rider:update', { micMode: 'off' }));
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('rider:updated')).toEqual([res.rider]);
    expect(await call(bob.socket, 'rider:update', {})).toEqual({ ok: false, error: 'invalid_payload' });
  });
});

describe('leader:transfer', () => {
  it('lets the leader hand over to an online rider', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 2);
    const [bob, carol] = riders as [(typeof riders)[0], (typeof riders)[0]];
    expect(await call(bob.socket, 'leader:transfer', { to: carol.auth.id })).toMatchObject({ error: 'not_leader' });
    expect(await call(leader.socket, 'leader:transfer', { to: newRider().id })).toMatchObject({ error: 'not_found' });

    const carolEvents = record(carol.socket);
    ok(await call(leader.socket, 'leader:transfer', { to: bob.auth.id }));
    await flush(leader.socket, carol.socket);
    expect(carolEvents.of('leader:changed')).toEqual([{ leaderId: bob.auth.id, by: leader.auth.id }]);
    expect(carolEvents.of('rider:updated').map((r) => [r.id, r.role])).toEqual([
      [leader.auth.id, 'rider'],
      [bob.auth.id, 'leader'],
    ]);
    // Powers moved with it.
    expect(await call(leader.socket, 'route:clear', {})).toMatchObject({ error: 'not_leader' });
    ok(await call(bob.socket, 'route:clear', {}));
  });

  it('refuses offline riders', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    riders[0]!.socket.disconnect();
    await nextEvent(leader.socket, 'rider:updated');
    expect(await call(leader.socket, 'leader:transfer', { to: riders[0]!.auth.id })).toMatchObject({
      ok: false,
      error: 'not_found',
    });
  });
});

describe('time:sync', () => {
  it('echoes t0 with the server clock, even before joining', async () => {
    const t = await startServer();
    const socket = await t.connect();
    expect(await call(socket, 'time:sync', { t0: 12.5 })).toEqual({ t0: 12.5, serverNow: t.clock.t });
    expect(await call(socket, 'time:sync', { t0: 'soon' })).toEqual({ ok: false, error: 'invalid_payload' });
  });
});

describe('presence', () => {
  it('records activity from any message in lastSeenAt', async () => {
    const t = await startServer();
    const { code, riders } = await rideWith(t, 1);
    t.clock.advance(7_000);
    await call(riders[0]!.socket, 'time:sync', { t0: 0 });
    const ride = t.server.store.get(code)!;
    expect(ride.riders.get(riders[0]!.auth.id)!.lastSeenAt).toBe(t.clock.t);
  });
});
