import type { Map as MlMap, StyleSpecification } from 'maplibre-gl';

/** A remote style that hasn't loaded after this long is given up on (offline, captive portal). */
export const STYLE_TIMEOUT_MS = 8_000;
/** While on the fallback, check this often whether the real style is reachable again. */
const RECOVERY_INTERVAL_MS = 60_000;
const RECOVERY_PROBE_TIMEOUT_MS = 5_000;

/** Background only: no tiles, sprites or glyphs to fetch, so it always loads. */
export const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  name: 'Offline',
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#e9e5de' } }],
};

export type StyleStatus = 'loading' | 'remote' | 'fallback';

export interface StyleEvents {
  /** A style finished loading; custom sources and layers must be (re)added. */
  onLoad(kind: 'remote' | 'fallback'): void;
  /** The current style is being replaced; custom layers are about to disappear. */
  onUnload(): void;
  onStatus(status: StyleStatus): void;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'load error';
}

/**
 * Loads the map style with a deadline. If the remote style fails or times out, the map switches to
 * an inline background-only style so markers and the route keep working, and switches back once the
 * remote style is reachable again.
 */
export class StyleManager {
  private status: StyleStatus = 'loading';
  private pending: 'remote' | 'fallback' = 'remote';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private recovery: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private disposed = false;

  constructor(
    private readonly map: MlMap,
    private url: string,
    private readonly events: StyleEvents,
  ) {
    // The map was constructed with `url`, so it is already loading.
    map.on('style.load', this.onStyleLoad);
    map.on('error', this.onError);
    window.addEventListener('online', this.tryRecover);
    this.armTimeout();
  }

  get current(): StyleStatus {
    return this.status;
  }

  /** Switch to another remote style (day/night). */
  setUrl(url: string): void {
    if (url === this.url) return;
    this.url = url;
    this.loadRemote();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    this.stopRecovery();
    this.map.off('style.load', this.onStyleLoad);
    this.map.off('error', this.onError);
    window.removeEventListener('online', this.tryRecover);
  }

  private loadRemote(): void {
    this.pending = 'remote';
    this.setStatus('loading');
    this.events.onUnload();
    this.map.setStyle(this.url, { diff: false });
    this.armTimeout();
  }

  private fallBack(reason: string): void {
    if (this.disposed || this.pending === 'fallback') return;
    console.warn(`[map] style unavailable (${reason}); using the offline style`);
    this.clearTimer();
    this.pending = 'fallback';
    this.setStatus('loading');
    this.events.onUnload();
    this.map.setStyle(FALLBACK_STYLE, { diff: false });
    this.startRecovery();
  }

  private readonly onStyleLoad = () => {
    if (this.disposed) return;
    this.clearTimer();
    const kind = this.pending;
    if (kind === 'remote') this.stopRecovery();
    this.setStatus(kind);
    this.events.onLoad(kind);
  };

  private readonly onError = (e: { error?: unknown }) => {
    // Sources and tiles only load after 'style.load', so an error before it is the style failing.
    if (this.status === 'loading' && this.pending === 'remote') this.fallBack(describe(e.error));
  };

  private readonly tryRecover = async () => {
    if (this.disposed || this.status !== 'fallback' || this.probing) return;
    this.probing = true;
    try {
      const res = await fetch(this.url, { cache: 'no-store', signal: AbortSignal.timeout(RECOVERY_PROBE_TIMEOUT_MS) });
      if (res.ok && !this.disposed && this.status === 'fallback') this.loadRemote();
    } catch {
      /* still unreachable */
    } finally {
      this.probing = false;
    }
  };

  private setStatus(status: StyleStatus): void {
    if (status === this.status) return;
    this.status = status;
    this.events.onStatus(status);
  }

  private armTimeout(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.status === 'loading' && this.pending === 'remote') this.fallBack('timeout');
    }, STYLE_TIMEOUT_MS);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private startRecovery(): void {
    if (!this.recovery) this.recovery = setInterval(() => void this.tryRecover(), RECOVERY_INTERVAL_MS);
  }

  private stopRecovery(): void {
    if (this.recovery) clearInterval(this.recovery);
    this.recovery = null;
  }
}
