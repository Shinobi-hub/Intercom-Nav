import type { BackgroundApi } from '../../core/services';

/** Fields Chrome supports that TypeScript's DOM lib dropped. */
interface ExtendedNotificationOptions extends NotificationOptions {
  renotify?: boolean;
  vibrate?: number[];
}

export interface WebBackgroundEnv {
  document: Document;
  /** The Notification constructor, or undefined where notifications don't exist (iOS Safari tabs). */
  notification?: { readonly permission: NotificationPermission };
  serviceWorker?: Pick<ServiceWorkerContainer, 'getRegistration'>;
}

export function defaultBackgroundEnv(): WebBackgroundEnv {
  return {
    document,
    notification: typeof Notification === 'undefined' ? undefined : Notification,
    serviceWorker: 'serviceWorker' in navigator ? navigator.serviceWorker : undefined,
  };
}

/**
 * The web can't keep GPS and voice alive with the screen off, so start/stop are no-ops. notify()
 * shows a notification through the service worker registration, but only when the user already
 * granted permission and the page is hidden: it never prompts (that needs a gesture and context the
 * caller has) and never duplicates the in-app alert UI while the page is visible.
 */
export function createWebBackground(env: WebBackgroundEnv = defaultBackgroundEnv()): BackgroundApi {
  return {
    supported: false,
    async start() {},
    async stop() {},
    async notify(n) {
      if (env.notification?.permission !== 'granted') return;
      if (env.document.visibilityState !== 'hidden') return;
      const registration = await env.serviceWorker?.getRegistration();
      if (!registration) return;
      const options: ExtendedNotificationOptions = {
        body: n.body,
        tag: n.id, // same alert id replaces instead of stacking
        renotify: true,
        requireInteraction: n.urgent,
        silent: false,
        icon: '/icon.svg',
        vibrate: n.urgent ? [400, 150, 400, 150, 400] : [150],
        data: { alertId: n.id, urgent: n.urgent },
      };
      await registration.showNotification(n.title, options);
    },
  };
}
