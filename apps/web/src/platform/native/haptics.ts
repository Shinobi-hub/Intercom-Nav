import type { HapticsPlugin } from '@capacitor/haptics';
import { ImpactStyle } from '@capacitor/haptics';
import type { HapticsApi } from '../../core/services';
import { toVibrationSegments } from '../common/vibration';

/**
 * iOS has no duration control: Haptics.vibrate is the ~400 ms system buzz. Button feedback in the
 * app uses 8-70 ms pulses, so up to this length an impact is used instead.
 */
const TAP_MAX_MS = 100;

export interface NativeHapticsDeps {
  plugin: Pick<HapticsPlugin, 'vibrate' | 'impact'>;
  kind: 'android' | 'ios';
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * navigator.vibrate semantics on top of @capacitor/haptics, which only vibrates once per call: each
 * "on" step of the pattern is scheduled, and a new pattern (or 0 / []) cancels the previous one.
 * iOS ignores durations (system vibration ≈ 400 ms), so short steps become impacts there.
 */
export function createNativeHaptics(deps: NativeHapticsDeps): HapticsApi {
  const { plugin, kind } = deps;
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  let timers: unknown[] = [];

  const pulse = (duration: number): void => {
    const done =
      kind === 'ios' && duration <= TAP_MAX_MS
        ? plugin.impact({ style: ImpactStyle.Heavy })
        : plugin.vibrate({ duration });
    done.catch(() => undefined);
  };

  return {
    vibrate(pattern) {
      for (const t of timers) clearTimer(t);
      timers = [];
      for (const { at, duration } of toVibrationSegments(pattern)) {
        if (at === 0) pulse(duration);
        else timers.push(setTimer(() => pulse(duration), at));
      }
    },
  };
}
