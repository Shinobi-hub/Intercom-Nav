import { destinationPoint, haversineM, TIMING, type LatLng } from '@intercom/shared';
import { TID } from '../helpers/contract';
import { buildRoute, driveRoute, projectOnSegment, riderStart, routeFixes } from '../helpers/geo';
import type { MarkerSample } from '../helpers/pageScript';
import { startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { waitFor } from '../helpers/wait';

const SPEED_MPS = 15; // 54 km/h
const FIX_INTERVAL_MS = 1_000;
const FIX_COUNT = 16; // 15 s along leg 1 (straight, 1 km)

interface GlideReport {
  fixesReceived: number;
  glideSamples: number;
  strictlyBetween: number;
  intervalsWithGlide: number;
  aheadOfNewestFix: number;
  backwardSteps: number;
  maxCrossTrackM: number;
  markerTravelM: number;
  fixTravelM: number;
}

/**
 * Projects the sampled marker positions onto the (straight) leg and checks them against the fixes
 * A had received at each moment. "Strictly between" = more than 0.5 m from every fix and inside
 * the span of received fixes: the marker is drawn where no fix ever was, i.e. it interpolates.
 */
function analyzeGlide(samples: readonly MarkerSample[], a: LatLng, b: LatLng): GlideReport {
  const along = (p: LatLng) => projectOnSegment(a, b, p).along;
  const fixes: { t: number; s: number }[] = [];
  let lastFixT = -1;
  for (const smp of samples) {
    if (smp.fix && smp.fix.t !== lastFixT) {
      lastFixT = smp.fix.t;
      fixes.push({ t: smp.t, s: along(smp.fix) });
    }
  }
  const lastArrival = fixes[fixes.length - 1]?.t ?? 0;
  let glideSamples = 0;
  let strictlyBetween = 0;
  let aheadOfNewestFix = 0;
  let backwardSteps = 0;
  let maxCross = 0;
  let prev: number | null = null;
  let first: number | null = null;
  let last: number | null = null;
  const intervals = new Set<number>();
  for (const smp of samples) {
    const m = smp.marker;
    // Stop shortly after the final fix: after that the marker legitimately dead-reckons and holds.
    if (!m || m.state !== 'live' || smp.t > lastArrival + 900) continue;
    const { along: s, cross } = projectOnSegment(a, b, m);
    maxCross = Math.max(maxCross, Math.abs(cross));
    if (prev !== null && s < prev - 0.5) backwardSteps++;
    prev = s;
    first ??= s;
    last = s;
    if (m.extrapolating) continue;
    const known = fixes.filter((f) => f.t <= smp.t);
    if (known.length < 2) continue;
    glideSamples++;
    const newest = known[known.length - 1]!.s;
    if (s > newest + 1) aheadOfNewestFix++;
    const j = known.findIndex((f, i) => i > 0 && s > known[i - 1]!.s + 0.5 && s < f.s - 0.5);
    if (j > 0) {
      strictlyBetween++;
      intervals.add(j);
    }
  }
  return {
    fixesReceived: fixes.length,
    glideSamples,
    strictlyBetween,
    intervalsWithGlide: intervals.size,
    aheadOfNewestFix,
    backwardSteps,
    maxCrossTrackM: Math.round(maxCross * 10) / 10,
    markerTravelM: Math.round((last ?? 0) - (first ?? 0)),
    fixTravelM: Math.round((fixes[fixes.length - 1]?.s ?? 0) - (fixes[0]?.s ?? 0)),
  };
}

test('B drives: A sees B\'s marker glide between fixes, then fade to stale once B\'s updates stop', { tag: '@slow' }, async ({ riders }, testInfo) => {
  const route = buildRoute(riderStart(1));
  const [asha, bharat] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0) },
    { name: 'Bharat', geo: route[0] },
  ]);
  await startGroupRide(asha, [bharat]);
  const bId = await bharat.id();
  await expect.poll(() => asha.map.ready(), { message: '[Asha] map ready' }).toBe(true);
  await expect.poll(async () => (await asha.map.markers())[bId]?.state, { message: '[Asha] marker for Bharat' }).toBe('live');

  const fixes = routeFixes(route, SPEED_MPS, FIX_INTERVAL_MS).slice(0, FIX_COUNT);
  const sampler = await asha.startSampler('marker', bId, 33);
  const drive = await driveRoute(bharat, fixes, FIX_INTERVAL_MS);
  await waitFor(async () => (await drive.injected()) >= fixes.length, {
    timeout: FIX_COUNT * FIX_INTERVAL_MS + 10_000,
    interval: 250,
    message: '[Bharat] should inject the scripted fixes',
  });
  const log = await drive.stop();
  const lastInjected = log[log.length - 1]!;

  // A has B's final position (the pipeline may smooth, so "close to", not equal).
  await waitFor(
    async () => {
      const fix = (await asha.state()).ride.riders[bId]?.location;
      return fix && haversineM(fix, lastInjected) < 20;
    },
    { timeout: 10_000, message: '[Asha] should receive Bharat\'s last fix' },
  );
  const samples = await sampler.stop();

  await test.step('marker moves and interpolates between consecutive fixes', async () => {
    const report = analyzeGlide(samples, route[0]!, route[1]!);
    await testInfo.attach('glide-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
    console.log(`glide report: ${JSON.stringify(report)}`);
    expect(report.fixesReceived, 'fixes A received from B').toBeGreaterThanOrEqual(FIX_COUNT - 4);
    expect(report.markerTravelM, 'marker travel vs fix travel').toBeGreaterThan(report.fixTravelM * 0.8);
    expect(report.maxCrossTrackM, 'marker stays on the road (cross-track)').toBeLessThan(5);
    expect(report.backwardSteps, 'marker never jumps backwards').toBe(0);
    expect(report.aheadOfNewestFix, 'gliding marker never overtakes the newest fix').toBe(0);
    expect(report.strictlyBetween / Math.max(1, report.glideSamples), 'share of glide samples strictly between fixes').toBeGreaterThan(0.5);
    expect(report.intervalsWithGlide, 'fix intervals with in-between samples').toBeGreaterThanOrEqual(Math.min(8, report.fixesReceived - 2));
  });

  await test.step('stale riderStaleMs after the last location update', async () => {
    // When Bharat's GPS goes quiet his location service keeps re-sending the newest fix every
    // locHeartbeatMs (so a rider stopped at a light doesn't fade) until that fix is
    // locHeartbeatMaxFixAgeMs old. The map fades him riderStaleMs after the last update that reaches
    // Asha, whichever kind it was: about 40 s after his last real fix.
    let lastUpdate = lastInjected.t;
    const staleAt = await waitFor(
      async () => {
        const [markers, { ride }] = await Promise.all([asha.map.markers(), asha.state()]);
        lastUpdate = Math.max(lastUpdate, ride.riders[bId]?.location?.t ?? 0);
        return markers[bId]?.state === 'stale' ? Date.now() : null;
      },
      { timeout: 75_000, interval: 250, message: '[Asha] Bharat\'s marker should turn stale once his updates stop' },
    );
    const timing = { staleAfterLastUpdateMs: staleAt - lastUpdate, staleAfterLastRealFixMs: staleAt - lastInjected.t };
    await testInfo.attach('stale-timing.json', { body: JSON.stringify(timing, null, 2), contentType: 'application/json' });
    console.log(`stale timing: ${JSON.stringify(timing)}`);
    expect(timing.staleAfterLastUpdateMs, 'stale too early').toBeGreaterThanOrEqual(TIMING.riderStaleMs - 1_500);
    expect(timing.staleAfterLastUpdateMs, 'stale too late').toBeLessThanOrEqual(TIMING.riderStaleMs + 5_000);
    // The last heartbeat goes out between (max fix age - heartbeat interval) and max fix age after the fix.
    const { locHeartbeatMaxFixAgeMs: maxAge, locHeartbeatMs: beat, riderStaleMs: stale } = TIMING;
    expect(timing.staleAfterLastRealFixMs, 'heartbeats keep a quiet rider live').toBeGreaterThanOrEqual(maxAge - beat + stale - 1_500);
    expect(timing.staleAfterLastRealFixMs, 'heartbeats stop vouching for an old fix').toBeLessThanOrEqual(maxAge + stale + 5_000);
    await expect(asha.tid(TID.mapMarker(bId))).toHaveAttribute('data-state', 'stale');
  });
});

test('the real GPS path: context.setGeolocation moves a rider on everyone\'s map', async ({ riders }) => {
  const start = riderStart(2);
  const [asha, chitra] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0) },
    { name: 'Chitra', geo: start },
  ]);
  await startGroupRide(asha, [chitra]);
  const cId = await chitra.id();
  const near = (p: LatLng | null | undefined, q: LatLng, m: number) => Boolean(p && haversineM(p, q) < m);

  // The first fix came from navigator.geolocation (no injection anywhere in this test).
  await expect
    .poll(async () => near((await asha.state()).ride.riders[cId]?.location, start, 25), { message: '[Asha] sees Chitra at her emulated position' })
    .toBe(true);

  // Move 60 m north once 3 s have passed since the last fix: 20 m/s, a believable motorcycle.
  const target = destinationPoint(start, 0, 60);
  await waitFor(
    async () => {
      const at = (await chitra.state()).local.gps.lastFixAt;
      return at !== null && Date.now() - at >= 3_000;
    },
    { timeout: 15_000, message: '[Chitra] should have a GPS fix' },
  );
  await chitra.context.setGeolocation({ latitude: target.lat, longitude: target.lng, accuracy: 8 });

  await expect
    .poll(async () => near((await chitra.state()).local.selfFix, target, 25), { message: '[Chitra] own fix follows the OS position' })
    .toBe(true);
  await expect
    .poll(async () => near((await asha.state()).ride.riders[cId]?.location, target, 25), { message: '[Asha] sees Chitra move' })
    .toBe(true);
  await expect
    .poll(async () => near((await asha.map.markers())[cId], target, 25), { message: '[Asha] marker for Chitra reaches the new position' })
    .toBe(true);
});
