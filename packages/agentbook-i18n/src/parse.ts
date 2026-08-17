/**
 * Locale-aware parsing of user-entered money and dates.
 *
 * WHY THIS MODULE EXISTS
 *
 * Localising output without localising input is a money-corruption bug, not an
 * incomplete feature. Before this module, 14 call sites parsed amounts as:
 *
 *     parseFloat(raw.replace(/,/g, ''))     // strip commas, then parse
 *
 * In Canadian French the decimal separator IS a comma, so a user typing
 * "45,50" produced parseFloat("4550") = 4550, and Math.round(4550 * 100)
 * booked $4,550.00 to the ledger instead of $45.50 — a 100x error, silent.
 *
 * That was latent only because no French UI existed. The moment the app renders
 * "45,50 $" on screen it is actively teaching users to type a format the old
 * parser misread. Output and input had to change together.
 *
 * SEPARATORS COME FROM Intl, NOT FROM A HARDCODED TABLE
 * Asking Intl.NumberFormat for its own parts means our parser and our formatter
 * agree by construction, including oddities like fr-CA's narrow no-break space
 * (U+202F) for thousands, which a hand-written table reliably gets wrong.
 *
 * AMBIGUITY IS REPORTED, NOT GUESSED
 * "1,500" is one thousand five hundred in en-US and one-and-a-half in fr-CA.
 * No parser can resolve that from the string alone, and guessing wrong is a
 * 1000x error. So the result carries `ambiguous`, and callers are expected to
 * echo `formatted` back for confirmation before writing anything.
 */

import { formatCurrency } from './formatters.js';

export interface ParsedAmount {
  /** False when the input is not a number at all. Check before using `cents`. */
  ok: boolean;
  /** Integer cents. Always finite when `ok`. 0 when not ok. */
  cents: number;
  /**
   * True when the input could reasonably mean something else in this locale.
   * Callers MUST confirm with the user before booking an ambiguous amount.
   */
  ambiguous: boolean;
  /** The chosen interpretation, formatted for echoing back to the user. */
  formatted: string;
}

export interface ParsedDate {
  ok: boolean;
  /** 'YYYY-MM-DD'. Empty when not ok. */
  iso: string;
  /** True when day/month order could not be determined from the value alone. */
  ambiguous: boolean;
}

/** Largest amount we accept, guarding against overflow nonsense like 1e999. */
const MAX_CENTS = 1e15;

interface Separators {
  decimal: string;
  group: string[];
}

const separatorCache = new Map<string, Separators>();

/**
 * The decimal and grouping separators Intl actually uses for a locale.
 * Derived by formatting a known number and reading the parts back.
 */
function separatorsFor(locale: string): Separators {
  const cached = separatorCache.get(locale);
  if (cached) return cached;

  let decimal = '.';
  const group = new Set<string>();
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.89);
    for (const p of parts) {
      if (p.type === 'decimal') decimal = p.value;
      if (p.type === 'group') group.add(p.value);
    }
  } catch {
    // Unknown locale: fall back to en-US conventions.
  }

  // Accept every plausible grouping character for the locale, not just the one
  // Intl emits: users type an ordinary space where Intl renders U+202F, and
  // pasted values may carry either.
  if (decimal === ',') {
    group.add(' ').add(' ').add(' ').add(' ').add('.');
  } else {
    group.add(',').add(' ').add(' ').add(' ').add(' ');
  }
  group.delete(decimal);

  const seps: Separators = { decimal, group: [...group] };
  separatorCache.set(locale, seps);
  return seps;
}

/** Strip currency symbols, letters and stray punctuation, keeping digits/separators/sign. */
function stripNonNumeric(raw: string, keep: string[]): string {
  const keepSet = new Set(keep);
  let out = '';
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch;
    else if (ch === '-' || ch === '+') out += ch;
    else if (keepSet.has(ch)) out += ch;
  }
  return out;
}

/**
 * Parse a user-entered amount into integer cents, using `locale`'s conventions.
 */
export function parseAmountToCents(raw: string, locale: string = 'en-US'): ParsedAmount {
  const fail: ParsedAmount = { ok: false, cents: 0, ambiguous: false, formatted: '' };
  if (typeof raw !== 'string') return fail;

  const trimmed = raw.trim();
  if (trimmed === '') return fail;

  // Reject scientific notation outright. Stripping the 'e' would silently turn
  // "1e999" into 1999 and book $1,999.00 — plausible-looking and wrong. No real
  // money entry uses exponent form.
  if (/\d\s*[eE]\s*[-+]?\d/.test(trimmed)) return fail;

  // Accounting negatives: ($45.50) means -45.50.
  const parenNegative = /^\(.*\)$/.test(trimmed);

  const { decimal, group } = separatorsFor(locale);
  let cleaned = stripNonNumeric(trimmed, [decimal, ...group]);

  const negative = parenNegative || cleaned.includes('-');
  cleaned = cleaned.replace(/[-+]/g, '');
  if (cleaned === '') return fail;

  // Decide decimal-vs-grouping by POSITION and TRAILING-DIGIT COUNT, not by
  // which character the locale nominally uses.
  //
  // Keying off the locale's separator alone breaks in both directions: a fr-CA
  // user typing "45.50" (US keyboard habit) would read '.' as grouping and give
  // 4550, while an en-US reading of "45,50" gives the same 100x error the other
  // way. Both are the bug this module exists to prevent, so neither locale gets
  // to assume its own punctuation.
  //
  // The rule: the LAST separator is the decimal point when the digits after it
  // look like a fraction (1, 2, or 4+ of them). Exactly 3 trailing digits is
  // the genuinely ambiguous case — it could be a thousands group.
  const allSeps = new Set<string>([decimal, ...group]);

  // Trim separators at either end before analysing. "45,00 $" cleans to
  // "45,00 " — a currency symbol drops out but the space before it survives as
  // a grouping candidate, and it would otherwise be read as the LAST separator
  // with zero digits after it, yielding 450000 instead of 4500.
  let lo = 0;
  let hi = cleaned.length;
  while (lo < hi && allSeps.has(cleaned[lo])) lo++;
  while (hi > lo && allSeps.has(cleaned[hi - 1])) hi--;
  cleaned = cleaned.slice(lo, hi);
  if (cleaned === '') return fail;

  let lastSepIdx = -1;
  let lastSepChar = '';
  for (let i = 0; i < cleaned.length; i++) {
    if (allSeps.has(cleaned[i])) {
      lastSepIdx = i;
      lastSepChar = cleaned[i];
    }
  }

  const dropSeps = (frag: string): string => {
    let out = '';
    for (const ch of frag) if (!allSeps.has(ch)) out += ch;
    return out;
  };

  let ambiguous = false;
  let intPart: string;
  let fracPart = '';

  if (lastSepIdx === -1) {
    intPart = cleaned;
  } else {
    const head = cleaned.slice(0, lastSepIdx);
    const tail = cleaned.slice(lastSepIdx + 1);

    // A separator with non-digits after it, or nothing after it, is malformed.
    if (!/^\d*$/.test(tail)) return fail;

    const otherSepCount = [...head].filter((c) => allSeps.has(c)).length;

    if (tail.length === 3) {
      // The ONLY genuinely undecidable width. Grouping always leaves exactly 3
      // digits after the final separator, and a 3-decimal value looks
      // identical. Break the tie on whether the separator is this locale's own
      // decimal mark:
      //
      //   en-US "1,500"   ',' is not en-US's decimal -> thousands  -> 150000
      //   en-US "45.005"  '.' IS en-US's decimal     -> fraction   -> 4501
      //   fr-CA "1,500"   ',' IS fr-CA's decimal     -> fraction   -> 150
      //   fr-CA "1.234"   '.' is not fr-CA's decimal -> thousands  -> 123400
      //
      // Ambiguity is reported only where BOTH readings are plausible in this
      // locale — the separator is the decimal mark AND it is the sole separator
      // present. en-US "1,500" needs no confirmation; fr-CA "1,500" does.
      if (lastSepChar === decimal) {
        intPart = dropSeps(head);
        fracPart = tail;
        ambiguous = otherSepCount === 0;
      } else {
        intPart = dropSeps(head) + tail;
      }
    } else if (tail.length === 0) {
      // Trailing separator: "45." or "1,". Treat as an integer amount.
      intPart = dropSeps(head);
    } else {
      // 1, 2, or 4+ trailing digits. Grouping cannot produce these widths, so
      // this is a fraction whichever character was used — which is what lets a
      // fr-CA user type "45.50" out of US keyboard habit and still be read as
      // forty-five fifty rather than four thousand five hundred and fifty.
      intPart = dropSeps(head);
      fracPart = tail;
    }
  }

  const normalized = fracPart === '' ? intPart : `${intPart}.${fracPart}`;

  if (normalized === '' || normalized === '.') return fail;
  if (!/^\d*\.?\d*$/.test(normalized)) return fail;

  const value = Number(normalized);
  if (!Number.isFinite(value)) return fail;

  const cents = Math.round(value * 100) * (negative ? -1 : 1);
  if (!Number.isFinite(cents) || Math.abs(cents) > MAX_CENTS) return fail;

  return {
    ok: true,
    cents,
    ambiguous,
    formatted: formatCurrency(cents, locale, currencyGuess(locale)),
  };
}

/** Reasonable currency for echoing a parsed amount back in this locale. */
function currencyGuess(locale: string): string {
  const l = locale.toLowerCase();
  if (l.endsWith('-ca')) return 'CAD';
  if (l.endsWith('-au')) return 'AUD';
  if (l.startsWith('zh')) return 'CNY';
  return 'USD';
}

/** True when this locale writes dates day-first. */
function isDayFirst(locale: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(locale).formatToParts(new Date(Date.UTC(2026, 2, 22)));
    const order = parts.filter((p) => p.type === 'day' || p.type === 'month').map((p) => p.type);
    return order[0] === 'day';
  } catch {
    return false;
  }
}

/**
 * Parse a user-entered date to an ISO 'YYYY-MM-DD'.
 *
 * Day/month order follows the locale: '03/04/2026' is 4 March in en-US and
 * 3 April in fr-CA. When both readings are valid the result is marked
 * ambiguous so the caller can confirm rather than silently commit.
 *
 * Parsing is purely arithmetic on the digits — no `new Date(string)` — because
 * `new Date('2026-03-22')` is UTC midnight and formatting it in a zone west of
 * UTC renders the previous day. That exact defect exists in formatDate and is
 * fixed alongside this module.
 */
export function parseDateInput(raw: string, locale: string = 'en-US'): ParsedDate {
  const fail: ParsedDate = { ok: false, iso: '', ambiguous: false };
  if (typeof raw !== 'string') return fail;
  const s = raw.trim();
  if (s === '') return fail;

  const pad = (n: number) => String(n).padStart(2, '0');
  const valid = (y: number, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || y < 1000 || y > 9999) return false;
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return d <= daysInMonth;
  };

  // ISO first — unambiguous in every locale.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!valid(y, m, d)) return fail;
    return { ok: true, iso: `${y}-${pad(m)}-${pad(d)}`, ambiguous: false };
  }

  // Slash or dot separated, 2 or 4 digit year last.
  const parts = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (parts) {
    const a = Number(parts[1]);
    const b = Number(parts[2]);
    let y = Number(parts[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;

    const dayFirst = isDayFirst(locale);
    const primary = dayFirst ? { m: b, d: a } : { m: a, d: b };
    const other = dayFirst ? { m: a, d: b } : { m: b, d: a };

    if (!valid(y, primary.m, primary.d)) {
      // Locale order is impossible; try the other reading before giving up.
      if (valid(y, other.m, other.d)) {
        return { ok: true, iso: `${y}-${pad(other.m)}-${pad(other.d)}`, ambiguous: false };
      }
      return fail;
    }

    // Ambiguous only when BOTH readings are real dates and they differ.
    const bothValid = valid(y, other.m, other.d);
    const differ = primary.m !== other.m || primary.d !== other.d;
    return {
      ok: true,
      iso: `${y}-${pad(primary.m)}-${pad(primary.d)}`,
      ambiguous: bothValid && differ,
    };
  }

  return fail;
}
