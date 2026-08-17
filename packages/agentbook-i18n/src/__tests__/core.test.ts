import { describe, it, expect } from 'vitest';
import { createTranslator, resolveLocale, type Catalog } from '../core.js';

/**
 * Note the absence of beforeEach() resetting shared state. There is no shared
 * state to reset — that is the point of createTranslator. The old suite needed
 * a reset hook, and that hook is precisely what hid the concurrency bug:
 * serialised tests never interleave, so the leak never showed.
 */

const CATALOG: Catalog = {
  en: {
    greeting: 'Hello',
    welcome: 'Welcome, {name}!',
    invoice_total: 'Total: {amount} ({count} items)',
    expense: {
      receipt_saved: 'Receipt saved for {amount}',
      category: 'Category',
    },
    // Plural variants
    expense_count_one: '{count} expense',
    expense_count_other: '{count} expenses',
  },
  'fr-CA': {
    greeting: 'Bonjour',
    welcome: 'Bienvenue, {name} !',
    expense: {
      receipt_saved: 'Reçu enregistré pour {amount}',
      category: 'Catégorie',
    },
    expense_count_one: '{count} dépense',
    expense_count_other: '{count} dépenses',
  },
  'zh-CN': {
    greeting: '你好',
    expense_count_other: '{count} 笔支出',
  },
};

describe('createTranslator', () => {
  it('translates a flat key in the bound locale', () => {
    expect(createTranslator('fr-CA', CATALOG).t('greeting')).toBe('Bonjour');
  });

  it('translates a nested dot-notated key', () => {
    expect(createTranslator('fr-CA', CATALOG).t('expense.category')).toBe('Catégorie');
  });

  it('exposes the bound locale', () => {
    expect(createTranslator('zh-CN', CATALOG).locale).toBe('zh-CN');
  });

  it('interpolates named params', () => {
    expect(createTranslator('en', CATALOG).t('welcome', { name: 'Maya' })).toBe('Welcome, Maya!');
  });

  it('renders a missing param as the literal placeholder, not an empty string', () => {
    // A visible {name} is easier to catch in review than a silent blank.
    expect(createTranslator('en', CATALOG).t('welcome')).toBe('Welcome, {name}!');
    expect(createTranslator('en', CATALOG).t('welcome', { other: 'x' })).toBe('Welcome, {name}!');
  });

  it('coerces numeric params to strings', () => {
    expect(createTranslator('en', CATALOG).t('invoice_total', { amount: '$10', count: 3 }))
      .toBe('Total: $10 (3 items)');
  });

  describe('fallback chain', () => {
    it('falls back to English when the locale lacks the key', () => {
      // 'invoice_total' exists only in en.
      expect(createTranslator('fr-CA', CATALOG).t('invoice_total', { amount: '5 $', count: 1 }))
        .toBe('Total: 5 $ (1 items)');
    });

    it('falls back to the base language for a regional tag', () => {
      // 'en-US' is not a catalog key; 'en' is.
      expect(createTranslator('en-US', CATALOG).t('greeting')).toBe('Hello');
    });

    it('falls back to English for an entirely unsupported locale', () => {
      expect(createTranslator('de-DE', CATALOG).t('greeting')).toBe('Hello');
    });

    it('returns the key itself when nothing resolves', () => {
      // Visible miss beats a silent empty string.
      expect(createTranslator('en', CATALOG).t('does.not.exist')).toBe('does.not.exist');
    });

    it('returns the key when a path resolves to an object rather than a string', () => {
      expect(createTranslator('en', CATALOG).t('expense')).toBe('expense');
    });
  });

  describe('pluralization', () => {
    it('selects the English singular and plural', () => {
      const { t } = createTranslator('en', CATALOG);
      expect(t('expense_count', { count: 1 })).toBe('1 expense');
      expect(t('expense_count', { count: 3 })).toBe('3 expenses');
    });

    it('applies French rules, where 0 is singular', () => {
      // This is the whole reason plurals are not deferrable: French and
      // English disagree at zero, so a count-bearing string without variants
      // is wrong in French from day one.
      const { t } = createTranslator('fr-CA', CATALOG);
      expect(t('expense_count', { count: 0 })).toBe('0 dépense');
      expect(t('expense_count', { count: 1 })).toBe('1 dépense');
      expect(t('expense_count', { count: 2 })).toBe('2 dépenses');
    });

    it('handles zh-CN, which has a single form', () => {
      const { t } = createTranslator('zh-CN', CATALOG);
      expect(t('expense_count', { count: 1 })).toBe('1 笔支出');
      expect(t('expense_count', { count: 5 })).toBe('5 笔支出');
    });

    it('ignores plural selection when count is absent', () => {
      expect(createTranslator('en', CATALOG).t('greeting')).toBe('Hello');
    });
  });
});

describe('concurrency — the regression this rewrite exists to prevent', () => {
  it('serves each interleaved request its OWN locale', async () => {
    // This exact scenario failed against the previous module-global
    // implementation: request B's locale overwrote the shared variable while
    // request A was awaiting, so the French user was served English.
    const results: Record<string, string> = {};

    const requestA = async () => {
      const { t } = createTranslator('fr-CA', CATALOG);
      await Promise.resolve();
      results.a = t('greeting');
    };
    const requestB = async () => {
      const { t } = createTranslator('en', CATALOG);
      await Promise.resolve();
      results.b = t('greeting');
    };
    const requestC = async () => {
      const { t } = createTranslator('zh-CN', CATALOG);
      await Promise.resolve();
      results.c = t('greeting');
    };

    await Promise.all([requestA(), requestB(), requestC()]);

    expect(results.a).toBe('Bonjour');
    expect(results.b).toBe('Hello');
    expect(results.c).toBe('你好');
  });

  it('keeps translators independent under heavy interleaving', async () => {
    const locales = ['en', 'fr-CA', 'zh-CN'];
    const expected = { en: 'Hello', 'fr-CA': 'Bonjour', 'zh-CN': '你好' } as const;

    const jobs = Array.from({ length: 60 }, (_, i) => {
      const loc = locales[i % 3] as keyof typeof expected;
      return (async () => {
        const { t } = createTranslator(loc, CATALOG);
        // Yield a variable number of times to force real interleaving.
        for (let n = 0; n <= i % 5; n++) await Promise.resolve();
        return t('greeting') === expected[loc];
      })();
    });

    expect((await Promise.all(jobs)).every(Boolean)).toBe(true);
  });

  it('does not export an ambient locale setter', async () => {
    // Guards against a well-meaning future PR reintroducing the global.
    const mod = await import('../core.js');
    expect('setLocale' in mod).toBe(false);
    expect('getLocale' in mod).toBe(false);
  });
});

describe('resolveLocale', () => {
  const AVAILABLE = ['en', 'fr-CA', 'zh-CN'];

  it('prefers tenant config over every other signal', () => {
    expect(resolveLocale(
      { tenantLocale: 'zh-CN', acceptLanguage: 'fr-CA,fr;q=0.9', telegramLanguageCode: 'fr' },
      AVAILABLE,
    )).toBe('zh-CN');
  });

  it('accepts the en-US value every existing AbTenantConfig row stores', () => {
    // Regression guard: a narrower whitelist would reject live rows. This
    // exact shape already shipped as a hotfix on businessType.
    expect(resolveLocale({ tenantLocale: 'en-US' }, AVAILABLE)).toBe('en');
  });

  it('maps a bare language onto its regional catalog entry', () => {
    expect(resolveLocale({ tenantLocale: 'fr' }, AVAILABLE)).toBe('fr-CA');
  });

  it('matches locale tags case-insensitively', () => {
    expect(resolveLocale({ tenantLocale: 'zh-cn' }, AVAILABLE)).toBe('zh-CN');
  });

  it('falls back to Accept-Language when tenant config is unset', () => {
    expect(resolveLocale({ tenantLocale: null, acceptLanguage: 'fr-CA,en;q=0.8' }, AVAILABLE))
      .toBe('fr-CA');
  });

  it('honours q-weights rather than header order', () => {
    expect(resolveLocale({ acceptLanguage: 'en;q=0.3,zh-CN;q=0.9' }, AVAILABLE)).toBe('zh-CN');
  });

  it('skips unsupported languages in Accept-Language', () => {
    expect(resolveLocale({ acceptLanguage: 'de-DE,de;q=0.9,zh-CN;q=0.5' }, AVAILABLE)).toBe('zh-CN');
  });

  it('ignores the wildcard tag', () => {
    expect(resolveLocale({ acceptLanguage: '*' }, AVAILABLE)).toBe('en');
  });

  it('uses the Telegram language_code when there is no header', () => {
    // Telegram supplies language_code and no Accept-Language at all.
    expect(resolveLocale({ telegramLanguageCode: 'zh' }, AVAILABLE)).toBe('zh-CN');
  });

  it('falls back to English when no signal matches', () => {
    expect(resolveLocale({ tenantLocale: 'de', acceptLanguage: 'de-DE' }, AVAILABLE)).toBe('en');
  });

  it('falls back to English on empty input rather than throwing', () => {
    expect(resolveLocale({}, AVAILABLE)).toBe('en');
    expect(resolveLocale({ tenantLocale: null, acceptLanguage: null }, AVAILABLE)).toBe('en');
  });

  it('never throws on a malformed Accept-Language header', () => {
    expect(() => resolveLocale({ acceptLanguage: ';;;q=,,' }, AVAILABLE)).not.toThrow();
    expect(resolveLocale({ acceptLanguage: ';;;q=,,' }, AVAILABLE)).toBe('en');
  });
});
