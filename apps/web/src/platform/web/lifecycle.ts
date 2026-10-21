import type { LifecycleApi } from '../../core/services';
import { createEmitter } from '../common/emitter';

/**
 * Foreground/background from Page Visibility, plus pagehide/pageshow (bfcache, where Safari may
 * skip visibilitychange) and the Page Lifecycle freeze/resume events where they exist. Callbacks
 * fire only on real transitions, so overlapping signals never double-fire.
 */
export function createWebLifecycle(doc: Document = document, win: Window = window): LifecycleApi {
  const resumed = createEmitter();
  const paused = createEmitter();
  let foreground = doc.visibilityState !== 'hidden';

  const toForeground = (): void => {
    if (foreground || doc.visibilityState === 'hidden') return;
    foreground = true;
    resumed.emit();
  };
  const toBackground = (): void => {
    if (!foreground) return;
    foreground = false;
    paused.emit();
  };

  doc.addEventListener('visibilitychange', () => (doc.visibilityState === 'hidden' ? toBackground() : toForeground()));
  win.addEventListener('pagehide', toBackground);
  win.addEventListener('pageshow', toForeground);
  doc.addEventListener('freeze', toBackground);
  doc.addEventListener('resume', toForeground);

  return {
    onResume: (cb) => resumed.on(cb),
    onPause: (cb) => paused.on(cb),
    isForeground: () => foreground,
  };
}
