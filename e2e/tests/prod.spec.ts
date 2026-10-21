/** Production build only (E2E_PROD=1): the ride server serves the built PWA. */
import { TID } from '../helpers/contract';
import { appUrl, PROD } from '../helpers/env';
import { expect, test } from '../helpers/test';

test.skip(!PROD, 'Production smoke runs with E2E_PROD=1 (builds the web app; the ride server serves it).');

test('PWA: manifest and service worker register; an offline reload still shows the app shell', async ({ riders }) => {
  const rider = await riders.launch({ name: 'Prod' });
  const { page, context } = rider;
  await page.goto(appUrl('/'));
  await expect(rider.tid(TID.homeCreate)).toBeVisible();
  expect(await page.evaluate(() => window.__intercom !== undefined), '?debug=1 exposes the debug hooks').toBe(true);

  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href, 'manifest link in <head>').toBeTruthy();
  const manifest = await page.evaluate(async (h) => (await fetch(h)).json(), href!);
  expect(manifest).toMatchObject({ name: 'Intercom Nav', display: 'standalone', start_url: '/' });

  await expect
    .poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.state ?? null), {
      timeout: 30_000,
      message: 'service worker activated (precache complete)',
    })
    .toBe('activated');
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000, message: 'page controlled by the SW' })
    .toBe(true);

  await context.setOffline(true);
  try {
    await page.reload();
    await expect(rider.tid(TID.homeCreate), 'app shell served offline').toBeVisible();
    await expect(page).toHaveTitle(/Intercom Nav/);
  } finally {
    await context.setOffline(false);
  }
});
