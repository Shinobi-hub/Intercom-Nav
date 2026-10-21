import { useSyncExternalStore } from 'react';
import { useLocalStore, type CameraMode } from '../../core/store';

export type AutoCameraMode = Exclude<CameraMode, 'free'>;

let lastAuto: AutoCameraMode = 'follow';
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function ensureTracking(): void {
  if (unsubscribe) return;
  const current = useLocalStore.getState().ui.cameraMode;
  if (current !== 'free') lastAuto = current;
  unsubscribe = useLocalStore.subscribe((st, prev) => {
    const mode = st.ui.cameraMode;
    if (mode === prev.ui.cameraMode || mode === 'free' || mode === lastAuto) return;
    lastAuto = mode;
    for (const l of listeners) l();
  });
}

/** The camera mode to return to from free mode: whichever of follow/group was used last. */
export function getLastAutoMode(): AutoCameraMode {
  ensureTracking();
  return lastAuto;
}

export function useLastAutoMode(): AutoCameraMode {
  ensureTracking();
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => lastAuto,
  );
}
