/**
 * Server-side Sentry init.
 *
 * This file is the fix for a defect that made the whole error-reporting layer
 * decorative: `Sentry.init()` was never called anywhere in the repo. The
 * logger dynamically imported `@sentry/nextjs` and called `captureException`
 * on it, but an SDK with no client bound drops every event silently — so
 * `reportError` had never delivered anything, and would not have even with
 * SENTRY_DSN set. The helper was called `sentryInitPromise`, which is what
 * made it look done.
 *
 * Loaded from `instrumentation.ts`, which is Next's sanctioned hook and the
 * only place init runs early enough to catch errors during module evaluation.
 */
import * as Sentry from '@sentry/nextjs';
import { baseSentryOptions } from '@/lib/observability/sentry-options';

// Unset DSN means "observability not configured yet", which is the state of
// dev, CI and preview. It must be a silent no-op, not a warning on every boot.
if (process.env.SENTRY_DSN) {
  Sentry.init({
    ...baseSentryOptions(
      process.env.SENTRY_DSN,
      process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    ),
  });
}
