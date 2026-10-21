import { TID } from '../helpers/contract';
import { speechSidecar } from '../helpers/audioFixtures';
import { riderStart } from '../helpers/geo';
import { startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { bytesDuring, bytesFrom, expectHears, expectSilenced, growth, setMicWithDock, vadFor, waitForVoice } from '../helpers/voice';

test('LiveKit: B\'s speech reaches A (bytes + VAD), and turning B\'s mic off stops it', { tag: ['@livekit', '@slow'] }, async ({ riders }) => {
  const [asha, bharat] = await riders.launchAll([
    { name: 'Asha', audio: 'silence', geo: riderStart(0) },
    { name: 'Bharat', audio: 'speech', geo: riderStart(1) },
  ]);
  await startGroupRide(asha, [bharat]);
  await waitForVoice([asha, bharat], 'livekit');
  const bId = await bharat.id();

  await test.step('B talks: own VAD opens the VOX gate and audio goes out', async () => {
    await expect
      .poll(() => vadFor(bharat, 'self'), { timeout: 30_000, intervals: [100], message: '[Bharat] own VAD should fire on the speech' })
      .toBe(true);
    await expect.poll(async () => (await bharat.voice.stats()).bytesSent, { timeout: 30_000, message: '[Bharat] bytesSent' }).toBeGreaterThan(4_000);
  });

  await test.step('A receives B: bytes, VAD, speaking indicator', async () => {
    await expectHears(asha, bharat);
    await expect(asha.tid(TID.mapMarker(bId)), '[Asha] marker shows Bharat speaking').toHaveAttribute('data-speaking', 'true', {
      timeout: 30_000,
    });
  });

  const talking = await test.step('bytes over one full speech cycle while talking', () => bytesDuring(asha, bId, speechSidecar().cycleMs));
  expect(talking, 'bytes from Bharat over a 12 s cycle').toBeGreaterThan(4_000);

  await test.step('B turns the mic off: nothing more reaches A', async () => {
    await setMicWithDock(bharat, 'off');
    await expect(bharat.tid(TID.dockMic)).toHaveAttribute('data-state', 'off');
    await expect.poll(() => bharat.audio.outgoingTrackState(), { message: '[Bharat] outgoing track released' }).not.toBe('live');
    await expectSilenced(asha, bharat, talking);
  });

  await test.step('B unmutes: audio flows again', async () => {
    const before = await bytesFrom(asha, bId);
    await setMicWithDock(bharat, 'vox');
    await expect
      .poll(async () => growth(await bytesFrom(asha, bId), before), { timeout: 30_000, message: '[Asha] bytes from Bharat after unmute' })
      .toBeGreaterThan(4_000);
    await expect.poll(() => vadFor(asha, bId), { timeout: 30_000, intervals: [100], message: '[Asha] VAD for Bharat after unmute' }).toBe(true);
  });
});
