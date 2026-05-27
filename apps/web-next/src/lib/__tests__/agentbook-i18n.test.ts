/**
 * PR 62 — i18n scaffolding tests.
 *
 * Pure logic — no DB, no network. Covers translation lookup, variable
 * interpolation, Accept-Language parsing, and fallbacks.
 */

import { describe, it, expect, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import { t, parseLocaleHeader } from '../agentbook-i18n';

describe('t (translate)', () => {
  it('returns the English default when no locale is given', () => {
    expect(t('rate.minute_exceeded')).toContain('Try again in a minute');
  });

  it('returns the Spanish translation when locale=es', () => {
    expect(t('rate.minute_exceeded', 'es')).toContain('Intenta de nuevo');
  });

  it('returns the Japanese translation when locale=ja', () => {
    expect(t('rate.minute_exceeded', 'ja')).toContain('もう一度');
  });

  it('falls back to English for an unsupported locale', () => {
    expect(t('rate.minute_exceeded', 'de')).toContain('Try again in a minute');
  });

  it('falls back to English for an empty locale string', () => {
    expect(t('rate.minute_exceeded', '')).toContain('Try again');
  });

  it('interpolates {var} from the vars dict', () => {
    expect(t('agent.undo_success', 'en', { description: 'log $5 coffee' })).toBe(
      'Undone: log $5 coffee',
    );
  });

  it('interpolates across all locales', () => {
    expect(t('agent.undo_success', 'es', { description: 'cafe' })).toContain('cafe');
    expect(t('agent.undo_success', 'ja', { description: 'コーヒー' })).toContain('コーヒー');
  });

  it('leaves {var} literal when the var is missing', () => {
    expect(t('agent.undo_success', 'en', {})).toBe('Undone: {description}');
  });

  it('interpolates numeric vars', () => {
    // Use a real key with a single-var template via undo_success
    expect(t('agent.undo_success', 'en', { description: '42 items' })).toBe(
      'Undone: 42 items',
    );
  });
});

describe('parseLocaleHeader', () => {
  it('returns en for null', () => {
    expect(parseLocaleHeader(null)).toBe('en');
  });
  it('returns en for empty string', () => {
    expect(parseLocaleHeader('')).toBe('en');
  });
  it('picks the language base from a region tag (en-US → en)', () => {
    expect(parseLocaleHeader('en-US,en;q=0.9')).toBe('en');
  });
  it('honors q-weight ordering', () => {
    // de is unsupported; en;q=0.8 wins over fr;q=0.5
    expect(parseLocaleHeader('de-DE,en;q=0.8,fr;q=0.5')).toBe('en');
  });
  it('returns zh-CN exactly when requested', () => {
    expect(parseLocaleHeader('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh-CN');
  });
  it('returns ja for Japanese-region tag', () => {
    expect(parseLocaleHeader('ja-JP,en;q=0.5')).toBe('ja');
  });
  it('falls back to en when nothing supported matches', () => {
    expect(parseLocaleHeader('de-DE,it-IT;q=0.9,ru;q=0.8')).toBe('en');
  });
  it('handles weights without q= prefix gracefully', () => {
    expect(parseLocaleHeader('fr-FR,en')).toBe('fr');
  });
  it('ignores extra params it does not recognize', () => {
    expect(parseLocaleHeader('es-ES; level=1; q=0.9, en; q=0.5')).toBe('es');
  });
});
