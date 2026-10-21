import { normalizeDeg, type RiderId } from '@intercom/shared';
import { formatAgo, initials } from '../../core/format';
import { TID } from '../../core/testIds';
import { readableTextColor } from './color';
import styles from './marker.module.css';
import type { MotionSample, TrackState } from './motion';

export interface MarkerModel {
  id: RiderId;
  name: string;
  color: string;
  self: boolean;
  leader: boolean;
  speaking: boolean;
  sos: boolean;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const ARROW_PATH = 'M12 1 L22.5 17 L12 12.5 L1.5 17 Z';
const CROWN_PATH = 'M2.5 19 L4.5 7 L9.2 11.2 L12 4 L14.8 11.2 L19.5 7 L21.5 19 Z';
/** A pointer that moved further than this between press and release was panning, not tapping. */
const TAP_SLOP_PX = 10;

function svg(path: string, viewBox: string, attrs: Record<string, string>): SVGSVGElement {
  const root = document.createElementNS(SVG_NS, 'svg');
  root.setAttribute('viewBox', viewBox);
  root.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', path);
  for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v);
  root.append(p);
  return root;
}

function span(className: string | undefined): HTMLSpanElement {
  const el = document.createElement('span');
  if (className) el.className = className;
  return el;
}

/** Stacking: SOS above everything, then me, then whoever is talking, then the rest by freshness. */
export function markerZIndex(model: MarkerModel, state: TrackState): number {
  if (model.sos) return 40;
  if (model.self) return 30;
  if (model.speaking) return 20;
  return state === 'live' ? 10 : state === 'stale' ? 5 : 1;
}

/**
 * DOM for one rider marker: colored disc with initials, heading arrow, name label, leader badge,
 * speaking ring and SOS treatment. Per-frame updates only touch the DOM when something changed.
 */
export class RiderMarkerElement {
  readonly el: HTMLDivElement;
  private readonly disc = span(styles.disc);
  private readonly arrow = span(`${styles.arrow} ${styles.arrowHidden}`);
  private readonly arrowPath: SVGPathElement;
  private readonly nameEl = span(styles.name);
  private readonly agoEl = span(styles.ago);
  private readonly leaderEl = span(styles.leader);
  private model: MarkerModel;
  private state: TrackState = 'live';
  private arrowDeg: number | null = null;
  private ago = '';
  private pressedAt: { x: number; y: number } | null = null;

  constructor(
    model: MarkerModel,
    private readonly onSelect: (id: RiderId) => void,
  ) {
    this.model = model;
    const el = document.createElement('div');
    el.className = styles.marker;
    el.setAttribute('role', 'button');
    el.tabIndex = 0;

    const arrowSvg = svg(ARROW_PATH, '0 0 24 18', { 'stroke-width': '2', 'stroke-linejoin': 'round' });
    this.arrowPath = arrowSvg.firstElementChild as SVGPathElement;
    this.arrow.append(arrowSvg);
    this.leaderEl.append(svg(CROWN_PATH, '0 0 24 24', { fill: 'currentColor' }));
    const label = span(styles.label);
    label.append(this.nameEl, this.agoEl);
    const sosTag = span(styles.sosTag);
    sosTag.textContent = 'SOS';
    // `allow-motion` keeps the SOS pulse running under prefers-reduced-motion (see global.css).
    el.append(span(`${styles.sosHalo} allow-motion`), span(styles.speakRing), this.arrow, this.disc, this.leaderEl, label, sosTag);
    this.el = el;

    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('click', this.onClick);
    el.addEventListener('keydown', this.onKeyDown);
    this.render(true);
  }

  setModel(model: MarkerModel): void {
    const prev = this.model;
    this.model = model;
    const changed = (Object.keys(model) as (keyof MarkerModel)[]).some((k) => model[k] !== prev[k]);
    if (changed) this.render(false, prev);
  }

  /** Per-frame update with the interpolated sample and the map's current bearing. */
  update(sample: MotionSample, mapBearing: number): void {
    if (sample.state !== this.state) {
      this.state = sample.state;
      this.renderState();
    }
    const ago = sample.state === 'lost' ? `last seen ${formatAgo(sample.ageMs)}` : '';
    if (ago !== this.ago) {
      this.ago = ago;
      this.agoEl.textContent = ago;
      this.renderLabel();
    }
    // Markers stay upright on a rotated map, so the arrow carries the rotation itself.
    const deg = sample.hdg === null ? null : normalizeDeg(sample.hdg - mapBearing);
    if (deg === null) {
      if (this.arrowDeg !== null) {
        this.arrow.classList.add(styles.arrowHidden);
        this.arrowDeg = null;
      }
    } else if (this.arrowDeg === null || Math.abs(deg - this.arrowDeg) > 0.3) {
      if (this.arrowDeg === null) this.arrow.classList.remove(styles.arrowHidden);
      this.arrow.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      this.arrowDeg = deg;
    }
  }

  destroy(): void {
    this.el.removeEventListener('pointerdown', this.onPointerDown);
    this.el.removeEventListener('click', this.onClick);
    this.el.removeEventListener('keydown', this.onKeyDown);
  }

  private render(initial: boolean, prev?: MarkerModel): void {
    const m = this.model;
    const el = this.el;
    if (initial || m.id !== prev?.id) el.dataset.testid = TID.mapMarker(m.id);
    if (initial || m.color !== prev?.color) {
      el.style.setProperty('--rider-color', m.color);
      el.style.setProperty('--rider-text', readableTextColor(m.color));
      this.arrowPath.setAttribute('fill', m.color);
    }
    if (initial || m.self !== prev?.self) {
      el.classList.toggle(styles.self, m.self);
      this.arrowPath.setAttribute('stroke', m.self ? '#ffffff' : '#0b0d10');
    }
    if (initial || m.name !== prev?.name || m.self !== prev?.self) {
      this.disc.textContent = initials(m.name);
      this.nameEl.textContent = m.self ? 'You' : m.name;
    }
    this.leaderEl.hidden = !m.leader;
    el.classList.toggle(styles.speaking, m.speaking);
    el.classList.toggle(styles.sos, m.sos);
    el.dataset.speaking = String(m.speaking);
    el.dataset.sos = String(m.sos);
    el.dataset.self = String(m.self);
    this.renderState();
    this.renderLabel();
  }

  private renderState(): void {
    const el = this.el;
    el.dataset.state = this.state;
    el.classList.toggle(styles.stale, this.state === 'stale');
    el.classList.toggle(styles.lost, this.state === 'lost');
    el.style.zIndex = String(markerZIndex(this.model, this.state));
  }

  private renderLabel(): void {
    const m = this.model;
    const parts = [m.self ? `${m.name || 'You'} (you)` : m.name];
    if (m.leader) parts.push('leader');
    if (m.sos) parts.push('SOS');
    if (m.speaking) parts.push('talking');
    if (this.state === 'stale') parts.push('position not updating');
    if (this.ago) parts.push(this.ago);
    this.el.setAttribute('aria-label', parts.join(', '));
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    this.pressedAt = { x: e.clientX, y: e.clientY };
  };

  private readonly onClick = (e: MouseEvent) => {
    const p = this.pressedAt;
    this.pressedAt = null;
    if (p && Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP_PX) return;
    e.stopPropagation();
    this.onSelect(this.model.id);
  };

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    this.onSelect(this.model.id);
  };
}
