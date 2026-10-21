import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebLifecycle } from './lifecycle';
import { createWebNetwork } from './network';

let visibility: DocumentVisibilityState = 'visible';
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });

function hide(): void {
  visibility = 'hidden';
  document.dispatchEvent(new Event('visibilitychange'));
}
function show(): void {
  visibility = 'visible';
  document.dispatchEvent(new Event('visibilitychange'));
}

afterEach(() => {
  show();
});

describe('createWebLifecycle', () => {
  it('fires pause and resume once per transition', () => {
    const lifecycle = createWebLifecycle(document, window);
    const onPause = vi.fn();
    const onResume = vi.fn();
    lifecycle.onPause(onPause);
    lifecycle.onResume(onResume);

    hide();
    window.dispatchEvent(new Event('pagehide')); // overlapping signal: no second pause
    document.dispatchEvent(new Event('freeze'));
    expect(onPause).toHaveBeenCalledTimes(1);
    expect(lifecycle.isForeground()).toBe(false);

    show();
    window.dispatchEvent(new Event('pageshow'));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(lifecycle.isForeground()).toBe(true);
  });

  it('treats a bfcache restore (pageshow) as a resume even without visibilitychange', () => {
    const lifecycle = createWebLifecycle(document, window);
    const onResume = vi.fn();
    lifecycle.onResume(onResume);
    window.dispatchEvent(new Event('pagehide'));
    expect(lifecycle.isForeground()).toBe(false);
    window.dispatchEvent(new Event('pageshow'));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it('does not resume from a Page Lifecycle "resume" while still hidden', () => {
    const lifecycle = createWebLifecycle(document, window);
    const onResume = vi.fn();
    lifecycle.onResume(onResume);
    hide();
    document.dispatchEvent(new Event('resume'));
    expect(onResume).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const lifecycle = createWebLifecycle(document, window);
    const onPause = vi.fn();
    lifecycle.onPause(onPause)();
    hide();
    expect(onPause).not.toHaveBeenCalled();
  });
});

describe('createWebNetwork', () => {
  it('reports online/offline transitions once each', () => {
    let online = true;
    const nav = {
      get onLine() {
        return online;
      },
    } as Navigator;
    const network = createWebNetwork(window, nav);
    const onChange = vi.fn();
    network.onChange(onChange);

    online = false;
    window.dispatchEvent(new Event('offline'));
    window.dispatchEvent(new Event('offline'));
    expect(network.isOnline()).toBe(false);
    online = true;
    window.dispatchEvent(new Event('online'));
    expect(onChange.mock.calls).toEqual([[false], [true]]);
  });
});
