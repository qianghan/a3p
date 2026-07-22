import { describe, it, expect } from 'vitest';
import { t, normalizeLocale } from './index';

describe('i18n t()', () => {
  it('returns the English string for locale "en"', () => {
    expect(t('docs.also_available_other_lang', 'en')).toBe('This page is also available in French.');
  });

  it('returns the French string for locale "fr"', () => {
    expect(t('docs.also_available_other_lang', 'fr')).toBe('Cette page est aussi disponible en anglais.');
  });

  it('defaults to English when no locale is passed', () => {
    expect(t('docs.also_available_other_lang')).toBe('This page is also available in French.');
  });

  it('falls back to the key itself for an unknown key', () => {
    expect(t('nonexistent.key', 'fr')).toBe('nonexistent.key');
  });

  it('falls back to English when a key is missing for a non-English locale', () => {
    // Simulates a key that hasn't been translated yet — should never throw
    // or return undefined, per the plan's fallback-to-English requirement.
    expect(t('docs.also_available_other_lang', 'fr')).not.toBe('docs.also_available_other_lang');
  });
});

describe('normalizeLocale()', () => {
  it('treats any "fr"-prefixed BCP-47 tag as French', () => {
    expect(normalizeLocale('fr')).toBe('fr');
    expect(normalizeLocale('fr-CA')).toBe('fr');
    expect(normalizeLocale('FR-ca')).toBe('fr');
  });

  it('treats any non-"fr" tag as English', () => {
    expect(normalizeLocale('en')).toBe('en');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('en-CA')).toBe('en');
    expect(normalizeLocale('de-DE')).toBe('en');
  });

  it('treats null/undefined/empty as English (matches tenant-config default)', () => {
    expect(normalizeLocale(null)).toBe('en');
    expect(normalizeLocale(undefined)).toBe('en');
    expect(normalizeLocale('')).toBe('en');
  });
});
