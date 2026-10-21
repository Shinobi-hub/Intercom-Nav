import type { BackgroundApi } from '../../core/services';
import type { NativeNotifier } from './notifications';
import type { PermissionBroker } from './permissions';
import type { RideServicePlugin } from './plugins';

export interface NativeBackgroundDeps {
  kind: 'android' | 'ios';
  rideService: Pick<RideServicePlugin, 'start' | 'stop'>;
  permissions: PermissionBroker;
  notifier: NativeNotifier;
}

/**
 * Ride start/stop for the native builds.
 *
 * Android: asks for every runtime permission the ride needs in one sequence (mic, location,
 * notifications, nearby devices) while the app is still in front, then starts RideService, the
 * foreground service of type location|microphone|mediaPlayback that keeps GPS, voice and the
 * WebView's JavaScript running with the screen off. Denied permissions don't block the start: the
 * service only claims the foreground-service types whose permissions were granted.
 *
 * iOS: background modes are static (Info.plist); start() asks for notification permission and
 * tells the plugin a ride is active so the audio session stays configured through interruptions.
 */
export function createNativeBackground(deps: NativeBackgroundDeps): BackgroundApi {
  const { kind, rideService, permissions, notifier } = deps;
  const warn = (what: string) => (err: unknown) => console.warn(`[platform] ${what}`, err);

  return {
    supported: true,

    async start(info) {
      if (kind === 'android') {
        await notifier.ensureChannels().catch(warn('notification channels'));
        await permissions.ensure(['microphone', 'location', 'notifications', 'bluetooth']).catch(warn('permissions'));
      } else {
        await notifier.requestPermission().catch(warn('notification permission'));
      }
      await rideService.start({ title: info.title, text: info.text, bluetoothRouting: true });
    },

    async stop() {
      await rideService.stop();
    },

    notify: (n) => notifier.notify(n),
  };
}
