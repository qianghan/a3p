/**
 * Shared gateway fetch helper for provider adapters.
 * In both local dev and Vercel, gateway routes are same-origin Next.js handlers,
 * so we use the app's own URL (localhost:3000 in dev, VERCEL_URL in prod).
 */

function getGatewayBase(): string {
  if (process.env.VERCEL_URL) {
    const proto = process.env.VERCEL_URL.startsWith('localhost') ? 'http' : 'https';
    return `${proto}://${process.env.VERCEL_URL}`;
  }
  return process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
}

export function createGwFetch(connectorSlug: string) {
  return async function gwFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const base = getGatewayBase();
    const url = `${base}/api/v1/gw/${connectorSlug}${path}`;
    return fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });
  };
}
