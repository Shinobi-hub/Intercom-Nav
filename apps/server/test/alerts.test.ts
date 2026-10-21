import { randomUUID } from 'node:crypto';
import { LIMITS, TIMING } from '@intercom/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { call, closeAllServers, emitRaw, fix, flush, joinRide, ok, record, rideWith, startServer } from './support/harness';

afterEach(closeAllServers);

describe('sos:raise', () => {
  it("broadcasts to the whole ride, raiser included, defaulting to the raiser's last location", async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    emitRaw(bob.socket, 'loc:update', fix(1_000, 18.6, 73.9));
    await flush(bob.socket);
    const bobEvents = record(bob.socket);
    const leaderEvents = record(leader.socket);

    const id = randomUUID();
    t.clock.advance(250);
    const res = ok(await call(bob.socket, 'sos:raise', { id, location: null }));
    expect(res.sos).toEqual({ id, riderId: bob.auth.id, location: fix(1_000, 18.6, 73.9), raisedAt: t.clock.t, responders: [] });
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('sos:raised')).toEqual([res.sos]);
    expect(bobEvents.of('sos:raised')).toEqual([res.sos]);
  });

  it('is idempotent by id: retries return the same alert without a second broadcast', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    const id = randomUUID();
    const first = ok(await call(bob.socket, 'sos:raise', { id, location: fix(5) }));
    t.clock.advance(3_000);
    const retry = ok(await call(bob.socket, 'sos:raise', { id, location: fix(9) }));
    expect(retry.sos).toEqual(first.sos);
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('sos:raised')).toHaveLength(1);
  });

  it('caps active alerts per rider and new alerts per minute', async () => {
    const t = await startServer();
    const { riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const ids: string[] = [];
    for (let i = 0; i < LIMITS.maxActiveSosPerRider; i++) {
      const id = randomUUID();
      ids.push(id);
      ok(await call(bob.socket, 'sos:raise', { id, location: null }));
    }
    expect(await call(bob.socket, 'sos:raise', { id: randomUUID(), location: null })).toMatchObject({
      ok: false,
      error: 'rate_limited',
    });
    // Retrying an existing alert is always fine.
    ok(await call(bob.socket, 'sos:raise', { id: ids[0], location: null }));

    // Cancel-and-raise churn hits the per-minute limit (one token was spent on the refusal above).
    for (const id of ids) ok(await call(bob.socket, 'sos:cancel', { id }));
    let raised = 0;
    let last: unknown;
    for (let i = 0; i < LIMITS.sosPerMinute; i++) {
      const id = randomUUID();
      last = await call(bob.socket, 'sos:raise', { id, location: null });
      if ((last as { ok: boolean }).ok) {
        raised++;
        ok(await call(bob.socket, 'sos:cancel', { id }));
      }
    }
    expect(raised).toBe(LIMITS.sosPerMinute - LIMITS.maxActiveSosPerRider - 1);
    expect(last).toMatchObject({ ok: false, error: 'rate_limited', retryInMs: expect.any(Number) });
    t.clock.advance(60_000);
    ok(await call(bob.socket, 'sos:raise', { id: randomUUID(), location: null }));
  });

  it('shows active alerts to late joiners', async () => {
    const t = await startServer();
    const { code, riders } = await rideWith(t, 1);
    const sos = ok(await call(riders[0]!.socket, 'sos:raise', { id: randomUUID(), location: fix(1) })).sos;
    const late = await joinRide(t, code, 'Late');
    expect(late.join.snapshot.activeSos).toEqual([sos]);
  });
});

describe('sos:cancel', () => {
  it('only the raiser or the leader may cancel', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 2);
    const [bob, carol] = riders as [(typeof riders)[0], (typeof riders)[0]];
    const id = randomUUID();
    ok(await call(bob.socket, 'sos:raise', { id, location: null }));
    expect(await call(carol.socket, 'sos:cancel', { id })).toMatchObject({ ok: false, error: 'not_leader' });

    const carolEvents = record(carol.socket);
    t.clock.advance(10);
    expect(await call(leader.socket, 'sos:cancel', { id })).toEqual({ ok: true });
    await flush(leader.socket, carol.socket);
    expect(carolEvents.of('sos:cancelled')).toEqual([{ id, riderId: bob.auth.id, by: leader.auth.id, at: t.clock.t }]);

    const own = randomUUID();
    ok(await call(bob.socket, 'sos:raise', { id: own, location: null }));
    ok(await call(bob.socket, 'sos:cancel', { id: own }));
    expect(await call(bob.socket, 'sos:cancel', { id: own })).toMatchObject({ error: 'not_found' });
  });

  it('a late retry cannot resurrect a cancelled alert', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const id = randomUUID();
    ok(await call(bob.socket, 'sos:raise', { id, location: null }));
    ok(await call(bob.socket, 'sos:cancel', { id }));
    const leaderEvents = record(leader.socket);
    expect(await call(bob.socket, 'sos:raise', { id, location: null })).toMatchObject({ ok: false, error: 'not_found' });
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('sos:raised')).toEqual([]);
  });

  it("cancels a leaving rider's alerts", async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const id = randomUUID();
    ok(await call(bob.socket, 'sos:raise', { id, location: null }));
    await flush(bob.socket, leader.socket);
    const leaderEvents = record(leader.socket);
    ok(await call(bob.socket, 'ride:leave', {}));
    await flush(leader.socket);
    expect(leaderEvents.names()).toEqual(['sos:cancelled', 'rider:left']);
    expect(leaderEvents.of('sos:cancelled')[0]).toMatchObject({ id, riderId: bob.auth.id, by: bob.auth.id });
  });
});

describe('sos:respond', () => {
  it('adds each responder once, ignores the raiser and broadcasts changes', async () => {
    const t = await startServer();
    const { leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const id = randomUUID();
    ok(await call(bob.socket, 'sos:raise', { id, location: null }));
    const bobEvents = record(bob.socket);

    t.clock.advance(1_500);
    const res = ok(await call(leader.socket, 'sos:respond', { id }));
    expect(res.sos.responders).toEqual([{ riderId: leader.auth.id, at: t.clock.t }]);
    ok(await call(leader.socket, 'sos:respond', { id }));
    expect(ok(await call(bob.socket, 'sos:respond', { id })).sos.responders).toHaveLength(1);
    await flush(leader.socket, bob.socket);
    expect(bobEvents.of('sos:updated')).toEqual([res.sos]);
    expect(await call(leader.socket, 'sos:respond', { id: randomUUID() })).toMatchObject({ error: 'not_found' });
  });
});

describe('break:request', () => {
  it('broadcasts, is idempotent by id, and enforces the cooldown', async () => {
    const t = await startServer();
    const { code, leader, riders } = await rideWith(t, 1);
    const bob = riders[0]!;
    const leaderEvents = record(leader.socket);
    const bobEvents = record(bob.socket);

    const id = randomUUID();
    const first = ok(await call(bob.socket, 'break:request', { id, kind: 'fuel', location: fix(3) }));
    expect(first.alert).toEqual({ id, riderId: bob.auth.id, kind: 'fuel', location: fix(3), at: t.clock.t });
    expect(ok(await call(bob.socket, 'break:request', { id, kind: 'fuel', location: null })).alert).toEqual(first.alert);

    t.clock.advance(12_000);
    expect(await call(bob.socket, 'break:request', { id: randomUUID(), kind: 'food', location: null })).toEqual({
      ok: false,
      error: 'cooldown',
      message: expect.any(String),
      retryInMs: TIMING.breakCooldownMs - 12_000,
    });
    // The cooldown is per rider.
    ok(await call(leader.socket, 'break:request', { id: randomUUID(), kind: 'restroom', location: null }));

    t.clock.advance(TIMING.breakCooldownMs - 12_000);
    const second = ok(await call(bob.socket, 'break:request', { id: randomUUID(), kind: 'break', location: null }));
    await flush(bob.socket, leader.socket);
    expect(leaderEvents.of('break:requested').map((b) => b.kind)).toEqual(['fuel', 'restroom', 'break']);
    expect(bobEvents.of('break:requested')).toHaveLength(3);

    // Late joiners see recent breaks, newest first, until they expire.
    const late = await joinRide(t, code, 'Late');
    expect(late.join.snapshot.recentBreaks.map((b) => b.id)).toEqual([second.alert.id, expect.any(String), id]);
    t.clock.advance(TIMING.recentBreakMs);
    expect((await joinRide(t, code, 'Later')).join.snapshot.recentBreaks).toEqual([]);
  });

  it('honours BREAK_COOLDOWN_MS', async () => {
    const t = await startServer({ BREAK_COOLDOWN_MS: '0' });
    const { riders } = await rideWith(t, 1);
    for (let i = 0; i < 3; i++) ok(await call(riders[0]!.socket, 'break:request', { id: randomUUID(), kind: 'break', location: null }));
  });
});
