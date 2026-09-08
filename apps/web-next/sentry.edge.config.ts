/**
 * Edge-runtime Sentry init (middleware and any edge route).
 *
 * Separate from the server config because the edge runtime has no Node
 * built-ins, so the SDK ships a different transport. Same options, same
 * scrubber — see sentry.server.config.ts for why this file exists at all.
 */
import * as Sentry from '@sentry/nextjs';
import { baseSentryOptions } from '@/lib/observability/sentry-options';

if (process.env.SENTRY_DSN) {
  Sentry.init({
    ...baseSentryOptions(
      process.env.SENTRY_DSN,
      process.env.VERCEL_ENV || process.env.NODE_ENV || 'development',
    ),
  });
}
