import type { AlertSoundsApi, ChimeKind } from '../../../core/services';
import { Announcer, type AnnounceOptions } from './announcer';
import { CHIMES, CLICK, scheduleNotes, startSirenVoice, type SirenVoice } from './tones';

export interface AlertOutputs {
  ctx: AudioContext;
  /** Chimes: through the normal mix (master volume, limiter). */
  fxBus: AudioNode;
  /** Siren: straight to the output, never ducked, ignores master volume. */
  alertBus: AudioNode;
}

export interface AlertSoundsDeps {
  /** Builds the audio graph on first use. */
  outputs(): AlertOutputs;
  onSirenChange(active: boolean): void;
  announcer?: Announcer;
}

export class AlertSounds implements AlertSoundsApi {
  private siren: SirenVoice | null = null;
  private readonly announcer: Announcer;

  constructor(private readonly deps: AlertSoundsDeps) {
    this.announcer = deps.announcer ?? new Announcer();
  }

  get sirenActive(): boolean {
    return this.siren !== null;
  }

  startSiren(): void {
    if (this.siren) return;
    const { ctx, alertBus } = this.deps.outputs();
    this.siren = startSirenVoice(ctx, alertBus);
    this.deps.onSirenChange(true);
  }

  stopSiren(): void {
    if (!this.siren) return;
    this.siren.stop();
    this.siren = null;
    this.deps.onSirenChange(false);
  }

  chime(kind: ChimeKind): void {
    const notes = CHIMES[kind];
    if (!notes) return;
    const { ctx, fxBus } = this.deps.outputs();
    scheduleNotes(ctx, fxBus, notes);
  }

  click(): void {
    const { ctx, fxBus } = this.deps.outputs();
    scheduleNotes(ctx, fxBus, CLICK);
  }

  /**
   * Speaks `text`. Routine announcements queue (newest two kept); urgent ones, by default any
   * text mentioning SOS, cut in and drop the queue.
   */
  announce(text: string, opts?: AnnounceOptions): void {
    this.announcer.announce(text, opts);
  }

  /** Called from the unlock gesture. */
  unlockSpeech(): void {
    this.announcer.unlock();
  }

  dispose(): void {
    this.siren?.stop(0.01);
    this.siren = null;
    this.announcer.cancel();
  }
}
