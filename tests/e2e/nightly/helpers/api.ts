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
