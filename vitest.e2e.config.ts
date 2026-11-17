import { defineConfig } from 'vitest/config';

// End to end tests boot the real server against the deterministic mock provider.
// Offline, no GPU, no API key, and they must pass on a clean machine.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    reporters: ['default'],
  },
});
