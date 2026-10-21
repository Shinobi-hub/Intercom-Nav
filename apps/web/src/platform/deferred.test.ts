import { describe, expect, it, vi } from 'vitest';
import type { PlatformApi } from '../core/services';
import { createStubPlatform } from '../core/stubs';
import { createDeferredPlatform } from './deferred';

function controllable() {
  let resumeCb: (() => void) | null = null;
  const impl: PlatformApi = {
    ...createStubPlatform(),
    kind: 'android',
    isNative: true,
    lifecycle: {
      onResume: (cb) => {
        resumeCb = cb;
        return () => {};
      },
      onPause: () => () => {},
      isForeground: () => false,
    },
  };
  return { impl, fireResume: () => resumeCb?.() };
}

describe('createDeferredPlatform', () => {
  it('is usable before the native layer loads and delegates once it has', async () => {
    const { impl, fireResume } = controllable();
    const vibrate = vi.spyOn(impl.haptics, 'vibrate');
    const start = vi.spyOn(impl.background, 'start');
    let resolve!: (p: PlatformApi) => void;
    const platform = createDeferredPlatform('android', () => new Promise((r) => (resolve = r)), createStubPlatform);

    expect(platform.kind).toBe('android');
    expect(platform.isNative).toBe(true);
    expect(platform.background.supported).toBe(true);
    const onResume = vi.fn();
    platform.lifecycle.onResume(onResume); // registered before load
    platform.haptics.vibrate(50); // queued
    const starting = platform.background.start({ title: 't', text: 'x' });

    resolve(impl);
    await starting;
    expect(vibrate).toHaveBeenCalledWith(50);
    expect(start).toHaveBeenCalledWith({ title: 't', text: 'x' });
    expect(platform.lifecycle.isForeground()).toBe(false);
    fireResume();
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('falls back when the native layer fails to load', async () => {
    const fallback = createStubPlatform();
    const share = vi.spyOn(fallback, 'share');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const platform = createDeferredPlatform('ios', () => Promise.reject(new Error('chunk failed')), () => fallback);
    await platform.share({ url: 'https://example.com' });
    expect(share).toHaveBeenCalled();
  });
});
