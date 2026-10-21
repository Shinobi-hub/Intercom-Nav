// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { MusicTrack } from '../../../core/services';
import { MusicPlayer, STREAM_CORS_MESSAGE, type MusicState } from './musicPlayer';
import { stepFrom, successorAfterRemoval, titleFromFileName, titleFromUrl } from './playlist';
import { createMemoryMusicStorage } from './storage';

const t = (id: string): MusicTrack => ({ id, title: id, kind: 'file', addedAt: 0 });

describe('playlist', () => {
  const list = [t('a'), t('b'), t('c')];
  it('steps with wraparound', () => {
    expect(stepFrom(list, 'a', 1)!.id).toBe('b');
    expect(stepFrom(list, 'c', 1)!.id).toBe('a');
    expect(stepFrom(list, 'a', -1)!.id).toBe('c');
    expect(stepFrom(list, null, 1)!.id).toBe('a');
    expect(stepFrom(list, 'gone', -1)!.id).toBe('c');
    expect(stepFrom([], null, 1)).toBeNull();
  });
  it('picks the successor of a removed current track', () => {
    expect(successorAfterRemoval(list, 'b', 'b')!.id).toBe('c');
    expect(successorAfterRemoval(list, 'c', 'c')!.id).toBe('a');
    expect(successorAfterRemoval(list, 'b', 'a')).toBeNull();
    expect(successorAfterRemoval([t('a')], 'a', 'a')).toBeNull();
  });
  it('makes titles', () => {
    expect(titleFromFileName('Highway_Song.mp3')).toBe('Highway Song');
    expect(titleFromUrl(new URL('https://radio.example/live/jazz.mp3'))).toBe('jazz');
    expect(titleFromUrl(new URL('https://radio.example/'))).toBe('radio.example');
  });
});

/** Just the HTMLAudioElement surface the player uses. */
class FakeAudio extends EventTarget {
  crossOrigin: string | null = null;
  preload = '';
  src = '';
  paused = true;
  currentTime = 0;
  error: { code: number } | null = null;
  playCalls = 0;
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {}
  async play() {
    this.playCalls++;
    this.paused = false;
    this.dispatchEvent(new Event('play'));
    this.dispatchEvent(new Event('playing'));
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}

function setup(probe: (url: string) => Promise<void> = async () => {}) {
  const el = new FakeAudio();
  const storage = createMemoryMusicStorage();
  const states: MusicState[] = [];
  const handlers: Record<string, () => void> = {};
  const mediaSession = { metadata: null, playbackState: 'none', setActionHandler: (a: string, h: () => void) => (handlers[a] = h) };
  let urls = 0;
  const revoked: string[] = [];
  const prepare = vi.fn();
  const player = new MusicPlayer({
    element: el as unknown as HTMLAudioElement,
    storage,
    prepare,
    onState: (s) => states.push({ ...s }),
    mediaSession: mediaSession as unknown as MediaSession,
    urls: { create: () => `blob:${++urls}`, revoke: (u) => revoked.push(u) },
    probeStream: probe,
  });
  const file = (name: string) => new File(['x'], name, { type: 'audio/mpeg' });
  return { el, storage, states, handlers, mediaSession, revoked, prepare, player, file };
}

describe('MusicPlayer', () => {
  it('stores files, plays, wraps around, and keeps object URLs tidy', async () => {
    const { player, el, file, revoked, prepare, states } = setup();
    const added = await player.addFiles([file('One.mp3'), file('Two.mp3'), new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    expect(added.map((a) => a.title)).toEqual(['One', 'Two']);
    expect(states.at(-1)!.error).toMatch(/skipped/);
    await player.play();
    expect(prepare).toHaveBeenCalled();
    expect(el.crossOrigin).toBe('anonymous');
    expect(el.src).toBe('blob:1');
    expect(states.at(-1)).toMatchObject({ playing: true, nowPlaying: { title: 'One' } });
    await player.next();
    expect(el.src).toBe('blob:2');
    expect(revoked).toEqual(['blob:1']);
    el.dispatchEvent(new Event('ended'));
    await vi.waitFor(() => expect(states.at(-1)!.nowPlaying!.title).toBe('One'));
    await player.previous();
    expect(states.at(-1)!.nowPlaying!.title).toBe('Two');
  });

  it('restarts the current track on previous() after a few seconds', async () => {
    const { player, el, file, states } = setup();
    await player.addFiles([file('One.mp3'), file('Two.mp3')]);
    await player.play();
    el.currentTime = 42;
    await player.previous();
    expect(el.currentTime).toBe(0);
    expect(states.at(-1)!.nowPlaying!.title).toBe('One');
  });

  it('toggles, removes the playing track and moves on, and notifies listeners', async () => {
    const { player, el, file, storage } = setup();
    const seen: number[] = [];
    player.onTracksChanged((tracks) => seen.push(tracks.length));
    const [one] = await player.addFiles([file('One.mp3'), file('Two.mp3')]);
    await player.toggle();
    expect(el.paused).toBe(false);
    await player.toggle();
    expect(el.paused).toBe(true);
    await player.play();
    await player.removeTrack(one!.id);
    expect((await storage.list()).map((x) => x.title)).toEqual(['Two']);
    expect(player.currentTrackId).not.toBe(one!.id);
    expect(el.paused).toBe(false);
    expect(seen.at(-1)).toBe(1);
  });

  it('adds CORS-checked streams and explains failures', async () => {
    const ok = setup();
    const track = await ok.player.addStream(' https://radio.example/live/jazz.mp3 ');
    expect(track).toMatchObject({ kind: 'stream', title: 'jazz', url: 'https://radio.example/live/jazz.mp3' });
    await expect(ok.player.addStream('ftp://x')).rejects.toThrow(/https/);
    const bad = setup(() => Promise.reject(new Error(STREAM_CORS_MESSAGE)));
    await expect(bad.player.addStream('https://no-cors.example/s.mp3')).rejects.toThrow(/CORS/);
    expect(bad.states.at(-1)!.error).toMatch(/CORS/);
  });

  it('reports a stream that fails to load', async () => {
    const { player, el, states } = setup();
    await player.addStream('https://radio.example/a.mp3', 'Radio A');
    await player.play();
    el.error = { code: 4 };
    el.dispatchEvent(new Event('error'));
    expect(states.at(-1)).toMatchObject({ playing: false });
    expect(states.at(-1)!.error).toMatch(/Radio A.*CORS/);
  });

  it('wires Media Session for helmet buttons', async () => {
    const { player, handlers, file, mediaSession } = setup();
    expect(Object.keys(handlers).sort()).toEqual(['nexttrack', 'pause', 'play', 'previoustrack']);
    await player.addFiles([file('One.mp3'), file('Two.mp3')]);
    handlers.play!();
    await vi.waitFor(() => expect(mediaSession.playbackState).toBe('playing'));
    handlers.nexttrack!();
    await vi.waitFor(() => expect(player.snapshot.nowPlaying!.title).toBe('Two'));
    handlers.pause!();
    expect(mediaSession.playbackState).toBe('paused');
  });
});
