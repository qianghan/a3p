import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export interface ApiClient {
  get<T = any>(path: string): Promise<{ status: number; data: T }>;
  post<T = any>(path: string, body?: any): Promise<{ status: number; data: T }>;
  put<T = any>(path: string, body?: any): Promise<{ status: number; data: T }>;
  patch<T = any>(path: string, body?: any): Promise<{ status: number; data: T }>;
  delete<T = any>(path: string): Promise<{ status: number; data: T }>;
}

/**
 * Authenticated API client for the logged-in page. Call after loginAsE2eUser(page).
 *
 * Uses an IN-PAGE fetch (page.evaluate) rather than page.request. The session
 * cookie is httpOnly, and Playwright's APIRequestContext was not carrying it —
 * every api() call came back 401, which silently failed ~90 of the 95 nightly
 * tests once the suite could actually reach the site. A fetch issued from the
 * page's own document sends the cookie exactly as the real app does, so these
 * tests now exercise the same auth path a user does.
 */
export function api(page: Page): ApiClient {
  async function call<T>(method: string, path: string, body?: any) {
    return (await page.evaluate(
      async ({ method, path, body }: { method: string; path: string; body: string | null }) => {
        const res = await fetch(path, {
          method,
          credentials: 'include',
          headers: body ? { 'Content-Type': 'application/json' } : {},
          body: body ?? undefined,
        });
        let data: any = null;
        try { data = await res.json(); } catch { /* non-JSON responses */ }
        return { status: res.status, data };
      },
      { method, path, body: body === undefined || body === null ? null : JSON.stringify(body) },
    )) as { status: number; data: T };
  }
  return {
    get:    (p)    => call('GET',    p),
    post:   (p, b) => call('POST',   p, b),
    put:    (p, b) => call('PUT',    p, b),
    patch:  (p, b) => call('PATCH',  p, b),
    delete: (p)    => call('DELETE', p),
  };
}

/**
 * Assert a request actually succeeded.
 *
 * Replaces `expect(status).toBeLessThan(500)`, which 27 tests used and which
 * passes on 401, 403 and 404. That is how a whole family of tests kept "passing"
 * against endpoints that do not exist in production: the [plugin]/[...path]
 * catch-all answers 501 for unimplemented plugin routes, and every 4xx sailed
 * through. A smoke test that cannot tell "works" from "not found" is not a test.
 *
 * Takes the whole response so the failure message can carry the server's own
 * error text instead of a bare number.
 */
export function expectOk(
  res: { status: number; data?: any },
  what: string,
): void {
  const detail = res.data?.error ?? res.data?.message ?? '';
  expect(
    res.status,
    `${what} returned ${res.status}${detail ? ` — ${detail}` : ''}. ` +
    `Expected 2xx. A 501 means the path is not served in production and falls through ` +
    `to the [plugin]/[...path] catch-all; a 404/400 means the path or payload is wrong.`,
  ).toBeGreaterThanOrEqual(200);
  expect(res.status, `${what} returned ${res.status}, expected 2xx`).toBeLessThan(300);
}
