import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';

/**
 * The PWA's keys are `mobile.<screen>.<name>` — three segments, nested JSON.
 * i18n-shell-wiring.test.ts only scrapes TWO-segment `t('ns.key')` calls and
 * i18n-french-quality.test.ts only reads top-level strings, so a typo'd or
 * untranslated PWA key passed every guard and rendered as a humanised English
 * fallback on a French phone. This file is the guard for app/app/**.
 */
const APP_DIR = join(__dirname, '..', '..', 'app', 'app');
const LOCALES = ['en', 'fr-CA', 'zh-CN'] as const;
// PR 5 (Task 5.5) appends 'capture'.
const SCREENS_OWNED_HERE = ['docs'] as const;
// Raised to 50 in Task 4.7 once the Docs screens exist; 0 here so this task's
// commit does not depend on how many keys PR 2/3 happen to use.
const MIN_KEYS_IN_CODE = 0;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e) && !e.includes('.test.')) out.push(p);
  }
  return out;
}

// Any quoted mobile key literal — catches t('…') calls AND keys held in maps
// (e.g. FILTER_LABEL_KEY) or returned from helpers (edit-form error keys).
const KEY_LITERAL = /'(mobile\.[a-z0-9_]+\.[a-z0-9_]+)'/g;

function flatten(tree: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!tree || typeof tree !== 'object') return out;
  for (const [k, v] of Object.entries(tree as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else for (const [ik, iv] of flatten(v, key)) out.set(ik, iv);
  }
  return out;
}

function screenKeys(locale: string, screen: string): Map<string, string> {
  const ns = (CATALOG[locale] as Record<string, unknown> | undefined)?.mobile as Record<string, unknown> | undefined;
  return flatten(ns?.[screen], `mobile.${screen}`);
}

const keysInCode = [...new Set(
  sourceFiles(APP_DIR).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(KEY_LITERAL)].map((m) => m[1])),
)].sort();

describe('every mobile.* key the PWA source names resolves', () => {
  it('scanned a real tree', () => {
    expect(keysInCode.length, 'no mobile.* keys scraped — did the key shape change?').toBeGreaterThanOrEqual(MIN_KEYS_IN_CODE);
  });

  it.each(LOCALES)('%s resolves all of them', (locale) => {
    const tr = createTranslator(locale, CATALOG);
    // Plural keys are stored as `<name>_one` / `<name>_other` (e.g. mobile.tabs.docs_review),
    // so they only resolve when a `count` is supplied.
    const missing = keysInCode.filter((k) => {
      const v = tr.t(k, { count: 1 });
      return v === k || v.trim() === '';
    });
    expect(missing, `${locale}: unresolved -> ${missing.join(', ')}`).toEqual([]);
  });
});

describe.each(SCREENS_OWNED_HERE)('mobile.%s subtree', (screen) => {
  const en = screenKeys('en', screen);

  it('exists in en', () => {
    expect(en.size).toBeGreaterThan(10);
  });

  it.each(['fr-CA', 'zh-CN'])('%s has exactly the en keys (no fallback-to-English)', (locale) => {
    const other = screenKeys(locale, screen);
    expect([...other.keys()].sort()).toEqual([...en.keys()].sort());
  });

  it.each(['fr-CA', 'zh-CN'])('%s keeps every {placeholder}', (locale) => {
    const other = screenKeys(locale, screen);
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
    const broken = [...en.entries()].filter(([k, v]) => names(v) !== names(other.get(k) ?? '')).map(([k]) => k);
    expect(broken).toEqual([]);
  });

  it.each(['fr-CA', 'zh-CN'])('%s values are translated, not copied', (locale) => {
    const other = screenKeys(locale, screen);
    const same = [...en.entries()].filter(([k, v]) => other.get(k) === v).map(([k]) => k);
    expect(same).toEqual([]);
  });

  it('zh-CN values contain CJK', () => {
    const zh = screenKeys('zh-CN', screen);
    const latinOnly = [...zh.entries()].filter(([, v]) => !/[㐀-鿿]/.test(v)).map(([k]) => k);
    expect(latinOnly).toEqual([]);
  });

  it('fr-CA never strips accents from common words', () => {
    const fr = screenKeys('fr-CA', screen);
    const stripped = /(?<![a-zàâçéèêëîïôöùûüÿ])(depense|depenses|recu|recus|categorie|categories|reessayer|enregistre|apercu|etes)(?![a-zàâçéèêëîïôöùûüÿ])/;
    const bad = [...fr.entries()].filter(([, v]) => stripped.test(v.toLowerCase())).map(([k]) => k);
    expect(bad).toEqual([]);
  });
});
