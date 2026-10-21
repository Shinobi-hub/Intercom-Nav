import type { Units } from './store';

const M_PER_MILE = 1609.344;
const FT_PER_M = 3.28084;

/** "350 m", "3.4 km", "34 km" / "500 ft", "2.3 mi", "23 mi". */
export function formatDistance(meters: number, units: Units): string {
  if (!Number.isFinite(meters)) return '–';
  const m = Math.max(0, meters);
  if (units === 'imperial') {
    const miles = m / M_PER_MILE;
    if (miles < 0.1) return `${Math.round((m * FT_PER_M) / 10) * 10} ft`;
    return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
  }
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  const km = m / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** "<1 min", "38 min", "1 h 05 min". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return '–';
  const s = Math.max(0, seconds);
  if (s < 60) return '<1 min';
  const totalMin = Math.round(s / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return `${h} h ${String(min).padStart(2, '0')} min`;
}

/** "62 km/h" / "38 mph"; "–" when unknown. */
export function formatSpeed(mps: number | null, units: Units): string {
  if (mps === null || !Number.isFinite(mps)) return '–';
  return units === 'imperial' ? `${Math.round(mps * 2.236936)} mph` : `${Math.round(mps * 3.6)} km/h`;
}

/** "just now", "45 s ago", "3 min ago", "2 h ago". */
export function formatAgo(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min ago`;
  return `${Math.round(min / 60)} h ago`;
}

/** Clock time `seconds` from now, e.g. "14:35". */
export function formatEta(seconds: number, now: Date = new Date()): string {
  const t = new Date(now.getTime() + Math.max(0, seconds) * 1000);
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Up to two initials: "Sam Lee" -> "SL", "alex" -> "A". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0]![0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? '') : '';
  return (first + last).toUpperCase();
}
