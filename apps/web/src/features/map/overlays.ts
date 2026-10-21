import type { LatLng } from '@intercom/shared';
import type { GeoJSON } from 'geojson';
import type { GeoJSONSource, Map as MlMap } from 'maplibre-gl';
import { circleFeature, EMPTY_COLLECTION, lineFeature } from './geometry';

export const OVERLAY = {
  routeSource: 'intercom-route',
  routeCasing: 'intercom-route-casing',
  routeLine: 'intercom-route-line',
  accuracySource: 'intercom-accuracy',
  accuracyFill: 'intercom-accuracy-fill',
  accuracyLine: 'intercom-accuracy-line',
} as const;

export interface OverlayColors {
  route: string;
  routeCasing: string;
  accuracy: string;
}

function firstSymbolLayer(map: MlMap): string | undefined {
  return map.getLayersOrder().find((id) => map.getLayer(id)?.type === 'symbol');
}

/**
 * The map's own GeoJSON layers: the shared route (casing + line) and my accuracy circle. They sit
 * below the style's labels so street names stay readable on top of the route. Data is kept here so
 * it can be re-applied when a style change wipes the sources.
 */
export class OverlayLayers {
  private route: [number, number][] | null = null;
  private accuracy: { center: LatLng; radiusM: number } | null = null;
  private installed = false;

  constructor(
    private readonly map: MlMap,
    private colors: OverlayColors,
  ) {}

  /** Adds the sources and layers the current style lacks; call after every style load. */
  install(): void {
    const map = this.map;
    const before = firstSymbolLayer(map);
    const c = this.colors;
    if (!map.getSource(OVERLAY.routeSource)) {
      map.addSource(OVERLAY.routeSource, { type: 'geojson', data: this.routeData() });
    }
    if (!map.getSource(OVERLAY.accuracySource)) {
      map.addSource(OVERLAY.accuracySource, { type: 'geojson', data: this.accuracyData() });
    }
    if (!map.getLayer(OVERLAY.routeCasing)) {
      map.addLayer(
        {
          id: OVERLAY.routeCasing,
          type: 'line',
          source: OVERLAY.routeSource,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': c.routeCasing,
            'line-opacity': 0.9,
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 6, 12, 10, 16, 16, 20, 26],
          },
        },
        before,
      );
    }
    if (!map.getLayer(OVERLAY.routeLine)) {
      map.addLayer(
        {
          id: OVERLAY.routeLine,
          type: 'line',
          source: OVERLAY.routeSource,
          layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: {
            'line-color': c.route,
            'line-width': ['interpolate', ['linear'], ['zoom'], 8, 3.5, 12, 6.5, 16, 10.5, 20, 18],
          },
        },
        before,
      );
    }
    if (!map.getLayer(OVERLAY.accuracyFill)) {
      map.addLayer(
        {
          id: OVERLAY.accuracyFill,
          type: 'fill',
          source: OVERLAY.accuracySource,
          paint: { 'fill-color': c.accuracy, 'fill-opacity': 0.16 },
        },
        before,
      );
    }
    if (!map.getLayer(OVERLAY.accuracyLine)) {
      map.addLayer(
        {
          id: OVERLAY.accuracyLine,
          type: 'line',
          source: OVERLAY.accuracySource,
          paint: { 'line-color': c.accuracy, 'line-opacity': 0.6, 'line-width': 1.5 },
        },
        before,
      );
    }
    this.installed = true;
  }

  /** The style was replaced; layers are gone until the next install(). */
  uninstall(): void {
    this.installed = false;
  }

  setColors(colors: OverlayColors): void {
    this.colors = colors;
    if (!this.installed) return;
    const map = this.map;
    map.setPaintProperty(OVERLAY.routeCasing, 'line-color', colors.routeCasing);
    map.setPaintProperty(OVERLAY.routeLine, 'line-color', colors.route);
    map.setPaintProperty(OVERLAY.accuracyFill, 'fill-color', colors.accuracy);
    map.setPaintProperty(OVERLAY.accuracyLine, 'line-color', colors.accuracy);
  }

  setRoute(coords: [number, number][] | null): void {
    this.route = coords && coords.length >= 2 ? coords : null;
    this.source(OVERLAY.routeSource)?.setData(this.routeData());
  }

  setAccuracy(center: LatLng | null, radiusM = 0): void {
    this.accuracy = center && radiusM > 0 ? { center, radiusM } : null;
    this.source(OVERLAY.accuracySource)?.setData(this.accuracyData());
  }

  get routeVisible(): boolean {
    return this.installed && this.route !== null && Boolean(this.map.getLayer(OVERLAY.routeLine));
  }

  private source(id: string): GeoJSONSource | undefined {
    return this.installed ? (this.map.getSource(id) as GeoJSONSource | undefined) : undefined;
  }

  private routeData(): GeoJSON {
    return this.route ? lineFeature(this.route) : EMPTY_COLLECTION;
  }

  private accuracyData(): GeoJSON {
    return this.accuracy ? circleFeature(this.accuracy.center, this.accuracy.radiusM) : EMPTY_COLLECTION;
  }
}
