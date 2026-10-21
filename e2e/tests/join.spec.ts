import { normalizeRideCode } from '@intercom/shared';
import { TID } from '../helpers/contract';
import { appUrl } from '../helpers/env';
import { riderStart } from '../helpers/geo';
import { createRide, expectInRide, joinRideByCode, joinRideByLink, waitForRiderCount } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { openSheet } from '../helpers/ui';
import { waitFor } from '../helpers/wait';

test('leader creates a ride, three riders join by code and by link, everyone sees four riders and the leader', async ({ riders }) => {
  const [asha, bharat, chitra, dev] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0) },
    { name: 'Bharat', geo: riderStart(1) },
    { name: 'Chitra', geo: riderStart(2) },
    { name: 'Dev', geo: riderStart(3) },
  ]);

  const code = await createRide(asha);
  expect(normalizeRideCode(await asha.tid(TID.rideCode).innerText()), 'ride code chip shows the code').toContain(code);

  await test.step('join by typing the code', () => joinRideByCode(bharat, code));
  await test.step('join by opening the shared link', () => joinRideByLink(chitra, code));
  await test.step('join by code again', () => joinRideByCode(dev, code));

  const all = [asha, bharat, chitra, dev];
  await waitForRiderCount(all, 4);

  const [leaderId, ...otherIds] = await Promise.all(all.map((r) => r.id()));
  const names = all.map((r) => r.name).sort();
  for (const r of all) {
    const { ride } = await r.state();
    expect(Object.values(ride.riders).map((x) => x.name).sort(), `[${r.name}] sees everyone by name`).toEqual(names);
    expect(ride.ride?.leaderId, `[${r.name}] knows who leads`).toBe(leaderId);
    expect(ride.riders[leaderId]?.role).toBe('leader');
    for (const id of otherIds) expect(ride.riders[id]?.role).toBe('rider');
  }

  await test.step('leader badge in the riders list', async () => {
    const sheet = await openSheet(bharat, 'riders');
    await expect(sheet.getByTestId(TID.ridersList)).toBeVisible();
    await expect(sheet.getByTestId(TID.riderRow(leaderId)), 'leader row carries a leader badge').toContainText(/leader/i);
    for (const id of otherIds) await expect(sheet.getByTestId(TID.riderRow(id))).not.toContainText(/leader/i);
  });
});

test('joining a ride that does not exist shows an error and stays on the home screen', async ({ riders }) => {
  const rider = await riders.launch({ name: 'Lost', geo: riderStart(4) });
  await rider.page.goto(appUrl('/'));
  await rider.tid(TID.joinName).fill(rider.name);
  // Valid alphabet and length, so it passes the input's checks and reaches the server (ride_not_found).
  await rider.tid(TID.homeJoinCode).fill('ZZZ-ZZ9');
  await rider.tid(TID.homeJoinSubmit).click();
  await expect(rider.tid(TID.joinError)).toBeVisible();
  await expect(rider.tid(TID.joinError)).not.toBeEmpty();
  await expect(rider.tid(TID.rideScreen)).toBeHidden();
  expect((await rider.state()).ride.ride, 'not in any ride').toBeNull();
});

test('a reload rejoins the same rider slot', async ({ riders }) => {
  const [asha, bharat] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0) },
    { name: 'Bharat', geo: riderStart(1) },
  ]);
  const code = await createRide(asha);
  await joinRideByLink(bharat, code);
  await waitForRiderCount([asha, bharat], 2);
  const before = await bharat.id();

  await bharat.page.reload();
  // Same identity from localStorage. Depending on the UI the reload lands on the ride, the join form
  // (Start ride is the audio-unlocking tap) or a resume button; follow it back in.
  for (let step = 0; step < 3; step++) {
    const screen = await waitFor(
      async () => {
        if (await bharat.tid(TID.rideScreen).isVisible()) return 'ride';
        if (await bharat.tid(TID.joinStart).isVisible()) return 'join';
        if (await bharat.tid(TID.homeResume).isVisible()) return 'resume';
        return null;
      },
      { timeout: 20_000, message: '[Bharat] after a reload: ride screen, join form or resume button' },
    );
    if (screen === 'ride') break;
    const control = bharat.tid(screen === 'join' ? TID.joinStart : TID.homeResume);
    await control.click();
    await expect(control, `[Bharat] ${screen} control should go away once tapped`).toBeHidden({ timeout: 20_000 });
  }
  await expectInRide(bharat);
  const { ride } = await bharat.state();
  expect(ride.selfId, 'same rider id after reload').toBe(before);
  await waitForRiderCount([asha, bharat], 2);
});
