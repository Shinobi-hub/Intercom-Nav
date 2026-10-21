import { AUDIO_DEFAULTS, TIMING } from '@intercom/shared';
import { addAndPlayMusic, describeTimeline, firstAtOrAfter, minDuck, setDuckLevel, waitForEpisode } from '../helpers/audio';
import { speechSidecar } from '../helpers/audioFixtures';
import { riderStart } from '../helpers/geo';
import type { AudioSample } from '../helpers/pageScript';
import { createRide, startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { waitForVoice } from '../helpers/voice';

const ONSET_BUDGET_MS = 500;
const RELEASE_BUDGET_MS = 2_500;
const SAMPLE_MS = 20;

/**
 * One speech window as heard by `who`: the duck must reach the floor within 500 ms of the VAD
 * firing and be back to >= 0.95 within 2.5 s of the window's end (onset + sidecar duration).
 */
function checkEpisode(samples: readonly AudioSample[], onAt: number, floor: number, who: string): { reachedMs: number; recoveredMs: number } {
  const windowEnd = onAt + speechSidecar().speech.durationMs;
  const ducked = firstAtOrAfter(samples, onAt - 100, (s) => s.duck <= floor + 0.05);
  const recovered = firstAtOrAfter(samples, windowEnd, (s) => s.duck >= 0.95);
  const timeline = `\n${describeTimeline(samples, onAt - 300, windowEnd + RELEASE_BUDGET_MS + 500)}`;
  expect(ducked, `${who}: duck gain never reached ${floor} + 0.05${timeline}`).toBeDefined();
  expect(ducked!.t - onAt, `${who}: duck onset after VAD fired${timeline}`).toBeLessThanOrEqual(ONSET_BUDGET_MS);
  expect(recovered, `${who}: duck never recovered to 0.95${timeline}`).toBeDefined();
  expect(recovered!.t - windowEnd, `${who}: release after the speech window ended${timeline}`).toBeLessThanOrEqual(RELEASE_BUDGET_MS);
  const lowest = minDuck(samples, onAt, windowEnd);
  expect(lowest, `${who}: floor is duckLevel`).toBeGreaterThanOrEqual(floor - 0.03);
  return { reachedMs: ducked!.t - onAt, recoveredMs: recovered!.t - windowEnd };
}

test('music ducks under another rider\'s speech, recovers, and follows the duck level setting', { tag: ['@livekit', '@slow'] }, async ({ riders }, testInfo) => {
  const [asha, bharat] = await riders.launchAll([
    { name: 'Asha', audio: 'silence', geo: riderStart(0) },
    { name: 'Bharat', audio: 'speech', geo: riderStart(1) },
  ]);
  await startGroupRide(asha, [bharat]);
  await waitForVoice([asha, bharat], 'livekit');
  const bId = await bharat.id();
  await addAndPlayMusic(asha);
  const timings: Record<string, unknown> = {};

  await test.step(`default floor ${AUDIO_DEFAULTS.duckLevel}: onset and release`, async () => {
    const sampler = await asha.startSampler('audio', bId, SAMPLE_MS);
    const { episode, samples } = await waitForEpisode(sampler, (s) => s.remote, {
      timeout: 40_000,
      tailMs: RELEASE_BUDGET_MS + 1_000,
      message: '[Asha] should hear one complete speech window from Bharat',
    });
    await sampler.stop();
    timings.default = checkEpisode(samples, episode.onAt, AUDIO_DEFAULTS.duckLevel, 'Asha');
  });

  await test.step('a lower duck level in Settings lowers the floor', async () => {
    const level = 0.1;
    await setDuckLevel(asha, level);
    const sampler = await asha.startSampler('audio', bId, SAMPLE_MS);
    const { episode, samples } = await waitForEpisode(sampler, (s) => s.remote, {
      timeout: 40_000,
      tailMs: RELEASE_BUDGET_MS + 1_000,
      message: '[Asha] should hear another speech window after the change',
    });
    await sampler.stop();
    timings.lowered = checkEpisode(samples, episode.onAt, level, 'Asha');
    expect(minDuck(samples, episode.onAt, episode.offAt), 'new floor is below the default').toBeLessThan(AUDIO_DEFAULTS.duckLevel - 0.1);
  });

  await testInfo.attach('duck-timings.json', { body: JSON.stringify(timings, null, 2), contentType: 'application/json' });
});

test('own voice ducks the music when enabled (default) and not when disabled', { tag: '@slow' }, async ({ riders }) => {
  // Two solo rides, so neither rider hears the other: only their own mic can duck their music.
  const [on, off] = await riders.launchAll([
    { name: 'Ojas', audio: 'speech', geo: riderStart(0) },
    { name: 'Farah', audio: 'speech', geo: riderStart(1), settings: { duckOnOwnVoice: false } },
  ]);
  await Promise.all([createRide(on), createRide(off)]);
  await Promise.all([addAndPlayMusic(on), addAndPlayMusic(off)]);
  const [onSampler, offSampler] = await Promise.all([on.startSampler('audio', null, SAMPLE_MS), off.startSampler('audio', null, SAMPLE_MS)]);
  const episodeOpts = { timeout: 40_000, tailMs: RELEASE_BUDGET_MS + 1_000 };
  const [heard, ignored] = await Promise.all([
    waitForEpisode(onSampler, (s) => s.self, { ...episodeOpts, message: '[Ojas] own VAD should fire on the speech' }),
    waitForEpisode(offSampler, (s) => s.self, { ...episodeOpts, message: '[Farah] own VAD should fire on the speech' }),
  ]);
  await Promise.all([onSampler.stop(), offSampler.stop()]);

  checkEpisode(heard.samples, heard.episode.onAt, AUDIO_DEFAULTS.duckLevel, 'Ojas (duckOnOwnVoice on)');
  const windowEnd = ignored.episode.onAt + speechSidecar().speech.durationMs + TIMING.duckHoldMs;
  expect(minDuck(ignored.samples, ignored.episode.onAt - 200, windowEnd), 'Farah (duckOnOwnVoice off): music not ducked by own voice').toBeGreaterThanOrEqual(0.95);
});
