// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { Announcer } from './announcer';
import { CHIMES, CLICK, SIREN_HIGH_HZ, SIREN_LOW_HZ, lengthOf, peakGain, scheduleNotes, startSirenVoice } from './tones';

describe('chime definitions', () => {
  it('are short, never clip, and sound like what they mean', () => {
    for (const [kind, notes] of Object.entries(CHIMES)) {
      expect(lengthOf(notes), kind).toBeLessThan(1.2);
      expect(peakGain(notes), kind).toBeLessThan(0.9);
    }
    const freqs = (k: keyof typeof CHIMES) => CHIMES[k].map((n) => n.freq);
    expect(freqs('join')).toEqual([...freqs('join')].sort((a, b) => a - b));
    expect(freqs('leave')).toEqual([...freqs('leave')].sort((a, b) => b - a));
    expect(CHIMES.sent).toHaveLength(3);
    expect(lengthOf(CHIMES.sent)).toBeLessThan(0.3);
    expect(CHIMES.route).toHaveLength(3);
    expect(CHIMES.break).toHaveLength(2);
    expect(Math.max(...freqs('error'))).toBeLessThan(200);
    expect(lengthOf(CLICK)).toBeLessThan(0.03);
  });
});

/** Records what the scheduler asks of an AudioContext. */
function fakeContext() {
  const log: string[] = [];
  const param = (name: string) => ({
    value: 0,
    setValueAtTime: (v: number, t: number) => log.push(`${name}=${v}@${t}`),
    linearRampToValueAtTime: (v: number, t: number) => log.push(`${name}~${v}@${t}`),
    exponentialRampToValueAtTime: (v: number, t: number) => log.push(`${name}^${v}@${t}`),
    setTargetAtTime: (v: number, t: number) => log.push(`${name}->${v}@${t}`),
    cancelScheduledValues: () => {},
  });
  const node = (kind: string) => {
    const n: Record<string, unknown> = {
      kind,
      connect: (to: unknown) => {
        log.push(`${kind}->${(to as { kind?: string }).kind ?? 'param'}`);
        return to;
      },
      disconnect: () => {},
    };
    return n;
  };
  const ctx = {
    currentTime: 10,
    createOscillator: () => {
      const o = node('osc');
      Object.assign(o, {
        type: 'sine',
        frequency: param('freq'),
        detune: param('detune'),
        start: (t: number) => log.push(`start@${t}`),
        stop: (t: number) => log.push(`stop@${t}`),
      });
      return o;
    },
    createGain: () => Object.assign(node('gain'), { gain: param('gain') }),
    createBiquadFilter: () => Object.assign(node('filter'), { type: 'lowpass', frequency: param('cutoff'), Q: param('Q') }),
  };
  return { ctx: ctx as unknown as AudioContext, log };
}

describe('scheduling', () => {
  it('gives each note an envelope that starts and stops on time', () => {
    const { ctx, log } = fakeContext();
    scheduleNotes(ctx, { kind: 'bus' } as unknown as AudioNode, CHIMES.sent);
    expect(log.filter((l) => l.startsWith('start@'))).toEqual(['start@10', 'start@10.08', 'start@10.16']);
    expect(log).toContain('gain=0@10');
    expect(log.filter((l) => l === 'gain->bus')).toHaveLength(3);
  });

  it('builds a two-tone siren that loops on its own and fades out on stop', () => {
    const { ctx, log } = fakeContext();
    const siren = startSirenVoice(ctx, { kind: 'alert' } as unknown as AudioNode);
    expect(log.filter((l) => l.startsWith('start@'))).toHaveLength(3);
    expect(log).toContain('gain->alert');
    // LFO swings the oscillators by half the interval around the centre.
    expect((SIREN_HIGH_HZ + SIREN_LOW_HZ) / 2).toBe(865);
    siren.stop();
    expect(log.some((l) => l.startsWith('gain->0@'))).toBe(true);
    expect(log.filter((l) => l.startsWith('stop@'))).toHaveLength(3);
  });
});

describe('Announcer', () => {
  function fakeSynth() {
    const spoken: { text: string; u: { onend: (() => void) | null } }[] = [];
    const synth = { speak: vi.fn((u: { text: string; onend: (() => void) | null }) => spoken.push({ text: u.text, u })), cancel: vi.fn(), resume: vi.fn() };
    class Utterance {
      rate = 1;
      lang = '';
      volume = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    }
    vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
    return { synth: synth as unknown as SpeechSynthesis, raw: synth, spoken };
  }

  it('queues routine announcements, keeping only the newest two', () => {
    const { synth, spoken } = fakeSynth();
    const a = new Announcer(() => synth);
    a.announce('one');
    a.announce('two');
    a.announce('three');
    a.announce('four');
    expect(spoken.map((s) => s.text)).toEqual(['one']);
    spoken[0]!.u.onend!();
    spoken[1]!.u.onend!();
    expect(spoken.map((s) => s.text)).toEqual(['one', 'three', 'four']);
  });

  it('lets an urgent announcement cut in and drop the queue', () => {
    const { synth, raw, spoken } = fakeSynth();
    const a = new Announcer(() => synth);
    a.announce('Sam joined');
    a.announce('Alex wants fuel');
    a.announce('SOS from Alex, 2 km away');
    expect(raw.cancel).toHaveBeenCalled();
    expect(spoken.map((s) => s.text)).toEqual(['Sam joined', 'SOS from Alex, 2 km away']);
    a.announce('Route updated');
    expect(spoken).toHaveLength(2);
    spoken[1]!.u.onend!();
    expect(spoken.at(-1)!.text).toBe('Route updated');
  });
});
