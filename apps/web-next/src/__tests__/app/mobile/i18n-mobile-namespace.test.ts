/**
 * The `mobile` catalog namespace — registration, resolution, plurals.
 *
 * Keys are nested (`mobile.tabs.home`) because C5 names them
 * mobile.<screen>.<name>; every other namespace is flat. Registration has to
 * happen in five places (locale-meta, catalog, catalog-client, both packs) and
 * missing any one of them degrades to English silently, so each is asserted.
 */
import { describe, it, expect } from 'vitest';
import { CATALOG, NAMESPACES } from '@agentbook/i18n/catalog';
import { CLIENT_CATALOG, CLIENT_NAMESPACES, loadLocalePack } from '@agentbook/i18n/catalog-client';
import { createTranslator } from '@agentbook/i18n';

const SHELL_KEYS = [
  'mobile.tabs.nav_label',
  'mobile.tabs.home',
  'mobile.tabs.docs',
  'mobile.tabs.capture',
  'mobile.tabs.chat',
  'mobile.tabs.home_attention',
  'mobile.tabs.docs_review_one',
  'mobile.tabs.docs_review_other',
  'mobile.kit.close',
  'mobile.kit.not_available',
  'mobile.kit.notifications',
  'mobile.kit.retry',
  'mobile.kit.loading',
  'mobile.kit.no_receipt',
  'mobile.kit.pdf_receipt',
  'mobile.kit.offline_as_of',
  'mobile.kit.stale_as_of',
  'mobile.kit.error_title',
  'mobile.kit.error_body',
  'mobile.kit.offline_title',
  'mobile.kit.offline_body',
  'mobile.kit.severity_critical',
  'mobile.kit.severity_warn',
  'mobile.kit.severity_info',
  'mobile.kit.alerts',
];

describe('the mobile namespace', () => {
  it('is registered as a client namespace and ships statically in en', () => {
    expect(NAMESPACES).toContain('mobile');
    expect(CLIENT_NAMESPACES).toContain('mobile');
    expect(Object.keys(CLIENT_CATALOG.en)).toContain('mobile');
  });

  it.each(['fr-CA', 'zh-CN'])('the lazily loaded %s pack carries it', async (locale) => {
    const pack = await loadLocalePack(locale);
    expect(pack).not.toBeNull();
    expect(Object.keys(pack as object)).toContain('mobile');
  });

  it.each(['en', 'fr-CA', 'zh-CN'])('%s resolves every shell key to real text', (locale) => {
    const { t } = createTranslator(locale, CATALOG);
    for (const key of SHELL_KEYS) {
      const value = t(key);
      expect(value, key).not.toBe(key);
      expect(value.trim(), key).not.toBe('');
    }
  });

  it('pluralises the Docs badge per locale (French zero is singular)', () => {
    const en = createTranslator('en', CATALOG).t;
    const fr = createTranslator('fr-CA', CATALOG).t;
    const zh = createTranslator('zh-CN', CATALOG).t;
    expect(en('mobile.tabs.docs_review', { count: 1 })).toBe('Docs, 1 item needs review');
    expect(en('mobile.tabs.docs_review', { count: 3 })).toBe('Docs, 3 items need review');
    expect(fr('mobile.tabs.docs_review', { count: 0 })).toBe('Pièces, 0 élément à vérifier');
    expect(fr('mobile.tabs.docs_review', { count: 2 })).toBe('Pièces, 2 éléments à vérifier');
    expect(zh('mobile.tabs.docs_review', { count: 5 })).toBe('单据，5 项待审核');
  });

  it('fr-CA and zh-CN are translated, not copied from English', () => {
    const en = createTranslator('en', CATALOG).t;
    for (const locale of ['fr-CA', 'zh-CN']) {
      const tr = createTranslator(locale, CATALOG).t;
      for (const key of SHELL_KEYS) expect(tr(key), `${locale} ${key}`).not.toBe(en(key));
    }
  });
});
