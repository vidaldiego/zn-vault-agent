// Path: vitest.integration.config.ts

/**
 * Vitest configuration for integration tests.
 * Runs tests against a live vault instance.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    testTimeout: 60000, // 60s timeout for integration tests
    hookTimeout: 60000,
    // Run sequentially to avoid port conflicts and state conflicts
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Retry flaky network tests once
    retry: 1,
    // Reporter for CI
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: 'test-results/integration.xml',
    },
  },
  // Ignore PostCSS config from parent directory
  css: {
    postcss: {},
  },
});
