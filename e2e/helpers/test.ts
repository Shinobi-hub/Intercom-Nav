/**
 * The suite's `test`: adds a `riders` pool (browsers always closed, diagnostics attached on failure)
 * and tag behaviour:
 *   @livekit  skipped with a clear message when the LiveKit dev server is down
 *   @slow     triple timeout
 *   @mesh     peer-to-peer voice (tag only, for --grep)
 */
import { test as base } from '@playwright/test';
import { LIVEKIT_DOWN_MESSAGE, livekitUp } from './env';
import { RiderPool } from './rider';

export const test = base.extend<{ riders: RiderPool; tagGate: void }>({
  tagGate: [
    async ({}, use, testInfo) => {
      if (testInfo.tags.includes('@livekit') && !(await livekitUp())) testInfo.skip(true, LIVEKIT_DOWN_MESSAGE);
      if (testInfo.tags.includes('@slow')) testInfo.slow();
      await use();
    },
    { auto: true },
  ],
  riders: async ({}, use, testInfo) => {
    const pool = new RiderPool();
    try {
      await use(pool);
    } finally {
      await pool.dispose(testInfo);
    }
  },
});

export { expect } from '@playwright/test';
