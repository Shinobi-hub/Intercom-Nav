/**
 * Synthetic geography for demo mode: a ~27 km riding loop south-west of Pune (city centre →
 * Sinhagad Road → Khadakwasla → NDA Road → Warje → Kothrud → Deccan), a few riders spread along
 * it, and places to search. Coordinates are approximate; none of this is real rider data.
 */
import type { LatLng, LocationFix, MicMode, Place, RideRoute } from '@intercom/shared';
import { bearingDeg, haversineM, polylineLengthM } from '@intercom/shared';

const LOOP: LatLng[] = [
  { lat: 18.5195, lng: 73.8553 }, // Shaniwar Wada
  { lat: 18.51, lng: 73.859 },
  { lat: 18.5018, lng: 73.8636 }, // Swargate
  { lat: 18.493, lng: 73.856 },
  { lat: 18.483, lng: 73.838 },
  { lat: 18.472, lng: 73.826 },
  { lat: 18.464, lng: 73.819 }, // Vadgaon
  { lat: 18.456, lng: 73.811 },
  { lat: 18.447, lng: 73.804 }, // Dhayari
  { lat: 18.444, lng: 73.79 },
  { lat: 18.4433, lng: 73.771 }, // Khadakwasla
  { lat: 18.456, lng: 73.765 },
  { lat: 18.47, lng: 73.769 }, // NDA gate
  { lat: 18.479, lng: 73.785 },
  { lat: 18.484, lng: 73.8 }, // Warje
  { lat: 18.496, lng: 73.805 },
  { lat: 18.5074, lng: 73.8077 }, // Kothrud
  { lat: 18.511, lng: 73.825 },
  { lat: 18.5167, lng: 73.8414 }, // Deccan
  { lat: 18.5185, lng: 73.849 },
];

/** Index in LOOP of the demo destination. */
const KHADAKWASLA = 10;

export interface Path {
  points: LatLng[];
  /** Distance along the path at each point. */
  cum: number[];
  length: number;
}

function makePath(points: LatLng[]): Path {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1]! + haversineM(points[i - 1]!, points[i]!));
  return { points, cum, length: cum[cum.length - 1]! };
}

/** Closed: the last segment returns to the start. */
export const LOOP_PATH = makePath([...LOOP, LOOP[0]!]);

/** Position and heading `s` meters along the loop (wraps around). */
export function pointAlong(path: Path, s: number): LatLng & { heading: number } {
  const d = ((s % path.length) + path.length) % path.length;
  let i = 1;
  while (i < path.cum.length - 1 && path.cum[i]! < d) i++;
  const a = path.points[i - 1]!;
  const b = path.points[i]!;
  const seg = path.cum[i]! - path.cum[i - 1]!;
  const t = seg > 0 ? (d - path.cum[i - 1]!) / seg : 0;
  return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, heading: bearingDeg(a, b) };
}

export function fixAt(path: Path, s: number, speed: number, acc: number): LocationFix {
  const p = pointAlong(path, s);
  return { lat: p.lat, lng: p.lng, acc, spd: speed, hdg: p.heading, alt: 560, t: Date.now() };
}

export interface DemoRider {
  id: string;
  name: string;
  /** Meters ahead (+) or behind (−) of me along the loop. */
  offset: number;
  /** How far the rider drifts around that spot, meters. */
  sway: number;
  phase: number;
  micMode: MicMode;
  online: boolean;
  /** Seconds within each 2-minute cycle when the rider's GPS drops out (stale marker). */
  dropout?: [number, number];
}

export const SELF_ID = 'd0000000-0000-4000-8000-000000000000';

export const DEMO_RIDERS: DemoRider[] = [
  { id: 'd0000000-0000-4000-8000-000000000001', name: 'Arjun', offset: 1_150, sway: 60, phase: 0.2, micMode: 'vox', online: true },
  { id: 'd0000000-0000-4000-8000-000000000002', name: 'Priya', offset: 420, sway: 40, phase: 1.9, micMode: 'vox', online: true },
  { id: 'd0000000-0000-4000-8000-000000000003', name: 'Kabir', offset: -380, sway: 45, phase: 3.1, micMode: 'open', online: true },
  {
    id: 'd0000000-0000-4000-8000-000000000004',
    name: 'Meera',
    offset: -1_050,
    sway: 70,
    phase: 4.4,
    micMode: 'off',
    online: true,
    dropout: [45, 80],
  },
  { id: 'd0000000-0000-4000-8000-000000000005', name: 'Rohan', offset: -2_900, sway: 0, phase: 0, micMode: 'vox', online: false },
];

export const ARJUN = DEMO_RIDERS[0]!.id;
export const PRIYA = DEMO_RIDERS[1]!.id;
export const KABIR = DEMO_RIDERS[2]!.id;

/** Where my demo ride starts along the loop, and how fast the group rolls (≈ 53 km/h). */
export const START_S = 2_200;
export const GROUP_SPEED = 14.8;

export const DESTINATION: Place = {
  name: 'Khadakwasla Dam',
  lat: LOOP[KHADAKWASLA]!.lat,
  lng: LOOP[KHADAKWASLA]!.lng,
  address: 'Khadakwasla, Pune',
};

export const PLACES: Place[] = [
  DESTINATION,
  { name: 'Sinhagad Fort', lat: 18.3663, lng: 73.7559, address: 'Sinhagad Ghat Road, Pune' },
  { name: 'Lonavala', lat: 18.7546, lng: 73.4062, address: 'Lonavala, Maharashtra' },
  { name: 'Lavasa', lat: 18.4058, lng: 73.5066, address: 'Lavasa, Mulshi' },
  { name: 'Mulshi Dam', lat: 18.5292, lng: 73.5136, address: 'Mulshi, Pune' },
  { name: 'Panshet Dam', lat: 18.3833, lng: 73.6167, address: 'Panshet, Pune' },
  { name: 'Tamhini Ghat', lat: 18.4566, lng: 73.4307, address: 'Tamhini, Mulshi' },
  { name: 'Purandar Fort', lat: 18.2836, lng: 73.9748, address: 'Purandar, Pune' },
  { name: 'Shaniwar Wada', lat: 18.5195, lng: 73.8553, address: 'Shaniwar Peth, Pune' },
];

/** Shared route from the start of the loop to Khadakwasla, as the server would broadcast it. */
export function loopRoute(setBy: string): RideRoute {
  const geometry = LOOP.slice(0, KHADAKWASLA + 1).map((p) => [p.lng, p.lat] as [number, number]);
  const distanceM = polylineLengthM(geometry);
  return {
    id: 'demo-route-khadakwasla',
    destination: DESTINATION,
    waypoints: [],
    geometry,
    distanceM,
    durationS: distanceM / 11.5,
    provider: 'mock',
    profile: 'motorcycle',
    setBy,
    setAt: Date.now(),
  };
}

/** A gently curving line from `from` to a searched place, standing in for a routed path. */
export function routeTo(from: LatLng, to: Place, setBy: string): RideRoute {
  const n = 24;
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const geometry: [number, number][] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const bend = Math.sin(t * Math.PI) * 0.12;
    geometry.push([from.lng + dLng * t - dLat * bend, from.lat + dLat * t + dLng * bend]);
  }
  const distanceM = polylineLengthM(geometry);
  return {
    id: `demo-route-${Date.now()}`,
    destination: to,
    waypoints: [],
    geometry,
    distanceM,
    durationS: distanceM / 12.5,
    provider: 'mock',
    profile: 'motorcycle',
    setBy,
    setAt: Date.now(),
  };
}
