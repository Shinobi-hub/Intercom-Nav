import { describe, expect, it, vi } from 'vitest';
import { createWebBackground, type WebBackgroundEnv } from './background';

const alert = { id: 'sos-123', title: 'SOS from Sam', body: '2 km away', urgent: true };

function setup(opts: { permission: NotificationPermission; visibility: DocumentVisibilityState; registered?: boolean }) {
  const showNotification = vi.fn(async () => {});
  const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
  const getRegistration = vi.fn(async () =>
    opts.registered === false ? undefined : ({ showNotification } as unknown as ServiceWorkerRegistration),
  );
  const env: WebBackgroundEnv = {
    document: { visibilityState: opts.visibility } as Document,
    notification: { permission: opts.permission, requestPermission } as unknown as { permission: NotificationPermission },
    serviceWorker: { getRegistration } as unknown as WebBackgroundEnv['serviceWorker'],
  };
  return { background: createWebBackground(env), showNotification, requestPermission, getRegistration };
}

describe('createWebBackground', () => {
  it('cannot keep the app alive with the screen off', async () => {
    const { background } = setup({ permission: 'granted', visibility: 'hidden' });
    expect(background.supported).toBe(false);
    await expect(background.start({ title: 't', text: 'x' })).resolves.toBeUndefined();
    await expect(background.stop()).resolves.toBeUndefined();
  });

  it('notifies through the service worker when permission is granted and the page is hidden', async () => {
    const { background, showNotification } = setup({ permission: 'granted', visibility: 'hidden' });
    await background.notify(alert);
    expect(showNotification).toHaveBeenCalledWith(
      'SOS from Sam',
      expect.objectContaining({ body: '2 km away', tag: 'sos-123', requireInteraction: true }),
    );
  });

  it('non-urgent alerts do not demand interaction', async () => {
    const { background, showNotification } = setup({ permission: 'granted', visibility: 'hidden' });
    await background.notify({ ...alert, urgent: false });
    expect(showNotification).toHaveBeenCalledWith(alert.title, expect.objectContaining({ requireInteraction: false }));
  });

  it('stays silent while the page is visible (the in-app UI shows the alert)', async () => {
    const { background, showNotification, getRegistration } = setup({ permission: 'granted', visibility: 'visible' });
    await background.notify(alert);
    expect(getRegistration).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it.each(['default', 'denied'] as const)('never prompts and never shows when permission is %s', async (permission) => {
    const { background, showNotification, requestPermission } = setup({ permission, visibility: 'hidden' });
    await background.notify(alert);
    expect(requestPermission).not.toHaveBeenCalled();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('does nothing without a service worker registration', async () => {
    const { background, showNotification } = setup({ permission: 'granted', visibility: 'hidden', registered: false });
    await expect(background.notify(alert)).resolves.toBeUndefined();
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('does nothing where notifications do not exist', async () => {
    const background = createWebBackground({ document: { visibilityState: 'hidden' } as Document });
    await expect(background.notify(alert)).resolves.toBeUndefined();
  });
});
