import type { RiderId } from '@intercom/shared';
import { TID } from '../helpers/contract';
import { riderStart } from '../helpers/geo';
import type { Rider } from '../helpers/rider';
import { startGroupRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { expectStable } from '../helpers/wait';

/** Break alerts from `from` in a rider's store, and the break toasts it has shown. */
async function breakState(r: Rider, from: RiderId) {
  const s = await r.state();
  return {
    alerts: s.ride.breaks.filter((b) => b.riderId === from).length,
    toastIds: s.local.ui.toasts.filter((t) => t.kind === 'break').map((t) => t.id),
  };
}

test('break: one tap alerts the others; a second tap inside the cooldown is refused', async ({ riders }) => {
  const [asha, bharat, chitra] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0) },
    { name: 'Bharat', geo: riderStart(1) },
    { name: 'Chitra', geo: riderStart(2) },
  ]);
  await startGroupRide(asha, [bharat, chitra]);
  const bId = await bharat.id();
  const breakBtn = bharat.tid(TID.dockBreak);

  await breakBtn.click();
  await expect(breakBtn, '[Bharat] dock shows the request went out').toHaveAttribute('data-state', 'sent');
  for (const r of [asha, chitra]) {
    await expect(r.tid(TID.toast).and(r.page.locator('[data-kind="break"]')), `[${r.name}] break toast`).toContainText('Bharat wants a break');
    await expect.poll(async () => (await breakState(r, bId)).alerts).toBe(1);
  }
  const seen = new Map(await Promise.all([asha, chitra].map(async (r) => [r, new Set((await breakState(r, bId)).toastIds)] as const)));

  await breakBtn.click();
  await expect(breakBtn, '[Bharat] cooldown feedback on the dock').toHaveAttribute('data-state', 'refused');
  await expect(breakBtn).not.toHaveAttribute('data-cooldown-ms', '0');
  await expectStable(
    () => Promise.all([asha, chitra].map(async (r) => ({ r, ...(await breakState(r, bId)) }))),
    (states) => {
      for (const { r, alerts, toastIds } of states) {
        if (alerts !== 1) return `[${r.name}] has ${alerts} break alerts from Bharat`;
        const fresh = toastIds.filter((id) => !seen.get(r)!.has(id));
        if (fresh.length) return `[${r.name}] showed a second break toast`;
      }
      return null;
    },
    { during: 4_000, message: 'a refused break must not reach anyone' },
  );
});
