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
    // The integration files share one live Vault and its WebSocket/IP rate
    // limiter. Running daemon-heavy files concurrently can make the harness
    // reject its own connections with HTTP 429 / close code 4029, which tests
    // test-runner saturation rather than agent behaviour. Keep this gate
    // serial; unique ports alone do not isolate the shared server quota.
    pool: 'forks',
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    // Ensure tests within a file run sequentially
    sequence: {
      shuffle: false,
    },
    // A release gate must surface the first failure rather than masking it.
    retry: 0,
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
