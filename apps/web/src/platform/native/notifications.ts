import type { Channel, LocalNotificationsPlugin } from '@capacitor/local-notifications';
import type { BackgroundApi } from '../../core/services';
import { notificationIdFor } from '../common/notificationId';

export const SOS_CHANNEL_ID = 'sos';
export const ALERTS_CHANNEL_ID = 'alerts';

/**
 * Android notification channels. Their importance/sound can't be changed after creation, so the
 * ids are stable and new behaviour needs new ids. No `sound` means the system default sound.
 */
export const NOTIFICATION_CHANNELS: readonly Channel[] = [
  {
    id: SOS_CHANNEL_ID,
    name: 'SOS alerts',
    description: 'A rider in your group needs help',
    importance: 4, // IMPORTANCE_HIGH: sound + heads-up
    visibility: 1, // public: readable on the lock screen
    vibration: true,
    lights: true,
    lightColor: '#FF3B30',
  },
  {
    id: ALERTS_CHANNEL_ID,
    name: 'Ride alerts',
    description: 'Breaks and other group alerts while the app is in the background',
    importance: 3, // IMPORTANCE_DEFAULT: sound, no heads-up
    visibility: 1,
    vibration: true,
  },
];

type NotificationsPlugin = Pick<LocalNotificationsPlugin, 'createChannel' | 'checkPermissions' | 'requestPermissions' | 'schedule'>;

export interface NativeNotifier {
  /** Android: create the SOS and Alerts channels (idempotent). No-op on iOS. */
  ensureChannels(): Promise<void>;
  /** iOS: ask for notification permission. Android requests POST_NOTIFICATIONS via RideService. */
  requestPermission(): Promise<boolean>;
  notify: BackgroundApi['notify'];
}

export function createNativeNotifier(plugin: NotificationsPlugin, kind: 'android' | 'ios'): NativeNotifier {
  let channels: Promise<void> | null = null;

  function ensureChannels(): Promise<void> {
    if (kind !== 'android') return Promise.resolve();
    channels ??= Promise.all(NOTIFICATION_CHANNELS.map((c) => plugin.createChannel(c))).then(
      () => undefined,
      (err: unknown) => {
        channels = null; // retry next time
        throw err;
      },
    );
    return channels;
  }

  return {
    ensureChannels,

    async requestPermission() {
      const { display } = await plugin.requestPermissions();
      return display === 'granted';
    },

    async notify(n) {
      // Never prompts: permission is requested once, at ride start.
      const { display } = await plugin.checkPermissions();
      if (display !== 'granted') return;
      await ensureChannels();
      await plugin.schedule({
        notifications: [
          {
            id: notificationIdFor(n.id),
            title: n.title,
            body: n.body,
            channelId: n.urgent ? SOS_CHANNEL_ID : ALERTS_CHANNEL_ID,
            autoCancel: true,
            group: 'ride-alerts',
            threadIdentifier: 'ride-alerts',
            // iOS: time-sensitive breaks through Focus once the entitlement is added (see docs/NATIVE.md).
            interruptionLevel: n.urgent ? 'timeSensitive' : 'active',
            extra: { alertId: n.id, urgent: n.urgent },
          },
        ],
      });
    },
  };
}
