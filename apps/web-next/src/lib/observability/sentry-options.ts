/**
 * The SDK-facing half of the Sentry setup.
 *
 * `scrub.ts` is deliberately free of any Sentry import so the redaction rules
 * — the part that protects customer bank and tax data — can be unit-tested
 * directly and cannot break when the SDK's event types change. That leaves
 * one type boundary to cross, and this file is it: exactly one cast, in the
 * file that already depends on Sentry, rather than three casts scattered
 * through the runtime configs.
 *
 * The import is type-only, so nothing from the SDK is pulled into a bundle
 * that only wants the options.
 */
import type { ErrorEvent } from '@sentry/nextjs';
import { beforeSend as scrubEvent } from './scrub';

/**
 * Shared init options, so server, edge and browser cannot drift apart on the
 * settings that matter for privacy and cost.
 */
export function baseSentryOptions(dsn: string, environment: string) {
  return {
    dsn,
    environment,
    // Errors are the requirement; traces are a cost with no current consumer.
    // Turn this up deliberately when someone is actually reading traces.
    tracesSampleRate: 0,
    // Never attach cookies, headers or IP automatically.
    sendDefaultPii: false,
    beforeSend: (event: ErrorEvent): ErrorEvent | null =>
      scrubEvent(event as unknown as Record<string, unknown>) as unknown as ErrorEvent | null,
    // Vercel sets this on every deployment; it is what makes a stack trace
    // resolvable against the source maps uploaded for that build.
    release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
  };
}
