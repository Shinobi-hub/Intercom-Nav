/** Pure playlist navigation. Tracks are in play order; every move wraps around. */
import type { MusicTrack } from '../../../core/services';

/** The track `step` places away from `currentId` (wrapping), or the first one when nothing is current. */
export function stepFrom(tracks: readonly MusicTrack[], currentId: string | null, step: 1 | -1): MusicTrack | null {
  if (tracks.length === 0) return null;
  const i = currentId ? tracks.findIndex((t) => t.id === currentId) : -1;
  if (i < 0) return step === 1 ? tracks[0]! : tracks[tracks.length - 1]!;
  return tracks[(i + step + tracks.length) % tracks.length]!;
}

/**
 * Which track should take over when `removedId` is deleted while `currentId` is loaded:
 * the one after it (wrapping), null when the current one was the last track or nothing changes.
 */
export function successorAfterRemoval(tracks: readonly MusicTrack[], removedId: string, currentId: string | null): MusicTrack | null {
  if (currentId !== removedId) return null;
  const remaining = tracks.filter((t) => t.id !== removedId);
  if (remaining.length === 0) return null;
  const i = tracks.findIndex((t) => t.id === removedId);
  return remaining[i % remaining.length] ?? remaining[0]!;
}

/** "Highway Song.mp3" -> "Highway Song"; falls back to the raw name. */
export function titleFromFileName(name: string): string {
  const base = name.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_]+/g, ' ').trim();
  return base || name || 'Untitled';
}

/** Best-effort title for a stream URL: the last path segment, else the host. */
export function titleFromUrl(url: URL): string {
  const last = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() ?? '');
  return last ? titleFromFileName(last) : url.host;
}
