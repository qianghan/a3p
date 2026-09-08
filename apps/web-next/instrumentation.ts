/**
 * Next's server bootstrap hook — where Sentry actually starts.
 *
 * `register()` runs once per runtime before any route module is evaluated,
 * which is the only point early enough to capture a failure during module
 * initialisation. The runtime split matters: the edge runtime cannot load the
 * Node transport, so each side imports its own config.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');
  }
  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

/**
 * Errors Next catches itself — thrown in a server component, a route handler,
 * or during streaming — never reach our own try/catch, so without this hook
 * they are invisible to the error tracker no matter how well `reportError` is
 * wired. This is the difference between "we log the errors we remembered to
 * catch" and "we see the errors".
 */
export async function onRequestError(
  ...args: Parameters<typeof import('@sentry/nextjs').captureRequestError>
) {
  if (!process.env.SENTRY_DSN) return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(...args);
}
