import type { RiderId } from '@intercom/shared';
import { speechSidecar } from '../helpers/audioFixtures';
import { TID } from '../helpers/contract';
import { riderStart } from '../helpers/geo';
import type { Rider, RiderPool } from '../helpers/rider';
import { startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { bytesDuring, bytesFrom, expectHears, expectSilenced, growth, setMicWithDock, switchVoiceMode, vadFor, waitForVoice } from '../helpers/voice';

/** Every rider holds a connected peer connection to every other rider (store + debug stats). */
async function expectFullMesh(riders: readonly Rider[]): Promise<void> {
  const ids = await Promise.all(riders.map((r) => r.id()));
  await Promise.all(
    riders.map(async (r, i) => {
      const others = ids.filter((_, j) => j !== i);
      await expect
        .poll(
          async () => {
            const { peers } = (await r.state()).local.voice;
            return others.map((id) => peers[id] ?? 'missing');
          },
          { timeout: 30_000, message: `[${r.name}] peer connection state to each other rider` },
        )
        .toEqual(others.map(() => 'connected'));
      await expect
        .poll(async () => {
          const stats = await r.voice.stats();
          return others.map((id: RiderId) => stats.peers[id]?.state ?? 'missing');
        }, { timeout: 30_000, message: `[${r.name}] voice.stats() peers` })
        .toEqual(others.map(() => 'connected'));
    }),
  );
}

type Trio = [Rider, Rider, Rider];

/** Asha leads and switches the ride to mesh; Bharat talks (speech-loop), Chitra and Asha are quiet. */
async function startMeshRide(riders: Trio): Promise<void> {
  const [asha, bharat, chitra] = riders;
  await startGroupRide(asha, [bharat, chitra]);
  await switchVoiceMode(asha, 'mesh');
  await waitForVoice(riders, 'mesh');
  for (const r of riders) await expect.poll(async () => (await r.state()).ride.ride?.voiceMode, { message: `[${r.name}] ride voiceMode` }).toBe('mesh');
  await expectFullMesh(riders);
}

function launchTrio(pool: RiderPool): Promise<Trio> {
  return pool.launchAll([
    { name: 'Asha', audio: 'silence', geo: riderStart(0) },
    { name: 'Bharat', audio: 'speech', geo: riderStart(1) },
    { name: 'Chitra', audio: 'silence', geo: riderStart(2) },
  ]);
}

test('mesh: the leader switches to peer-to-peer; speech flows over peer connections; mic off stops it', { tag: ['@mesh', '@slow'] }, async ({ riders }) => {
  const trio = await launchTrio(riders);
  const [asha, bharat, chitra] = trio;
  await test.step('leader switches to mesh in Settings; full mesh forms', () => startMeshRide(trio));
  const bId = await bharat.id();

  await test.step('A and C both hear B directly', async () => {
    await expectHears(asha, bharat);
    await expectHears(chitra, bharat);
    await expect(asha.tid(TID.mapMarker(bId))).toHaveAttribute('data-speaking', 'true', { timeout: 30_000 });
  });

  const talking = await bytesDuring(asha, bId, speechSidecar().cycleMs);
  expect(talking, 'bytes from Bharat over a 12 s cycle (mesh)').toBeGreaterThan(4_000);

  await test.step('B turns the mic off: nothing reaches A or C', async () => {
    await setMicWithDock(bharat, 'off');
    await Promise.all([expectSilenced(asha, bharat, talking), expectSilenced(chitra, bharat, talking)]);
  });

  await test.step('B unmutes over the existing peer connections', async () => {
    const before = await bytesFrom(asha, bId);
    await setMicWithDock(bharat, 'vox');
    await expect.poll(async () => growth(await bytesFrom(asha, bId), before), { timeout: 30_000 }).toBeGreaterThan(4_000);
    await expect.poll(() => vadFor(asha, bId), { timeout: 30_000, intervals: [100] }).toBe(true);
  });
});

test('mesh -> LiveKit: switching back moves everyone to the SFU and voice keeps working', { tag: ['@mesh', '@livekit', '@slow'] }, async ({ riders }) => {
  const trio = await launchTrio(riders);
  const [asha, bharat, chitra] = trio;
  await startMeshRide(trio);
  await expectHears(asha, bharat);

  await switchVoiceMode(asha, 'livekit');
  await waitForVoice(trio, 'livekit');
  const bId = await bharat.id();
  for (const r of trio) await expect.poll(async () => (await r.state()).ride.ride?.voiceMode).toBe('livekit');

  // Fresh LiveKit subscriptions: count from the switch, not from the mesh counters.
  const [aBefore, cBefore] = [await bytesFrom(asha, bId), await bytesFrom(chitra, bId)];
  await expect.poll(async () => growth(await bytesFrom(asha, bId), aBefore), { timeout: 30_000, message: '[Asha] bytes over LiveKit' }).toBeGreaterThan(4_000);
  await expect.poll(async () => growth(await bytesFrom(chitra, bId), cBefore), { timeout: 30_000, message: '[Chitra] bytes over LiveKit' }).toBeGreaterThan(4_000);
  await expect.poll(() => vadFor(asha, bId), { timeout: 30_000, intervals: [100], message: '[Asha] VAD for Bharat over LiveKit' }).toBe(true);
  for (const r of trio) await expect.poll(async () => (await r.voice.stats()).transport).toBe('livekit');
});
