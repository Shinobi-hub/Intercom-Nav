import { getServices } from '../../core/services';

/** Click earcon + short buzz for a tap, so gloved riders know it registered without looking. */
export function tapFeedback(): void {
  try {
    const s = getServices();
    s.audio.alerts.click();
    s.platform.haptics.vibrate(12);
  } catch {
    /* services not registered (isolated tests, dev harness without audio) */
  }
}
