/**
 * Owns the getUserMedia stream: constraints, permission/device errors, and re-acquiring when the
 * device disappears under us (Bluetooth helmet switching profile, USB unplug, OS interruption).
 * Knows nothing about the audio graph; the engine wires whatever stream it reports.
 */
import type { MicState } from '../../../core/store';

export interface MicCaptureOptions {
  onStream(stream: MediaStream | null): void;
  onState(state: MicState, error: string | null): void;
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Delay before re-acquiring after the track ended unexpectedly; doubles per failure. */
  reacquireDelayMs?: number;
  maxReacquireDelayMs?: number;
}

export function micConstraints(deviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
}

/** Maps getUserMedia failures to a MicState and a message a rider can act on. */
export function describeMicError(err: unknown): { state: MicState; message: string } {
  const name = err instanceof Error || (typeof err === 'object' && err && 'name' in err) ? String((err as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return { state: 'denied', message: 'Microphone access is blocked. Allow it in the browser or app settings to talk.' };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { state: 'error', message: 'No microphone found. Connect your helmet headset or check the input device.' };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return { state: 'error', message: 'The microphone is busy (another app may be using it). Try again in a moment.' };
    case 'NotSupportedError':
    case 'TypeError':
      return { state: 'error', message: 'This browser cannot use the microphone here (it needs HTTPS).' };
    default:
      return { state: 'error', message: `Microphone failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export class MicCapture {
  private stream: MediaStream | null = null;
  private deviceId: string | null = null;
  private wanted = false;
  private generation = 0;
  private pending: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;
  private readonly gum: (c: MediaStreamConstraints) => Promise<MediaStream>;

  constructor(private readonly opts: MicCaptureOptions) {
    this.gum =
      opts.getUserMedia ??
      ((c) => {
        if (!navigator.mediaDevices?.getUserMedia) return Promise.reject(new DOMException('getUserMedia unavailable', 'NotSupportedError'));
        return navigator.mediaDevices.getUserMedia(c);
      });
  }

  get live(): boolean {
    return this.stream !== null;
  }

  get currentStream(): MediaStream | null {
    return this.stream;
  }

  /** Acquire (or keep) the mic on `deviceId`. Resolves once it is live or has failed. */
  start(deviceId: string | null): Promise<void> {
    this.wanted = true;
    if (this.stream && deviceId === this.deviceId) return Promise.resolve();
    if (this.pending && deviceId === this.deviceId) return this.pending;
    this.deviceId = deviceId;
    return this.acquire();
  }

  /** Release the device (stops every track, so Bluetooth can drop back from HFP to A2DP). */
  stop(): void {
    this.wanted = false;
    this.generation++;
    this.pending = null;
    this.clearRetry();
    this.failures = 0;
    this.release();
    this.opts.onState('off', null);
  }

  private acquire(): Promise<void> {
    this.clearRetry();
    const gen = ++this.generation;
    this.opts.onState('requesting', null);
    const run = (async () => {
      let stream: MediaStream;
      try {
        stream = await this.gum(micConstraints(this.deviceId));
      } catch (err) {
        // A remembered device that is gone: fall back to the default input rather than failing.
        if (this.deviceId && (err as { name?: string })?.name === 'OverconstrainedError') {
          try {
            stream = await this.gum(micConstraints(null));
          } catch (err2) {
            return this.failed(gen, err2);
          }
        } else {
          return this.failed(gen, err);
        }
      }
      if (gen !== this.generation || !this.wanted) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.release();
      this.stream = stream;
      this.failures = 0;
      const track = stream.getAudioTracks()[0];
      track?.addEventListener('ended', () => this.onEnded(stream), { once: true });
      this.opts.onStream(stream);
      this.opts.onState('live', null);
    })();
    this.pending = run.finally(() => {
      if (gen === this.generation) this.pending = null;
    });
    return this.pending;
  }

  private failed(gen: number, err: unknown): void {
    if (gen !== this.generation) return;
    const { state, message } = describeMicError(err);
    this.release();
    this.opts.onState(state, message);
    // Permission problems need the user; device problems may clear up (headset reconnecting).
    if (state === 'error' && this.wanted) this.scheduleRetry();
  }

  private onEnded(stream: MediaStream): void {
    if (stream !== this.stream || !this.wanted) return;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    this.clearRetry();
    const base = this.opts.reacquireDelayMs ?? 500;
    const delay = Math.min(base * 2 ** this.failures, this.opts.maxReacquireDelayMs ?? 10_000);
    this.failures++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) void this.acquire();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private release(): void {
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.opts.onStream(null);
  }
}
