import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG } from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';

/**
 * The shell's translator wiring, checked end to end.
 *
 * WHY THIS EXISTS SEPARATELY FROM i18n-catalog.test.ts
 *
 * That file proves the catalog is internally consistent: same keys in every
 * locale, matching interpolation variables, every value actually translated.
 * All of it passed during the last rollout while the running page was still
 * visibly English — because a consistent catalog says nothing about whether
 * the COMPONENT asks for a key or just hardcodes the sentence.
 *
 * So this asserts the other two halves:
 *
 *   1. every key the shell ACTUALLY CALLS resolves, in all three locales, and
 *   2. the literals that P1-6 converted really left the source.
 *
 * Half 1 matters because `t()` never throws on a missing key. `useT`'s
 * fallback humanises `core_ui.accounting_basis` into "Accounting basis", which
 * reads as correct English and hides a typo or a missing catalog entry
 * completely — in every locale at once.
 *
 * WHAT THIS DOES **NOT** CATCH, AND WHO DOES
 *
 * A key present in en but missing from fr-CA resolves through the lookup chain
 * (fr-CA -> fr -> en) and comes back as the ENGLISH string — so the check
 * below sees a value and passes. Verified by deleting one: this file stayed
 * green. i18n-catalog.test.ts's key-parity assertion is what fails there
 * ("fr-CA is missing 1 key(s)"), and the two are complementary:
 *
 *   parity (catalog test)   every locale has every key
 *   resolution (this file)  every key the CODE calls exists at all
 *
 * Neither alone is enough. A typo at the call site passes parity, because the
 * catalog is perfectly consistent about a key nobody defined.
 *
 * "Do the translations differ from English" is likewise left to
 * i18n-catalog.test.ts, which enforces it for every key with the shared
 * IDENTICAL_ALLOWED list. Duplicating it would mean a second copy of that list.
 */

const APP = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(APP, rel), 'utf8');

function shellFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(APP, dir))) {
      const rel = `${dir}/${e}`;
      if (statSync(join(APP, rel)).isDirectory()) {
        if (e !== '__tests__' && e !== 'node_modules') walk(rel);
      } else if (e.endsWith('.tsx') && !e.includes('.test.')) {
        // Only files wired to the SHELL translator. `components/docs` uses a
        // separate `t` from @/lib/i18n with its own catalog and a
        // (key, locale) signature — scanning it would report its keys as
        // missing from a catalog they were never meant to be in.
        if (/from '@\/hooks\/use-t'/.test(readFileSync(join(APP, rel), 'utf8'))) out.push(rel);
      }
    }
  };
  walk('app');
  walk('components');
  return out;
}

describe('every key the shell calls resolves', () => {
  const files = shellFiles();
  const keys = [...new Set(
    files.flatMap((f) => [...read(f).matchAll(/\bt\('([a-z0-9_]+\.[a-z0-9_]+)'/g)].map((m) => m[1])),
  )].sort();

  it('scanned a real tree', () => {
    // Floors, not equalities: the point is that a broken scan (wrong root, a
    // regex that stops matching) cannot make the assertions below vacuous.
    // Measured at the time of writing: 56 files, 573 distinct keys.
    expect(files.length, 'no files matched — did the useT import path change?').toBeGreaterThan(40);
    expect(keys.length, 'no keys scraped — did the t() call shape change?').toBeGreaterThan(450);
  });

  it.each(['en', 'fr-CA', 'zh-CN'])('%s resolves all of them', (locale) => {
    const tr = createTranslator(locale, CATALOG);
    // createTranslator returns the KEY itself when nothing resolves; useT would
    // humanise it instead. Either way it is not a translation, and neither one
    // raises — which is exactly why this has to be asserted.
    const missing = keys.filter((k) => tr.t(k) === k || tr.t(k).trim() === '');
    expect(missing, `${locale}: ${missing.length} unresolved -> ${missing.join(', ')}`).toEqual([]);
  });
});

/**
 * Literals P1-6 converted, sampled across both tranches. If one comes back, a
 * francophone reader gets an English sentence mid-page — the half-and-half
 * state the locale feature flag exists to prevent.
 */
const CONVERTED: Array<[string, string]> = [
  // tranche 1 — settings
  ['app/(dashboard)/settings/page.tsx', '>Profile<'],
  ['app/(dashboard)/settings/page.tsx', '>Danger Zone<'],
  ['app/(dashboard)/settings/page.tsx', 'placeholder="Your display name"'],
  ['app/(dashboard)/settings/page.tsx', 'title="Uninstall plugin"'],
  ['components/settings/AgentBookSettingsPanel.tsx', '>Business type<'],
  ['components/settings/AgentBookSettingsPanel.tsx', '>Accounting basis<'],
  ['components/settings/AgentBookSettingsPanel.tsx', '>Accrual — revenue when invoiced<'],
  ['components/settings/AgentBookSettingsPanel.tsx', '>Estimated annual income<'],
  ['components/settings/AgentBookSettingsPanel.tsx', 'placeholder="Acme Corp"'],
  // tranche 2 — teams, sales-rep, payroll, admin, PWA
  ['app/(dashboard)/payroll/page.tsx', '>Run payroll<'],
  ['app/(dashboard)/payroll/page.tsx', '>PAYG withheld<'],
  ['app/(dashboard)/sales-rep/apply/page.tsx', '>Become an AgentBook Partner<'],
  ['app/(dashboard)/sales-rep/apply/page.tsx', '>Confirm your jurisdiction<'],
  ['app/(dashboard)/sales-rep/page.tsx', '>Sales Rep Dashboard<'],
  ['app/(dashboard)/teams/page.tsx', '>No teams yet<'],
  ['components/teams/member-access-modal.tsx', '>Can Use<'],
  ['components/admin/LLMProvidersSection.tsx', '>No LLM providers configured<'],
  ['components/pwa/InstallAppBanner.tsx', '>Add to Home Screen<'],
];

describe('the converted literals are gone', () => {
  it.each(CONVERTED)('%s no longer contains %s', (file, literal) => {
    expect(read(file)).not.toContain(literal);
  });

  it('the files still hold text, i.e. the codemod did not just delete it', () => {
    // Guard the guard: `not.toContain` passes just as happily on an empty file.
    for (const [f] of CONVERTED) {
      const src = read(f);
      expect(src.length, f).toBeGreaterThan(2_000);
      expect((src.match(/\bt\('/g) || []).length, f).toBeGreaterThan(3);
    }
  });
});

describe('the brand names were left alone', () => {
  it('the wordmark is not translated', () => {
    // The codemod caught this one and it had to be reverted by hand:
    // `aria-label="AgentBook"` is the product name, and routing it through the
    // catalog would let a locale rename the brand.
    expect(read('components/brand/Wordmark.tsx')).toContain('aria-label="AgentBook"');
  });
});

describe('strings that are deliberately NOT translated', () => {
  /**
   * P1-6 finished with seven literals left in the plugin frontends, each left
   * on purpose. They are recorded here because the obvious "improvement" — give
   * them keys — is a regression twice over:
   *
   *   - the value would be identical in all three locales, so the key buys
   *     nothing, and
   *   - bin/i18n-unwired-key-guard.sh flags any literal whose exact English
   *     value exists as a key, so every plain mention of the word anywhere in
   *     the repo starts failing a measure that must be zero. That is exactly
   *     what happened when Telegram/WhatsApp/webhook briefly had keys.
   *
   * The assertion is on the CATALOG, not the call sites: it fails the moment
   * someone adds the key, which is the decision worth catching.
   */
  const MUST_HAVE_NO_KEY = [
    'Telegram',    // product name
    'WhatsApp',    // product name
    'Webhook',     // the word is used unchanged in French and Chinese
    'Deel',        // payroll provider
    'Finch',       // payroll provider
    'GitHub',      // product name
    'Google Gemini',
    'C-corp',      // US legal entity type, used untranslated in all three
  ];

  it.each(MUST_HAVE_NO_KEY)('%s has no catalog key', (value) => {
    const en = (CATALOG as Record<string, Record<string, Record<string, unknown>>>).en;
    const owners: string[] = [];
    for (const [ns, entries] of Object.entries(en)) {
      for (const [k, v] of Object.entries(entries)) {
        if (typeof v === 'string' && v === value) owners.push(`${ns}.${k}`);
      }
    }
    expect(
      owners,
      `${value} is a brand or term of art with the same value in every locale. `
      + `A key for it makes every mention in the repo an "unwired key". Remove ${owners.join(', ')}.`,
    ).toEqual([]);
  });
});
