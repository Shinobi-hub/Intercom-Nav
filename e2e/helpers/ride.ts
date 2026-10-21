/** Ride flows through the real UI: create, join (code / shared link), rider counts. */
import { formatRideCode, isValidRideCode, normalizeRideCode } from '@intercom/shared';
import { expect } from '@playwright/test';
import { TID, type AppSnapshot } from './contract';
import { appUrl } from './env';
import type { Rider } from './rider';
import { waitFor } from './wait';

const JOIN_TIMEOUT = 30_000;

/**
 * Types the rider's name into the identity field of the current screen. The home screen carries it
 * (Create and Join start the ride straight from there); a shared link opens a join screen with it.
 */
async function enterName(rider: Rider): Promise<void> {
  const name = rider.tid(TID.joinName);
  await expect(name, `[${rider.name}] the name field (${TID.joinName}) should be on screen`).toBeVisible({ timeout: JOIN_TIMEOUT });
  await name.fill(rider.name);
}

/** Waits for the ride screen, failing early with the app's own error text if joining failed. */
export async function expectInRide(rider: Rider, timeout = JOIN_TIMEOUT): Promise<void> {
  const outcome = await waitFor(
    async () => {
      if (await rider.tid(TID.joinError).isVisible()) return `join error: ${(await rider.tid(TID.joinError).innerText()).trim()}`;
      if (await rider.tid(TID.rideScreen).isVisible()) return 'in ride';
      return null;
    },
    { timeout, interval: 200, message: `[${rider.name}] never reached the ride screen (${TID.rideScreen})` },
  );
  expect(outcome, `[${rider.name}] joining failed`).toBe('in ride');
  await expect(rider.tid(TID.connectionStatus), `[${rider.name}] should be connected`).toHaveAttribute('data-state', 'connected');
}

/** The ride code from the store (raw, 6 chars), cross-checked with the URL. */
export async function rideCodeOf(rider: Rider): Promise<string> {
  const { ride } = await rider.state();
  const code = ride.ride?.code;
  if (!code || !isValidRideCode(code)) throw new Error(`[${rider.name}] has no valid ride code in state (got ${JSON.stringify(code)})`);
  expect(new URL(rider.page.url()).pathname, `[${rider.name}] URL should be the ride link`).toBe(`/r/${code}`);
  return code;
}

/** Leader creates a ride from the home screen: name, then Create ride (the audio-unlocking tap). */
export async function createRide(leader: Rider): Promise<string> {
  await leader.page.goto(appUrl('/'));
  await enterName(leader);
  await leader.tid(TID.homeCreate).click();
  await expectInRide(leader);
  return rideCodeOf(leader);
}

/** Joins from the home screen by typing the code formatted "ABC-D23", as people read it out. */
export async function joinRideByCode(rider: Rider, code: string): Promise<void> {
  await rider.page.goto(appUrl('/'));
  await enterName(rider);
  await rider.tid(TID.homeJoinCode).fill(formatRideCode(code));
  await rider.tid(TID.homeJoinSubmit).click();
  await expectInRide(rider);
  expect(await rideCodeOf(rider)).toBe(normalizeRideCode(code));
}

/** Joins by opening the shared link /r/CODE: join screen, name, Join ride. */
export async function joinRideByLink(rider: Rider, code: string): Promise<void> {
  await rider.page.goto(appUrl(`/r/${code}`));
  await enterName(rider);
  await rider.tid(TID.joinStart).click();
  await expectInRide(rider);
  expect(await rideCodeOf(rider)).toBe(code);
}

export async function joinRide(rider: Rider, code: string, via: 'code' | 'link' = 'code'): Promise<void> {
  return via === 'code' ? joinRideByCode(rider, code) : joinRideByLink(rider, code);
}

export const onlineRiders = (s: AppSnapshot) => Object.values(s.ride.riders).filter((r) => r.online);

/** Every rider sees exactly `n` riders online, in the store and on the rider-count chip. */
export async function waitForRiderCount(riders: readonly Rider[], n: number, timeout = 20_000): Promise<void> {
  await Promise.all(
    riders.map(async (r) => {
      await expect
        .poll(async () => onlineRiders(await r.state()).length, { timeout, message: `[${r.name}] should see ${n} riders online` })
        .toBe(n);
      await expect(r.tid(TID.riderCount), `[${r.name}] rider count chip`).toHaveAttribute('data-count', String(n), { timeout });
    }),
  );
}

/**
 * Convenience: first rider creates the ride, the rest join (alternating code input and shared
 * link), and everyone sees everyone. Returns the code.
 */
export async function startGroupRide(leader: Rider, others: readonly Rider[]): Promise<string> {
  const code = await createRide(leader);
  await Promise.all(others.map((r, i) => joinRide(r, code, i % 2 === 0 ? 'code' : 'link')));
  await waitForRiderCount([leader, ...others], others.length + 1);
  return code;
}
