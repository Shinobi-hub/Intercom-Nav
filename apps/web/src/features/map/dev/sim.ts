// Dev-harness ride simulation: riders driving the Pune route with jitter and irregular updates.
import { bearingDeg, type LatLng, type LocationFix } from '@intercom/shared';
import type { LocationServiceApi } from '../../../core/services';
import { useLocalStore, useRideStore } from '../../../core/store';
import { gaussian, jitter, seededRandom } from '../../geo/testing';
import { prepareRoute, type PreparedRoute } from '../../route/progress';
import { PUNE_ROUTE } from './puneRoute';

export interface SimRider {
  id: string;
  name: string;
  color: string;
  /** Start position along the route, meters. */
  startM: number;
  speedMps: number;
  jitterM: number;
  /** Stops sending updates between these sim times (ms), to go stale and lost. */
  pause?: [number, number];
  sos?: boolean;
  /** Toggles voice activity every couple of seconds. */
  talks?: boolean;
}

const route = prepareRoute({ geometry: PUNE_ROUTE, distanceM: 0, durationS: 0 }) as PreparedRoute;

/** Point and travel bearing `meters` along the route. */
export function alongRoute(meters: number): LatLng & { bearing: number } {
  const { points, cumulative } = route;
  const d = Math.min(Math.max(0, meters), route.lengthM - 0.01);
  let i = 0;
  while (i < points.length - 2 && cumulative[i + 1]! < d) i++;
  const a = points[i]!;
  const b = points[i + 1]!;
  const seg = cumulative[i + 1]! - cumulative[i]!;
  const k = seg > 0 ? (d - cumulative[i]!) / seg : 0;
  return { lat: a.lat + (b.lat - a.lat) * k, lng: a.lng + (b.lng - a.lng) * k, bearing: bearingDeg(a, b) };
}

/** Drives `riders` through useRideStore and my own position through the real location pipeline. */
export function startSimulation(opts: {
  riders: SimRider[];
  self: { startM: number; speedMps: number; jitterM: number; id: string };
  location: LocationServiceApi;
  seed?: number;
}): () => void {
  const random = seededRandom(opts.seed ?? 7);
  const normal = gaussian(random);
  const t0 = performance.now();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  };

  for (const r of opts.riders) {
    const tick = () => {
      const now = performance.now();
      const simMs = now - t0;
      const paused = r.pause && simMs >= r.pause[0] && simMs < r.pause[1];
      if (!paused) {
        const p = alongRoute(r.startM + (r.speedMps * simMs) / 1000);
        const pos = jitter(p, r.jitterM, normal);
        const moving = r.speedMps > 0;
        const fix: LocationFix = {
          lat: pos.lat,
          lng: pos.lng,
          acc: Math.round(r.jitterM * 1.5),
          spd: moving ? Math.max(0, r.speedMps + normal() * 0.6) : 0,
          hdg: moving ? (p.bearing + normal() * 3 + 360) % 360 : null,
          t: Date.now(),
        };
        useRideStore.getState().setRiderLocation(r.id, fix, Date.now() + useRideStore.getState().clockOffsetMs);
      }
      later(tick, 800 + random() * 1_700); // irregular 0.8-2.5 s
    };
    later(tick, random() * 800);
    if (r.talks) {
      let on = false;
      const talk = () => {
        on = !on;
        useLocalStore.getState().setSpeaking(r.id, on);
        later(talk, on ? 1_500 + random() * 2_000 : 1_000 + random() * 2_500);
      };
      later(talk, 500);
    }
  }

  const self = opts.self;
  const selfTick = () => {
    const simMs = performance.now() - t0;
    const p = alongRoute(self.startM + (self.speedMps * simMs) / 1000);
    const pos = jitter(p, self.jitterM, normal);
    opts.location.inject({
      lat: pos.lat,
      lng: pos.lng,
      accuracy: 6 + Math.abs(normal()) * 3,
      speed: self.speedMps + normal() * 0.3,
      heading: (p.bearing + normal() * 2 + 360) % 360,
      altitude: 560,
      timestamp: Date.now(),
    });
    later(selfTick, 1_000);
  };
  selfTick();

  return () => timers.forEach((id) => clearTimeout(id));
}
