import type { RideRoute } from '@intercom/shared';
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import styles from './routeMarkers.module.css';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PIN_PATH = 'M20 50.5C20 50.5 3 31.5 3 19.5a17 17 0 0 1 34 0c0 12-17 31-17 31z';
const FLAG_POLE = 'M14.5 10.5v18';
const FLAG_CLOTH = 'M14.5 10.5h12.5l-3.2 4.6 3.2 4.6h-12.5z';

function pinSvg(color: string): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', '0 0 40 52');
  root.setAttribute('aria-hidden', 'true');
  const shape = (d: string, attrs: Record<string, string>) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
    root.append(p);
  };
  shape(PIN_PATH, { fill: color, stroke: '#ffffff', 'stroke-width': '3' });
  shape(FLAG_POLE, { stroke: '#ffffff', 'stroke-width': '2.6', 'stroke-linecap': 'round', fill: 'none' });
  shape(FLAG_CLOTH, { fill: '#ffffff' });
  return root;
}

/** Destination flag and numbered waypoint markers for the shared route. */
export class RouteMarkers {
  private markers: maplibregl.Marker[] = [];
  private routeId: string | null = null;

  constructor(
    private readonly map: MlMap,
    private readonly color: string,
  ) {}

  set(route: RideRoute | null): void {
    if ((route?.id ?? null) === this.routeId) return;
    this.clear();
    this.routeId = route?.id ?? null;
    if (!route) return;

    route.waypoints.forEach((wp, i) => {
      const el = document.createElement('div');
      el.className = styles.waypoint;
      el.textContent = String(i + 1);
      el.setAttribute('aria-label', `Waypoint ${i + 1}: ${wp.name}`);
      this.markers.push(new maplibregl.Marker({ element: el }).setLngLat([wp.lng, wp.lat]).addTo(this.map));
    });

    const el = document.createElement('div');
    el.className = styles.destination;
    el.dataset.routeMarker = 'destination';
    el.setAttribute('aria-label', `Destination: ${route.destination.name}`);
    const label = document.createElement('span');
    label.className = styles.destinationLabel;
    label.textContent = route.destination.name;
    el.append(pinSvg(this.color), label);
    this.markers.push(
      new maplibregl.Marker({ element: el, anchor: 'bottom' })
        .setLngLat([route.destination.lng, route.destination.lat])
        .addTo(this.map),
    );
  }

  destroy(): void {
    this.clear();
  }

  private clear(): void {
    for (const m of this.markers) m.remove();
    this.markers = [];
    this.routeId = null;
  }
}
