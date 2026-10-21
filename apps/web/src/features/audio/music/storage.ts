/**
 * Where the playlist lives. Track metadata and file Blobs go to IndexedDB (idb-keyval store
 * 'intercom-music' / 'tracks'); tests and browsers without IndexedDB use the in-memory version.
 */
import { createStore, delMany, get, getMany, keys, setMany, type UseStore } from 'idb-keyval';
import type { MusicTrack } from '../../../core/services';

export interface MusicStorage {
  /** Oldest first. */
  list(): Promise<MusicTrack[]>;
  add(track: MusicTrack, file?: Blob): Promise<void>;
  file(id: string): Promise<Blob | undefined>;
  remove(id: string): Promise<void>;
}

const META = 'meta:';
const FILE = 'file:';

const byAdded = (a: MusicTrack, b: MusicTrack) => a.addedAt - b.addedAt || a.id.localeCompare(b.id);

export function createIdbMusicStorage(): MusicStorage {
  let store: UseStore | null = null;
  const db = () => (store ??= createStore('intercom-music', 'tracks'));
  return {
    async list() {
      const metaKeys = (await keys(db())).filter((k): k is string => typeof k === 'string' && k.startsWith(META));
      const tracks = await getMany<MusicTrack | undefined>(metaKeys, db());
      return tracks.filter((t): t is MusicTrack => !!t).sort(byAdded);
    },
    async add(track, file) {
      const entries: [string, unknown][] = [[META + track.id, track]];
      if (file) entries.unshift([FILE + track.id, file]);
      await setMany(entries, db());
    },
    file: (id) => get<Blob>(FILE + id, db()),
    remove: (id) => delMany([META + id, FILE + id], db()),
  };
}

export function createMemoryMusicStorage(): MusicStorage {
  const tracks = new Map<string, MusicTrack>();
  const files = new Map<string, Blob>();
  return {
    list: async () => [...tracks.values()].sort(byAdded),
    async add(track, file) {
      tracks.set(track.id, track);
      if (file) files.set(track.id, file);
    },
    file: async (id) => files.get(id),
    async remove(id) {
      tracks.delete(id);
      files.delete(id);
    },
  };
}

/** IndexedDB when the browser has it (private modes may not), memory otherwise. */
export function createMusicStorage(): MusicStorage {
  return typeof indexedDB !== 'undefined' ? createIdbMusicStorage() : createMemoryMusicStorage();
}
