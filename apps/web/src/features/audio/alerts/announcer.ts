/**
 * Text-to-speech for alerts. speechSynthesis plays through the system output, outside Web Audio,
 * so it can't be mixed or ducked; we only control ordering.
 *
 * Utterances are handed to the engine one at a time from our own short queue, which lets an
 * urgent announcement drop everything queued (and cut off whatever is talking) without losing
 * track of state, and stops a burst of routine alerts from piling up into a minute of talk.
 */

export interface AnnounceOptions {
  /** Cancel queued and current announcements and speak now. Defaults to true for SOS texts. */
  urgent?: boolean;
}

const MAX_QUEUED = 2;

interface Item {
  text: string;
  urgent: boolean;
}

export class Announcer {
  private queue: Item[] = [];
  private current: Item | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly synth: () => SpeechSynthesis | null = defaultSynth) {}

  /** iOS only lets speech start from a user gesture once; speak an empty utterance inside it. */
  unlock(): void {
    const synth = this.synth();
    if (!synth) return;
    try {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      synth.speak(u);
    } catch {
      /* no TTS here */
    }
  }

  announce(text: string, opts: AnnounceOptions = {}): void {
    const clean = text.trim();
    const synth = this.synth();
    if (!clean || !synth) return;
    const urgent = opts.urgent ?? /\bSOS\b/i.test(clean);
    if (urgent) {
      this.queue = [];
      this.current = null;
      this.clearWatchdog();
      synth.cancel();
      this.speak({ text: clean, urgent });
      return;
    }
    this.queue.push({ text: clean, urgent });
    // Keep the newest routine items; an older one is stale by the time it would be heard.
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
    if (!this.current) this.next();
  }

  cancel(): void {
    this.queue = [];
    this.current = null;
    this.clearWatchdog();
    this.synth()?.cancel();
  }

  private next(): void {
    const item = this.queue.shift();
    if (item) this.speak(item);
  }

  private speak(item: Item): void {
    const synth = this.synth();
    if (!synth) return;
    this.current = item;
    const u = new SpeechSynthesisUtterance(item.text);
    u.rate = 1.05;
    u.lang = typeof navigator !== 'undefined' ? navigator.language : 'en';
    const done = () => {
      if (this.current !== item) return;
      this.current = null;
      this.clearWatchdog();
      this.next();
    };
    u.onend = done;
    u.onerror = done;
    // Chrome sometimes never fires 'end' (e.g. after the tab was backgrounded); don't wedge.
    this.clearWatchdog();
    this.watchdog = setTimeout(done, 4_000 + item.text.length * 120);
    // Chrome can be left paused after the page was hidden.
    synth.resume();
    synth.speak(u);
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

function defaultSynth(): SpeechSynthesis | null {
  return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
}
