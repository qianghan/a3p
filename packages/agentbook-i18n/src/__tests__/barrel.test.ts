import { describe, it, expect } from 'vitest';
import { parseAmountToCents, parseDateInput, formatDate, formatMoney } from '../index.js';

describe('public barrel exports', () => {
  it('exposes parsing alongside formatting, so callers cannot get one without the other', () => {
    expect(typeof parseAmountToCents).toBe('function');
    expect(typeof parseDateInput).toBe('function');
    expect(typeof formatDate).toBe('function');
    expect(typeof formatMoney).toBe('function');
  });

  it('round-trips fr-CA money through the public surface', () => {
    const rendered = formatMoney(4550, 'CAD');
    expect(parseAmountToCents(rendered, 'fr-CA').cents).toBe(4550);
    // The bug this pairing prevents.
    expect(parseAmountToCents('45,50', 'fr-CA').cents).toBe(4550);
  });

  it('date-only formatting does not shift the day via the public surface', () => {
    expect(formatDate('2026-03-22', 'en-US')).toMatch(/22/);
  });
});

describe('the main barrel must stay catalog-free', () => {
  it('does not export the catalog from @agentbook/i18n', async () => {
    // This is the invariant behind the entry-point split. All six plugin
    // frontends import formatMoney from the main barrel; when CATALOG lived
    // there too, every plugin bundle inlined all three locale packs — +18.8 KB
    // per bundle, ~113 KB duplicated across six CDN bundles, which defeated the
    // shared-translator architecture entirely.
    const barrel = await import('../index.js');
    for (const name of [
      'CATALOG',
      'AVAILABLE_LOCALES',
      'LOCALE_STATUS',
      'TRANSLATED_LOCALES',
      'SCAFFOLD_LOCALES',
      'NAMESPACES',
      'offerableLocales',
    ]) {
      expect(name in barrel, `'${name}' must NOT be exported from the main barrel`).toBe(false);
    }
  });

  it('still exports the functions plugins need', async () => {
    const barrel = await import('../index.js');
    for (const name of [
      'formatMoney', 'formatCurrency', 'formatDate', 'formatNumber', 'formatPercent',
      'parseAmountToCents', 'parseDateInput',
      'createTranslator', 'resolveLocale',
      'isSelectableLocale', 'canonicalizeLocale',
    ]) {
      expect(typeof (barrel as Record<string, unknown>)[name], name).toBe('function');
    }
  });

  it('exposes the catalog only via the catalog entry point', async () => {
    const cat = await import('../catalog-entry.js');
    expect(cat.CATALOG).toBeTypeOf('object');
    expect(cat.AVAILABLE_LOCALES).toEqual(['en', 'fr-CA', 'zh-CN']);
    expect(typeof cat.offerableLocales).toBe('function');
  });
});
