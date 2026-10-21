import { TIMING } from '@intercom/shared';
import { addAndPlayMusic } from '../helpers/audio';
import { TID } from '../helpers/contract';
import { riderStart } from '../helpers/geo';
import type { Rider } from '../helpers/rider';
import { joinRideByLink, startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { expectAllHidden, holdButton } from '../helpers/ui';
import { expectStable } from '../helpers/wait';

/** Holds comfortably past the threshold: the hold fires on a timer while pressed. */
const FULL_HOLD_MS = TIMING.sosHoldMs + 300;

const sosCount = async (r: Rider) => Object.keys((await r.state()).ride.sos).length;

async function expectAlerted(r: Rider, raiser: Rider): Promise<void> {
  await expect(r.tid(TID.sosOverlay), `[${r.name}] SOS overlay`).toBeVisible();
  await expect(r.tid(TID.sosOverlay)).toContainText(raiser.name);
  await expect.poll(() => r.audio.sirenActive(), { message: `[${r.name}] siren` }).toBe(true);
}

test('SOS: short hold ignored; full hold alerts everyone; responders, silence, late joiner, hold to cancel', { tag: '@slow' }, async ({ riders }) => {
  const [asha, bharat, chitra] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0) },
    { name: 'Bharat', geo: riderStart(1) },
    { name: 'Chitra', geo: riderStart(2) },
  ]);
  const code = await startGroupRide(asha, [bharat, chitra]);
  const bId = await bharat.id();
  await addAndPlayMusic(asha);
  await expect.poll(() => asha.audio.musicGain(), { message: '[Asha] music audible before the SOS' }).toBeGreaterThan(0.5);

  await test.step('a 0.8 s hold does nothing', async () => {
    await holdButton(bharat, TID.dockSos, 800);
    await expectStable(
      () => Promise.all([asha, bharat, chitra].map(sosCount)),
      (counts) => (counts.some((n) => n > 0) ? `SOS state appeared: ${counts}` : null),
      { during: 2_500, message: 'a short hold must not raise an SOS' },
    );
    await expect(bharat.tid(TID.dockSos)).toHaveAttribute('data-active', 'false');
    await expect(asha.tid(TID.sosOverlay)).toBeHidden();
  });

  await test.step('a full hold raises it: overlay + siren for the others, music muted', async () => {
    await holdButton(bharat, TID.dockSos, FULL_HOLD_MS);
    await expect(bharat.tid(TID.dockSos)).toHaveAttribute('data-active', 'true');
    await expect(bharat.tid(TID.sosActiveBanner)).toBeVisible();
    await expect(bharat.tid(TID.sosActiveBanner), 'server confirmed').toHaveAttribute('data-source', 'server');
    await expectAlerted(asha, bharat);
    await expectAlerted(chitra, bharat);
    await expect.poll(() => asha.audio.musicGain(), { message: '[Asha] music muted during SOS' }).toBeLessThan(0.01);
    await expect.poll(async () => (await asha.state()).local.ui.focus?.riderId, { message: '[Asha] map focuses Bharat' }).toBe(bId);
    await expect.poll(() => asha.spoken(), { message: '[Asha] announcement' }).toContainEqual(expect.stringContaining('SOS from Bharat'));
    expect(await bharat.audio.sirenActive(), 'the raiser gets no siren').toBe(false);
  });

  await test.step('Asha taps "I\'m coming": Bharat sees her; her siren stops', async () => {
    await asha.tid(TID.sosRespond).click();
    await expect(bharat.tid(TID.sosResponders)).toContainText('Asha');
    await expect(bharat.tid(TID.sosResponders)).toHaveAttribute('data-count', '1');
    await expect.poll(() => asha.audio.sirenActive(), { message: '[Asha] siren after responding' }).toBe(false);
  });

  await test.step('Chitra silences: siren stops, the SOS stays as a banner', async () => {
    await chitra.tid(TID.sosSilence).click();
    await expect.poll(() => chitra.audio.sirenActive(), { message: '[Chitra] siren after silencing' }).toBe(false);
    await expect(chitra.tid(TID.sosOverlay)).toBeHidden();
    await expect(chitra.tid(TID.sosBanner)).toBeVisible();
    await expect(bharat.tid(TID.sosActiveBanner)).toBeVisible();
    expect(await sosCount(chitra)).toBe(1);
  });

  const dev = await riders.launch({ name: 'Dev', geo: riderStart(3) });
  await test.step('a rider joining during the SOS gets it from the snapshot', async () => {
    await joinRideByLink(dev, code);
    await expectAlerted(dev, bharat);
  });

  await test.step('Bharat holds Cancel: it clears everywhere and the sirens stop', async () => {
    await holdButton(bharat, TID.sosCancel, FULL_HOLD_MS);
    for (const r of [asha, bharat, chitra, dev]) {
      await expectAllHidden(r, [TID.sosOverlay, TID.sosBanner, TID.sosActiveBanner], 15_000);
      await expect.poll(() => r.audio.sirenActive(), { message: `[${r.name}] siren after cancel` }).toBe(false);
      await expect.poll(() => sosCount(r), { message: `[${r.name}] SOS state after cancel` }).toBe(0);
    }
    await expect(bharat.tid(TID.dockSos)).toHaveAttribute('data-active', 'false');
    await expect.poll(() => asha.audio.musicGain(), { message: '[Asha] music back after the SOS' }).toBeGreaterThan(0.5);
  });
});
