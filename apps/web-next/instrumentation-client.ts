/**
 * Browser Sentry init.
 *
 * Before this there was no browser error capture at all: a React render
 * error, a failed fetch in a plugin page or a TypeError in the chat widget
 * left no trace anywhere. Server logs cannot see any of it.
 *
 * TWO THINGS ARE DELIBERATE HERE
 *
 * 1. The SDK is imported dynamically, inside the DSN check. A static import
 *    would put ~35 kB gzip of Sentry in the chunk shared by all 598 routes,
 *    against a 115 kB budget currently sitting at 103 kB — `bin/perf-budget.mjs`
 *    would fail the build, correctly. Behind a dynamic import it is its own
 *    async chunk, fetched only where it is configured.
 *
 * 2. The DSN is read from NEXT_PUBLIC_SENTRY_DSN, not SENTRY_DSN. Server env
 *    is not available in the browser, and a browser DSN is a public,
 *    write-only ingest key by design — it is not the server secret and must
 *    not be set to it.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void (async () => {
    try {
      const [Sentry, { baseSentryOptions }] = await Promise.all([
        import('@sentry/nextjs'),
        import('@/lib/observability/sentry-options'),
      ]);
      Sentry.init({
        ...baseSentryOptions(dsn, process.env.NEXT_PUBLIC_VERCEL_ENV || 'development'),
        // Session replay and browser tracing are additional payload and
        // additional PII surface on a product showing people their bank
        // transactions. Errors only until someone asks for more.
        integrations: [],
      });
    } catch {
      // Error reporting failing must never break the page it was watching.
    }
  })();
}

/**
 * Router transition instrumentation. Exported unconditionally because Next
 * expects the symbol; it does nothing when the SDK never initialised.
 */
export const onRouterTransitionStart = () => {};
