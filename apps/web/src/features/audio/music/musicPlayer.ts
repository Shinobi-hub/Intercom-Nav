/**
 * In-app music: local files (Blobs in IndexedDB) and CORS-enabled stream URLs, played by an
 * <audio> element the engine routes through Web Audio (so it can be ducked). Media Session
 * handlers make helmet / headset buttons work.
 */
import { uuid } from '@intercom/shared';
import type { MusicPlayerApi, MusicTrack, Unsubscribe } from '../../../core/services';
import { stepFrom, successorAfterRemoval, titleFromFileName, titleFromUrl } from './playlist';
import type { MusicStorage } from './storage';

export interface MusicState {
  playing: boolean;
  nowPlaying: { id: string; title: string } | null;
  error: string | null;
}

export interface MusicPlayerDeps {
  element: HTMLAudioElement;
  storage: MusicStorage;
  /**
   * Routes the element through the engine and resumes the AudioContext. Called synchronously at
   * the start of play()/next()/previous(), so a tap on a play button counts as the user gesture.
   */
  prepare(): void;
  onState(state: Readonly<MusicState>): void;
  mediaSession?: MediaSession | null;
  urls?: { create(blob: Blob): string; revoke(url: string): void };
  /** Rejects with a rider-readable message when a stream URL can't be played through Web Audio. */
  probeStream?: (url: string) => Promise<void>;
}

/** Restart the current track instead of going back when we're this far into it. */
const RESTART_THRESHOLD_S = 3;
const AUDIO_EXT = /\.(mp3|m4a|m4b|aac|ogg|oga|opus|wav|wave|flac|webm|weba|caf|aif|aiff)$/i;

const STREAM_HELP = 'Streams must be https:// audio URLs that allow cross-origin (CORS) access, and this one may be offline.';
export const STREAM_CORS_MESSAGE = `Couldn't play that stream. ${STREAM_HELP}`;

export class MusicPlayer implements MusicPlayerApi {
  private tracks: MusicTrack[] = [];
  private loaded: Promise<void> | null = null;
  private current: MusicTrack | null = null;
  private objectUrl: string | null = null;
  private loadToken = 0;
  private readonly listeners = new Set<(tracks: MusicTrack[]) => void>();
  private state: MusicState = { playing: false, nowPlaying: null, error: null };
  private readonly urls: NonNullable<MusicPlayerDeps['urls']>;

  constructor(private readonly deps: MusicPlayerDeps) {
    this.urls = deps.urls ?? { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) };
    const el = deps.element;
    // Must be set before any src: without CORS a stream plays but Web Audio only gets silence.
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.addEventListener('play', () => this.publish({ playing: true }));
    el.addEventListener('playing', () => this.publish({ playing: true, error: null }));
    el.addEventListener('pause', () => this.publish({ playing: false }));
    el.addEventListener('ended', () => void this.advance(1));
    el.addEventListener('error', () => this.onMediaError());
    this.setupMediaSession();
  }

  get snapshot(): Readonly<MusicState> {
    return this.state;
  }

  get currentTrackId(): string | null {
    return this.current?.id ?? null;
  }

  async listTracks(): Promise<MusicTrack[]> {
    await this.ensureLoaded();
    return [...this.tracks];
  }

  async addFiles(files: File[]): Promise<MusicTrack[]> {
    await this.ensureLoaded();
    const audio = files.filter((f) => f.type.startsWith('audio/') || AUDIO_EXT.test(f.name));
    if (audio.length < files.length) this.publish({ error: audio.length ? 'Some files were skipped: not audio.' : 'Those files are not audio.' });
    const now = Date.now();
    const added: MusicTrack[] = [];
    for (const [i, file] of audio.entries()) {
      const track: MusicTrack = { id: uuid(), title: titleFromFileName(file.name), kind: 'file', sizeBytes: file.size, addedAt: now + i };
      try {
        await this.deps.storage.add(track, file);
      } catch (err) {
        const quota = (err as { name?: string })?.name === 'QuotaExceededError';
        this.publish({ error: quota ? 'Not enough storage on this device for more music.' : `Couldn't save "${track.title}".` });
        break;
      }
      added.push(track);
    }
    if (added.length) {
      this.tracks = [...this.tracks, ...added];
      this.emitTracks();
      void requestPersistentStorage();
    }
    return added;
  }

  async addStream(url: string, title?: string): Promise<MusicTrack> {
    await this.ensureLoaded();
    let parsed: URL;
    try {
      parsed = new URL(url.trim());
    } catch {
      throw this.fail('That is not a valid URL.');
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw this.fail('Stream URLs must start with https://');
    try {
      await (this.deps.probeStream ?? probeStream)(parsed.href);
    } catch (err) {
      throw this.fail(err instanceof Error && err.message ? err.message : STREAM_CORS_MESSAGE);
    }
    const track: MusicTrack = {
      id: uuid(),
      title: title?.trim() || titleFromUrl(parsed),
      kind: 'stream',
      url: parsed.href,
      addedAt: Date.now(),
    };
    await this.deps.storage.add(track);
    this.tracks = [...this.tracks, track];
    this.emitTracks();
    this.publish({ error: null });
    return track;
  }

  async removeTrack(id: string): Promise<void> {
    await this.ensureLoaded();
    const successor = successorAfterRemoval(this.tracks, id, this.current?.id ?? null);
    const wasCurrent = this.current?.id === id;
    const wasPlaying = !this.deps.element.paused;
    await this.deps.storage.remove(id);
    this.tracks = this.tracks.filter((t) => t.id !== id);
    this.emitTracks();
    if (!wasCurrent) return;
    this.unload();
    if (successor && wasPlaying && (await this.load(successor))) await this.start();
  }

  async play(id?: string): Promise<void> {
    this.deps.prepare();
    await this.ensureLoaded();
    const track = id ? this.tracks.find((t) => t.id === id) : (this.current ?? this.tracks[0]);
    if (!track) return;
    const el = this.deps.element;
    if (track.id !== this.current?.id || el.error || !el.src) {
      if (!(await this.load(track))) return;
    }
    await this.start();
  }

  pause(): void {
    this.deps.element.pause();
  }

  toggle(): Promise<void> {
    if (this.deps.element.paused) return this.play();
    this.pause();
    return Promise.resolve();
  }

  next(): Promise<void> {
    this.deps.prepare();
    return this.advance(1);
  }

  async previous(): Promise<void> {
    this.deps.prepare();
    const el = this.deps.element;
    if (this.current && el.currentTime > RESTART_THRESHOLD_S) {
      el.currentTime = 0;
      if (el.paused) await this.start();
      return;
    }
    await this.advance(-1);
  }

  onTracksChanged(cb: (tracks: MusicTrack[]) => void): Unsubscribe {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    this.unload();
    this.listeners.clear();
  }

  private async advance(step: 1 | -1): Promise<void> {
    await this.ensureLoaded();
    const track = stepFrom(this.tracks, this.current?.id ?? null, step);
    if (track && (await this.load(track))) await this.start();
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= this.deps.storage.list().then(
      (tracks) => {
        this.tracks = tracks;
        this.emitTracks();
      },
      (err: unknown) => {
        console.warn('[music] could not read the playlist', err);
        this.loaded = null;
      },
    );
    return this.loaded;
  }

  /** Points the element at `track`. False if it was superseded or its file is gone. */
  private async load(track: MusicTrack): Promise<boolean> {
    const token = ++this.loadToken;
    let src: string;
    let objectUrl: string | null = null;
    if (track.kind === 'file') {
      const blob = await this.deps.storage.file(track.id);
      if (token !== this.loadToken) return false;
      if (!blob) {
        this.publish({ error: `"${track.title}" is no longer stored on this device. Add it again.` });
        return false;
      }
      src = objectUrl = this.urls.create(blob);
    } else {
      src = track.url ?? '';
    }
    this.revokeObjectUrl();
    this.objectUrl = objectUrl;
    this.current = track;
    this.deps.element.src = src;
    this.updateMetadata(track);
    this.publish({ nowPlaying: { id: track.id, title: track.title }, error: null });
    return true;
  }

  private async start(): Promise<void> {
    try {
      await this.deps.element.play();
    } catch (err) {
      const name = (err as { name?: string })?.name;
      // AbortError: superseded by another load. NotSupportedError: the 'error' event explains it.
      if (name === 'NotAllowedError') this.publish({ playing: false, error: 'Tap play to start the music.' });
      else if (name !== 'AbortError' && name !== 'NotSupportedError') console.warn('[music] play failed', err);
    }
  }

  private unload(): void {
    this.loadToken++;
    const el = this.deps.element;
    el.pause();
    el.removeAttribute('src');
    el.load();
    this.revokeObjectUrl();
    this.current = null;
    if (this.deps.mediaSession) this.deps.mediaSession.metadata = null;
    this.publish({ playing: false, nowPlaying: null });
  }

  private onMediaError(): void {
    const t = this.current;
    if (!t || !this.deps.element.error) return;
    this.publish({
      playing: false,
      error:
        t.kind === 'stream'
          ? `Can't play "${t.title}". ${STREAM_HELP}`
          : `Can't play "${t.title}". The file may be damaged or in a format this device can't decode.`,
    });
  }

  private revokeObjectUrl(): void {
    if (this.objectUrl) this.urls.revoke(this.objectUrl);
    this.objectUrl = null;
  }

  private fail(message: string): Error {
    this.publish({ error: message });
    return new Error(message);
  }

  private publish(patch: Partial<MusicState>): void {
    const next = { ...this.state, ...patch };
    if (next.playing === this.state.playing && next.nowPlaying === this.state.nowPlaying && next.error === this.state.error) return;
    this.state = next;
    if (this.deps.mediaSession && patch.playing !== undefined) {
      this.deps.mediaSession.playbackState = next.nowPlaying ? (next.playing ? 'playing' : 'paused') : 'none';
    }
    this.deps.onState(this.state);
  }

  private emitTracks(): void {
    const snapshot = [...this.tracks];
    for (const cb of this.listeners) cb(snapshot);
  }

  private setupMediaSession(): void {
    const ms = this.deps.mediaSession;
    if (!ms) return;
    const handlers: [MediaSessionAction, () => void][] = [
      ['play', () => void this.play()],
      ['pause', () => this.pause()],
      ['nexttrack', () => void this.next()],
      ['previoustrack', () => void this.previous()],
    ];
    for (const [action, handler] of handlers) {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action not supported by this browser */
      }
    }
  }

  private updateMetadata(track: MusicTrack): void {
    const ms = this.deps.mediaSession;
    if (!ms || typeof MediaMetadata === 'undefined') return;
    ms.metadata = new MediaMetadata({ title: track.title, artist: 'Intercom Nav', album: 'Ride music' });
  }
}

/**
 * Fetches just the response headers of a stream with CORS: if this fails, an <audio crossorigin>
 * element fails the same way (or Web Audio would get silence), so we can say why up front.
 */
export async function probeStream(url: string): Promise<void> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);
  try {
    const res = await fetch(url, { mode: 'cors', cache: 'no-store', signal: ac.signal });
    ac.abort(); // headers are all we need; don't download a live stream
    if (!res.ok) throw new Error(`The stream answered with an error (HTTP ${res.status}). Check the URL.`);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('The stream answered')) throw err;
    throw new Error(ac.signal.aborted && !(err instanceof TypeError) ? 'The stream did not respond. Check the URL.' : STREAM_CORS_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}

async function requestPersistentStorage(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* best effort: keeps the browser from evicting saved music under storage pressure */
  }
}
