/**
 * Earcons and haptics for direct actions. Riders wear gloves and can't watch the screen, so every
 * press must be felt and heard. The ride controller only makes noise for remote events; anything the
 * rider just tapped gets its feedback from here.
 */
import type { ChimeKind } from '../core/services';
import { getServices } from '../core/services';

/** A press landed. */
export function tapFeedback(): void {
  const { audio, platform } = getServices();
  audio.alerts.click();
  platform.haptics.vibrate(12);
}

/** A light tick while a hold is in progress. */
export function tickFeedback(): void {
  getServices().platform.haptics.vibrate(8);
}

/** The action was accepted. */
export function successFeedback(kind: ChimeKind = 'sent'): void {
  const { audio, platform } = getServices();
  audio.alerts.chime(kind);
  platform.haptics.vibrate([18, 60, 18]);
}

/** The action was refused or failed. */
export function errorFeedback(): void {
  const { audio, platform } = getServices();
  audio.alerts.chime('error');
  platform.haptics.vibrate([70, 50, 70]);
}
