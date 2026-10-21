import { LIMITS } from '@intercom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { closeAllServers, createRide, emitRaw, fix, flush, joinRide, record, rideWith, startServer } from './support/harness';

afterEach(closeAllServers);

describe('loc:update', () => {
  it('relays to everyone but the sender and stores the fix', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 2);
    const [bob, carol] = riders as [(typeof riders)[0], (typeof riders)[0]];
    const events = [leader, bob, carol].map((m) => record(m.socket));

    t.clock.advance(40);
    emitRaw(bob.socket, 'loc:update', fix(5_000));
    await flush(bob.socket, leader.socket, carol.socket);
    const relay = { riderId: bob.auth.id, fix: fix(5_000), rt: t.clock.t };
    expect(events[0]!.of('loc:relay')).toEqual([relay]);
    expect(events[2]!.of('loc:relay')).toEqual([relay]);
    expect(events[1]!.events).toEqual([]);

    // Late joiners get it in the snapshot.
    const late = await joinRide(t, code, 'Late');
    expect(late.join.snapshot.riders.find((r) => r.id === bob.auth.id)).toMatchObject({
      location: fix(5_000),
      locationAt: t.clock.t,
      lastSeenAt: t.clock.t,
    });
  });

  it(`drops fixes beyond ${LIMITS.locPerSecond} per second`, async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    for (let i = 1; i <= LIMITS.locPerSecond + 3; i++) emitRaw(bob.socket, 'loc:update', fix(i));
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('loc:relay').map((r) => r.fix.t)).toEqual([1, 2, 3, 4]);

    t.clock.advance(1_000 / LIMITS.locPerSecond);
    emitRaw(bob.socket, 'loc:update', fix(100));
    emitRaw(bob.socket, 'loc:update', fix(101));
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('loc:relay').map((r) => r.fix.t)).toEqual([1, 2, 3, 4, 100]);
  });

  it('drops fixes that are not newer than the stored one', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    emitRaw(bob.socket, 'loc:update', fix(2_000));
    emitRaw(bob.socket, 'loc:update', fix(1_000));
    emitRaw(bob.socket, 'loc:update', fix(2_000));
    emitRaw(bob.socket, 'loc:update', fix(3_000));
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('loc:relay').map((r) => r.fix.t)).toEqual([2_000, 3_000]);
  });

  it('silently drops invalid fixes and fixes from sockets outside a ride', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    emitRaw(bob.socket, 'loc:update', { ...fix(1), lat: 123 });
    emitRaw(bob.socket, 'loc:update', { ...fix(2), t: Number.MAX_VALUE * 2 });
    emitRaw(bob.socket, 'loc:update', 'here');
    emitRaw(bob.socket, 'loc:update');
    await flush(bob.socket);
    // Junk still counts against the rate limit; refill before the valid fix.
    t.clock.advance(1_000);
    emitRaw(bob.socket, 'loc:update', fix(3), () => undefined);
    const stranger = await t.connect();
    emitRaw(stranger, 'loc:update', fix(4));
    await flush(bob.socket, stranger, leader.socket);
    expect(leaderEvents.of('loc:relay').map((r) => r.fix.t)).toEqual([3]);
  });
});

describe('rtc:signal', () => {
  const offer = { description: { type: 'offer', sdp: 'v=0\r\n' } };

  it('reaches only the addressed rider, tagged with the sender', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 2);
    const [bob, carol] = riders as [(typeof riders)[0], (typeof riders)[0]];
    const events = [leader, bob, carol].map((m) => record(m.socket));
    emitRaw(leader.socket, 'rtc:signal', { to: bob.auth.id, data: offer });
    const candidate = { candidate: { candidate: 'candidate:1 1 udp 2122260223 10.0.0.2 51234 typ host', sdpMid: '0', sdpMLineIndex: 0 } };
    emitRaw(carol.socket, 'rtc:signal', { to: bob.auth.id, data: candidate });
    await flush(leader.socket, carol.socket, bob.socket);
    expect(events[1]!.of('rtc:signal')).toEqual([
      { from: leader.auth.id, data: offer },
      { from: carol.auth.id, data: candidate },
    ]);
    expect(events[0]!.events).toEqual([]);
    expect(events[2]!.events).toEqual([]);
  });

  it('drops signals to offline riders, other rides, oneself, and invalid signals', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 2);
    const [bob, carol] = riders as [(typeof riders)[0], (typeof riders)[0]];
    const other = await createRide(t, 'Elsewhere');
    const outsider = await joinRide(t, other.join.snapshot.code, 'Outsider');
    carol.socket.disconnect();
    const watched = [leader, bob, other, outsider].map((m) => record(m.socket));
    await flush(leader.socket);

    emitRaw(leader.socket, 'rtc:signal', { to: carol.auth.id, data: offer }); // offline
    emitRaw(leader.socket, 'rtc:signal', { to: outsider.auth.id, data: offer }); // other ride
    emitRaw(outsider.socket, 'rtc:signal', { to: bob.auth.id, data: offer }); // other ride, reverse
    emitRaw(leader.socket, 'rtc:signal', { to: leader.auth.id, data: offer }); // self
    emitRaw(leader.socket, 'rtc:signal', { to: bob.auth.id, data: {} }); // neither description nor candidate
    emitRaw(leader.socket, 'rtc:signal', { to: bob.auth.id, data: { description: { type: 'offer', sdp: 'x'.repeat(LIMITS.sdpMaxChars + 1) } } });
    emitRaw(leader.socket, 'rtc:signal', { to: 'not-a-uuid', data: offer });
    await flush(leader.socket, outsider.socket, bob.socket, other.socket);
    for (const w of watched) expect(w.of('rtc:signal')).toEqual([]);
  });

  it(`drops signals beyond ${LIMITS.rtcSignalPerSecond} per second`, async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const bobEvents = record(bob.socket);
    for (let i = 0; i < LIMITS.rtcSignalPerSecond + 10; i++) {
      emitRaw(leader.socket, 'rtc:signal', { to: bob.auth.id, data: offer });
    }
    await flush(leader.socket, bob.socket);
    expect(bobEvents.of('rtc:signal')).toHaveLength(LIMITS.rtcSignalPerSecond);
  });
});
