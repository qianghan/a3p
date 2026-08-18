/**
 * French copy quality.
 *
 * WHY THIS EXISTS
 *
 * The other catalog invariants check that fr-CA values EXIST, have matching
 * placeholders, and DIFFER from English. All three passed while 26 values were
 * misspelled French with the accents stripped — "Parametres", "Depenses
 * totales", "Etat des resultats". A value can be present, unique, and
 * structurally perfect while still being wrong as language.
 *
 * Two of them were worse than misspellings: `receipt_upload_prompt` and
 * `upload_now` used "télécharger" — which means DOWNLOAD — for an UPLOAD
 * action. Fluent, confident, and pointing the user the wrong way.
 *
 * These checks are deliberately narrow. A French spell-checker is out of scope
 * and would produce false positives on brand names and accounting jargon; the
 * point is to catch the two mechanical classes that already shipped.
 */
import { describe, it, expect } from 'vitest';
import { CATALOG } from '@agentbook/i18n/catalog';

function frenchValues(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const data = CATALOG['fr-CA'] ?? {};
  for (const ns of Object.keys(data)) {
    const tree = data[ns] as Record<string, unknown>;
    for (const [k, v] of Object.entries(tree)) {
      if (typeof v === 'string') out.push([`${ns}.${k}`, v]);
    }
  }
  return out;
}

/**
 * Words that are spelled WITH an accent in French. Finding the unaccented
 * spelling as a whole word means the accent was dropped.
 *
 * A short explicit list, not a dictionary: a false positive here blocks a
 * correct translation, which is worse than missing one.
 */
const ACCENT_STRIPPED: Record<string, string> = {
  parametres: 'paramètres',
  reessayer: 'réessayer',
  creer: 'créer',
  creee: 'créée',
  depense: 'dépense',
  depenses: 'dépenses',
  recu: 'reçu',
  recus: 'reçus',
  apercu: 'aperçu',
  periode: 'période',
  echeance: 'échéance',
  numero: 'numéro',
  donnees: 'données',
  details: 'détails',
  categorie: 'catégorie',
  categories: 'catégories',
  declaration: 'déclaration',
  annee: 'année',
  derniere: 'dernière',
  premiere: 'première',
  operation: 'opération',
  resultats: 'résultats',
  tresorerie: 'trésorerie',
  telecharger: 'télécharger',
  economiser: 'économiser',
  enregistre: 'enregistré',
  cloture: 'clôture',
  tres: 'très',
  etes: 'êtes',
  etat: 'état',
};

/**
 * Does `value` contain `stripped` as a standalone word?
 *
 * NOT \b. JavaScript word boundaries treat accented letters as NON-word
 * characters, so /\btres\b/ matches inside "paramètres" — the è acts as a
 * boundary — and flags a correctly-spelled value. That false positive is not
 * hypothetical: it fired on common.settings the first time this ran.
 *
 * Exported-by-closure so the self-test below exercises the SAME matcher; a
 * self-test on a different regex proves nothing about this one.
 */
const FR_LETTERS = 'a-zàâçéèêëîïôöùûüÿ';
function containsStrippedWord(value: string, stripped: string): boolean {
  return new RegExp(`(?<![${FR_LETTERS}])${stripped}(?![${FR_LETTERS}])`).test(value.toLowerCase());
}

describe('fr-CA: accents are not optional', () => {
  it('has no value with a French word spelled without its accent', () => {
    const bad: string[] = [];
    for (const [key, value] of frenchValues()) {
      for (const [stripped, correct] of Object.entries(ACCENT_STRIPPED)) {
        if (containsStrippedWord(value, stripped)) {
          bad.push(`${key}: "${value}" — "${stripped}" should be "${correct}"`);
          break;
        }
      }
    }
    expect(bad, `${bad.length} fr-CA value(s) look like French with accents stripped`).toEqual([]);
  });
});

describe('fr-CA: upload is not download', () => {
  it('never uses "télécharger" for an upload action', () => {
    // télécharger = download. téléverser = upload. Two keys shipped with the
    // wrong one, telling users to "download" their receipts in order to
    // upload them.
    const uploadish = /upload|televerser|téléverser/i;
    const bad: string[] = [];
    for (const [key, value] of frenchValues()) {
      const looksLikeUploadKey = uploadish.test(key);
      if (looksLikeUploadKey && /télécharger|telecharger/i.test(value)) {
        bad.push(`${key}: "${value}" — use "téléverser" (upload), not "télécharger" (download)`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('fr-CA: the check is not vacuous', () => {
  it('actually inspects a meaningful number of French values', () => {
    // If CATALOG['fr-CA'] were empty or mis-imported, every assertion above
    // would pass trivially.
    const values = frenchValues();
    expect(values.length).toBeGreaterThan(100);
    expect(values.some(([, v]) => /[àâçéèêëîïôùûü]/i.test(v))).toBe(true);
  });

  it('flags a stripped accent if one is reintroduced', () => {
    // Exercises the real matcher, not a lookalike.
    expect(containsStrippedWord('Parametres du compte', 'parametres')).toBe(true);
    expect(containsStrippedWord('Depenses totales', 'depenses')).toBe(true);
  });

  it('does NOT flag a correctly accented value', () => {
    // The false positive that the naive \b version produced: "paramètres"
    // ends in the letters t-r-e-s, and è is not a \w character.
    expect(containsStrippedWord('Paramètres', 'tres')).toBe(false);
    expect(containsStrippedWord('Dépenses totales', 'depenses')).toBe(false);
    expect(containsStrippedWord('Réessayer', 'reessayer')).toBe(false);
  });
});
