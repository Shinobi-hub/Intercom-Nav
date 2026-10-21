import type { LatLng } from '@intercom/shared';
import { directionsUrl } from '../../core/links';
import { getServices } from '../../core/services';
import { useLocalStore } from '../../core/store';

/**
 * Any tap on an alert is a user gesture; if iOS suspended audio, use it to bring the siren and
 * voice back before anything else.
 */
export function resumeAudioIfSuspended(): void {
  const state = useLocalStore.getState().audio.contextState;
  if (state === 'suspended' || state === 'interrupted') void getServices().controller.resumeAudio();
}

export function respondToSos(id: string): void {
  resumeAudioIfSuspended();
  void getServices().controller.respondSos(id);
}

export function silenceSos(id: string): void {
  resumeAudioIfSuspended();
  getServices().controller.acknowledgeSos(id);
}

/** Turn-by-turn in the platform maps app. */
export function openDirections(to: LatLng): void {
  const { platform } = getServices();
  platform.openExternal(directionsUrl(to, platform.kind));
}

export function showRiderOnMap(riderId: string): void {
  const local = useLocalStore.getState();
  local.openSheet(null);
  local.focusRider(riderId);
}
