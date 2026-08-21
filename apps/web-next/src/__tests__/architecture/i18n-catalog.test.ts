/**
 * i18n catalog invariants.
 *
 * Lives here, in the architecture suite, on purpose. This directory is run by
 * the `invariants` CI job, which is un-masked and fires on ANY code change —
 * unlike `plugin-tests`, whose failures were swallowed by `|| echo`. A guard
 * that the regression it guards against can route around is decoration.
 *
 * These assertions read JSON off disk. No database, no network.
 *
 * WHAT EACH INVARIANT ACTUALLY CATCHES
 *
 *   key parity          A translator adds a key to one locale and forgets the
 *                       others. Users of the other locales see a raw key.
 *
 *   variable parity     A translator "helpfully" localises the placeholder:
 *                       "{amount}" becomes "{montant}". The string still
 *                       renders, so review misses it — but the interpolated
 *                       value silently vanishes. This is the highest-value
 *                       invariant here, because the failure is invisible.
 *
 *   CJK presence        A zh-CN key gets copy-pasted from English and left
 *                       untranslated. Parity passes; the user sees English.
 *
 *   tax/legal ABSENCE   Inverted on purpose. Regulated copy must stay English
 *                       (decision: tax guidance is English-only with a
 *                       notice). A future PR that "completes the
 *                       translation" must fail CI, not ship.
 */
import { describe, it, expect } from 'vitest';
import {
  CATALOG,
  AVAILABLE_LOCALES,
  REFERENCE_LOCALE,
  NAMESPACES,
  LOCALE_STATUS,
  TRANSLATED_LOCALES,
  SCAFFOLD_LOCALES,
} from '@agentbook/i18n/catalog';
import { createTranslator } from '@agentbook/i18n';

/** Flatten a namespace tree into dot-notated leaf keys. */
function flatten(obj: unknown, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') {
      for (const [nk, nv] of flatten(v, key)) out.set(nk, nv);
    } else if (typeof v === 'string') {
      out.set(key, v);
    }
  }
  return out;
}

/** All leaf keys for a locale, across every namespace. */
function localeKeys(locale: string): Map<string, string> {
  const out = new Map<string, string>();
  const data = CATALOG[locale] ?? {};
  for (const ns of Object.keys(data)) {
    for (const [k, v] of flatten(data[ns], ns)) out.set(k, v);
  }
  return out;
}

/** `{placeholder}` names in a template, order-insensitive. */
function vars(template: string): Set<string> {
  return new Set(Array.from(template.matchAll(/\{(\w+)\}/g), (m) => m[1]));
}

const NON_REFERENCE_LOCALES = AVAILABLE_LOCALES.filter((l) => l !== REFERENCE_LOCALE);

/**
 * Keys whose translated value may legitimately equal the English value —
 * proper nouns, symbols, and words that are genuinely identical in the target
 * language. Keep this list SHORT and justified; it is the one escape hatch in
 * the "no untranslated leakage" check.
 */
const IDENTICAL_ALLOWED = new Set<string>([
  // "Correct" is a valid French word with the same spelling and meaning.
  'common.correct',
  // Table headers in the chart of accounts. "Code" and "Type" are spelled and
  // used identically in French; translating them would be inventing a
  // difference that does not exist.
  'accounting.code',
  'accounting.type',
  // Same situation: these words are borrowed unchanged into French. Forcing a
  // synonym to satisfy this check would make the copy WORSE, so each one is
  // listed deliberately rather than the check being relaxed.
  'homeoffice.configuration',
  'homeoffice.internet',
  'agents.notifications',
  'agents.model_standard',
  // "Date" and "Notes" are the same word in French.
  'expenses_ui.col_date',
  'expenses_ui.notes',
  // Also identical in French: "Description", "Transactions", "Exceptions" and
  // "Budgets" are all borrowed unchanged. "Budget" in particular is the
  // standard French accounting term, so a synonym would read as a mistake.
  'expenses_ui.col_description',
  'expenses_ui.transactions',
  'expenses_ui.exceptions',
  'expenses_ui.budgets',
  // "Distance" is the same word in French.
  'expenses_ui.distance',
  // Shared table/section labels that French borrows unchanged. "Client",
  // "Total" and "Budget" in particular are the standard French accounting
  // terms, so substituting a synonym to satisfy this check would make the
  // copy read as a mistake to a native speaker.
  'common.actions',
  'common.description',
  'common.total',
  'common.client',
  'invoice_ui.clients',
  'invoice_ui.budget',
  // "Canada" is spelled identically in French — it is the country's own name in
  // both official languages, and inventing a variant would be an error.
  'tax_ui.canada',
  // "Notes" is the same word in French (already allowed for expenses_ui).
  'core_ui.notes',
  // "Quotas" is borrowed unchanged into French. "Net" is the accounting term in
  // both languages, and the strip abbreviates it to the same three letters.
  'billing_ui.quotas',
  'core_ui.abbr_net',
  // "Action" is the same word in French (common.actions is already allowed).
  'core_ui.action',
]);

/**
 * A value with no translatable text — entirely placeholders, digits, symbols
 * or punctuation, e.g. "{vendor}" or "{amount} ({count})". Exempt from the
 * "must differ from English" and CJK checks by rule rather than by allowlist,
 * because there is genuinely nothing in them to translate and enumerating
 * them by hand would rot.
 */
function hasTranslatableText(value: string): boolean {
  return /[A-Za-z]{2,}/.test(value.replace(/\{\w+\}/g, ''));
}

/**
 * Regulated copy that must remain English in EVERY locale.
 *
 * Decision: tax guidance, filing disclosures and legal copy are not
 * translated, because a fluent mistranslation of tax advice is a liability
 * rather than a cosmetic bug.
 *
 * WHY THIS IS AN EXPLICIT KEY LIST AND NOT A PREFIX
 *
 * The first version matched the prefixes 'tax.advice.', 'legal.' and
 * 'filing.disclosure.'. **Zero of the catalog's 253 keys use those names**, so
 * the invariant passed trivially and always would have — a guard asserting
 * something about a naming convention this codebase does not follow.
 *
 * Meanwhile the genuinely advice-shaped strings live under ordinary names, and
 * two of them were ALREADY translated into French before anyone noticed:
 *
 *   tax.bracket_alert  "You're {amount} from the next tax bracket. Prepay
 *                       expenses to save ~{savings}."
 *
 * That is the same bracket-timing advice behind a previous production
 * incident, where the figure shown to users was not a real quantity.
 * Translating it into two more languages multiplies that surface.
 *
 * So the list is enumerated by hand. Adding an advice-shaped string means
 * adding it here; there is no naming convention doing the work silently.
 */
const ENGLISH_ONLY_KEYS = new Set<string>([
  'tax.deduction_found',
  'tax.bracket_alert',
  'proactive.cash_flow_warning',
  'proactive.year_end_planning',
]);

function isEnglishOnly(key: string): boolean {
  return ENGLISH_ONLY_KEYS.has(key);
}

describe('i18n catalog: structure', () => {
  it('ships the three supported locales', () => {
    expect(AVAILABLE_LOCALES.sort()).toEqual(['en', 'fr-CA', 'zh-CN']);
  });

  it('has no locale left over from a previous scheme', () => {
    // es/ja were never wired to anything and were deleted rather than carried
    // forward at 7-keys-complete, which would have forced every parity
    // assertion below to special-case them forever.
    expect(AVAILABLE_LOCALES).not.toContain('es');
    expect(AVAILABLE_LOCALES).not.toContain('ja');
    expect(AVAILABLE_LOCALES).not.toContain('fr'); // renamed to fr-CA
  });

  it('gives every locale the same namespaces as the reference locale', () => {
    for (const locale of NON_REFERENCE_LOCALES) {
      expect(Object.keys(CATALOG[locale]).sort(), `namespaces for ${locale}`).toEqual(NAMESPACES);
    }
  });

  it('defines a non-trivial number of keys', () => {
    // Guards against an import collapsing to {} — which would make every
    // other invariant here vacuously true.
    expect(localeKeys(REFERENCE_LOCALE).size).toBeGreaterThan(50);
  });
});

describe('i18n catalog: key parity', () => {
  const reference = localeKeys(REFERENCE_LOCALE);

  for (const locale of NON_REFERENCE_LOCALES) {
    it(`${locale} has no missing keys`, () => {
      const keys = localeKeys(locale);
      const missing = [...reference.keys()]
        .filter((k) => !isEnglishOnly(k))
        .filter((k) => !keys.has(k));
      expect(missing, `${locale} is missing ${missing.length} key(s)`).toEqual([]);
    });

    it(`${locale} has no orphan keys absent from ${REFERENCE_LOCALE}`, () => {
      const orphans = [...localeKeys(locale).keys()].filter((k) => !reference.has(k));
      expect(orphans, `${locale} has keys not defined in ${REFERENCE_LOCALE}`).toEqual([]);
    });
  }
});

describe('i18n catalog: interpolation variable parity', () => {
  const reference = localeKeys(REFERENCE_LOCALE);

  for (const locale of NON_REFERENCE_LOCALES) {
    it(`${locale} preserves every {placeholder} name`, () => {
      const keys = localeKeys(locale);
      const broken: string[] = [];
      for (const [key, enTemplate] of reference) {
        const translated = keys.get(key);
        if (translated === undefined) continue; // covered by the parity test
        const expected = vars(enTemplate);
        const actual = vars(translated);
        const same =
          expected.size === actual.size && [...expected].every((v) => actual.has(v));
        if (!same) {
          broken.push(`${key}: expected {${[...expected]}} got {${[...actual]}}`);
        }
      }
      // A localised placeholder renders fine and silently drops its value.
      expect(broken, `${locale} has ${broken.length} broken placeholder(s)`).toEqual([]);
    });
  }
});

describe('i18n catalog: value sanity', () => {
  for (const locale of AVAILABLE_LOCALES) {
    it(`${locale} has no empty or whitespace-only values`, () => {
      const empties = [...localeKeys(locale)]
        .filter(([, v]) => v.trim() === '')
        .map(([k]) => k);
      expect(empties).toEqual([]);
    });
  }

  // Content invariants apply to locales marked `ready`. A `scaffold` locale
  // has correct structure but English placeholder values by design — it is
  // kept away from users by the feature flag, guarded below.
  const CJK = /[㐀-䶿一-鿿豈-﫿]/;

  for (const locale of TRANSLATED_LOCALES) {
    it(`${locale} values differ from ${REFERENCE_LOCALE}`, () => {
      const reference = localeKeys(REFERENCE_LOCALE);
      const identical = [...localeKeys(locale)]
        .filter(([k, v]) => reference.get(k) === v)
        .filter(([k]) => !IDENTICAL_ALLOWED.has(k))
        // Regulated copy is REQUIRED to equal English (see the English-only
        // block below). Without this the two invariants contradict each other:
        // one demands these keys differ, the other demands they match.
        .filter(([k]) => !isEnglishOnly(k))
        .filter(([, v]) => hasTranslatableText(v))
        .map(([k]) => k);
      expect(
        identical,
        `${locale} has ${identical.length} value(s) identical to English — ` +
          `translate them, or add to IDENTICAL_ALLOWED with a reason`,
      ).toEqual([]);
    });
  }

  it('zh-CN values contain CJK characters once it is marked ready', () => {
    if (LOCALE_STATUS['zh-CN'] !== 'ready') {
      // Scaffold state: structure only. The release guard below is what stops
      // this reaching a user.
      expect(SCAFFOLD_LOCALES).toContain('zh-CN');
      return;
    }
    const suspect = [...localeKeys('zh-CN')]
      .filter(([k]) => !IDENTICAL_ALLOWED.has(k))
      // Regulated copy is required to stay English, so it legitimately has no
      // CJK. Third invariant that needs this exemption — they all describe the
      // same rule from a different angle.
      .filter(([k]) => !isEnglishOnly(k))
      .filter(([, v]) => hasTranslatableText(v))
      .filter(([, v]) => !CJK.test(v))
      .map(([k, v]) => `${k}="${v}"`);
    expect(suspect, `zh-CN keys that look untranslated: ${suspect.length}`).toEqual([]);
  });
});

describe('i18n catalog: scaffolding cannot reach users', () => {
  it('declares a readiness status for every shipped locale', () => {
    // A locale added to CATALOG without a status would silently escape both
    // the content invariants and the release guard.
    const undeclared = AVAILABLE_LOCALES.filter((l) => !LOCALE_STATUS[l]);
    expect(undeclared, 'locales missing a LOCALE_STATUS entry').toEqual([]);
  });

  it('keeps the reference locale as the only `reference` entry', () => {
    const refs = AVAILABLE_LOCALES.filter((l) => LOCALE_STATUS[l] === 'reference');
    expect(refs).toEqual([REFERENCE_LOCALE]);
  });

  it('lists every scaffolded locale explicitly', () => {
    // Not an assertion that the list is empty — it asserts the list is
    // EXPLICIT. GA (the feature-flag flip) requires it empty, and that
    // assertion lands with the flag itself.
    for (const l of SCAFFOLD_LOCALES) {
      expect(AVAILABLE_LOCALES, `scaffold locale ${l} must exist in CATALOG`).toContain(l);
      expect(LOCALE_STATUS[l]).toBe('scaffold');
    }
  });
});

describe('i18n catalog: regulated copy stays English', () => {
  it('the English-only list actually matches real keys', () => {
    // The check this replaced was VACUOUS: it matched prefixes no key in this
    // catalog uses, so it passed without inspecting anything. Assert the list
    // resolves to real keys before trusting any assertion built on it.
    const reference = localeKeys(REFERENCE_LOCALE);
    const missing = [...ENGLISH_ONLY_KEYS].filter((k) => !reference.has(k));
    expect(missing, 'ENGLISH_ONLY_KEYS names keys that do not exist').toEqual([]);
    expect(ENGLISH_ONLY_KEYS.size).toBeGreaterThan(0);
  });

  for (const locale of NON_REFERENCE_LOCALES) {
    it(`${locale} serves regulated copy in English, verbatim`, () => {
      // These keys MUST exist (they are user-facing) but must hold the English
      // text. Asserting equality, not absence: a missing key would silently
      // fall back to English and look identical, so absence proves nothing.
      const reference = localeKeys(REFERENCE_LOCALE);
      const keys = localeKeys(locale);
      const wrong: string[] = [];
      for (const k of ENGLISH_ONLY_KEYS) {
        const en = reference.get(k);
        const got = keys.get(k);
        if (en !== undefined && got !== undefined && got !== en) {
          wrong.push(`${k}: expected the English text, got "${got}"`);
        }
      }
      expect(
        wrong,
        `${locale} must not translate tax/financial guidance — ` +
          `a fluent mistranslation of advice is a liability, not a cosmetic bug`,
      ).toEqual([]);
    });
  }
});

describe('i18n runtime: no ambient locale state', () => {
  it('does not export setLocale/getLocale', async () => {
    // The previous implementation held currentLocale in module scope. On
    // Fluid Compute, instances are reused across concurrent requests, so that
    // global served one user another user's language. Structural guard against
    // reintroducing it.
    const mod = await import('@agentbook/i18n');
    expect('setLocale' in mod).toBe(false);
    expect('getLocale' in mod).toBe(false);
    expect('loadLocale' in mod).toBe(false);
  });
});

describe('plural variants in the REAL catalog', () => {
  // The MECHANICS of plural selection are covered against a synthetic fixture
  // in packages/agentbook-i18n. What that cannot check is whether the shipped
  // catalog actually HAS the variants the pages ask for — a half-declared
  // plural (`_one` with no `_other`) resolves to the bare key, and the user
  // reads the key.
  it('every _one variant has a matching _other, in every locale', () => {
    const missing: string[] = [];
    for (const locale of AVAILABLE_LOCALES) {
      for (const [ns, data] of Object.entries(CATALOG[locale] ?? {})) {
        const keys = data as Record<string, unknown>;
        for (const key of Object.keys(keys)) {
          if (!key.endsWith('_one')) continue;
          const other = key.replace(/_one$/, '_other');
          if (!(other in keys)) missing.push(`${locale}/${ns}.${other}`);
        }
      }
    }
    expect(
      missing,
      'a plural with no _other variant falls through and renders the raw key',
    ).toEqual([]);
  });

  it('tax_ui.days_away resolves per locale, including the French zero', () => {
    // The code this replaced was `${n} day${n === 1 ? '' : 's'} away` — English
    // plural logic inlined in a component. French counts 0 as SINGULAR, so that
    // produced "dans 0 jours" where "dans 0 jour" is correct. This asserts the
    // real catalog key rather than the selection mechanism.
    const en = createTranslator('en', CATALOG).t;
    const fr = createTranslator('fr-CA', CATALOG).t;
    const zh = createTranslator('zh-CN', CATALOG).t;

    expect(en('tax_ui.days_away', { count: 1 })).toBe('1 day away');
    expect(en('tax_ui.days_away', { count: 0 })).toBe('0 days away');

    // The case the hand-rolled check got wrong.
    expect(fr('tax_ui.days_away', { count: 0 })).toBe('dans 0 jour');
    expect(fr('tax_ui.days_away', { count: 1 })).toBe('dans 1 jour');
    expect(fr('tax_ui.days_away', { count: 2 })).toBe('dans 2 jours');

    // Chinese has no plural inflection; one form serves every count.
    expect(zh('tax_ui.days_away', { count: 1 })).toBe('1 天后');
    expect(zh('tax_ui.days_away', { count: 9 })).toBe('9 天后');
  });
});
