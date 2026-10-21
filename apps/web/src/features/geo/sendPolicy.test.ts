// @vitest-environment node
import { destinationPoint, TIMING, type LocationFix } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { shouldSend, type SentRecord } from './sendPolicy';

const HOME = { lat: 18.52, lng: 73.85 };
const NOW = 1_700_000_000_000;

function fix(p: Partial<LocationFix> & { meters?: number } = {}): LocationFix {
  const { meters = 0, ...rest } = p;
  return { ...destinationPoint(HOME, 0, meters), acc: 5, spd: 0, hdg: null, t: NOW, ...rest };
}

const sent = (f: LocationFix, agoMs: number): SentRecord => ({ fix: f, at: NOW - agoMs });

describe('shouldSend', () => {
  it('sends the first fix', () => {
    expect(shouldSend(fix(), null, NOW)).toBe(true);
  });

  it(`never sends more often than every ${TIMING.locMinIntervalMs} ms`, () => {
    const last = sent(fix(), TIMING.locMinIntervalMs - 1);
    expect(shouldSend(fix({ meters: 500, spd: 30, hdg: 90 }), last, NOW)).toBe(false);
    expect(shouldSend(fix({ meters: 500 }), sent(fix(), TIMING.locMinIntervalMs), NOW)).toBe(true);
  });

  it(`sends after moving ${TIMING.locMinMoveM} m`, () => {
    const last = sent(fix(), 1000);
    expect(shouldSend(fix({ meters: TIMING.locMinMoveM - 0.5 }), last, NOW)).toBe(false);
    expect(shouldSend(fix({ meters: TIMING.locMinMoveM + 0.5 }), last, NOW)).toBe(true);
  });

  it('sends on a heading change only while moving', () => {
    const moving = sent(fix({ spd: 10, hdg: 350 }), 1000);
    expect(shouldSend(fix({ spd: 10, hdg: 5 }), moving, NOW)).toBe(false); // 15 degrees, wraps through north
    expect(shouldSend(fix({ spd: 10, hdg: 10 }), moving, NOW)).toBe(true); // 20 degrees
    const parked = sent(fix({ spd: 0, hdg: 350 }), 1000);
    expect(shouldSend(fix({ spd: 0, hdg: 90 }), parked, NOW)).toBe(false);
  });

  it('sends when the heading first becomes known while moving', () => {
    expect(shouldSend(fix({ spd: 5, hdg: 120 }), sent(fix({ spd: 5, hdg: null }), 1000), NOW)).toBe(true);
  });

  it('sends when the rider starts or stops moving, so receivers stop dead reckoning promptly', () => {
    expect(shouldSend(fix({ spd: 0, hdg: 90 }), sent(fix({ spd: 8, hdg: 90 }), 1000), NOW)).toBe(true);
    expect(shouldSend(fix({ spd: 3, hdg: 90 }), sent(fix({ spd: 0, hdg: 90 }), 1000), NOW)).toBe(true);
    expect(shouldSend(fix({ spd: null }), sent(fix({ spd: 0 }), 1000), NOW)).toBe(false);
  });

  it(`sends at least every ${TIMING.locHeartbeatMs} ms while fixes keep coming`, () => {
    expect(shouldSend(fix(), sent(fix(), TIMING.locHeartbeatMs - 1), NOW)).toBe(false);
    expect(shouldSend(fix(), sent(fix(), TIMING.locHeartbeatMs), NOW)).toBe(true);
  });
});
