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
    // Enable file-level parallelism - different test files run concurrently
    // Tests within each file still run sequentially
    // Safe because: unique ports (auto-assigned 19000+), unique IDs (Date.now())
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false, // Enable parallel test files
        minForks: 1,
        maxForks: 4, // Limit concurrent files to avoid overwhelming the vault
      },
    },
    // Ensure tests within a file run sequentially
    sequence: {
      shuffle: false,
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
