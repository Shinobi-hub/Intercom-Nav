import type { AppPlugin } from '@capacitor/app';
import type { LifecycleApi } from '../../core/services';
import { createEmitter } from '../common/emitter';

/**
 * Foreground/background from @capacitor/app, normalised across platforms because the raw events
 * mean different things:
 *
 *   Android  appStateChange(false) = Activity.onStop (really backgrounded). 'pause'/'resume' also
 *            fire around permission dialogs, so they're not used.
 *   iOS      'pause' = didEnterBackground. appStateChange(false) = willResignActive, which also fires
 *            for Control Center and system alerts, so it's not used for "background".
 *   Both     appStateChange(true) = the app is active again; it's the resume signal (on iOS that is
 *            didBecomeActive, so the audio session can be reactivated by then).
 *
 * Page visibility can't be used on Android: while a ride runs the WebView is deliberately kept
 * "visible" with the screen off (see RideWebView.java), so document.visibilityState stays 'visible'.
 */
export function createNativeLifecycle(app: Pick<AppPlugin, 'addListener' | 'getState'>, kind: 'android' | 'ios'): LifecycleApi {
  const resumed = createEmitter();
  const paused = createEmitter();
  let foreground = true;

  const toBackground = (): void => {
    if (!foreground) return;
    foreground = false;
    paused.emit();
  };
  const toForeground = (): void => {
    if (foreground) return;
    foreground = true;
    resumed.emit();
  };

  void app.addListener('appStateChange', ({ isActive }) => {
    if (isActive) toForeground();
    else if (kind === 'android') toBackground();
  });
  if (kind === 'ios') void app.addListener('pause', toBackground);

  // JS normally boots with the app in front, but a launch into the background is possible.
  app
    .getState()
    .then(({ isActive }) => {
      if (!isActive) toBackground();
    })
    .catch(() => undefined);

  return {
    onResume: (cb) => resumed.on(cb),
    onPause: (cb) => paused.on(cb),
    isForeground: () => foreground,
  };
}
