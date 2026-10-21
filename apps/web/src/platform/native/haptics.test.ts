import type { HapticsPlugin } from '@capacitor/haptics';
import { ImpactStyle } from '@capacitor/haptics';
import { describe, expect, it, vi } from 'vitest';
import { createNativeHaptics } from './haptics';

function setup(kind: 'android' | 'ios') {
  const plugin = { vibrate: vi.fn(async () => {}), impact: vi.fn(async () => {}) };
  const timers: Array<{ at: number; fn: () => void; cancelled: boolean }> = [];
  const haptics = createNativeHaptics({
    plugin: plugin as unknown as Pick<HapticsPlugin, 'vibrate' | 'impact'>,
    kind,
    setTimer: (fn, ms) => {
      const t = { at: ms, fn, cancelled: false };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => {
      (t as { cancelled: boolean }).cancelled = true;
    },
  });
  const runTimers = () => timers.filter((t) => !t.cancelled).forEach((t) => t.fn());
  return { haptics, plugin, timers, runTimers };
}

describe('createNativeHaptics', () => {
  it('plays each "on" step of a pattern at its offset', () => {
    const { haptics, plugin, timers, runTimers } = setup('android');
    haptics.vibrate([600, 200, 600, 200, 600]);
    expect(plugin.vibrate).toHaveBeenCalledTimes(1);
    expect(plugin.vibrate).toHaveBeenCalledWith({ duration: 600 });
    expect(timers.map((t) => t.at)).toEqual([800, 1600]);
    runTimers();
    expect(plugin.vibrate).toHaveBeenCalledTimes(3);
  });

  it('a new pattern (or 0) cancels the rest of the previous one', () => {
    const { haptics, plugin, timers, runTimers } = setup('android');
    haptics.vibrate([100, 100, 100]);
    haptics.vibrate(0);
    expect(timers.every((t) => t.cancelled)).toBe(true);
    runTimers();
    expect(plugin.vibrate).toHaveBeenCalledTimes(1);
  });

  it('uses impacts for short taps on iOS, which cannot shorten its vibration', () => {
    const { haptics, plugin } = setup('ios');
    haptics.vibrate(12);
    expect(plugin.impact).toHaveBeenCalledWith({ style: ImpactStyle.Heavy });
    expect(plugin.vibrate).not.toHaveBeenCalled();
    haptics.vibrate(600);
    expect(plugin.vibrate).toHaveBeenCalledWith({ duration: 600 });
  });
});
