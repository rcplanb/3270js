import { defineConfig } from 'vitest/config';

// Live tests against a real host. Opt-in: npm run test:live, with
// HERCULES_HOST and TSO_PASSWORD set (see test/live/README.md).
export default defineConfig({
  test: {
    include: ['test/live/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
