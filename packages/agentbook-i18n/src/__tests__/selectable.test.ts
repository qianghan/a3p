import { describe, it, expect } from 'vitest';
import {
  SELECTABLE_LOCALES,
  SELECTABLE_LOCALE_VALUES,
  isSelectableLocale,
  canonicalizeLocale,
} from '../selectable.js';
import { resolveLocale } from '../core.js';
import { AVAILABLE_LOCALES } from '../catalog.js';

describe('selectable locales', () => {
  it('offers exactly the three supported languages', () => {
    expect(SELECTABLE_LOCALE_VALUES).toEqual(['en-US', 'fr-CA', 'zh-CN']);
  });

  it('gives every option a native-language label', () => {
    // A language picker that lists "Chinese (Simplified)" in English is not
    // much use to someone who cannot read the English label.
    for (const l of SELECTABLE_LOCALES) {
      expect(l.label.trim()).not.toBe('');
      expect(l.englishLabel.trim()).not.toBe('');
    }
    expect(SELECTABLE_LOCALES.find((l) => l.value === 'zh-CN')?.label).toBe('简体中文');
    expect(SELECTABLE_LOCALES.find((l) => l.value === 'fr-CA')?.label).toBe('Français (Canada)');
  });
});

describe('isSelectableLocale', () => {
  it('accepts every offered value', () => {
    for (const v of SELECTABLE_LOCALE_VALUES) expect(isSelectableLocale(v)).toBe(true);
  });

  it('accepts en-US, which every existing row already stores', () => {
    // The column default is 'en-US'. A whitelist that rejected it would break
    // the settings page for every tenant in the database — the same failure
    // that previously shipped as a hotfix on businessType.
    expect(isSelectableLocale('en-US')).toBe(true);
  });

  it('accepts known legacy values not offered in the picker', () => {
    for (const v of ['en', 'en-CA', 'en-AU', 'en-GB', 'fr']) {
      expect(isSelectableLocale(v), v).toBe(true);
    }
  });

  it('is case-insensitive', () => {
    expect(isSelectableLocale('ZH-CN')).toBe(true);
    expect(isSelectableLocale('fr-ca')).toBe(true);
  });

  it('rejects unsupported languages', () => {
    for (const v of ['de-DE', 'ja', 'es', 'pt-BR']) {
      expect(isSelectableLocale(v), v).toBe(false);
    }
  });

  it('rejects junk and non-strings without throwing', () => {
    for (const v of ['', '   ', 'not-a-locale', '../../etc/passwd', '<script>', null, undefined, 42, {}, []]) {
      expect(isSelectableLocale(v as unknown), JSON.stringify(v)).toBe(false);
    }
  });
});

describe('canonicalizeLocale', () => {
  it('normalises case to the stored form', () => {
    expect(canonicalizeLocale('ZH-cn')).toBe('zh-CN');
    expect(canonicalizeLocale('FR-CA')).toBe('fr-CA');
    expect(canonicalizeLocale('en-us')).toBe('en-US');
  });

  it('trims surrounding whitespace', () => {
    expect(canonicalizeLocale('  fr-CA  ')).toBe('fr-CA');
  });
});

describe('selectable values resolve to a real catalog locale', () => {
  it('every selectable value maps onto a catalog entry', () => {
    // The contract that ties the two lists together: whatever a tenant can
    // store must resolve to a locale the catalog can actually serve.
    // 'en-US' is selectable but is NOT a catalog key — it must fall back to 'en'.
    for (const v of SELECTABLE_LOCALE_VALUES) {
      const resolved = resolveLocale({ tenantLocale: v }, [...AVAILABLE_LOCALES]);
      expect(AVAILABLE_LOCALES, `${v} resolved to ${resolved}`).toContain(resolved);
    }
  });

  it('resolves en-US to the en catalog rather than falling through to default', () => {
    expect(resolveLocale({ tenantLocale: 'en-US' }, [...AVAILABLE_LOCALES])).toBe('en');
  });

  it('resolves every legacy value to a servable catalog locale', () => {
    for (const v of ['en', 'en-CA', 'en-AU', 'en-GB', 'fr']) {
      const resolved = resolveLocale({ tenantLocale: v }, [...AVAILABLE_LOCALES]);
      expect(AVAILABLE_LOCALES, `${v} -> ${resolved}`).toContain(resolved);
    }
    // Legacy bare 'fr' should land on Canadian French, not English.
    expect(resolveLocale({ tenantLocale: 'fr' }, [...AVAILABLE_LOCALES])).toBe('fr-CA');
  });
});

describe('offerableLocales — only `ready` locales are offered', () => {
  it('offers all three now that zh-CN content has landed', async () => {
    // This test previously asserted zh-CN was NOT offered, because its catalog
    // was `scaffold` (English placeholders). It was written to fail the day
    // that changed rather than silently keep passing — which is exactly what
    // happened when the Chinese content landed.
    const { offerableLocales } = await import('../catalog-entry.js');
    const offered = offerableLocales().map((l) => l.value);
    expect(offered).toEqual(['en-US', 'fr-CA', 'zh-CN']);

    // The validator stays deliberately WIDER than the picker so a tenant on a
    // legacy value can still save their settings.
    expect(SELECTABLE_LOCALE_VALUES).toContain('zh-CN');
    expect(isSelectableLocale('zh-CN')).toBe(true);
  });

  it('would still hide a locale that went back to scaffold', async () => {
    // Keeps the gating logic itself covered now that no locale is scaffold —
    // otherwise this behaviour would be untested until the next new language.
    const { getOfferableLocales } = await import('../selectable.js');
    const offered = getOfferableLocales(
      { en: 'reference', 'fr-CA': 'ready', 'zh-CN': 'scaffold' },
      (v) => (v === 'en-US' ? 'en' : v),
    ).map((l) => l.value);
    expect(offered).toEqual(['en-US', 'fr-CA']);
  });

  it('grows automatically when a locale is marked ready', async () => {
    // The picker derives from LOCALE_STATUS rather than a second hand-kept
    // list, so flipping zh-CN to 'ready' is the only change needed to offer it.
    const { getOfferableLocales } = await import('../selectable.js');
    const asIfReady = getOfferableLocales(
      { en: 'reference', 'fr-CA': 'ready', 'zh-CN': 'ready' },
      (v) => (v === 'en-US' ? 'en' : v),
    ).map((l) => l.value);
    expect(asIfReady).toEqual(['en-US', 'fr-CA', 'zh-CN']);
  });
});
