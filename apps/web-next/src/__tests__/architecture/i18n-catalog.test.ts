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
 * Regulated copy that must remain English-only.
 * Tax guidance and legal disclosures are not translated, per the plan's
 * English-only decision, because a fluent mistranslation of tax advice is a
 * liability rather than a cosmetic bug.
 */
const ENGLISH_ONLY_PREFIXES = ['tax.advice.', 'legal.', 'filing.disclosure.'];

function isEnglishOnly(key: string): boolean {
  return ENGLISH_ONLY_PREFIXES.some((p) => key.startsWith(p));
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
  for (const locale of NON_REFERENCE_LOCALES) {
    it(`${locale} contains NO tax-guidance, legal, or filing-disclosure keys`, () => {
      // Inverted invariant. Presence is the failure.
      const present = [...localeKeys(locale).keys()].filter(isEnglishOnly);
      expect(
        present,
        `${locale} must not translate regulated copy. Tax guidance and legal ` +
          `disclosures are English-only with a visible notice. Found: ${present.join(', ')}`,
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
