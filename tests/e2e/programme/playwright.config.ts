import { defineConfig } from '@playwright/test';
import mobile from '../mobile-app/playwright.config';

/**
 * The programme's cross-PR prod journeys (docs/superpowers/scorecards/programme.json `journeys`), run by
 * tests/scorecard/programme.ts --phase post. Same browser, viewport, timeouts and NO-trace rules as the mobile-app
 * suite (they log in with a password); only the test directory differs.
 */
export default defineConfig({ ...mobile, testDir: '.', testMatch: '**/*.spec.ts', timeout: 240_000 });
