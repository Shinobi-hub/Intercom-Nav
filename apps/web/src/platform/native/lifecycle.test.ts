import type { AppPlugin, AppState } from '@capacitor/app';
import { describe, expect, it, vi } from 'vitest';
import { createNativeLifecycle } from './lifecycle';

function fakeApp(isActive = true) {
  const listeners = new Map<string, Array<(data?: unknown) => void>>();
  const app = {
    addListener: vi.fn(async (event: string, fn: (data?: unknown) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn]);
      return { remove: async () => {} };
    }),
    getState: vi.fn(async (): Promise<AppState> => ({ isActive })),
  };
  const fire = (event: string, data?: unknown) => listeners.get(event)?.forEach((fn) => fn(data));
  return { app: app as unknown as Pick<AppPlugin, 'addListener' | 'getState'>, fire };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('createNativeLifecycle (android)', () => {
  it('backgrounds on appStateChange(false) (onStop) and resumes on the next active', async () => {
    const { app, fire } = fakeApp();
    const lifecycle = createNativeLifecycle(app, 'android');
    await tick();
    const onPause = vi.fn();
    const onResume = vi.fn();
    lifecycle.onPause(onPause);
    lifecycle.onResume(onResume);

    fire('appStateChange', { isActive: false });
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(lifecycle.isForeground()).toBe(false);

    fire('appStateChange', { isActive: true });
    fire('appStateChange', { isActive: true });
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(lifecycle.isForeground()).toBe(true);
  });

  it('ignores the onPause/onResume pair a permission dialog causes', async () => {
    const { app, fire } = fakeApp();
    const lifecycle = createNativeLifecycle(app, 'android');
    await tick();
    const onPause = vi.fn();
    const onResume = vi.fn();
    lifecycle.onPause(onPause);
    lifecycle.onResume(onResume);

    fire('pause');
    fire('resume');
    fire('appStateChange', { isActive: true }); // BridgeActivity.onResume always fires this
    expect(onPause).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('starts backgrounded if the app was launched without being active', async () => {
    const { app } = fakeApp(false);
    const lifecycle = createNativeLifecycle(app, 'android');
    await tick();
    expect(lifecycle.isForeground()).toBe(false);
  });
});

describe('createNativeLifecycle (ios)', () => {
  it('backgrounds on didEnterBackground, not on willResignActive', async () => {
    const { app, fire } = fakeApp();
    const lifecycle = createNativeLifecycle(app, 'ios');
    await tick();
    const onPause = vi.fn();
    const onResume = vi.fn();
    lifecycle.onPause(onPause);
    lifecycle.onResume(onResume);

    fire('appStateChange', { isActive: false }); // Control Center pulled down
    expect(lifecycle.isForeground()).toBe(true);
    fire('appStateChange', { isActive: true });
    expect(onResume).not.toHaveBeenCalled();

    fire('pause');
    expect(onPause).toHaveBeenCalledTimes(1);
    fire('resume'); // willEnterForeground: not active yet
    expect(onResume).not.toHaveBeenCalled();
    fire('appStateChange', { isActive: true }); // didBecomeActive
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});
