import { randomUUID } from 'node:crypto';
import { LIMITS, TIMING, type LocationFix, type RideRoute, type RiderAuth } from '@intercom/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { hashSecret, secretMatches } from './secret';
import { RideStore, type Outcome } from './store';

const T0 = 1_750_000_000_000;

function setup(overrides: { maxRiders?: number; codes?: string[] } = {}) {
  let t = T0;
  const codes = overrides.codes ? [...overrides.codes] : null;
  let n = 0;
  const store = new RideStore({
    now: () => t,
    maxRiders: overrides.maxRiders ?? 8,
    timing: {
      leaderGraceMs: TIMING.leaderGraceMs,
      riderPruneMs: TIMING.riderPruneMs,
      rideIdleTtlMs: TIMING.rideIdleTtlMs,
      breakCooldownMs: TIMING.breakCooldownMs,
      recentBreakMs: TIMING.recentBreakMs,
    },
    generateCode: codes ? () => codes.shift() ?? `ZZZZ${String(n++).padStart(2, '2')}` : undefined,
  });
  return { store, advance: (ms: number) => void (t += ms), now: () => t };
}

function auth(name = 'Rider', secret = 'correct-horse-battery-staple'): RiderAuth {
  return { id: randomUUID(), secret, name, color: '#0A84FF' };
}

function fix(t: number, lat = 18.52, lng = 73.85): LocationFix {
  return { lat, lng, acc: 5, spd: 10, hdg: 90, t };
}

/** Unwraps an ok outcome, failing the test otherwise. */
function ok<T extends object>(res: Outcome<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.error}`);
  return res;
}

function errorOf(res: Outcome<object>): string | undefined {
  return res.ok ? undefined : res.error;
}

describe('secrets', () => {
  it('stores a SHA-256 hash and compares in constant time', () => {
    const hash = hashSecret('s3cret-s3cret-s3cret');
    expect(hash).toHaveLength(32);
    expect(secretMatches(hash, 's3cret-s3cret-s3cret')).toBe(true);
    expect(secretMatches(hash, 's3cret-s3cret-s3creT')).toBe(false);
  });
});

describe('RideStore: create and join', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup();
  });

  it('creates a ride with the creator as online leader', () => {
    const a = auth('Alice');
    const { ride, rider } = s.store.create(a, 'mesh', 'sa');
    expect(ride.leaderId).toBe(a.id);
    expect(ride.voiceMode).toBe('mesh');
    expect(rider).toMatchObject({ id: a.id, name: 'Alice', online: true, sessionId: 'sa', joinedAt: T0, micMode: 'vox' });
    const snap = s.store.snapshot(ride);
    expect(snap).toMatchObject({ code: ride.code, leaderId: a.id, maxRiders: 8, route: null, activeSos: [], recentBreaks: [] });
    expect(snap.riders).toEqual([expect.objectContaining({ id: a.id, role: 'leader', online: true })]);
    expect(snap.serverNow).toBe(T0);
    expect(JSON.stringify(snap)).not.toContain(a.secret);
  });

  it('retries ride codes on collision', () => {
    const s2 = setup({ codes: ['AAAAAA', 'AAAAAA', 'BBBBBB'] });
    expect(s2.store.create(auth(), 'mesh', 's1').ride.code).toBe('AAAAAA');
    expect(s2.store.create(auth(), 'mesh', 's2').ride.code).toBe('BBBBBB');
  });

  it('gives up after many collisions instead of looping forever', () => {
    const stuck = new RideStore({
      now: () => T0,
      maxRiders: 8,
      timing: { leaderGraceMs: 1, riderPruneMs: 1, rideIdleTtlMs: 1, breakCooldownMs: 1, recentBreakMs: 1 },
      generateCode: () => 'AAAAAA',
    });
    stuck.create(auth(), 'mesh', 's1');
    expect(() => stuck.create(auth(), 'mesh', 's2')).toThrow(/unique ride code/);
  });

  it('joins a new rider', () => {
    const { ride } = s.store.create(auth('Alice'), 'mesh', 'sa');
    s.advance(1000);
    const b = auth('Bob');
    const res = ok(s.store.join(ride.code, b, 'sb'));
    expect(res.resumed).toBe(false);
    expect(res.replacedSessionId).toBeNull();
    expect(res.rider).toMatchObject({ id: b.id, joinedAt: T0 + 1000, online: true });
    expect(s.store.riderState(ride, res.rider).role).toBe('rider');
    expect(s.store.riderCount).toBe(2);
  });

  it('reports unknown rides', () => {
    expect(errorOf(s.store.join('ABCDEF', auth(), 's'))).toBe('ride_not_found');
  });

  it('resumes with the right secret, refreshing profile and session', () => {
    const a = auth('Alice');
    const { ride } = s.store.create(a, 'mesh', 'sa');
    s.store.disconnect(ride.code, a.id, 'sa');
    s.advance(5000);
    const res = ok(s.store.join(ride.code, { ...a, name: 'Alice 2', color: '#30D158' }, 'sa2'));
    expect(res.resumed).toBe(true);
    expect(res.replacedSessionId).toBeNull();
    expect(res.rider).toMatchObject({ name: 'Alice 2', color: '#30D158', online: true, sessionId: 'sa2', joinedAt: T0 });
    expect(res.rider.lastSeenAt).toBe(T0 + 5000);
  });

  it('names the session to replace when the rider is still connected elsewhere', () => {
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'old');
    expect(ok(s.store.join(ride.code, a, 'new')).replacedSessionId).toBe('old');
    // Rejoining on the same session replaces nothing.
    expect(ok(s.store.join(ride.code, a, 'new')).replacedSessionId).toBeNull();
  });

  it('rejects a known rider id with the wrong secret', () => {
    const a = auth('Alice', 'alice-secret-alice-secret');
    const { ride } = s.store.create(a, 'mesh', 'sa');
    expect(errorOf(s.store.join(ride.code, { ...a, secret: 'mallory-secret-mallory' }, 'sm'))).toBe('rider_conflict');
    expect(s.store.get(ride.code)!.riders.get(a.id)!.sessionId).toBe('sa');
  });

  it('refuses new riders when full', () => {
    const s2 = setup({ maxRiders: 2 });
    const a = auth();
    const { ride } = s2.store.create(a, 'mesh', 'sa');
    ok(s2.store.join(ride.code, auth(), 'sb'));
    expect(errorOf(s2.store.join(ride.code, auth(), 'sc'))).toBe('ride_full');
    // Riders already in the ride can always come back.
    expect(ok(s2.store.join(ride.code, a, 'sa2')).resumed).toBe(true);
  });

  it('prunes riders offline longer than riderPruneMs to make room', () => {
    const s2 = setup({ maxRiders: 3 });
    const a = auth('A');
    const b = auth('B');
    const c = auth('C');
    const { ride } = s2.store.create(a, 'mesh', 'sa');
    ok(s2.store.join(ride.code, b, 'sb'));
    ok(s2.store.join(ride.code, c, 'sc'));
    s2.store.disconnect(ride.code, b.id, 'sb');
    s2.advance(TIMING.riderPruneMs);
    expect(errorOf(s2.store.join(ride.code, auth(), 'sd'))).toBe('ride_full'); // not *longer* yet
    s2.advance(1);
    const res = ok(s2.store.join(ride.code, auth('D'), 'sd'));
    expect(res.pruned).toEqual([b.id]);
    expect(res.leaderChange).toBeNull();
    expect([...ride.riders.keys()]).not.toContain(b.id);
  });

  it('does not prune when pruning would not make room', () => {
    const s2 = setup({ maxRiders: 2 });
    const a = auth();
    const b = auth();
    const { ride } = s2.store.create(a, 'mesh', 'sa');
    ok(s2.store.join(ride.code, b, 'sb'));
    s2.advance(TIMING.riderPruneMs + 1);
    expect(errorOf(s2.store.join(ride.code, auth(), 'sc'))).toBe('ride_full');
    expect(ride.riders.size).toBe(2);
  });

  it('never prunes a rider with an active SOS', () => {
    const s2 = setup({ maxRiders: 2 });
    const a = auth();
    const b = auth();
    const { ride } = s2.store.create(a, 'mesh', 'sa');
    ok(s2.store.join(ride.code, b, 'sb'));
    ok(s2.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null }));
    s2.store.disconnect(ride.code, b.id, 'sb');
    s2.advance(TIMING.riderPruneMs + 1);
    expect(errorOf(s2.store.join(ride.code, auth(), 'sc'))).toBe('ride_full');
  });

  it('hands leadership on when the pruned rider was the leader', () => {
    const s2 = setup({ maxRiders: 2 });
    const a = auth();
    const b = auth();
    const { ride } = s2.store.create(a, 'mesh', 'sa');
    ok(s2.store.join(ride.code, b, 'sb'));
    s2.store.disconnect(ride.code, a.id, 'sa');
    s2.advance(1000);
    s2.store.disconnect(ride.code, b.id, 'sb');
    // a has now been offline longer than riderPruneMs, b exactly that long (not prunable yet).
    s2.advance(TIMING.riderPruneMs);
    const d = auth();
    const res = ok(s2.store.join(ride.code, d, 'sd'));
    expect(res.pruned).toEqual([a.id]);
    // b is offline, d is online: the earliest-joined *online* rider leads.
    expect(res.leaderChange).toEqual({ leaderId: d.id, previousId: a.id });
    expect(ride.leaderId).toBe(d.id);
  });
});

describe('RideStore: presence and leaving', () => {
  it('only the current session can mark a rider offline', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'old');
    ok(s.store.join(ride.code, a, 'new'));
    expect(s.store.disconnect(ride.code, a.id, 'old')).toBeNull();
    expect(ride.riders.get(a.id)!.online).toBe(true);
    s.advance(500);
    const m = s.store.disconnect(ride.code, a.id, 'new');
    expect(m?.rider).toMatchObject({ online: false, sessionId: null, lastSeenAt: T0 + 500 });
    // Disconnect does not free the slot.
    expect(ride.riders.has(a.id)).toBe(true);
  });

  it('records activity', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    s.advance(42);
    s.store.touch(ride.code, a.id);
    expect(ride.riders.get(a.id)!.lastSeenAt).toBe(T0 + 42);
    s.store.touch('NOPE22', a.id); // unknown ride: ignored
  });

  it('removes a leaving rider and deletes the empty ride', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    const res = ok(s.store.leave(ride.code, a.id));
    expect(res.rideDeleted).toBe(true);
    expect(s.store.get(ride.code)).toBeUndefined();
    expect(s.store.rideCount).toBe(0);
    expect(errorOf(s.store.leave(ride.code, a.id))).toBe('not_in_ride');
  });

  it('moves leadership to the earliest-joined online rider when the leader leaves', () => {
    const s = setup();
    const [a, b, c, d] = [auth('A'), auth('B'), auth('C'), auth('D')];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    ok(s.store.join(ride.code, c, 'sc'));
    ok(s.store.join(ride.code, d, 'sd'));
    s.store.disconnect(ride.code, b.id, 'sb');
    const res = ok(s.store.leave(ride.code, a.id));
    expect(res.leaderChange).toEqual({ leaderId: c.id, previousId: a.id });
    expect(ride.leaderId).toBe(c.id);
  });

  it('falls back to any remaining rider when nobody is online', () => {
    const s = setup();
    const [a, b, c] = [auth('A'), auth('B'), auth('C')];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    ok(s.store.join(ride.code, c, 'sc'));
    s.store.disconnect(ride.code, b.id, 'sb');
    s.store.disconnect(ride.code, c.id, 'sc');
    expect(ok(s.store.leave(ride.code, a.id)).leaderChange).toEqual({ leaderId: b.id, previousId: a.id });
  });

  it("cancels the leaver's own SOS alerts", () => {
    const s = setup();
    const [a, b] = [auth('A'), auth('B')];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    const own = ok(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null })).sos;
    const other = ok(s.store.raiseSos(ride.code, a.id, { id: randomUUID(), location: null })).sos;
    const res = ok(s.store.leave(ride.code, b.id));
    expect(res.cancelledSos.map((x) => x.id)).toEqual([own.id]);
    expect([...ride.sos.keys()]).toEqual([other.id]);
    expect(res.leaderChange).toBeNull();
  });

  it('updates profile fields and reports whether anything changed', () => {
    const s = setup();
    const a = auth('Alice');
    const { ride } = s.store.create(a, 'mesh', 'sa');
    const first = ok(s.store.updateProfile(ride.code, a.id, { micMode: 'open', name: 'Ali' }));
    expect(first.changed).toBe(true);
    expect(first.rider).toMatchObject({ micMode: 'open', name: 'Ali', color: '#0A84FF' });
    expect(ok(s.store.updateProfile(ride.code, a.id, { micMode: 'open' })).changed).toBe(false);
    expect(ok(s.store.updateProfile(ride.code, a.id, { color: '#30D158' })).changed).toBe(true);
    expect(errorOf(s.store.updateProfile(ride.code, randomUUID(), { name: 'x' }))).toBe('not_in_ride');
  });
});

describe('RideStore: locations', () => {
  it('stores newer fixes and drops out-of-order ones', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    s.advance(100);
    expect(s.store.updateLocation(ride.code, a.id, fix(2000))).not.toBeNull();
    const rider = ride.riders.get(a.id)!;
    expect(rider.location?.t).toBe(2000);
    expect(rider.locationAt).toBe(T0 + 100);
    expect(rider.lastSeenAt).toBe(T0 + 100);
    expect(s.store.updateLocation(ride.code, a.id, fix(2000))).toBeNull();
    expect(s.store.updateLocation(ride.code, a.id, fix(1999))).toBeNull();
    expect(s.store.updateLocation(ride.code, a.id, fix(2001))).not.toBeNull();
    expect(rider.location?.t).toBe(2001);
  });

  it('recovers when the rider clock jumps backwards', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    s.store.updateLocation(ride.code, a.id, fix(T0 + 3_600_000)); // clock an hour ahead
    s.advance(29_999);
    expect(s.store.updateLocation(ride.code, a.id, fix(T0))).toBeNull();
    s.advance(1);
    expect(s.store.updateLocation(ride.code, a.id, fix(T0 + 30_000))).not.toBeNull();
  });

  it('ignores fixes for unknown riders', () => {
    const s = setup();
    expect(s.store.updateLocation('ABCDEF', randomUUID(), fix(1))).toBeNull();
  });
});

describe('RideStore: SOS', () => {
  function rideWithTwo() {
    const s = setup();
    const [a, b, c] = [auth('Leader'), auth('B'), auth('C')];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    ok(s.store.join(ride.code, c, 'sc'));
    return { s, ride, a, b, c };
  }

  it('raises idempotently by id', () => {
    const { s, ride, b } = rideWithTwo();
    const id = randomUUID();
    s.advance(10);
    const first = ok(s.store.raiseSos(ride.code, b.id, { id, location: fix(5) }));
    expect(first.created).toBe(true);
    expect(first.sos).toEqual({ id, riderId: b.id, location: fix(5), raisedAt: T0 + 10, responders: [] });
    s.advance(10);
    const again = ok(s.store.raiseSos(ride.code, b.id, { id, location: null }));
    expect(again.created).toBe(false);
    expect(again.sos).toEqual(first.sos);
    expect(s.store.snapshot(ride).activeSos).toEqual([first.sos]);
  });

  it("defaults the location to the rider's last known fix", () => {
    const { s, ride, b } = rideWithTwo();
    s.store.updateLocation(ride.code, b.id, fix(77, 18.6, 73.9));
    const res = ok(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null }));
    expect(res.sos.location).toEqual(fix(77, 18.6, 73.9));
  });

  it('limits active alerts per rider', () => {
    const { s, ride, b } = rideWithTwo();
    for (let i = 0; i < LIMITS.maxActiveSosPerRider; i++) {
      ok(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null }));
    }
    expect(errorOf(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null }))).toBe('rate_limited');
  });

  it('lets only the raiser or the leader cancel', () => {
    const { s, ride, a, b, c } = rideWithTwo();
    const sos1 = ok(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null })).sos;
    expect(errorOf(s.store.cancelSos(ride.code, c.id, sos1.id))).toBe('not_leader');
    s.advance(5);
    expect(ok(s.store.cancelSos(ride.code, b.id, sos1.id))).toMatchObject({ sos: { id: sos1.id }, at: T0 + 5 });
    const sos2 = ok(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null })).sos;
    ok(s.store.cancelSos(ride.code, a.id, sos2.id));
    expect(ride.sos.size).toBe(0);
    expect(errorOf(s.store.cancelSos(ride.code, a.id, sos2.id))).toBe('not_found');
  });

  it('does not let a late retry resurrect a cancelled alert', () => {
    const { s, ride, b } = rideWithTwo();
    const id = randomUUID();
    ok(s.store.raiseSos(ride.code, b.id, { id, location: null }));
    ok(s.store.cancelSos(ride.code, b.id, id));
    expect(errorOf(s.store.raiseSos(ride.code, b.id, { id, location: null }))).toBe('not_found');
    expect(ride.sos.size).toBe(0);
  });

  it('adds each responder once and ignores the raiser', () => {
    const { s, ride, a, b, c } = rideWithTwo();
    const sos = ok(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null })).sos;
    expect(ok(s.store.respondSos(ride.code, b.id, sos.id)).changed).toBe(false);
    s.advance(3);
    const first = ok(s.store.respondSos(ride.code, a.id, sos.id));
    expect(first.changed).toBe(true);
    expect(first.sos.responders).toEqual([{ riderId: a.id, at: T0 + 3 }]);
    expect(ok(s.store.respondSos(ride.code, a.id, sos.id)).changed).toBe(false);
    expect(ok(s.store.respondSos(ride.code, c.id, sos.id)).sos.responders).toHaveLength(2);
    expect(errorOf(s.store.respondSos(ride.code, c.id, randomUUID()))).toBe('not_found');
  });

  it('hands out copies, not live state', () => {
    const { s, ride, a, b } = rideWithTwo();
    const sos = ok(s.store.raiseSos(ride.code, b.id, { id: randomUUID(), location: null })).sos;
    ok(s.store.respondSos(ride.code, a.id, sos.id));
    expect(sos.responders).toEqual([]);
  });
});

describe('RideStore: breaks', () => {
  it('enforces the per-rider cooldown with retryInMs', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.requestBreak(ride.code, a.id, { id: randomUUID(), kind: 'fuel', location: null }));
    s.advance(10_000);
    const res = s.store.requestBreak(ride.code, a.id, { id: randomUUID(), kind: 'food', location: null });
    expect(res).toEqual({
      ok: false,
      error: 'cooldown',
      message: expect.any(String),
      retryInMs: TIMING.breakCooldownMs - 10_000,
    });
    s.advance(TIMING.breakCooldownMs - 10_000);
    expect(ok(s.store.requestBreak(ride.code, a.id, { id: randomUUID(), kind: 'food', location: null })).created).toBe(true);
  });

  it('is idempotent by id, even inside the cooldown', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    const id = randomUUID();
    const first = ok(s.store.requestBreak(ride.code, a.id, { id, kind: 'break', location: fix(9) }));
    s.advance(1000);
    const again = ok(s.store.requestBreak(ride.code, a.id, { id, kind: 'fuel', location: null }));
    expect(again.created).toBe(false);
    expect(again.alert).toEqual(first.alert);
  });

  it('keeps recent breaks newest first, capped and expiring', () => {
    const s = setup({ maxRiders: 16 });
    const riders = Array.from({ length: 16 }, (_, i) => auth(`R${i}`));
    const { ride } = s.store.create(riders[0]!, 'mesh', 's0');
    riders.slice(1).forEach((r, i) => ok(s.store.join(ride.code, r, `s${i + 1}`)));
    // 16 riders x 2 breaks (cooldown in between) = 32 > recentBreaksKept.
    for (let round = 0; round < 2; round++) {
      for (const r of riders) {
        s.advance(10);
        ok(s.store.requestBreak(ride.code, r.id, { id: randomUUID(), kind: 'break', location: null }));
      }
      s.advance(TIMING.breakCooldownMs);
    }
    const snap = s.store.snapshot(ride);
    expect(snap.recentBreaks).toHaveLength(LIMITS.recentBreaksKept);
    expect(snap.recentBreaks[0]!.at).toBeGreaterThan(snap.recentBreaks[1]!.at);
    s.advance(TIMING.recentBreakMs);
    expect(s.store.snapshot(ride).recentBreaks).toEqual([]);
    s.store.sweep();
    expect(ride.breaks).toEqual([]);
  });

  it("defaults the location to the rider's last fix", () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    s.store.updateLocation(ride.code, a.id, fix(3));
    expect(ok(s.store.requestBreak(ride.code, a.id, { id: randomUUID(), kind: 'restroom', location: null })).alert.location).toEqual(
      fix(3),
    );
  });
});

describe('RideStore: route, leadership, voice', () => {
  function route(id: string, setBy: string): RideRoute {
    return {
      id,
      destination: { name: 'D', lat: 1, lng: 1 },
      waypoints: [],
      geometry: [
        [0, 0],
        [1, 1],
      ],
      distanceM: 1,
      durationS: 1,
      provider: 'mock',
      profile: 'motorcycle',
      setBy,
      setAt: T0,
    };
  }

  it('authorizes route requests and resolves the origin', () => {
    const s = setup();
    const [a, b] = [auth(), auth()];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    expect(errorOf(s.store.startRoute(ride.code, b.id, { lat: 1, lng: 2 }))).toBe('not_leader');
    expect(errorOf(s.store.startRoute(ride.code, a.id, undefined))).toBe('no_origin');
    expect(ok(s.store.startRoute(ride.code, a.id, { lat: 1, lng: 2 })).origin).toEqual({ lat: 1, lng: 2 });
    s.store.updateLocation(ride.code, a.id, fix(1, 18.5, 73.8));
    expect(ok(s.store.startRoute(ride.code, a.id, undefined)).origin).toEqual({ lat: 18.5, lng: 73.8 });
  });

  it('keeps the newest requested route when computations finish out of order', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    const first = ok(s.store.startRoute(ride.code, a.id, { lat: 0, lng: 0 }));
    const second = ok(s.store.startRoute(ride.code, a.id, { lat: 0, lng: 0 }));
    ok(s.store.commitRoute(second.ride, a.id, second.seq, route('second', a.id)));
    expect(errorOf(s.store.commitRoute(first.ride, a.id, first.seq, route('first', a.id)))).toBe('route_failed');
    expect(ride.route?.id).toBe('second');
  });

  it('lets a clear win over a computation still in flight', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    const pending = ok(s.store.startRoute(ride.code, a.id, { lat: 0, lng: 0 }));
    expect(ok(s.store.clearRoute(ride.code, a.id)).changed).toBe(false);
    expect(errorOf(s.store.commitRoute(pending.ride, a.id, pending.seq, route('late', a.id)))).toBe('route_failed');
    expect(ride.route).toBeNull();
    const next = ok(s.store.startRoute(ride.code, a.id, { lat: 0, lng: 0 }));
    ok(s.store.commitRoute(next.ride, a.id, next.seq, route('r', a.id)));
    expect(ok(s.store.clearRoute(ride.code, a.id)).changed).toBe(true);
  });

  it('never commits into a ride that ended or a recycled code', () => {
    const s = setup({ codes: ['AAAAAA', 'AAAAAA'] });
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    const pending = ok(s.store.startRoute(ride.code, a.id, { lat: 0, lng: 0 }));
    ok(s.store.leave(ride.code, a.id));
    const again = s.store.create(a, 'mesh', 'sa');
    expect(again.ride.code).toBe('AAAAAA');
    expect(errorOf(s.store.commitRoute(pending.ride, a.id, pending.seq, route('stale', a.id)))).toBe('not_in_ride');
    expect(again.ride.route).toBeNull();
  });

  it('transfers leadership only from the leader to an online rider', () => {
    const s = setup();
    const [a, b, c] = [auth(), auth(), auth()];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    ok(s.store.join(ride.code, c, 'sc'));
    expect(errorOf(s.store.transferLeader(ride.code, b.id, c.id))).toBe('not_leader');
    expect(errorOf(s.store.transferLeader(ride.code, a.id, randomUUID()))).toBe('not_found');
    s.store.disconnect(ride.code, c.id, 'sc');
    expect(errorOf(s.store.transferLeader(ride.code, a.id, c.id))).toBe('not_found');
    expect(ok(s.store.transferLeader(ride.code, a.id, a.id)).change).toBeNull();
    expect(ok(s.store.transferLeader(ride.code, a.id, b.id)).change).toEqual({ leaderId: b.id, previousId: a.id });
    expect(s.store.snapshot(ride).riders.map((r) => r.role)).toEqual(['rider', 'leader', 'rider']);
  });

  it('switches the voice transport for the leader only, if available', () => {
    const s = setup();
    const [a, b] = [auth(), auth()];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    expect(errorOf(s.store.setVoiceMode(ride.code, b.id, 'livekit', ['livekit', 'mesh']))).toBe('not_leader');
    expect(errorOf(s.store.setVoiceMode(ride.code, a.id, 'livekit', ['mesh']))).toBe('unavailable');
    expect(ok(s.store.setVoiceMode(ride.code, a.id, 'mesh', ['mesh']))).toEqual({ ok: true, changed: false, epoch: 0 });
    expect(ok(s.store.setVoiceMode(ride.code, a.id, 'livekit', ['livekit', 'mesh']))).toEqual({
      ok: true,
      changed: true,
      epoch: 1,
    });
    expect(ride.voiceMode).toBe('livekit');
  });
});

describe('RideStore: sweep', () => {
  it('deletes rides nobody has been online in for rideIdleTtlMs', () => {
    const s = setup();
    const [a, b] = [auth(), auth()];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    s.store.disconnect(ride.code, a.id, 'sa');
    s.advance(60_000);
    s.store.disconnect(ride.code, b.id, 'sb');
    s.advance(TIMING.rideIdleTtlMs - 1);
    expect(s.store.sweep().deletedRides).toEqual([]);
    s.advance(1);
    expect(s.store.sweep().deletedRides).toEqual([ride.code]);
    expect(s.store.get(ride.code)).toBeUndefined();
  });

  it('keeps rides with someone online, however old', () => {
    const s = setup();
    const a = auth();
    const { ride } = s.store.create(a, 'mesh', 'sa');
    s.advance(TIMING.rideIdleTtlMs * 10);
    expect(s.store.sweep().deletedRides).toEqual([]);
    expect(s.store.get(ride.code)).toBeDefined();
  });

  it('moves leadership after leaderGraceMs offline, to the earliest-joined online rider', () => {
    const s = setup();
    const [a, b, c] = [auth(), auth(), auth()];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    ok(s.store.join(ride.code, c, 'sc'));
    s.store.disconnect(ride.code, b.id, 'sb');
    s.store.disconnect(ride.code, a.id, 'sa');
    s.advance(TIMING.leaderGraceMs);
    expect(s.store.sweep().leaderChanges).toEqual([]);
    s.advance(1);
    expect(s.store.sweep().leaderChanges).toEqual([{ code: ride.code, leaderId: c.id, previousId: a.id }]);
    expect(ride.leaderId).toBe(c.id);
    expect(ride.riders.has(a.id)).toBe(true);
  });

  it('keeps an offline leader when there is nobody to hand over to', () => {
    const s = setup();
    const [a, b] = [auth(), auth()];
    const { ride } = s.store.create(a, 'mesh', 'sa');
    ok(s.store.join(ride.code, b, 'sb'));
    s.store.disconnect(ride.code, b.id, 'sb');
    s.store.disconnect(ride.code, a.id, 'sa');
    s.advance(TIMING.leaderGraceMs + 1);
    expect(s.store.sweep().leaderChanges).toEqual([]);
    expect(ride.leaderId).toBe(a.id);
  });
});
