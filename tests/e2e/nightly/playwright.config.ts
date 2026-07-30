import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/phase*.spec.ts',
  timeout: 30_000,
  retries: 2,
  workers: 4,
  // fullyParallel stays OFF (the default). Every phase runs against the SAME
  // e2e tenant, so tests within a file must run in order: several of them read
  // a total, mutate, and read it back — the delete-reversal check in phase3
  // asserts the tax estimate moves by exactly the amount it booked. Turning
  // fullyParallel on would let same-file tests interleave against shared books
  // and produce flakes that look like ledger bugs. Files still run in parallel
  // across workers, which is where the speed comes from.
  fullyParallel: false,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'junit.xml' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
});
