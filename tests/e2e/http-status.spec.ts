/**
 * HTTP STATUS codes, not rendered pages.
 *
 * `apps/web-next` used to answer every unmatched path with `200 text/html`.
 * The `(dashboard)/[...slug]` catch-all was a client component: it matched any
 * path Next.js had no route for and only rendered a 404 screen once
 * JavaScript ran. A human saw "404". Every HTTP client saw success.
 *
 * That page is gone. Its two remaining real routes (`/billing`,
 * `/admin/billing`) now resolve through `PLUGIN_ROUTE_MAP` in `middleware.ts`,
 * the same rewrite `/forum` has always used, and everything else falls to
 * Next.js's own routing-layer 404.
 *
 * That broke a real client. The MCP OAuth flow asks for
 * `/.well-known/oauth-protected-resource/api/v1/mcp`, and the MCP SDK falls
 * back to the root metadata URL only on a 4xx — its `shouldAttemptFallback` is
 * `status >= 400 && status < 500`. A 200 meant "found it", so the SDK threw
 * parsing an HTML page as JSON, discovery ended, and the connector could not
 * be added at all (PR #556).
 *
 * So these assertions are deliberately about the response line and the
 * content-type. A test that navigated and looked for the text "404" would have
 * passed throughout the entire outage.
 *
 * Run against a production build (`next build && next start`) or a deployment:
 *   npx playwright test http-status.spec.ts
 *   PLAYWRIGHT_BASE_URL=https://agentbook.brainliber.com npx playwright test http-status.spec.ts
 */
import { test, expect, type APIRequestContext } from '@playwright/test';

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:3000';

/** GET without following redirects — a 307 to /login must not read as a 200. */
async function head(request: APIRequestContext, path: string) {
  const res = await request.get(`${BASE}${path}`, { maxRedirects: 0 });
  return { status: res.status(), contentType: res.headers()['content-type'] ?? '', res };
}

test.describe('unmatched paths return a genuine 404', () => {
  for (const path of [
    '/this-path-does-not-exist',
    '/random/deep/junk/path',
    // The reported symptom. No route serves it, so 404 is the right answer —
    // and a 404 is what lets a discovery client move on to its next candidate.
    '/.well-known/openid-configuration',
    // Shares a string prefix with the real `/billing` plugin route but is not
    // it. The middleware matches `path === prefix || path.startsWith(prefix + '/')`,
    // so a longer first segment is correctly not a match.
    '/billing-export',
  ]) {
    test(`GET ${path} -> 404`, async ({ request }) => {
      const { status, contentType } = await head(request, path);
      expect(status, `${path} must 404 at the HTTP level, not after hydration`).toBe(404);
      expect(contentType).toContain('text/html');
    });
  }
});

test.describe('the MCP discovery paths still answer with JSON', () => {
  // These carry a kill switch: when the MCP feature flag is off they return
  // 503 with a JSON body. Both 200 and 503 are the route handler working. What
  // must never happen again is the catch-all swallowing the path and replying
  // with an HTML page, which is what broke discovery.
  for (const path of [
    '/.well-known/oauth-protected-resource/api/v1/mcp',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
  ]) {
    test(`GET ${path} -> JSON, never HTML`, async ({ request }) => {
      const { status, contentType, res } = await head(request, path);
      expect(contentType, `${path} must be served by its route handler`).toContain(
        'application/json',
      );
      expect([200, 503]).toContain(status);
      // Parses as JSON — the exact failure mode in #556 was an SDK throwing
      // while parsing an HTML body it had been told was fine.
      expect(await res.json()).toBeTruthy();
    });
  }
});

test.describe('routes that must keep working', () => {
  test('GET /docs/<page> renders', async ({ request }) => {
    // /docs/[...slug] is a separate, more specific catch-all. The [...slug]
    // change must not reach it.
    const { status, contentType } = await head(request, '/docs/configure/business-profile');
    expect(status).toBe(200);
    expect(contentType).toContain('text/html');
  });

  for (const path of ['/billing', '/admin/billing']) {
    test(`GET ${path} still resolves`, async ({ request }) => {
      // Plugin routes with no dedicated page. Deleting the catch-all is
      // exactly the change that could strand them, so assert they did not
      // become 404s. Unauthenticated, middleware sends them to /login — a 307,
      // which is the rewrite path working, not a miss.
      const { status } = await head(request, path);
      expect(status, `${path} must not 404`).not.toBe(404);
      expect([200, 307]).toContain(status);
    });
  }

  test('GET /login renders', async ({ request }) => {
    const { status, contentType } = await head(request, '/login');
    expect(status).toBe(200);
    expect(contentType).toContain('text/html');
  });
});
