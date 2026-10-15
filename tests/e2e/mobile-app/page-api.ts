import type { Page } from '@playwright/test';

/**
 * Same-origin fetch from inside the page, so the httpOnly session cookie travels.
 * (page.request has not carried it reliably against prod; see project memory.)
 */
export async function inPageFetch<T = unknown>(
  page: Page,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null }> {
  return page.evaluate(
    async ({ m, p, b }) => {
      const r = await fetch(p, {
        method: m,
        credentials: 'include',
        headers: b === undefined ? undefined : { 'content-type': 'application/json' },
        body: b === undefined ? undefined : JSON.stringify(b),
      });
      let data: unknown = null;
      try { data = await r.json(); } catch { data = null; }
      return { status: r.status, data };
    },
    { m: method, p: path, b: body },
  ) as Promise<{ status: number; data: T | null }>;
}
