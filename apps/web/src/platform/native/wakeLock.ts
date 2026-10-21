import type { KeepAwakePlugin } from '@capacitor-community/keep-awake';
import type { WakeLockApi } from '../../core/services';

/**
 * FLAG_KEEP_SCREEN_ON (Android) / isIdleTimerDisabled (iOS). Both stick across background and
 * foreground, so nothing needs re-acquiring on resume; enable() stays idempotent for the controller.
 * Screen-off operation doesn't depend on this: that's the RideService's job.
 */
export function createNativeWakeLock(plugin: Pick<KeepAwakePlugin, 'keepAwake' | 'allowSleep'>): WakeLockApi {
  let active = false;
  return {
    async enable() {
      await plugin.keepAwake();
      active = true;
    },
    async disable() {
      active = false;
      await plugin.allowSleep();
    },
    get active() {
      return active;
    },
  };
}
