// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * @see https://playwright.dev/docs/test-configuration
 */
module.exports = defineConfig({
  testDir: './tests',

  /* Run tests in files in parallel */
  fullyParallel: true,

  /* Fail the build on CI if you accidentally left test.only in the source code. */
  forbidOnly: !!process.env.CI,

  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,

  /* Opt out of parallel tests on CI. */
  workers: process.env.CI ? 1 : undefined,

  /* Reporter to use. See https://playwright.dev/docs/test-reporters */
  reporter: 'html',

  /* Shared settings for all projects below. */
  use: {
    /** Base URL — lets tests use relative paths: page.goto('/login.html') */
    baseURL: 'http://localhost:5000',

    /* Collect trace when retrying the failed test. */
    trace: 'on-first-retry',
  },

  /* Chromium-only for fast local execution */
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /**
   * Boot a static file server before any test runs.
   * `serve` (npm package) serves the current directory on the given port.
   * Install once if missing: npx serve --version (auto-installs via npx)
   */
  webServer: {
    command: 'npx serve -p 5000 .',
    url: 'http://localhost:5000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
