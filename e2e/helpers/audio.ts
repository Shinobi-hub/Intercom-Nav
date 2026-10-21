/** Music player flow and analysis of sampled audio timelines (duck gain vs VAD). */
import { expect } from '@playwright/test';
import { MUSIC_FILE } from './audioFixtures';
import { TID } from './contract';
import type { AudioSample } from './pageScript';
import type { Rider, Sampler } from './rider';
import { attributeBecomes, closeSheet, openSheet, rangeBounds, setRange } from './ui';
import { waitFor } from './wait';

/**
 * Adds fixtures/audio/music.wav through the Music sheet's file input and makes sure it plays. The
 * panel starts the first track added on a fresh device by itself; Play is only pressed if it didn't.
 */
export async function addAndPlayMusic(rider: Rider): Promise<void> {
  const sheet = await openSheet(rider, 'music');
  await rider.tid(TID.musicFileInput).setInputFiles(MUSIC_FILE);
  await expect(sheet.locator('[data-testid^="music-track-"]').first(), `[${rider.name}] music.wav should show up in the playlist`).toBeVisible();
  const play = rider.tid(TID.musicPlayPause);
  if (!(await attributeBecomes(play, 'data-playing', 'true', 5_000))) await play.click();
  await expect(rider.tid(TID.dockMusic), `[${rider.name}] dock Music button should show playing`).toHaveAttribute('data-playing', 'true');
  await expect
    .poll(async () => (await rider.audio.musicState()).playing, { message: `[${rider.name}] __intercom.audio.musicState().playing` })
    .toBe(true);
  await closeSheet(rider, 'music');
}

/** Sets duckLevel (0..1) with the Settings slider, whether the slider runs 0..1 or 0..100. */
export async function setDuckLevel(rider: Rider, level: number): Promise<void> {
  await openSheet(rider, 'settings');
  const slider = rider.tid(TID.settingsDuckLevel);
  const { max } = await rangeBounds(slider);
  await setRange(slider, max <= 1 ? level : Math.round(level * 100));
  await expect
    .poll(async () => (await rider.state()).settings.duckLevel, { message: `[${rider.name}] settings.duckLevel after moving the slider` })
    .toBeCloseTo(level, 2);
  await closeSheet(rider, 'settings');
}

export interface Episode {
  /** Page time of the first sample with the flag set (rising edge). */
  onAt: number;
  /** Page time of the last sample with the flag set before it cleared for good (falling edge). */
  offAt: number;
}

/**
 * Speech episodes (rising -> falling edges) in a sampled flag. Episodes already in progress when
 * sampling started are skipped, so onAt is a real onset. Short dropouts (< bridgeMs) are bridged:
 * the VAD may blink between words, we care about the utterance.
 */
export function episodes(samples: readonly AudioSample[], flag: (s: AudioSample) => boolean, bridgeMs = 400): Episode[] {
  const out: Episode[] = [];
  let on: number | null = null;
  let lastOn = 0;
  let sawOff = false;
  for (const s of samples) {
    if (flag(s)) {
      if (on === null && sawOff) on = s.t;
      lastOn = s.t;
    } else {
      sawOff = true;
      if (on !== null && s.t - lastOn >= bridgeMs) {
        out.push({ onAt: on, offAt: lastOn });
        on = null;
      }
    }
  }
  return out;
}

/** Waits until the sampler holds a complete episode with `tailMs` of samples after it ends. */
export async function waitForEpisode(
  sampler: Sampler<AudioSample>,
  flag: (s: AudioSample) => boolean,
  opts: { timeout: number; tailMs: number; after?: number; message: string },
): Promise<{ episode: Episode; samples: readonly AudioSample[] }> {
  return waitFor(
    async () => {
      const samples = await sampler.pull();
      const last = samples[samples.length - 1];
      const ep = episodes(samples, flag).find((e) => e.onAt >= (opts.after ?? 0));
      return ep && last && last.t - ep.offAt >= opts.tailMs ? { episode: ep, samples } : null;
    },
    { timeout: opts.timeout, interval: 500, message: opts.message },
  );
}

export function firstAtOrAfter(samples: readonly AudioSample[], from: number, pred: (s: AudioSample) => boolean): AudioSample | undefined {
  return samples.find((s) => s.t >= from && pred(s));
}

export function minDuck(samples: readonly AudioSample[], from: number, to: number): number {
  let min = Infinity;
  for (const s of samples) if (s.t >= from && s.t <= to) min = Math.min(min, s.duck);
  return min;
}

/** Compact timeline for failure messages / attachments. */
export function describeTimeline(samples: readonly AudioSample[], from: number, to: number, everyMs = 100): string {
  const lines: string[] = [];
  let next = from;
  for (const s of samples) {
    if (s.t < from || s.t > to || s.t < next) continue;
    next = s.t + everyMs;
    lines.push(`${String(s.t - from).padStart(6)} ms  duck=${s.duck.toFixed(3)} music=${s.music.toFixed(3)} remoteVad=${s.remote ? 1 : 0} selfVad=${s.self ? 1 : 0}`);
  }
  return lines.join('\n');
}
