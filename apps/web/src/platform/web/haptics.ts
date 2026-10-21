import type { HapticsApi } from '../../core/services';

/** navigator.vibrate where it exists (not iOS Safari). Chrome ignores it until the first tap. */
export function createWebHaptics(nav: Navigator = navigator): HapticsApi {
  return {
    vibrate(pattern) {
      if (typeof nav.vibrate !== 'function') return;
      try {
        nav.vibrate(pattern);
      } catch {
        // Some engines throw on invalid patterns or when blocked; haptics are never critical.
      }
    },
  };
}
