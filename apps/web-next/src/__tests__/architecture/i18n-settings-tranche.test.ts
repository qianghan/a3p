import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';

/**
 * The settings surfaces, checked end to end rather than key by key.
 *
 * WHY THIS EXISTS SEPARATELY FROM i18n-catalog.test.ts
 *
 * That file proves the catalog is internally consistent: same keys in every
 * locale, matching interpolation variables, no untranslated values. All of
 * that passed on the last rollout while the running page was still visibly
 * English — because a consistent catalog says nothing about whether the
 * COMPONENT asks for a key or just hardcodes the sentence.
 *
 * So this asserts both halves of the wiring:
 *
 *   1. the literals really left the source, per file, and
 *   2. the keys that replaced them resolve through the REAL translator to a
 *      real translation, not to the humanised-key fallback.
 *
 * Point 2 matters because `t()` never throws on a missing key — `useT`'s
 * fallback turns `core_ui.accounting_basis` into "Accounting basis", which
 * reads as correct English and hides a catalog miss completely.
 */

const APP = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(APP, rel), 'utf8');

const SETTINGS_PAGE = 'app/(dashboard)/settings/page.tsx';
const SETTINGS_PANEL = 'components/settings/AgentBookSettingsPanel.tsx';

/**
 * Literals this tranche converted. If one comes back, a user reading French
 * gets an English sentence in the middle of the page — the exact half-and-half
 * state the locale feature flag exists to prevent.
 */
const CONVERTED: Array<[string, string]> = [
  [SETTINGS_PAGE, '>Profile<'],
  [SETTINGS_PAGE, '>Avatar URL<'],
  [SETTINGS_PAGE, '>Danger Zone<'],
  [SETTINGS_PAGE, '>Connected Apps<'],
  [SETTINGS_PAGE, '>Appearance<'],
  [SETTINGS_PAGE, '>My Plugin Configurations<'],
  [SETTINGS_PAGE, 'placeholder="Your display name"'],
  [SETTINGS_PAGE, 'title="Uninstall plugin"'],
  [SETTINGS_PANEL, '>Business type<'],
  [SETTINGS_PANEL, '>Accounting basis<'],
  [SETTINGS_PANEL, '>Accrual — revenue when invoiced<'],
  [SETTINGS_PANEL, '>Cash — revenue when paid<'],
  [SETTINGS_PANEL, '>Your personal profile<'],
  [SETTINGS_PANEL, '>Estimated annual income<'],
  [SETTINGS_PANEL, '>Accept card payments on invoices<'],
  [SETTINGS_PANEL, '>AgentBook Settings<'],
  [SETTINGS_PANEL, 'alt="AgentBook referral card"'],
  [SETTINGS_PANEL, 'placeholder="Acme Corp"'],
];

describe('the settings literals are gone from the source', () => {
  it.each(CONVERTED)('%s no longer contains %s', (file, literal) => {
    expect(read(file)).not.toContain(literal);
  });

  it('the files still render text, i.e. the codemod did not just delete it', () => {
    // Guard the guard: `not.toContain` passes just as happily on an empty file.
    for (const f of [SETTINGS_PAGE, SETTINGS_PANEL]) {
      const src = read(f);
      expect(src.length).toBeGreaterThan(10_000);
      expect((src.match(/\bt\('core_ui\./g) || []).length).toBeGreaterThan(15);
    }
  });
});

describe('every key this tranche introduced resolves in every locale', () => {
  /** Read the keys out of the source, so the list cannot drift from reality. */
  const usedKeys = [...new Set(
    [read(SETTINGS_PAGE), read(SETTINGS_PANEL)]
      .flatMap((src) => [...src.matchAll(/\bt\('([a-z0-9_]+\.[a-z0-9_]+)'\)/g)].map((m) => m[1])),
  )];

  it('found the call sites', () => {
    expect(usedKeys.length).toBeGreaterThan(70);
  });

  it.each(['en', 'fr-CA', 'zh-CN'])('%s has a real value for all of them', (locale) => {
    const t = createTranslator(locale, CATALOG);
    const missing = usedKeys.filter((k) => {
      const v = t.t(k);
      // createTranslator returns the KEY itself when nothing resolves; useT's
      // fallback would humanise it instead. Either way it is not a translation.
      return v === k || v.trim() === '';
    });
    expect(missing, `${locale}: unresolved keys ${missing.join(', ')}`).toEqual([]);
  });

  it('fr-CA and zh-CN actually differ from English', () => {
    // The point of the tranche. A key present in all three locales with the
    // same English string in each is not translated, it is just copied.
    const en = createTranslator('en', CATALOG);
    // Words that are the same in the target language. The first four are this
    // tranche's (product names, plus "Logo" which French borrows unchanged);
    // the last three are pre-existing keys these files already used and which
    // i18n-catalog.test.ts's own IDENTICAL_ALLOWED already blesses — they are
    // listed because this test scrapes every key in the file, not only the
    // ones the tranche introduced.
    const BRANDS = new Set([
      'core_ui.telegram', 'core_ui.webhook', 'core_ui.whatsapp', 'core_ui.logo',
      'agents.notifications', 'tax_ui.canada', 'common.description',
    ]);
    for (const locale of ['fr-CA', 'zh-CN']) {
      const tr = createTranslator(locale, CATALOG);
      const identical = usedKeys
        .filter((k) => !BRANDS.has(k))
        .filter((k) => tr.t(k) === en.t(k));
      expect(identical, `${locale}: still English -> ${identical.join(', ')}`).toEqual([]);
    }
  });

  it('a sample reads as the right language, not transliterated English', () => {
    const fr = createTranslator('fr-CA', CATALOG);
    const zh = createTranslator('zh-CN', CATALOG);
    expect(fr.t('core_ui.accounting_basis')).toBe('Méthode comptable');
    expect(fr.t('core_ui.default_payment_terms')).toBe('Conditions de paiement par défaut');
    expect(zh.t('core_ui.accounting_basis')).toMatch(/[一-鿿]/);
    expect(zh.t('core_ui.danger_zone')).toMatch(/[一-鿿]/);
  });
});
