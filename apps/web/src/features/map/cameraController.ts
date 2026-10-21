import type { LatLng } from '@intercom/shared';
import type { Map as MlMap } from 'maplibre-gl';
import type { CameraMode } from '../../core/store';
import { boundsOf, groupPadding, needsRefit, type Bounds } from './camera';

export interface CameraFrame {
  /** My drawn position and heading, if known. */
  self: (LatLng & { hdg: number | null }) | null;
  /** Drawn positions of everyone the group view should include. */
  group: LatLng[];
}

export interface CameraDeps {
  map: MlMap;
  /** Writes the camera mode to the store (the store echoes it back through setMode()). */
  requestMode(mode: CameraMode): void;
  headingUp(): boolean;
}

/** Group view: refit at most this often. */
export const GROUP_REFIT_MS = 3_000;
const GROUP_MAX_ZOOM = 16;
/** Zoom used when following starts from a far-out view. */
const FOLLOW_ZOOM = 15;
const FOLLOW_MIN_ZOOM = 11;
const EASE_MS = 700;
const FOCUS_ZOOM = 15;
const FOCUS_MS = 1_200;
const STUCK_POINTER_MS = 20_000;

/**
 * Drives the camera for the three modes. Rules: follow keeps me centered (heading-up optional),
 * group keeps everyone in view without constant motion, free never moves on its own. Any gesture by
 * the user switches to free, and nothing animates while a finger or mouse button is down.
 */
export class CameraController {
  private mode: CameraMode = 'follow';
  private lastFit: { at: number; bounds: Bounds } | null = null;
  /** Our own camera animation runs until then; per-frame updates would cancel it. */
  private animatingUntil = 0;
  private readonly pointers = new Set<number>();
  private pressedAt = 0;
  private pendingFocus: LatLng | null = null;
  private followed: { lat: number; lng: number; bearing: number } | null = null;
  private needsFollowEase = true;
  private readonly canvas: HTMLElement;

  constructor(private readonly deps: CameraDeps) {
    const map = deps.map;
    this.canvas = map.getCanvasContainer();
    for (const ev of ['movestart', 'zoomstart', 'rotatestart', 'pitchstart', 'dragstart'] as const) {
      map.on(ev, this.onCameraStart);
    }
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    window.addEventListener('blur', this.onBlur);
  }

  get current(): CameraMode {
    return this.mode;
  }

  setMode(mode: CameraMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.lastFit = null;
    this.followed = null;
    this.needsFollowEase = mode === 'follow';
    if (mode === 'free') this.animatingUntil = 0;
  }

  /** Fly to a rider (SOS, tap in the riders list) and leave the camera there. */
  focus(target: LatLng): void {
    this.deps.requestMode('free');
    if (this.pointers.size > 0) {
      this.pendingFocus = target;
      return;
    }
    this.flyTo(target);
  }

  /** The viewport changed size: re-fit or re-center on the next frame. */
  onResize(): void {
    this.lastFit = null;
    this.followed = null;
  }

  tick(now: number, frame: CameraFrame): void {
    // A pointerup can get lost (focus change, OS gesture); don't freeze the camera forever.
    if (this.pointers.size > 0 && now - this.pressedAt > STUCK_POINTER_MS) this.pointers.clear();
    if (this.pointers.size > 0 || now < this.animatingUntil) return;
    if (this.mode === 'follow') this.follow(now, frame);
    else if (this.mode === 'group') this.fitGroup(now, frame);
  }

  destroy(): void {
    const map = this.deps.map;
    for (const ev of ['movestart', 'zoomstart', 'rotatestart', 'pitchstart', 'dragstart'] as const) {
      map.off(ev, this.onCameraStart);
    }
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private follow(now: number, { self }: CameraFrame): void {
    if (!self) return;
    const map = this.deps.map;
    const bearing = this.deps.headingUp() ? (self.hdg ?? map.getBearing()) : 0;
    if (this.needsFollowEase) {
      // Entering follow: glide there once (or jump, from a far-out view), then track frame by frame.
      this.needsFollowEase = false;
      this.followed = { lat: self.lat, lng: self.lng, bearing };
      if (map.getZoom() < FOLLOW_MIN_ZOOM) {
        map.jumpTo({ center: [self.lng, self.lat], bearing, zoom: FOLLOW_ZOOM });
        return;
      }
      map.easeTo({ center: [self.lng, self.lat], bearing, duration: EASE_MS });
      this.animatingUntil = now + EASE_MS + 50;
      return;
    }
    const f = this.followed;
    if (f && Math.abs(f.lat - self.lat) < 1e-8 && Math.abs(f.lng - self.lng) < 1e-8 && Math.abs(f.bearing - bearing) < 0.05) {
      return;
    }
    map.jumpTo({ center: [self.lng, self.lat], bearing });
    this.followed = { lat: self.lat, lng: self.lng, bearing };
  }

  private fitGroup(now: number, { self, group }: CameraFrame): void {
    const points = self ? [...group, self] : group;
    const bounds = boundsOf(points);
    if (!bounds) return;
    const last = this.lastFit;
    if (last && (now - last.at < GROUP_REFIT_MS || !needsRefit(last.bounds, bounds))) return;
    const map = this.deps.map;
    const canvas = map.getCanvas();
    const padding = groupPadding(canvas.clientWidth, canvas.clientHeight);
    const camera = map.cameraForBounds(
      [
        [bounds.west, bounds.south],
        [bounds.east, bounds.north],
      ],
      { padding, maxZoom: GROUP_MAX_ZOOM, bearing: 0 },
    );
    this.lastFit = { at: now, bounds };
    if (!camera) return;
    const duration = last ? 900 : EASE_MS;
    map.easeTo({ ...camera, bearing: 0, duration });
    this.animatingUntil = now + duration + 50;
  }

  private flyTo(target: LatLng): void {
    const map = this.deps.map;
    map.flyTo({ center: [target.lng, target.lat], zoom: Math.max(map.getZoom(), FOCUS_ZOOM), duration: FOCUS_MS });
  }

  /** MapLibre only attaches an originalEvent to camera events caused by user input. */
  private readonly onCameraStart = (e: { originalEvent?: unknown }) => {
    if (!e.originalEvent) return;
    this.animatingUntil = 0;
    if (this.mode !== 'free') this.deps.requestMode('free');
  };

  private readonly onPointerDown = (e: PointerEvent) => {
    this.pointers.add(e.pointerId);
    this.pressedAt = performance.now();
  };

  private readonly onPointerUp = (e: PointerEvent) => {
    if (this.pointers.delete(e.pointerId) && this.pointers.size === 0) this.released();
  };

  private readonly onBlur = () => {
    if (this.pointers.size === 0) return;
    this.pointers.clear();
    this.released();
  };

  private released(): void {
    const target = this.pendingFocus;
    this.pendingFocus = null;
    if (target) this.flyTo(target);
  }
}
