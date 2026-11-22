import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/unit/**/*.test.ts',
      'test/differential/**/*.test.ts',
      'test/interop/**/*.test.ts',
    ],
    passWithNoTests: true,
    // Differential tests drive a real s3270 process.
    testTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/*.ts'], // entry points are re-exports only
      reporter: ['text', 'html'],
    },
  },
});
