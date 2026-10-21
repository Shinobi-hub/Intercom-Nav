import type { WakeLockApi } from '../../core/services';
import { SILENT_VIDEO_SOURCES } from './silentVideo';

export interface WebWakeLockEnv {
  document: Document;
  /** navigator.wakeLock, or undefined where the Screen Wake Lock API is missing. */
  wakeLock?: WakeLock;
  /** Factory for the fallback video (tests inject a fake; jsdom can't play media). */
  createVideo?: (doc: Document) => HTMLVideoElement;
}

export function defaultWakeLockEnv(): WebWakeLockEnv {
  return { document, wakeLock: 'wakeLock' in navigator ? navigator.wakeLock : undefined };
}

/** A muted, looping, inline, invisible video: while it plays, mobile browsers keep the screen on. */
export function createSilentVideo(doc: Document): HTMLVideoElement {
  const video = doc.createElement('video');
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  // Attribute forms too: older iOS only honours the attributes.
  video.setAttribute('muted', '');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.setAttribute('aria-hidden', 'true');
  video.setAttribute('tabindex', '-1');
  video.disablePictureInPicture = true;
  Object.assign(video.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    width: '1px',
    height: '1px',
    opacity: '0',
    pointerEvents: 'none',
  });
  for (const { src, type } of SILENT_VIDEO_SOURCES) {
    const source = doc.createElement('source');
    source.src = src;
    source.type = type;
    video.appendChild(source);
  }
  return video;
}

/**
 * Screen Wake Lock API, re-acquired whenever the page becomes visible again (browsers release it on
 * every hide). Where the API is missing or refuses, a silent looping video keeps the screen on; it
 * has to start inside a user gesture, so enable() reaches video.play() synchronously.
 */
export function createWebWakeLock(env: WebWakeLockEnv = defaultWakeLockEnv()): WakeLockApi {
  const { document: doc, wakeLock: api } = env;
  let wanted = false;
  let sentinel: WakeLockSentinel | null = null;
  let pending: Promise<void> | null = null;
  let video: HTMLVideoElement | null = null;

  function stopVideo(): void {
    if (video && !video.paused) video.pause();
  }

  function requestNative(wakeLock: WakeLock): Promise<void> {
    if (sentinel && !sentinel.released) return Promise.resolve();
    if (pending) return pending;
    const request = wakeLock
      .request('screen')
      .then(async (s) => {
        if (!wanted) {
          // disable() ran while the request was in flight.
          await s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
        });
        stopVideo(); // a fallback started earlier is no longer needed
      })
      .finally(() => {
        if (pending === request) pending = null;
      });
    pending = request;
    return request;
  }

  function playVideo(): Promise<void> {
    if (!video) {
      video = (env.createVideo ?? createSilentVideo)(doc);
      doc.body?.appendChild(video);
    }
    // Older engines return undefined instead of a promise.
    const played: Promise<void> | undefined = video.play();
    return played ?? Promise.resolve();
  }

  function acquire(): Promise<void> {
    if (!api) return playVideo();
    return requestNative(api).catch((err: unknown) =>
      // Refused (battery saver, permissions policy, page not visible): the video is a best effort.
      playVideo().catch(() => {
        throw err;
      }),
    );
  }

  doc.addEventListener('visibilitychange', () => {
    if (!wanted || doc.visibilityState !== 'visible') return;
    acquire().catch((err: unknown) => console.warn('[platform] wake lock re-acquire failed', err));
  });

  return {
    enable() {
      wanted = true;
      return acquire();
    },
    async disable() {
      wanted = false;
      const s = sentinel;
      sentinel = null;
      if (s && !s.released) await s.release().catch(() => undefined);
      stopVideo();
    },
    get active() {
      return Boolean(sentinel && !sentinel.released) || Boolean(video && !video.paused);
    },
  };
}
