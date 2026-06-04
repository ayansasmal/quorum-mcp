import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/integration/**/*.test.js'],
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
