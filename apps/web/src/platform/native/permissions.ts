import type { RidePermission, RidePermissionStatus, RideServicePlugin } from './plugins';

export interface PermissionBroker {
  /** Requests whatever of `permissions` is still missing; resolves with the resulting states. */
  ensure(permissions: RidePermission[]): Promise<RidePermissionStatus>;
}

/**
 * Android shows one runtime-permission dialog at a time; a second request made while one is showing
 * is cancelled and comes back "denied". At ride start the background service, the GPS provider and
 * the audio engine all want permissions at once, so requests from this layer are chained here, and
 * the native side additionally queues the WebView's own microphone prompt behind them (see
 * PermissionGate.java). Already-granted permissions resolve without any dialog.
 */
export function createPermissionBroker(plugin: Pick<RideServicePlugin, 'ensurePermissions'>): PermissionBroker {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    ensure(permissions) {
      const run = tail.then(() => plugin.ensurePermissions({ permissions }));
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
