import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './web/browser-tests',
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  // The documented local harness runs against `next dev`; the first request
  // to a passkey route can include a cold route compilation. Product
  // assertions remain exact, but they must not abort an in-flight WebAuthn
  // verification merely because that one-time compile exceeds 5 seconds.
  expect: { timeout: 20_000 },
  use: {
    baseURL: process.env.BROWSER_TEST_BASE_URL || 'http://localhost:3012',
    headless: true,
    trace: 'retain-on-failure',
  },
});
