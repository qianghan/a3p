/**
 * /app i18n completeness — what mobile-app-hygiene.test.ts does NOT cover.
 *
 * Already covered there (not re-implemented): hardcoded English in JSX text,
 * attributes, object copy and toast/error calls (AST-based), literal t() keys,
 * and every mobile.* key (any depth) existing in each locale's OWN catalog.
 *
 * Added here:
 *   1. Every mobile.* leaf in fr-CA / zh-CN is actually translated, i.e. not
 *      byte-identical to English (a copy-pasted English value satisfies the
 *      presence check and still shows English to Maya).
 *   2. fr-CA mobile strings use U+2019, never a straight apostrophe.
 *   3. Shell components rendered inside /app (LanguageSwitcher) are localized.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { flattenKeys } from './helpers/mobile-hygiene';

const SRC = join(__dirname, '..', '..');
/** mobile.* leaves whose translation legitimately equals English. */
const IDENTICAL_OK = new Set<string>([]);

type Cat = Record<string, unknown>;
const leaf = (cat: Cat, key: string): string | undefined =>
  key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Cat)[k] : undefined), cat) as string | undefined;

/** Keys in `locale` whose value is missing/blank or identical to English. */
export function untranslated(catalog: Record<string, Cat>, locale: string, keys: string[], ok: Set<string>): string[] {
  return keys.filter((k) => {
    if (ok.has(k)) return false;
    const v = leaf(catalog[locale], k);
    return !v || v.trim() === '' || v === leaf(catalog.en, k);
  });
}

/** Values containing a straight apostrophe between letters (should be U+2019 in fr-CA). */
export function straightApostrophes(catalog: Record<string, Cat>, locale: string, keys: string[]): string[] {
  return keys.filter((k) => /\p{L}'\p{L}/u.test(leaf(catalog[locale], k) ?? ''));
}

const MOBILE_KEYS = flattenKeys((CATALOG.en as Cat).mobile, 'mobile').sort();

describe('the catalog checks can fail', () => {
  const cat = {
    en: { mobile: { a: { x: 'Save', y: 'Close' } } },
    'fr-CA': { mobile: { a: { x: 'Save', y: "L'accueil" } } },
  } as unknown as Record<string, Cat>;
  const keys = ['mobile.a.x', 'mobile.a.y', 'mobile.a.z'];
  it('flags identical-to-English and missing values, honours the allow-list', () => {
    expect(untranslated(cat, 'fr-CA', keys, new Set())).toEqual(['mobile.a.x', 'mobile.a.z']);
    expect(untranslated(cat, 'fr-CA', keys, new Set(['mobile.a.x']))).toEqual(['mobile.a.z']);
  });
  it('flags straight apostrophes only between letters', () => {
    expect(straightApostrophes(cat, 'fr-CA', keys)).toEqual(['mobile.a.y']);
    const ok = { 'fr-CA': { mobile: { a: { y: 'L’accueil', z: "'quoted'" } } } } as unknown as Record<string, Cat>;
    expect(straightApostrophes(ok, 'fr-CA', ['mobile.a.y', 'mobile.a.z'])).toEqual([]);
  });
});

describe('mobile.* catalog completeness (three-segment keys included)', () => {
  it('found a meaningful number of keys', () => {
    expect(MOBILE_KEYS.length).toBeGreaterThanOrEqual(80);
    expect(MOBILE_KEYS.filter((k) => k.split('.').length === 3).length).toBeGreaterThanOrEqual(80);
  });
  it.each(['fr-CA', 'zh-CN'])('%s: every mobile.* value is translated, not copied English', (locale) => {
    expect(untranslated(CATALOG as Record<string, Cat>, locale, MOBILE_KEYS, IDENTICAL_OK)).toEqual([]);
  });
  it('fr-CA uses typographic apostrophes (U+2019)', () => {
    expect(straightApostrophes(CATALOG as Record<string, Cat>, 'fr-CA', MOBILE_KEYS)).toEqual([]);
  });
});

describe('shell components rendered inside /app are localized', () => {
  it('LanguageSwitcher no longer hardcodes its error line', () => {
    const src = readFileSync(join(SRC, 'components', 'layout', 'language-switcher.tsx'), 'utf8');
    expect(src).not.toContain('Could not change language. Please try again.');
    expect(src).toContain("t('common.change_language_failed')");
  });
  it.each(['en', 'fr-CA', 'zh-CN'])('%s has common.change_language_failed', (locale) => {
    expect(leaf(CATALOG[locale] as Cat, 'common.change_language_failed')).toBeTruthy();
  });
});
