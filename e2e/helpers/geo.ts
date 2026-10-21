/**
 * Scripted GPS. Fixes go in through `window.__intercom.geo.inject` (the app's location pipeline:
 * filter -> smoothing -> send policy), driven by a timer inside the page so the spacing is exact.
 * The real navigator.geolocation path is covered with context.setGeolocation (see location.spec.ts).
 */
import { bearingDeg, destinationPoint, haversineM, type LatLng } from '@intercom/shared';
import { PUNE, type Rider } from './rider';

export interface RouteLeg {
  bearing: number;
  meters: number;
}

/** ~3 km near Pune: 1 km north-east, 1 km east, 1 km north. Leg 1 is straight for glide checks. */
export const PUNE_ROUTE_LEGS: RouteLeg[] = [
  { bearing: 45, meters: 1_000 },
  { bearing: 90, meters: 1_000 },
  { bearing: 0, meters: 1_000 },
];

export interface ScriptedFix {
  lat: number;
  lng: number;
  /** m/s */
  speed: number;
  heading: number;
}

/** Route vertices from a start point. */
export function buildRoute(start: LatLng = PUNE, legs: RouteLeg[] = PUNE_ROUTE_LEGS): LatLng[] {
  const points = [start];
  for (const leg of legs) points.push(destinationPoint(points[points.length - 1]!, leg.bearing, leg.meters));
  return points;
}

/** Fixes every `intervalMs` at a constant `speedMps` along the polyline (stops at the end). */
export function routeFixes(route: LatLng[], speedMps: number, intervalMs: number): ScriptedFix[] {
  const step = (speedMps * intervalMs) / 1000;
  const fixes: ScriptedFix[] = [];
  let leg = 0;
  let along = 0; // meters into the current leg
  for (;;) {
    const a = route[leg]!;
    const b = route[leg + 1]!;
    const legLen = haversineM(a, b);
    const heading = bearingDeg(a, b);
    const p = destinationPoint(a, heading, along);
    fixes.push({ lat: p.lat, lng: p.lng, speed: speedMps, heading });
    along += step;
    while (along > legLen) {
      along -= legLen;
      leg++;
      if (leg >= route.length - 1) return fixes;
    }
  }
}

/** Starting points a few hundred meters apart, so riders' markers don't sit on top of each other. */
export function riderStart(slot: number): LatLng {
  return destinationPoint(PUNE, (slot * 72) % 360, slot === 0 ? 0 : 150 + slot * 40);
}

/** One raw fix through the app's location pipeline. Returns the page time it was injected. */
export async function injectFix(rider: Rider, fix: Partial<ScriptedFix> & LatLng, accuracy = 5): Promise<number> {
  return rider.guard(
    rider.page.evaluate(
      ({ fix, accuracy }) => {
        const geo = window.__intercom?.geo;
        if (!geo) throw new Error('window.__intercom.geo is not registered');
        const timestamp = Date.now();
        geo.inject({ lat: fix.lat, lng: fix.lng, accuracy, speed: fix.speed ?? null, heading: fix.heading ?? null, timestamp });
        return timestamp;
      },
      { fix, accuracy },
    ),
  );
}

export interface DriveLogEntry {
  i: number;
  /** Page Date.now() at injection. */
  t: number;
  lat: number;
  lng: number;
}

/** A route being driven inside a rider's page. */
export class Drive {
  constructor(
    private readonly rider: Rider,
    private readonly key: string,
    readonly fixes: readonly ScriptedFix[],
  ) {}

  /** Injections so far. */
  log(): Promise<DriveLogEntry[]> {
    return this.rider.guard(
      this.rider.page.evaluate((key) => (window as unknown as Record<string, { log: DriveLogEntry[] }>)[key]?.log.slice() ?? [], this.key),
    );
  }

  async injected(): Promise<number> {
    return (await this.log()).length;
  }

  /** Stops injecting (a stopped GPS: no more fixes at all). Returns the log. */
  async stop(): Promise<DriveLogEntry[]> {
    await this.rider.page
      .evaluate((key) => {
        const d = (window as unknown as Record<string, { timer: number }>)[key];
        if (d) window.clearInterval(d.timer);
      }, this.key)
      .catch(() => {});
    return this.log();
  }
}

let driveSeq = 0;

/**
 * Drives `fixes` through the rider's location pipeline, one every `intervalMs`, from a timer in the page.
 * Use `routeFixes(buildRoute(), speed, interval)` for a scripted route at a given speed.
 */
export async function driveRoute(rider: Rider, fixes: readonly ScriptedFix[], intervalMs = 1_000, accuracy = 5): Promise<Drive> {
  const key = `__e2eDrive${++driveSeq}`;
  await rider.guard(
    rider.page.evaluate(
      ({ key, fixes, intervalMs, accuracy }) => {
        const geo = window.__intercom?.geo;
        if (!geo) throw new Error('window.__intercom.geo is not registered');
        const state = { log: [] as { i: number; t: number; lat: number; lng: number }[], timer: 0 };
        let i = 0;
        const tick = () => {
          const f = fixes[i];
          if (!f) {
            window.clearInterval(state.timer);
            return;
          }
          const t = Date.now();
          geo.inject({ lat: f.lat, lng: f.lng, accuracy, speed: f.speed, heading: f.heading, timestamp: t });
          state.log.push({ i, t, lat: f.lat, lng: f.lng });
          i++;
        };
        tick();
        state.timer = window.setInterval(tick, intervalMs);
        (window as unknown as Record<string, unknown>)[key] = state;
      },
      { key, fixes, intervalMs, accuracy },
    ),
  );
  return new Drive(rider, key, fixes);
}

/** Signed along-track and cross-track distance (m) of `p` relative to the segment a -> b. */
export function projectOnSegment(a: LatLng, b: LatLng, p: LatLng): { along: number; cross: number } {
  const d = haversineM(a, p);
  if (d < 0.01) return { along: 0, cross: 0 };
  const delta = ((bearingDeg(a, p) - bearingDeg(a, b)) * Math.PI) / 180;
  return { along: d * Math.cos(delta), cross: d * Math.sin(delta) };
}
