import { TID } from '../helpers/contract';
import { riderStart } from '../helpers/geo';
import type { Rider } from '../helpers/rider';
import { startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { closeSheet, openSheet } from '../helpers/ui';
import { expectStable } from '../helpers/wait';

const DISTANCE = /\d+(?:[.,]\d+)?\s?(?:km|m|mi|ft)\b/;

/** Leader searches (mock geocoder) in the Route sheet and picks the first result. */
async function pickDestination(leader: Rider, query: string): Promise<void> {
  await openSheet(leader, 'route');
  const input = leader.tid(TID.destSearchInput);
  await input.fill(query);
  await input.press('Enter');
  await leader.tid(TID.destResult(0)).click();
  // Picking a destination closes the sheet by itself, so the map with the new route is in view.
  await expect(leader.tid(TID.sheet('route')), `[${leader.name}] the route sheet closes after picking`).toBeHidden();
}

async function expectRouteShown(r: Rider): Promise<void> {
  await expect(r.tid(TID.routeSummary), `[${r.name}] route summary`).toBeVisible();
  await expect(r.tid(TID.routeSummary), `[${r.name}] route summary shows a distance`).toContainText(DISTANCE);
  await expect.poll(async () => (await r.state()).ride.route?.distanceM ?? 0, { message: `[${r.name}] route in store` }).toBeGreaterThan(0);
  await expect.poll(() => r.map.routeVisible(), { message: `[${r.name}] route line on the map` }).toBe(true);
}

test('route: the leader picks a destination for everyone; a non-leader cannot change it; clear removes it', async ({ riders }) => {
  const [asha, bharat, chitra] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0) },
    { name: 'Bharat', geo: riderStart(1) },
    { name: 'Chitra', geo: riderStart(2) },
  ]);
  await startGroupRide(asha, [bharat, chitra]);
  const all = [asha, bharat, chitra];
  // The server routes from the leader's position.
  await expect.poll(async () => (await asha.state()).local.selfFix !== null, { message: '[Asha] has a GPS fix' }).toBe(true);

  await test.step('leader searches and picks a result: everyone sees the route', async () => {
    await pickDestination(asha, 'Lonavala');
    for (const r of all) await expectRouteShown(r);
  });
  const routeId = (await asha.state()).ride.route!.id;

  await test.step('a non-leader cannot change it', async () => {
    await openSheet(bharat, 'route');
    // Leader-only controls aren't rendered for other riders (testIds.ts); the server would refuse
    // their route:set anyway (not_leader, covered by the server tests).
    await expect(bharat.tid(TID.destCurrent), '[Bharat] sees the destination').toBeVisible();
    for (const id of [TID.destSearchInput, TID.destUseCenter, TID.destClear]) {
      await expect(bharat.tid(id), `[Bharat] ${id} is leader-only`).toBeHidden();
    }
    await expectStable(
      () => Promise.all(all.map(async (r) => (await r.state()).ride.route?.id ?? null)),
      (ids) => (ids.every((id) => id === routeId) ? null : `route changed: ${ids.join(', ')}`),
      { during: 3_000, message: 'the route must stay as the leader set it' },
    );
    await closeSheet(bharat, 'route');
  });

  await test.step('leader clears it: gone everywhere', async () => {
    await openSheet(asha, 'route');
    await asha.tid(TID.destClear).click();
    await closeSheet(asha, 'route');
    for (const r of all) {
      await expect(r.tid(TID.routeSummary), `[${r.name}] route summary gone`).toBeHidden();
      await expect.poll(async () => (await r.state()).ride.route, { message: `[${r.name}] route in store` }).toBeNull();
      await expect.poll(() => r.map.routeVisible(), { message: `[${r.name}] route line gone` }).toBe(false);
    }
  });
});
