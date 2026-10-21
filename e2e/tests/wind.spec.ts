import { addAndPlayMusic } from '../helpers/audio';
import { riderStart } from '../helpers/geo';
import { startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { bytesFrom, growth, waitForVoice } from '../helpers/voice';
import { waitFor } from '../helpers/wait';

const RECORD_MS = 25_000; // longer than wind.wav's 20 s loop

test('wind on an open mic never trips the VAD or ducks the music', { tag: ['@livekit', '@slow'] }, async ({ riders }, testInfo) => {
  const [asha, wasim] = await riders.launchAll([
    { name: 'Asha', audio: 'silence', geo: riderStart(0) },
    // Open mic, so the wind really reaches Asha instead of being gated by Wasim's VOX.
    { name: 'Wasim', audio: 'wind', geo: riderStart(1), settings: { micMode: 'open', liveMicMode: 'open' } },
  ]);
  await startGroupRide(asha, [wasim]);
  await waitForVoice([asha, wasim], 'livekit');
  const wId = await wasim.id();
  await addAndPlayMusic(asha);

  const bytesBefore = await bytesFrom(asha, wId);
  const [aSampler, wSampler] = await Promise.all([asha.startSampler('audio', wId, 50), wasim.startSampler('audio', null, 50)]);
  await waitFor(
    async () => {
      const s = await aSampler.pull();
      return s.length > 0 && s[s.length - 1]!.t - s[0]!.t >= RECORD_MS;
    },
    { timeout: RECORD_MS + 15_000, interval: 1_000, message: '[Asha] audio sampler should run' },
  );
  const [heard, own] = await Promise.all([aSampler.stop(), wSampler.stop()]);
  const bytes = growth(await bytesFrom(asha, wId), bytesBefore);

  const quiet = (xs: readonly { remote: boolean; self: boolean }[], key: 'remote' | 'self') => xs.filter((s) => !s[key]).length / xs.length;
  const report = {
    samples: heard.length,
    windBytesAtAsha: bytes,
    ashaVadForWasimQuietShare: quiet(heard, 'remote'),
    wasimOwnVadQuietShare: quiet(own, 'self'),
    ashaMinDuck: Math.min(...heard.map((s) => s.duck)),
  };
  await testInfo.attach('wind-report.json', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });

  expect(bytes, 'wind audio actually reaches Asha (else the test proves nothing)').toBeGreaterThan(20_000);
  expect(report.ashaVadForWasimQuietShare, "Asha's VAD for Wasim stays off").toBeGreaterThanOrEqual(0.98);
  expect(report.wasimOwnVadQuietShare, "Wasim's own VAD stays off (VOX wouldn't open on wind)").toBeGreaterThanOrEqual(0.98);
  expect(report.ashaMinDuck, "Asha's music is never ducked").toBeGreaterThanOrEqual(0.95);
});
