import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './web/browser-tests',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.BROWSER_TEST_BASE_URL || 'http://localhost:3012',
    headless: true,
    trace: 'retain-on-failure',
  },
});
