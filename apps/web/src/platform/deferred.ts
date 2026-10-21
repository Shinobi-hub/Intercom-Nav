import type { PlatformApi } from '../core/services';
import { createEmitter } from './common/emitter';

/**
 * A PlatformApi that can be handed out synchronously while the real one loads (the native
 * implementation is a separate chunk). Async members wait for it; sync members answer from safe
 * defaults until it arrives; listeners registered early are wired to it once it's there.
 */
export function createDeferredPlatform(
  kind: 'android' | 'ios',
  load: () => Promise<PlatformApi>,
  fallback: () => PlatformApi,
): PlatformApi {
  let impl: PlatformApi | null = null;
  const resumed = createEmitter();
  const paused = createEmitter();
  const networkChanged = createEmitter<[boolean]>();

  const ready: Promise<PlatformApi> = load()
    .catch((err: unknown) => {
      console.error('[platform] native layer failed to load; falling back to web adapters', err);
      return fallback();
    })
    .then((p) => {
      impl = p;
      p.lifecycle.onResume(() => resumed.emit());
      p.lifecycle.onPause(() => paused.emit());
      p.network.onChange((online) => networkChanged.emit(online));
      return p;
    });

  /** Runs now if loaded, else as soon as it is (fire-and-forget members like vibrate). */
  const whenReady = (fn: (p: PlatformApi) => void): void => {
    if (impl) fn(impl);
    else void ready.then(fn);
  };

  return {
    kind,
    isNative: true,
    geo: {
      start: async (onFix, onError) => (await ready).geo.start(onFix, onError),
      stop: async () => (await ready).geo.stop(),
    },
    wakeLock: {
      enable: async () => (await ready).wakeLock.enable(),
      disable: async () => (await ready).wakeLock.disable(),
      get active() {
        return impl?.wakeLock.active ?? false;
      },
    },
    lifecycle: {
      onResume: (cb) => resumed.on(cb),
      onPause: (cb) => paused.on(cb),
      isForeground: () => impl?.lifecycle.isForeground() ?? document.visibilityState !== 'hidden',
    },
    haptics: { vibrate: (pattern) => whenReady((p) => p.haptics.vibrate(pattern)) },
    audioSession: { setMode: (mode) => whenReady((p) => p.audioSession.setMode(mode)) },
    background: {
      get supported() {
        return impl?.background.supported ?? true;
      },
      start: async (info) => (await ready).background.start(info),
      stop: async () => (await ready).background.stop(),
      notify: async (n) => (await ready).background.notify(n),
    },
    network: {
      isOnline: () => impl?.network.isOnline() ?? navigator.onLine,
      onChange: (cb) => networkChanged.on(cb),
    },
    openExternal: (url) => whenReady((p) => p.openExternal(url)),
    share: async (data) => (await ready).share(data),
  };
}
