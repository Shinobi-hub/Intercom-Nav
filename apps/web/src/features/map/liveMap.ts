import { haversineM, type LatLng, type RiderId } from '@intercom/shared';
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { MAP_STYLE_DAY, MAP_STYLE_NIGHT } from '../../core/config';
import { registerDebug, type MapMarkerDebug } from '../../core/debug';
import { useLocalStore, useRideStore, useSettings } from '../../core/store';
import { CameraController } from './cameraController';
import { compensateForNightFilter, NIGHT_CANVAS_FILTER } from './color';
import { FrameLoop } from './frameLoop';
import styles from './map.module.css';
import { provideMapCenter } from './mapCenter';
import { RiderMarkerElement, type MarkerModel } from './markerElement';
import { MotionTrack, type MotionSample } from './motion';
import { OverlayLayers, type OverlayColors } from './overlays';
import { RouteMarkers } from './routeMarkers';
import { StyleManager, type StyleStatus } from './styleManager';
import { planTheme, wantsNight } from './theme';

export interface LiveMapOptions {
  container: HTMLElement;
  onRiderSelect(id: RiderId): void;
  /** The map can't recover by itself (WebGL context lost for good); the owner should recreate it. */
  onFatal(reason: string): void;
}

/** Fixes that were already this old when they reached us (join snapshots) are drawn as aged. */
const AGED_FIX_MS = 5_000;
const ACCURACY_UPDATE_MS = 100;
const THEME_CHECK_MS = 60_000;
const CONTEXT_RESTORE_GRACE_MS = 6_000;
/** A focus request this old when the map mounts is no longer acted on. */
const FOCUS_FRESH_MS = 30_000;
/** Internal key for my own marker; rider ids are UUIDs, so it can't collide. */
const SELF_KEY = '#self';

const ROUTE_CASING = '#0b2a55';
const FALLBACK_ROUTE = '#3d9bff';

interface Entry {
  key: string;
  track: MotionTrack;
  view: RiderMarkerElement;
  marker: maplibregl.Marker;
  drawn: [number, number] | null;
  /** Added to the map on its first frame with a position, so it never flashes at 0,0. */
  added: boolean;
}

function routeColor(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--route').trim() || FALLBACK_ROUTE;
  } catch {
    return FALLBACK_ROUTE;
  }
}

function initialView(): { center: [number, number]; zoom: number } {
  const self = useLocalStore.getState().selfFix;
  if (self) return { center: [self.lng, self.lat], zoom: 15 };
  const { riders, route } = useRideStore.getState();
  const located = Object.values(riders).flatMap((r) => (r.location ? [r.location] : []));
  if (located.length > 0) {
    const lat = located.reduce((s, p) => s + p.lat, 0) / located.length;
    const lng = located.reduce((s, p) => s + p.lng, 0) / located.length;
    return { center: [lng, lat], zoom: 13 };
  }
  if (route) return { center: [route.destination.lng, route.destination.lat], zoom: 11 };
  return { center: [0, 20], zoom: 1.5 };
}

let active: LiveMap | null = null;
let debugRegistered = false;

function registerMapDebug(): void {
  if (debugRegistered) return;
  debugRegistered = true;
  registerDebug('map', {
    ready: () => active?.ready ?? false,
    markers: () => active?.debugMarkers() ?? {},
    cameraMode: () => useLocalStore.getState().ui.cameraMode,
    routeVisible: () => active?.routeVisible ?? false,
  });
}

/**
 * The imperative core behind <MapView>: owns the MapLibre map, one MotionTrack + DOM marker per
 * rider, the route and accuracy layers, the camera, the theme, and a single ~30 fps frame loop.
 * It reads the stores directly so React never re-renders at frame rate.
 */
export class LiveMap {
  readonly map: MlMap;
  private readonly container: HTMLElement;
  private readonly styleManager: StyleManager;
  private readonly overlays: OverlayLayers;
  private readonly routeMarkers: RouteMarkers;
  private readonly camera: CameraController;
  private readonly loop: FrameLoop;
  private readonly entries = new Map<string, Entry>();
  private readonly cleanups: (() => void)[] = [];
  private readonly routeColor = routeColor();
  private accuracyShown: { lat: number; lng: number; r: number; at: number } | null = null;
  private overlaysReady = false;
  private contextLost = false;
  private contextTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly opts: LiveMapOptions) {
    const container = opts.container;
    this.container = container;
    container.style.setProperty('--night-filter', NIGHT_CANVAS_FILTER);
    const plan = planTheme(wantsNight(useSettings.getState().mapTheme), MAP_STYLE_DAY, MAP_STYLE_NIGHT, false);
    const view = initialView();

    this.map = new maplibregl.Map({
      container,
      style: plan.styleUrl,
      center: view.center,
      zoom: view.zoom,
      attributionControl: { compact: true },
      // A flat map reads best at a glance; pitch gestures only get in the way with gloves.
      maxPitch: 0,
      pitchWithRotate: false,
      touchPitch: false,
    });
    const map = this.map;

    this.overlays = new OverlayLayers(map, this.overlayColors(plan.canvasFilter));
    this.routeMarkers = new RouteMarkers(map, this.routeColor);
    this.styleManager = new StyleManager(map, plan.styleUrl, {
      onLoad: () => this.installOverlays(),
      onUnload: () => {
        this.overlaysReady = false;
        this.overlays.uninstall();
      },
      onStatus: (status) => this.onStyleStatus(status),
    });
    this.camera = new CameraController({
      map,
      requestMode: (mode) => useLocalStore.getState().setCameraMode(mode),
      headingUp: () => useSettings.getState().headingUp,
    });
    this.loop = new FrameLoop(() => this.tick());

    map.on('resize', this.onResize);
    map.on('webglcontextlost', this.onContextLost);
    map.on('webglcontextrestored', this.onContextRestored);

    container.dataset.style = 'loading';
    container.dataset.ready = 'false';
    this.applyTheme();
    this.subscribe();
    this.syncRiders();
    this.syncSelf();
    this.syncRoute();
    const ui = useLocalStore.getState().ui;
    this.camera.setMode(ui.cameraMode);
    container.dataset.camera = ui.cameraMode;
    if (ui.focus && Date.now() - ui.focus.at < FOCUS_FRESH_MS) this.focusRider(ui.focus.riderId);

    this.cleanups.push(
      provideMapCenter(() => {
        const c = this.map.getCenter();
        return { lat: c.lat, lng: c.lng };
      }),
    );
    const themeTimer = setInterval(() => this.applyTheme(), THEME_CHECK_MS);
    this.cleanups.push(() => clearInterval(themeTimer));

    active = this;
    registerMapDebug();
    this.loop.start();
  }

  get ready(): boolean {
    return this.overlaysReady && !this.contextLost;
  }

  get routeVisible(): boolean {
    return this.ready && this.overlays.routeVisible;
  }

  /** Interpolated positions as drawn right now, keyed by rider id (mine under selfId, or 'self'). */
  debugMarkers(): Record<RiderId, MapMarkerDebug> {
    const now = performance.now();
    const selfId = useRideStore.getState().selfId ?? 'self';
    const out: Record<RiderId, MapMarkerDebug> = {};
    for (const e of this.entries.values()) {
      const s = e.track.sample(now);
      if (!s) continue;
      out[e.key === SELF_KEY ? selfId : e.key] = {
        lat: s.lat,
        lng: s.lng,
        hdg: s.hdg,
        state: s.state,
        extrapolating: s.extrapolating,
      };
    }
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (active === this) active = null;
    this.loop.stop();
    for (const c of this.cleanups.splice(0)) c();
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.map.off('resize', this.onResize);
    this.map.off('webglcontextlost', this.onContextLost);
    this.map.off('webglcontextrestored', this.onContextRestored);
    this.camera.destroy();
    this.styleManager.dispose();
    this.routeMarkers.destroy();
    for (const key of [...this.entries.keys()]) this.removeEntry(key);
    this.map.remove();
  }

  // ---- store -> map --------------------------------------------------------------------------

  private subscribe(): void {
    this.cleanups.push(
      useRideStore.subscribe((s, p) => {
        if (s.riders !== p.riders || s.selfId !== p.selfId) this.syncRiders();
        else if (s.sos !== p.sos || s.ride !== p.ride) this.syncModels();
        if (s.route !== p.route) this.syncRoute();
      }),
      useLocalStore.subscribe((s, p) => {
        if (s.selfFix !== p.selfFix) this.syncSelf();
        if (s.speaking !== p.speaking) this.syncModels();
        if (s.ui.cameraMode !== p.ui.cameraMode) {
          this.camera.setMode(s.ui.cameraMode);
          this.container.dataset.camera = s.ui.cameraMode;
        }
        if (s.ui.focus && s.ui.focus !== p.ui.focus) this.focusRider(s.ui.focus.riderId);
      }),
      useSettings.subscribe((s, p) => {
        if (s.mapTheme !== p.mapTheme) this.applyTheme();
        if (s.headingUp !== p.headingUp) this.camera.onResize();
        if (s.name !== p.name || s.color !== p.color) this.syncModels();
      }),
    );
  }

  private syncRiders(): void {
    const ride = useRideStore.getState();
    const now = performance.now();
    const serverNow = Date.now() + ride.clockOffsetMs;
    const present = new Set<string>();
    for (const r of Object.values(ride.riders)) {
      // My own entry mirrors what I sent; my marker comes from selfFix instead.
      if (r.id === ride.selfId || !r.location) continue;
      present.add(r.id);
      const entry = this.entries.get(r.id) ?? this.addEntry(r.id);
      // Staleness counts from local receipt, except for fixes that were already old on arrival.
      const ageMs = r.locationAt === null ? 0 : serverNow - r.locationAt;
      entry.track.push(r.location, now, ageMs > AGED_FIX_MS ? ageMs : 0);
    }
    for (const key of [...this.entries.keys()]) {
      if (key !== SELF_KEY && !present.has(key)) this.removeEntry(key);
    }
    this.syncModels();
  }

  private syncSelf(): void {
    const fix = useLocalStore.getState().selfFix;
    if (!fix) {
      this.removeEntry(SELF_KEY);
      return;
    }
    const entry = this.entries.get(SELF_KEY) ?? this.addEntry(SELF_KEY);
    entry.track.push(fix, performance.now());
  }

  private syncModels(): void {
    for (const [key, e] of this.entries) e.view.setModel(this.modelFor(key));
  }

  private syncRoute(): void {
    const route = useRideStore.getState().route;
    this.overlays.setRoute(route?.geometry ?? null);
    this.routeMarkers.set(route);
  }

  private modelFor(key: string): MarkerModel {
    const ride = useRideStore.getState();
    const speaking = useLocalStore.getState().speaking;
    const hasSos = (id: string) => Object.values(ride.sos).some((s) => s.riderId === id);
    if (key === SELF_KEY) {
      const id = ride.selfId;
      const me = id ? ride.riders[id] : undefined;
      const settings = useSettings.getState();
      return {
        id: id ?? 'self',
        name: me?.name ?? (settings.name.trim() || 'You'),
        color: me?.color ?? settings.color,
        self: true,
        leader: id !== null && ride.ride?.leaderId === id,
        speaking: id !== null && Boolean(speaking[id]),
        sos: id !== null && hasSos(id),
      };
    }
    const r = ride.riders[key];
    return {
      id: key,
      name: r?.name ?? 'Rider',
      color: r?.color ?? '#6b7480',
      self: false,
      leader: ride.ride ? ride.ride.leaderId === key : r?.role === 'leader',
      speaking: Boolean(speaking[key]),
      sos: hasSos(key),
    };
  }

  private addEntry(key: string): Entry {
    const view = new RiderMarkerElement(this.modelFor(key), (id) => this.opts.onRiderSelect(id));
    const marker = new maplibregl.Marker({
      element: view.el,
      anchor: 'center',
      rotationAlignment: 'viewport',
      pitchAlignment: 'viewport',
      subpixelPositioning: true,
    });
    const entry: Entry = { key, track: new MotionTrack(), view, marker, drawn: null, added: false };
    this.entries.set(key, entry);
    return entry;
  }

  private removeEntry(key: string): void {
    const e = this.entries.get(key);
    if (!e) return;
    e.view.destroy();
    e.marker.remove();
    this.entries.delete(key);
    if (key === SELF_KEY) this.showAccuracy(null, 0);
  }

  private focusRider(riderId: RiderId): void {
    const ride = useRideStore.getState();
    const key = riderId === ride.selfId ? SELF_KEY : riderId;
    const target: LatLng | null =
      this.entries.get(key)?.track.sample(performance.now()) ??
      ride.riders[riderId]?.location ??
      Object.values(ride.sos).find((s) => s.riderId === riderId)?.location ??
      null;
    if (target) this.camera.focus({ lat: target.lat, lng: target.lng });
  }

  // ---- frame ----------------------------------------------------------------------------------

  private tick(): void {
    const now = performance.now();
    const bearing = this.map.getBearing();
    let self: MotionSample | null = null;
    const group: LatLng[] = [];
    for (const e of this.entries.values()) {
      const s = e.track.sample(now);
      if (!s) continue;
      e.view.update(s, bearing);
      if (!e.drawn || e.drawn[0] !== s.lng || e.drawn[1] !== s.lat) {
        e.drawn = [s.lng, s.lat];
        e.marker.setLngLat(e.drawn);
        if (!e.added) {
          e.marker.addTo(this.map);
          e.added = true;
        }
      }
      if (e.key === SELF_KEY) self = s;
      else if (s.state === 'live') group.push(s);
    }
    if (this.contextLost) return;
    this.updateAccuracy(self, now);
    this.camera.tick(now, { self, group });
  }

  private updateAccuracy(self: MotionSample | null, now: number): void {
    const fix = useLocalStore.getState().selfFix;
    if (!self || !fix) {
      if (this.accuracyShown) this.showAccuracy(null, 0);
      return;
    }
    const last = this.accuracyShown;
    if (last) {
      if (now - last.at < ACCURACY_UPDATE_MS) return;
      if (last.r === fix.acc && haversineM(last, self) < Math.max(0.3, fix.acc * 0.01)) return;
    }
    this.showAccuracy(self, fix.acc, now);
  }

  private showAccuracy(center: LatLng | null, radiusM: number, now = performance.now()): void {
    if (this.overlaysReady) this.overlays.setAccuracy(center, radiusM);
    else this.overlays.setAccuracy(null);
    this.accuracyShown = center ? { lat: center.lat, lng: center.lng, r: radiusM, at: now } : null;
  }

  // ---- style, theme, lifecycle --------------------------------------------------------------

  private installOverlays(): void {
    try {
      this.overlays.install();
      this.overlaysReady = true;
      this.accuracyShown = null; // redraw on the next frame
    } catch (e) {
      console.error('[map] could not add route/accuracy layers', e);
    }
    this.container.dataset.ready = String(this.ready);
  }

  private onStyleStatus(status: StyleStatus): void {
    this.container.dataset.style = status;
    this.container.dataset.ready = String(this.ready);
    // The fallback is a day style: at night it needs the canvas filter even if a night style is set.
    if (status !== 'loading') this.applyTheme();
  }

  private applyTheme(): void {
    const night = wantsNight(useSettings.getState().mapTheme);
    const plan = planTheme(night, MAP_STYLE_DAY, MAP_STYLE_NIGHT, this.styleManager.current === 'fallback');
    this.styleManager.setUrl(plan.styleUrl);
    this.container.classList.toggle(styles.nightFilter, plan.canvasFilter);
    this.container.dataset.theme = night ? 'night' : 'day';
    if (this.overlaysReady) this.overlays.setColors(this.overlayColors(plan.canvasFilter));
  }

  private overlayColors(filtered: boolean): OverlayColors {
    const colors = { route: this.routeColor, routeCasing: ROUTE_CASING, accuracy: this.routeColor };
    if (!filtered) return colors;
    return {
      route: compensateForNightFilter(colors.route),
      routeCasing: compensateForNightFilter(colors.routeCasing),
      accuracy: compensateForNightFilter(colors.accuracy),
    };
  }

  private readonly onResize = () => {
    this.camera.onResize();
  };

  private readonly onContextLost = () => {
    // MapLibre drops the style until the context comes back; our layers go with it.
    this.contextLost = true;
    this.overlaysReady = false;
    this.overlays.uninstall();
    this.container.dataset.ready = 'false';
    this.container.dataset.gl = 'lost';
    this.armContextWatchdog();
  };

  private readonly onContextRestored = () => {
    this.contextLost = false;
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = null;
    this.container.dataset.gl = 'ok';
    // MapLibre reloads the saved style, which fires 'style.load' and reinstalls the overlays.
  };

  private armContextWatchdog(): void {
    if (this.contextTimer) clearTimeout(this.contextTimer);
    this.contextTimer = setTimeout(() => {
      this.contextTimer = null;
      if (!this.contextLost || this.disposed) return;
      // Hidden tabs may legitimately wait for the GPU; judge once we're visible again.
      if (document.hidden) this.armContextWatchdog();
      else this.opts.onFatal('webgl context lost');
    }, CONTEXT_RESTORE_GRACE_MS);
  }
}
