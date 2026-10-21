/**
 * A requestAnimationFrame loop throttled to ~30 fps that sleeps while the document is hidden
 * (browsers throttle hidden tabs anyway; native WebViews don't always).
 */
export class FrameLoop {
  private raf = 0;
  private last = -Infinity;
  private running = false;
  private failed = false;

  constructor(
    private readonly tick: (now: number) => void,
    private readonly minIntervalMs = 1000 / 30,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.schedule();
  }

  stop(): void {
    this.running = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private schedule(): void {
    if (!this.running || this.raf || document.hidden) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number) => {
    this.raf = 0;
    if (!this.running) return;
    // A little slack so a 60 Hz display reliably gets every other frame.
    if (now - this.last >= this.minIntervalMs - 4) {
      this.last = now;
      try {
        this.tick(now);
      } catch (e) {
        // Keep animating; report a broken frame once instead of flooding the console at 30 Hz.
        if (!this.failed) console.error('[map] frame failed', e);
        this.failed = true;
      }
    }
    this.schedule();
  };

  private readonly onVisibility = () => {
    if (document.hidden) {
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
    } else {
      this.schedule();
    }
  };
}
