import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES_DIR = join(__dirname, '..', '..', '..', 'packages', 'agentbook-i18n', 'src', 'locales');

/** Flattened `mobile.*` catalog values for a locale, optionally filtered by key prefix. */
export function catalogValues(locale: string, prefix = 'mobile.'): Record<string, string> {
  const json = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'mobile.json'), 'utf8')) as Record<string, unknown>;
  const out: Record<string, string> = {};
  const walk = (o: Record<string, unknown>, p: string) => {
    for (const [k, v] of Object.entries(o)) {
      const key = `${p}.${k}`;
      if (typeof v === 'string') out[key] = v;
      else if (v && typeof v === 'object') walk(v as Record<string, unknown>, key);
    }
  };
  walk(json, 'mobile');
  return Object.fromEntries(Object.entries(out).filter(([k]) => k.startsWith(prefix)));
}

/** A `common.*` catalog value (e.g. the language switcher's accessible name). */
export function commonValue(locale: string, key: string): string {
  const json = JSON.parse(readFileSync(join(LOCALES_DIR, locale, 'common.json'), 'utf8')) as Record<string, string>;
  const v = json[key];
  if (typeof v !== 'string') throw new Error(`common.${key} missing in ${locale}`);
  return v;
}

/**
 * Render the real app in `locale` WITHOUT touching production state: the one
 * tenant-config GET is rewritten (flag on + locale) and the switcher's PUT is
 * answered locally, so a locale-changing PUT never reaches the server.
 * Requires serviceWorkers: 'block' (page.route cannot see SW-handled requests).
 */
export async function forceLocale(page: Page, initial: string): Promise<{ current: () => string }> {
  let locale = initial;
  await page.route('**/api/v1/agentbook-core/tenant-config', async (route) => {
    const req = route.request();
    if (req.method() === 'PUT') {
      try {
        const b = JSON.parse(req.postData() ?? '{}') as { locale?: unknown };
        if (typeof b.locale === 'string') locale = b.locale;
      } catch { /* keep current */ }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { locale } }) });
    }
    if (req.method() !== 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { locale } }) });
    const res = await route.fetch();
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    json.i18nLocalesEnabled = true;
    json.data = { ...((json.data as Record<string, unknown>) ?? {}), locale };
    return route.fulfill({ response: res, json });
  });
  return { current: () => locale };
}
