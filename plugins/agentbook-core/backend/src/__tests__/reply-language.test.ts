import { describe, it, expect } from 'vitest';
import { detectMessageLanguage, resolveReplyLocale } from '../reply-language';

describe('detectMessageLanguage', () => {
  it('sees CJK', () => { expect(detectMessageLanguage('记录 42 元咖啡')).toBe('zh'); });
  it('sees French by stopwords or accents', () => {
    expect(detectMessageLanguage('Montre-moi mes dépenses du mois')).toBe('fr');
    expect(detectMessageLanguage('combien ai-je dépensé en repas')).toBe('fr');
  });
  it('sees English by stopwords', () => {
    expect(detectMessageLanguage('Categorize them')).toBe('en');
    expect(detectMessageLanguage('show my expenses this month')).toBe('en');
  });
  it('returns null when too short or ambiguous', () => {
    expect(detectMessageLanguage('yes')).toBeNull();
    expect(detectMessageLanguage('ok')).toBeNull();
    expect(detectMessageLanguage('$42 Starbucks')).toBeNull();
    expect(detectMessageLanguage('')).toBeNull();
  });
});

describe('resolveReplyLocale', () => {
  it('English on a fr-CA tenant → en-CA (English words, Canadian formatting)', () => {
    expect(resolveReplyLocale({ text: 'Categorize them', tenantLocale: 'fr-CA' })).toBe('en-CA');
  });
  it('French on a fr-CA tenant keeps fr-CA', () => {
    expect(resolveReplyLocale({ text: 'Catégorise-les', tenantLocale: 'fr-CA' })).toBe('fr-CA');
  });
  it('French on an en-US tenant → fr-CA (the only French catalog)', () => {
    expect(resolveReplyLocale({ text: 'Montre mes dépenses', tenantLocale: 'en-US' })).toBe('fr-CA');
  });
  it('Chinese anywhere → zh-CN', () => {
    expect(resolveReplyLocale({ text: '记录 42 元咖啡', tenantLocale: 'en-AU' })).toBe('zh-CN');
  });
  it('a short turn continues the language of the MOST RECENT detectable user turn (array is newest-first)', () => {
    expect(resolveReplyLocale({ text: 'yes', previousUserTexts: ['ok', 'Categorize them'], tenantLocale: 'fr-CA' })).toBe('en-CA');
    expect(resolveReplyLocale({ text: 'oui', previousUserTexts: ['Montre mes dépenses'], tenantLocale: 'en-US' })).toBe('fr-CA');
    // thread switched en → fr; the newest wins, not the oldest
    expect(resolveReplyLocale({ text: 'ok', previousUserTexts: ['Montre mes dépenses', 'show my expenses'], tenantLocale: 'en-US' })).toBe('fr-CA');
  });
  it('falls back to the tenant locale, then en-US', () => {
    expect(resolveReplyLocale({ text: 'yes', tenantLocale: 'fr-CA' })).toBe('fr-CA');
    expect(resolveReplyLocale({ text: 'yes', tenantLocale: null })).toBe('en-US');
  });
  it('English keeps the tenant region for AU/GB/US', () => {
    expect(resolveReplyLocale({ text: 'show my expenses', tenantLocale: 'en-AU' })).toBe('en-AU');
    expect(resolveReplyLocale({ text: 'show my expenses', tenantLocale: 'zh-CN' })).toBe('en-US');
  });
});
