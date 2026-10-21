/**
 * Offline and back. Note how Chromium emulates offline (measured on this rig): an open WebSocket is
 * neither closed nor errored, its frames are held in both directions and flushed when the network
 * returns; new connections fail. WebRTC (UDP) is unaffected. The ride server's socket.io ping
 * (10 s + 10 s) therefore notices a frozen rider within ~20 s.
 */
import { TIMING } from '@intercom/shared';
import { TID } from '../helpers/contract';
import { buildRoute, driveRoute, riderStart, routeFixes } from '../helpers/geo';
import { startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { holdButton } from '../helpers/ui';
import { bytesFrom, growth, vadFor, waitForVoice } from '../helpers/voice';
import { waitFor } from '../helpers/wait';

test('C drops offline, misses an SOS, comes back, reconnects, sees it, and voice recovers', { tag: ['@slow', '@livekit'] }, async ({ riders }) => {
  const route = buildRoute(riderStart(2));
  const [asha, bharat, chitra] = await riders.launchAll([
    { name: 'Asha', audio: 'silence', geo: riderStart(0) },
    { name: 'Bharat', audio: 'speech', geo: riderStart(1) },
    { name: 'Chitra', audio: 'silence', geo: route[0] },
  ]);
  await startGroupRide(asha, [bharat, chitra]);
  await waitForVoice([asha, bharat, chitra], 'livekit');
  const [bId, cId] = [await bharat.id(), await chitra.id()];
  // Chitra rides slowly so she keeps reporting: "stale" can only come from the outage.
  const drive = await driveRoute(chitra, routeFixes(route, 4, 1_000), 1_000);
  await expect.poll(async () => (await asha.map.markers())[cId]?.state, { message: '[Asha] Chitra live' }).toBe('live');

  await test.step('Chitra goes offline: she sees it, the others see her offline or stale', async () => {
    await chitra.context.setOffline(true);
    await expect(chitra.tid(TID.connectionStatus), '[Chitra] own status').toHaveAttribute('data-state', /offline|reconnecting/);
    for (const r of [asha, bharat]) {
      await waitFor(
        async () => {
          const [{ ride }, markers] = await Promise.all([r.state(), r.map.markers()]);
          return ride.riders[cId]?.online === false || markers[cId]?.state !== 'live';
        },
        { timeout: 60_000, interval: 500, message: `[${r.name}] should see Chitra offline or stale` },
      );
    }
  });

  await test.step('Bharat raises an SOS while Chitra is away', async () => {
    await holdButton(bharat, TID.dockSos, TIMING.sosHoldMs + 300);
    await expect(asha.tid(TID.sosOverlay)).toBeVisible();
  });

  await test.step('Chitra comes back: reconnects and shows the SOS', async () => {
    await chitra.context.setOffline(false);
    await expect(chitra.tid(TID.connectionStatus), '[Chitra] reconnected').toHaveAttribute('data-state', 'connected', { timeout: 60_000 });
    await expect.poll(async () => (await asha.state()).ride.riders[cId]?.online, { timeout: 30_000, message: '[Asha] Chitra online again' }).toBe(true);
    await expect(chitra.tid(TID.sosOverlay), '[Chitra] SOS overlay').toBeVisible();
    await expect.poll(async () => Object.values((await chitra.state()).ride.sos).some((s) => s.riderId === bId && s.source === 'server')).toBe(true);
    await expect.poll(() => chitra.audio.sirenActive(), { message: '[Chitra] siren' }).toBe(true);
    await expect.poll(async () => (await asha.map.markers())[cId]?.state, { timeout: 30_000, message: '[Asha] Chitra live again' }).toBe('live');
  });

  await test.step('voice recovers for Chitra', async () => {
    await waitForVoice([chitra], 'livekit', 60_000);
    const before = await bytesFrom(chitra, bId);
    await expect.poll(async () => growth(await bytesFrom(chitra, bId), before), { timeout: 30_000, message: '[Chitra] bytes from Bharat' }).toBeGreaterThan(4_000);
    await expect.poll(() => vadFor(chitra, bId), { timeout: 30_000, intervals: [100], message: '[Chitra] VAD for Bharat' }).toBe(true);
  });
  await drive.stop();
});
