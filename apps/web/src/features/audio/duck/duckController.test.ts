// @vitest-environment node
import { TIMING } from '@intercom/shared';
import { describe, expect, it } from 'vitest';
import { DuckController, MUTE_TIME_CONSTANT_S, envelopeAt, timeConstantFor, type DuckClock, type DuckRamp } from './duckController';

/** Manual clock: timers fire only when advance() passes their due time. */
class FakeClock implements DuckClock {
  now = 0;
  private timers = new Map<number, { at: number; cb: () => void }>();
  private nextId = 1;

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].cb();
    }
    this.now = until;
  }
}

function setup(duckLevel = 0.3) {
  const clock = new FakeClock();
  const events: (DuckRamp & { at: number })[] = [];
  const active: boolean[] = [];
  const duck = new DuckController({
    duckLevel,
    clock,
    apply: (r) => events.push({ ...r, at: clock.now / 1000 }),
    onActiveChange: (a) => active.push(a),
  });
  const gainAt = (ms: number) => envelopeAt(events, ms / 1000);
  return { clock, duck, events, active, gainAt };
}

describe('DuckController', () => {
  it('ducks to duckLevel within the attack time', () => {
    const { duck, events, gainAt, clock } = setup(0.3);
    clock.advance(1_000);
    duck.setSpeech(true);
    expect(events).toEqual([{ target: 0.3, timeConstantS: timeConstantFor(TIMING.duckAttackMs), at: 1 }]);
    // 95% of the way down after duckAttackMs.
    expect(gainAt(1_000 + TIMING.duckAttackMs)).toBeLessThan(0.3 + 0.05 * 0.7 + 1e-9);
    expect(gainAt(1_000 + TIMING.duckAttackMs / 3)).toBeGreaterThan(0.5);
    expect(duck.phase).toBe('ducked');
  });

  it('holds after speech ends, then releases back to 1', () => {
    const { duck, events, gainAt, clock, active } = setup(0.3);
    duck.setSpeech(true);
    clock.advance(2_000);
    duck.setSpeech(false);
    expect(duck.phase).toBe('holding');
    expect(active).toEqual([true]);
    clock.advance(TIMING.duckHoldMs - 1);
    expect(events).toHaveLength(1);
    expect(gainAt(2_000 + TIMING.duckHoldMs - 1)).toBeCloseTo(0.3, 3);
    clock.advance(1);
    expect(events.at(-1)).toEqual({ target: 1, timeConstantS: timeConstantFor(TIMING.duckReleaseMs), at: 2 + TIMING.duckHoldMs / 1000 });
    expect(active).toEqual([true, false]);
    expect(duck.phase).toBe('idle');
    const releasedAt = 2_000 + TIMING.duckHoldMs + TIMING.duckReleaseMs;
    expect(gainAt(releasedAt)).toBeGreaterThan(0.95);
    expect(gainAt(releasedAt - TIMING.duckReleaseMs / 2)).toBeLessThan(0.9);
  });

  it('bridges a pause shorter than the hold without releasing', () => {
    const { duck, events, clock, active } = setup();
    duck.setSpeech(true);
    clock.advance(500);
    duck.setSpeech(false);
    clock.advance(TIMING.duckHoldMs - 100);
    duck.setSpeech(true);
    clock.advance(5_000);
    expect(events.filter((e) => e.target === 1)).toHaveLength(0);
    expect(active).toEqual([true]);
  });

  it('dives again when speech returns during the release', () => {
    const { duck, events, clock, gainAt } = setup(0.2);
    duck.setSpeech(true);
    clock.advance(300);
    duck.setSpeech(false);
    clock.advance(TIMING.duckHoldMs + 200);
    const t = clock.now;
    duck.setSpeech(true);
    expect(events.at(-1)!.target).toBe(0.2);
    expect(gainAt(t)).toBeGreaterThan(0.2);
    expect(gainAt(t + TIMING.duckAttackMs)).toBeLessThan(0.25);
  });

  it('mutes immediately for SOS and ignores speech until it ends', () => {
    const { duck, events, clock, gainAt } = setup(0.3);
    duck.setSos(true);
    expect(events.at(-1)).toEqual({ target: 0, timeConstantS: MUTE_TIME_CONSTANT_S, at: 0 });
    expect(gainAt(15)).toBeLessThan(0.05);
    duck.setSpeech(true);
    clock.advance(100);
    duck.setSpeech(false);
    clock.advance(2_000);
    expect(events).toHaveLength(1);
    expect(duck.phase).toBe('muted');
    duck.setSos(false);
    expect(events.at(-1)).toMatchObject({ target: 1 });
  });

  it('restores to the ducked level when SOS ends mid-speech', () => {
    const { duck, events } = setup(0.3);
    duck.setSpeech(true);
    duck.setSos(true);
    duck.setSos(false);
    expect(events.map((e) => e.target)).toEqual([0.3, 0, 0.3]);
  });

  it('follows duckLevel changes while ducked, and only then', () => {
    const { duck, events } = setup(0.3);
    duck.setDuckLevel(0.5);
    expect(events).toHaveLength(0);
    duck.setSpeech(true);
    duck.setDuckLevel(0.1);
    expect(events.map((e) => e.target)).toEqual([0.5, 0.1]);
    duck.setDuckLevel(7);
    expect(events.at(-1)!.target).toBe(1);
  });

  it('ignores repeated inputs and stops its timer on dispose', () => {
    const { duck, events, clock } = setup();
    duck.setSpeech(true);
    duck.setSpeech(true);
    duck.setSos(false);
    expect(events).toHaveLength(1);
    duck.setSpeech(false);
    duck.dispose();
    clock.advance(10_000);
    expect(events).toHaveLength(1);
  });
});

describe('envelopeAt', () => {
  it('follows setTargetAtTime semantics', () => {
    const events = [
      { at: 0, target: 0, timeConstantS: 0.1 },
      { at: 0.1, target: 1, timeConstantS: 0.1 },
    ];
    expect(envelopeAt(events, 0.1)).toBeCloseTo(Math.exp(-1), 6);
    expect(envelopeAt(events, 0.2)).toBeCloseTo(1 - (1 - Math.exp(-1)) * Math.exp(-1), 6);
    expect(envelopeAt([], 5, 0.4)).toBe(0.4);
  });
});
