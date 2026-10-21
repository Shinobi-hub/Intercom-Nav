import { TIMING } from '@intercom/shared';
import { describe, expect, it, vi } from 'vitest';
import { markerZIndex, RiderMarkerElement, type MarkerModel } from './markerElement';
import type { MotionSample } from './motion';

const model = (p: Partial<MarkerModel> = {}): MarkerModel => ({
  id: 'r1',
  name: 'Sam Lee',
  color: '#A3E635',
  self: false,
  leader: false,
  speaking: false,
  sos: false,
  ...p,
});
const sample = (p: Partial<MotionSample> = {}): MotionSample => ({
  lat: 0,
  lng: 0,
  hdg: 90,
  state: 'live',
  extrapolating: false,
  ageMs: 0,
  ...p,
});

describe('RiderMarkerElement', () => {
  it('renders initials, test id and state attributes', () => {
    const m = new RiderMarkerElement(model(), vi.fn());
    const el = m.el;
    expect(el.dataset.testid).toBe('rider-marker-r1');
    expect(el.dataset).toMatchObject({ state: 'live', speaking: 'false', sos: 'false', self: 'false' });
    expect(el.textContent).toContain('SL');
    expect(el.textContent).toContain('Sam Lee');
    // Lime needs dark initials.
    expect(el.style.getPropertyValue('--rider-text')).toBe('#0b0d10');
  });

  it('reflects speaking, SOS and leader changes', () => {
    const m = new RiderMarkerElement(model(), vi.fn());
    m.setModel(model({ speaking: true, sos: true, leader: true }));
    expect(m.el.dataset).toMatchObject({ speaking: 'true', sos: 'true' });
    expect(m.el.getAttribute('aria-label')).toBe('Sam Lee, leader, SOS, talking');
    expect(Number(m.el.style.zIndex)).toBe(markerZIndex(model({ sos: true }), 'live'));
  });

  it('labels my own marker "You"', () => {
    const m = new RiderMarkerElement(model({ self: true, id: 'me' }), vi.fn());
    expect(m.el.dataset.testid).toBe('rider-marker-me');
    expect(m.el.textContent).toContain('You');
  });

  it('turns the heading arrow against the map bearing and hides it without a heading', () => {
    const m = new RiderMarkerElement(model(), vi.fn());
    const arrow = m.el.querySelector('svg')!.parentElement!;
    m.update(sample({ hdg: 90 }), 30);
    expect(arrow.style.transform).toBe('rotate(60.0deg)');
    m.update(sample({ hdg: 10 }), 350);
    expect(arrow.style.transform).toBe('rotate(20.0deg)');
    m.update(sample({ hdg: null }), 0);
    expect(arrow.className).toMatch(/arrowHidden/);
  });

  it('shows stale and lost states with "last seen"', () => {
    const m = new RiderMarkerElement(model(), vi.fn());
    m.update(sample({ state: 'stale', ageMs: TIMING.riderStaleMs }), 0);
    expect(m.el.dataset.state).toBe('stale');
    m.update(sample({ state: 'lost', ageMs: 3 * 60_000 }), 0);
    expect(m.el.dataset.state).toBe('lost');
    expect(m.el.textContent).toContain('last seen 3 min ago');
  });

  it('selects on tap and keyboard, but not at the end of a pan', () => {
    const onSelect = vi.fn();
    const m = new RiderMarkerElement(model(), onSelect);
    m.el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    m.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(onSelect).toHaveBeenCalledWith('r1');
    const down = new MouseEvent('pointerdown', { clientX: 0, clientY: 0 });
    m.el.dispatchEvent(down);
    m.el.dispatchEvent(new MouseEvent('click', { clientX: 60, clientY: 0 }));
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});
