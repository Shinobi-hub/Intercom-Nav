import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebWakeLock } from './wakeLock';

/** WakeLockSentinel stand-in; `drop()` simulates the browser releasing it when the page hides. */
class FakeSentinel extends EventTarget {
  released = false;
  readonly type = 'screen' as const;
  onrelease = null;
  async release(): Promise<void> {
    this.drop();
  }
  drop(): void {
    if (this.released) return;
    this.released = true;
    this.dispatchEvent(new Event('release'));
  }
}

function fakeWakeLockApi() {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn(async (_type?: WakeLockType) => {
    const s = new FakeSentinel();
    sentinels.push(s);
    return s as unknown as WakeLockSentinel;
  });
  return { api: { request } as unknown as WakeLock, request, sentinels };
}

let visibility: DocumentVisibilityState = 'visible';
function setVisibility(v: DocumentVisibilityState): void {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
}
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

/** A real <video> with playback stubbed: jsdom can't play media. */
function fakeVideo() {
  const element = document.createElement('video');
  let paused = true;
  const play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  const pause = vi.fn(() => {
    paused = true;
  });
  Object.defineProperties(element, {
    paused: { configurable: true, get: () => paused, set: (v: boolean) => (paused = v) },
    play: { configurable: true, value: play },
    pause: { configurable: true, value: pause },
  });
  return element as HTMLVideoElement & { play: typeof play; pause: typeof pause; paused: boolean };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  visibility = 'visible';
});

describe('createWebWakeLock with the Screen Wake Lock API', () => {
  it('acquires a screen wake lock on enable', async () => {
    const { api, request } = fakeWakeLockApi();
    const lock = createWebWakeLock({ document, wakeLock: api });
    await lock.enable();
    expect(request).toHaveBeenCalledWith('screen');
    expect(lock.active).toBe(true);
  });

  it('re-acquires when the page becomes visible again after the browser released it', async () => {
    const { api, request, sentinels } = fakeWakeLockApi();
    const lock = createWebWakeLock({ document, wakeLock: api });
    await lock.enable();

    setVisibility('hidden');
    sentinels[0]!.drop(); // browsers release screen locks on hide
    expect(lock.active).toBe(false);

    setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active).toBe(true);
  });

  it('does not re-acquire after disable()', async () => {
    const { api, request, sentinels } = fakeWakeLockApi();
    const lock = createWebWakeLock({ document, wakeLock: api });
    await lock.enable();
    await lock.disable();
    expect(sentinels[0]!.released).toBe(true);
    expect(lock.active).toBe(false);

    setVisibility('hidden');
    setVisibility('visible');
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not request twice while a request is in flight or a lock is held', async () => {
    const { api, request } = fakeWakeLockApi();
    const lock = createWebWakeLock({ document, wakeLock: api });
    await Promise.all([lock.enable(), lock.enable()]);
    await lock.enable();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('releases a lock that arrives after disable()', async () => {
    let resolve!: (s: WakeLockSentinel) => void;
    const sentinel = new FakeSentinel();
    const api = { request: vi.fn(() => new Promise<WakeLockSentinel>((r) => (resolve = r))) } as unknown as WakeLock;
    const lock = createWebWakeLock({ document, wakeLock: api });
    const enabling = lock.enable();
    await lock.disable();
    resolve(sentinel as unknown as WakeLockSentinel);
    await enabling;
    expect(sentinel.released).toBe(true);
    expect(lock.active).toBe(false);
  });

  it('falls back to the silent video when the request is refused', async () => {
    const api = { request: vi.fn(async () => Promise.reject(new DOMException('no', 'NotAllowedError'))) } as unknown as WakeLock;
    const video = fakeVideo();
    const lock = createWebWakeLock({ document, wakeLock: api, createVideo: () => video });
    await lock.enable();
    expect(video.play).toHaveBeenCalled();
    expect(lock.active).toBe(true);
  });
});

describe('createWebWakeLock without the API (silent video fallback)', () => {
  it('starts the video synchronously inside enable(), as iOS requires a user gesture', () => {
    const video = fakeVideo();
    const lock = createWebWakeLock({ document, createVideo: () => video });
    void lock.enable(); // not awaited: play() must already have happened
    expect(video.play).toHaveBeenCalledTimes(1);
    expect(lock.active).toBe(true);
  });

  it('restarts the video on visibility and pauses it on disable', async () => {
    const video = fakeVideo();
    const lock = createWebWakeLock({ document, createVideo: () => video });
    await lock.enable();
    setVisibility('hidden');
    video.paused = true; // the browser paused it while hidden
    setVisibility('visible');
    expect(video.play).toHaveBeenCalledTimes(2);

    await lock.disable();
    expect(video.pause).toHaveBeenCalled();
    expect(lock.active).toBe(false);
  });
});
