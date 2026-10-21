import { describe, expect, it, vi } from 'vitest';
import { createPermissionBroker } from './permissions';
import type { RidePermission, RidePermissionStatus } from './plugins';

const granted: RidePermissionStatus = {
  location: 'granted',
  preciseLocation: true,
  microphone: 'granted',
  notifications: 'granted',
  bluetooth: 'granted',
};

describe('createPermissionBroker', () => {
  it('never has two native requests in flight at once', async () => {
    const resolvers: Array<() => void> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const ensurePermissions = vi.fn(async ({ permissions }: { permissions: RidePermission[] }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => resolvers.push(r));
      inFlight--;
      return { ...granted, location: permissions.includes('location') ? 'granted' : 'prompt' } as RidePermissionStatus;
    });
    const broker = createPermissionBroker({ ensurePermissions });

    const all = broker.ensure(['microphone', 'location', 'notifications', 'bluetooth']);
    const location = broker.ensure(['location']);
    await Promise.resolve();
    expect(ensurePermissions).toHaveBeenCalledTimes(1);

    resolvers.shift()!();
    await all;
    await new Promise((r) => setTimeout(r, 0));
    expect(ensurePermissions).toHaveBeenCalledTimes(2);
    resolvers.shift()!();
    await expect(location).resolves.toMatchObject({ location: 'granted' });
    expect(maxInFlight).toBe(1);
  });

  it('a failed request does not block the next one', async () => {
    const ensurePermissions = vi
      .fn()
      .mockRejectedValueOnce(new Error('activity gone'))
      .mockResolvedValueOnce(granted);
    const broker = createPermissionBroker({ ensurePermissions });
    await expect(broker.ensure(['location'])).rejects.toThrow('activity gone');
    await expect(broker.ensure(['location'])).resolves.toEqual(granted);
  });
});
