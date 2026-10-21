import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    name: 'web',
    // Pure-logic test files can opt into `// @vitest-environment node` for speed.
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['./src/test/setup.ts'],
  },
});
