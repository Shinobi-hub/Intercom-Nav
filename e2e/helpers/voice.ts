/** Voice checks: transport state, bytes and VAD between riders, mic control, transport switching. */
import type { RiderId, VoiceMode } from '@intercom/shared';
import { expect } from '@playwright/test';
import { speechSidecar } from './audioFixtures';
import { TID } from './contract';
import type { Rider } from './rider';
import { closeSheet, openSheet } from './ui';
import { expectStable, sleep } from './wait';

/** Voice connected on `transport`: status chip (data-state, data-transport) and the debug hook agree. */
export async function waitForVoice(riders: readonly Rider[], transport: VoiceMode, timeout = 30_000): Promise<void> {
  await Promise.all(
    riders.map(async (r) => {
      const status = r.tid(TID.voiceStatus);
      await expect(status, `[${r.name}] voice transport`).toHaveAttribute('data-transport', transport, { timeout });
      await expect(status, `[${r.name}] voice state`).toHaveAttribute('data-state', 'connected', { timeout });
      await expect.poll(() => r.voice.transport(), { timeout, message: `[${r.name}] __intercom.voice.transport()` }).toBe(transport);
    }),
  );
}

/** Bytes `listener` has received from `speakerId` on the current transport (0 when not connected). */
export async function bytesFrom(listener: Rider, speakerId: RiderId): Promise<number> {
  const stats = await listener.voice.stats();
  return stats.peers[speakerId]?.bytesReceived ?? 0;
}

/** Counter growth since `baseline`. A counter that restarted (e.g. LiveKit resubscribed) counts from 0. */
export function growth(now: number, baseline: number): number {
  return now >= baseline ? now - baseline : now;
}

/** Bytes received from `speakerId` over a measurement window. */
export async function bytesDuring(listener: Rider, speakerId: RiderId, ms: number): Promise<number> {
  const before = await bytesFrom(listener, speakerId);
  await sleep(ms); // measurement window, not an assertion
  return growth(await bytesFrom(listener, speakerId), before);
}

export async function vadFor(listener: Rider, speakerId: RiderId | 'self'): Promise<boolean> {
  return (await listener.audio.vad())[speakerId]?.speaking ?? false;
}

/** `listener` receives `speaker`'s audio and its VAD for the speaker fires (speaker uses speech-loop). */
export async function expectHears(listener: Rider, speaker: Rider, timeout = 30_000): Promise<void> {
  const id = await speaker.id();
  await expect
    .poll(() => bytesFrom(listener, id), { timeout, message: `[${listener.name}] voice stats should show bytes from ${speaker.name}` })
    .toBeGreaterThan(4_000);
  await expect
    .poll(() => vadFor(listener, id), { timeout, intervals: [100], message: `[${listener.name}] VAD for ${speaker.name} should fire` })
    .toBe(true);
}

/**
 * After the speaker's mic went off: the listener's VAD for them stays quiet for a whole speech cycle
 * (so a speech window passes) and bytes nearly stop compared with `talkingBytesPerCycle`.
 */
export async function expectSilenced(listener: Rider, speaker: Rider, talkingBytesPerCycle: number): Promise<void> {
  const id = await speaker.id();
  await expect
    .poll(() => vadFor(listener, id), { timeout: 5_000, intervals: [100], message: `[${listener.name}] VAD for ${speaker.name} should drop` })
    .toBe(false);
  const before = await bytesFrom(listener, id);
  await expectStable(
    () => vadFor(listener, id),
    (speaking) => (speaking ? `VAD for ${speaker.name} fired` : null),
    { during: speechSidecar().cycleMs + 1_000, interval: 100, message: `[${listener.name}] should not hear ${speaker.name} with the mic off` },
  );
  const leaked = growth(await bytesFrom(listener, id), before);
  expect(leaked, `[${listener.name}] bytes from ${speaker.name} over a cycle with the mic off (talking: ${talkingBytesPerCycle})`).toBeLessThan(
    Math.max(1_500, talkingBytesPerCycle * 0.2),
  );
}

/** Leader switches the ride's voice transport in Settings. */
export async function switchVoiceMode(leader: Rider, mode: VoiceMode): Promise<void> {
  await openSheet(leader, 'settings');
  await leader.tid(TID.settingsVoiceMode(mode)).click();
  await closeSheet(leader, 'settings');
}

/** Sets the mic mode with the dock's Mic button (taps until data-mode matches; it may cycle modes). */
export async function setMicWithDock(rider: Rider, mode: 'vox' | 'open' | 'off'): Promise<void> {
  const mic = rider.tid(TID.dockMic);
  for (let taps = 0; taps < 3; taps++) {
    const current = await mic.getAttribute('data-mode');
    if (current === mode) break;
    await mic.click();
    await expect(mic, `[${rider.name}] Mic button should change mode when tapped`).not.toHaveAttribute('data-mode', current ?? '', {
      timeout: 5_000,
    });
  }
  await expect(mic, `[${rider.name}] Mic button should reach mode "${mode}"`).toHaveAttribute('data-mode', mode);
}
