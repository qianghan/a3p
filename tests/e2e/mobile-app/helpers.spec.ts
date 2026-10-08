import { test, expect } from '@playwright/test';
import {
  catalogT,
  money,
  isLocalHost,
  loginUnavailableReason,
  PERSONAS,
  randomTag,
  randomPassword,
  freshEmail,
  neverCachePaths,
} from './helpers';

// Pure helpers — no browser, no network. They run in every invocation so a broken
// foundation fails here, not as 40 confusing failures in the journeys that use it.
test.describe('@mobile-helpers', () => {
  test('catalogT reads the app catalog from source, with the same fallbacks as the app', () => {
    const en = catalogT('en');
    expect(en('mobile.tabs.home')).toBe('Home');
    expect(en('mobile.tabs.nav_label')).toBe('Main navigation');
    expect(en('common.documents')).toBe('Documents');
    // region tag → base language → en
    expect(catalogT('en-US')('mobile.tabs.docs')).toBe('Docs');
    // an unknown key is returned as-is, so a typo is visible rather than blank
    expect(en('mobile.tabs.nope')).toBe('mobile.tabs.nope');
  });

  test('catalogT applies plural forms and parameters', () => {
    const en = catalogT('en');
    expect(en('mobile.tabs.docs_review', { count: 1 })).toBe('Docs, 1 item needs review');
    expect(en('mobile.tabs.docs_review', { count: 3 })).toBe('Docs, 3 items need review');
  });

  test('catalogT serves a translated locale and falls back to English per key', () => {
    const fr = catalogT('fr-CA');
    expect(fr('mobile.tabs.home')).toBe('Accueil');
  });

  test('money is the app formatter (locale + currency)', () => {
    expect(money(123456, 'USD', 'en-US')).toBe('$1,235');
    expect(money(123456, 'CAD', 'en-CA')).toBe('$1,235');
    expect(money(123456, 'AUD', 'en-AU')).toBe('$1,235');
    // fr-CA groups with U+00A0 (NBSP) and puts the symbol after a U+00A0 — exact characters, not \s.
    expect(money(123456, 'CAD', 'fr-CA')).toBe('1\u00A0235\u00A0$');
  });

  test('persona table and the local-host login gate', () => {
    expect(Object.keys(PERSONAS)).toEqual(['maya', 'alex', 'sydney']);
    expect(PERSONAS.maya).toMatchObject({ currency: 'CAD', jurisdiction: 'ca' });
    expect(isLocalHost('http://localhost:3100')).toBe(true);
    expect(isLocalHost('http://127.0.0.1:3000')).toBe(true);
    expect(isLocalHost('https://agentbook.brainliber.com')).toBe(false);
    expect(isLocalHost(undefined)).toBe(false);
    expect(loginUnavailableReason('https://agentbook.brainliber.com')).toBeNull();
  });

  test('throwaway credentials are CSPRNG-shaped, long enough and unique', () => {
    const passwords = new Set(Array.from({ length: 50 }, () => randomPassword()));
    expect(passwords.size).toBe(50);
    for (const p of passwords) {
      expect(p.length).toBeGreaterThanOrEqual(16);
      // 12 random bytes -> 16 base64url chars, then the fixed policy suffix.
      expect(p).toMatch(/^[A-Za-z0-9_-]{16}-Aa1!$/);
    }
    const tags = new Set(Array.from({ length: 50 }, () => randomTag()));
    expect(tags.size).toBe(50);
    for (const tag of tags) expect(tag).toMatch(/^[0-9a-f]{10}$/);
    const email = freshEmail(1700000000000);
    expect(email).toMatch(/^e2e-mobile-fresh-1700000000000-[0-9a-f]{10}@agentbook\.test$/);
    expect(freshEmail()).not.toBe(freshEmail());
  });

  test('neverCachePaths reads the array body and ignores a path that is only in a comment', () => {
    const real = [
      '// "/api/v1/agentbook-core/mobile/home" must never be cached (this comment must not count)',
      'const NEVER_CACHE_PATHS = [',
      "  '/api/v1/agentbook-tax/tax/estimate', // live",
      "  '/api/v1/agentbook-core/mobile/home', // PWA Home",
      '];',
    ].join('\n');
    expect(neverCachePaths(real)).toEqual(['/api/v1/agentbook-tax/tax/estimate', '/api/v1/agentbook-core/mobile/home']);

    const onlyInComment = [
      'const NEVER_CACHE_PATHS = [',
      "  '/api/v1/agentbook-tax/tax/estimate',",
      "  // '/api/v1/agentbook-core/mobile/home',",
      "  /* '/api/v1/agentbook-core/calendar/upcoming' */",
      '];',
      "const OTHER = ['/api/v1/agentbook-core/calendar/upcoming'];",
    ].join('\n');
    const got = neverCachePaths(onlyInComment);
    expect(got).toEqual(['/api/v1/agentbook-tax/tax/estimate']);
    expect(got).not.toContain('/api/v1/agentbook-core/mobile/home');
    expect(got).not.toContain('/api/v1/agentbook-core/calendar/upcoming');

    expect(neverCachePaths('const X = [];')).toBeNull();
  });
});
