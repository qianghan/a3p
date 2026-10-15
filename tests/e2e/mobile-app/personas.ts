export type PersonaKey = 'maya' | 'alex' | 'sydney' | 'fresh';
export const PERSONA_KEYS: PersonaKey[] = ['maya', 'alex', 'sydney', 'fresh'];

export interface PersonaExpect {
  seeded: boolean;
  currency: string | null;
  /** Currency marks that must never appear on this persona's screens. */
  wrongCurrencyMarks: RegExp[];
  /** Jurisdiction terms that must never appear (spec §8.2: AU never shows US SE terms). */
  forbiddenTerms: RegExp[];
}

export const PERSONAS: Record<PersonaKey, PersonaExpect> = {
  maya: { seeded: true, currency: 'CAD', wrongCurrencyMarks: [/US\$/, /(?<!C)A\$/], forbiddenTerms: [/\bIRS\b/, /Schedule C/i, /\bForm 1040\b/] },
  alex: { seeded: true, currency: 'USD', wrongCurrencyMarks: [/CA\$/, /(?<!C)A\$/], forbiddenTerms: [/\bCRA\b/, /GST\/HST/, /\bATO\b/, /\bT2125\b/] },
  sydney: { seeded: true, currency: 'AUD', wrongCurrencyMarks: [/CA\$/, /US\$/], forbiddenTerms: [/self[- ]employment/i, /Schedule C/i, /\bIRS\b/, /\bSE tax\b/i, /\bCRA\b/] },
  fresh: { seeded: false, currency: null, wrongCurrencyMarks: [], forbiddenTerms: [] },
};

export const digits = (s: string) => s.replace(/\D/g, '');
/** formatCurrencyCents renders whole units (maximumFractionDigits: 0). */
export const wholeUnits = (cents: number) => String(Math.round(Math.abs(cents) / 100));
