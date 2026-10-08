import { defineConfig, devices } from '@playwright/test';

/**
 * The /app PWA journeys, run against a real deployment (default: production).
 *
 * workers: 1 — the personas are shared seeded tenants and some journeys write
 * (Remind on an overdue invoice); parallel runs would interleave on the same books.
 * serviceWorkers: 'block' — a worker registering mid-test fires
 * controllerchange → one reload, which reads as a flaky navigation. The
 * worker's own rules are covered by the vm test and phase9-pwa.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 90_000,
  retries: 1,
  workers: 1,
  fullyParallel: false,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'junit.xml' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com',
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
    userAgent: devices['iPhone 13'].userAgent,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
