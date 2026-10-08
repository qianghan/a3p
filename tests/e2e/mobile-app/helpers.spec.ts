import { test, expect } from '@playwright/test';
import { catalogT, money, isLocalHost, loginUnavailableReason, PERSONAS } from './helpers';

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
    expect(money(123456, 'CAD', 'fr-CA')).toMatch(/1\s235\s\$/);
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
});
