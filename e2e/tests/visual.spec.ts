/**
 * Screenshots of key states at phone sizes (portrait 390x844, landscape 844x390) into e2e/screenshots/,
 * plus a touch-target audit of each state: every visible interactive element >= 56 px in both
 * dimensions (gloves), the four dock buttons >= 76 px. Audit failures are soft, so one run lists all.
 */
import { TIMING } from '@intercom/shared';
import { TID } from '../helpers/contract';
import { appUrl, SCREENSHOT_DIR } from '../helpers/env';
import { riderStart } from '../helpers/geo';
import { PHONE_LANDSCAPE, PHONE_PORTRAIT, saveScreenshot, type Rider } from '../helpers/rider';
import { joinRideByLink, createRide } from '../helpers/ride';
import { expect, test } from '../helpers/test';
import { auditTouchTargets, closeSheet, holdButton, openSheet } from '../helpers/ui';
import type { TestInfo } from '@playwright/test';

const DOCK = { [TID.dockMic]: 76, [TID.dockMusic]: 76, [TID.dockBreak]: 76, [TID.dockSos]: 76 };
/** Third-party map attribution isn't a rider control. */
const IGNORE = ['.maplibregl-ctrl-attrib'];

async function capture(rider: Rider, state: string, testInfo: TestInfo): Promise<void> {
  for (const [orientation, size] of [['portrait', PHONE_PORTRAIT], ['landscape', PHONE_LANDSCAPE]] as const) {
    await rider.page.setViewportSize(size);
    // Two frames so layout and the map settle at the new size.
    await rider.page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    await saveScreenshot(rider, SCREENSHOT_DIR, `${state}-${orientation}`, testInfo);
    const issues = await auditTouchTargets(rider.page, { min: 56, strict: DOCK, ignore: IGNORE });
    expect.soft(issues, `${state} (${orientation}): touch targets below minimum`).toEqual([]);
  }
  await rider.page.setViewportSize(PHONE_PORTRAIT);
}

test('screenshots of key states in both orientations; touch targets fit gloved hands', { tag: '@slow' }, async ({ riders }, testInfo) => {
  const [asha, bharat] = await riders.launchAll([
    { name: 'Asha', geo: riderStart(0), deviceScaleFactor: 2 },
    { name: 'Bharat', geo: riderStart(1), deviceScaleFactor: 2 },
  ]);
  await asha.page.goto(appUrl('/'));
  await expect(asha.tid(TID.homeCreate)).toBeVisible();
  await capture(asha, 'home', testInfo);

  const code = await createRide(asha);
  await bharat.page.goto(appUrl(`/r/${code}`));
  await expect(bharat.tid(TID.joinStart)).toBeVisible();
  await capture(bharat, 'join-link', testInfo);
  await joinRideByLink(bharat, code);
  await capture(asha, 'ride', testInfo);

  for (const sheet of ['music', 'riders', 'settings', 'share', 'route'] as const) {
    await openSheet(asha, sheet);
    await capture(asha, `sheet-${sheet}`, testInfo);
    await closeSheet(asha, sheet);
  }

  await bharat.tid(TID.dockBreak).click();
  await expect(asha.tid(TID.toast).first()).toBeVisible();
  await capture(asha, 'break-toast', testInfo);

  await holdButton(bharat, TID.dockSos, TIMING.sosHoldMs + 300);
  await expect(asha.tid(TID.sosOverlay)).toBeVisible();
  await capture(asha, 'sos-overlay', testInfo);
  await capture(bharat, 'sos-raised', testInfo);
  await asha.tid(TID.sosSilence).click();
  await expect(asha.tid(TID.sosBanner)).toBeVisible();
  await capture(asha, 'sos-banner', testInfo);
});
