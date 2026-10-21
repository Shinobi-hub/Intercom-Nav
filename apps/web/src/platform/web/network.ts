import type { NetworkApi } from '../../core/services';
import { createEmitter } from '../common/emitter';

/**
 * navigator.onLine + online/offline events. Also used by the native builds: Android's WebView keeps
 * these accurate as long as the app holds ACCESS_NETWORK_STATE (declared in the manifest).
 */
export function createWebNetwork(win: Window = window, nav: Navigator = navigator): NetworkApi {
  const changed = createEmitter<[boolean]>();
  let last = nav.onLine;
  const update = (online: boolean): void => {
    if (online === last) return;
    last = online;
    changed.emit(online);
  };
  win.addEventListener('online', () => update(true));
  win.addEventListener('offline', () => update(false));
  return {
    isOnline: () => nav.onLine,
    onChange: (cb) => changed.on(cb),
  };
}
