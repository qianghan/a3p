/**
 * Personal tax identifiers in free text (PR 4e review C1/I1) — ONE module used by
 * every chat write path (agent brain, Telegram adapter, conversation context,
 * thread turns) so refusal and redaction can't drift apart.
 *
 * Two different questions, deliberately different breadth:
 *  - classifySensitiveIds(text).refuse — should the brain refuse this message
 *    before anything sees it? Narrow: (a) a PERSONAL-id keyword (TFN/SIN/SSN,
 *    NAS, fr-CA/zh-CN equivalents) adjacent to a number passing THAT id's
 *    checksum, or (b) an unlabelled 9-digit number passing the TFN or SIN
 *    checksum with no business/document prefix (ABN, ACN, BN, EIN, invoice,
 *    INV, order, ref, PO, account…) just before it. Invoice numbers, ABNs,
 *    bank/routing numbers and EINs are business data and go through.
 *  - redactSensitiveIds(text) — what may be STORED. Broad: any checksum-valid
 *    TFN/SIN 9-digit number and any valid-shape SSN, regardless of keyword.
 */

const SEP = '[\\s.-]?';
/** 9 digits, optionally grouped 3-3-3 or 3-2-4 with one separator kind. */
const NINE = `(?<![\\d])\\d{3}${SEP}\\d{2,3}${SEP}\\d{3,4}(?![\\d])`;

const digitsOf = (s: string) => s.replace(/\D/g, '');

export function isValidTfn(raw: string): boolean {
  const d = digitsOf(raw);
  if (d.length !== 9) return false;
  const w = [1, 4, 3, 7, 5, 8, 6, 9, 10];
  return [...d].reduce((a, c, i) => a + Number(c) * w[i], 0) % 11 === 0;
}

export function isValidSin(raw: string): boolean {
  const d = digitsOf(raw);
  if (d.length !== 9 || d === '000000000') return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let n = Number(d[i]);
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

export function isValidSsn(raw: string): boolean {
  const d = digitsOf(raw);
  if (d.length !== 9) return false;
  const area = d.slice(0, 3), group = d.slice(3, 5), serial = d.slice(5);
  return area !== '000' && area !== '666' && area[0] !== '9' && group !== '00' && serial !== '0000';
}

type IdKind = 'tfn' | 'sin' | 'ssn';
const KEYWORDS: Array<{ kind: IdKind; re: string }> = [
  { kind: 'tfn', re: "\\btfn\\b|\\btax\\s+file\\s+(?:number|no\\.?|#)|税务档案号|税号" },
  { kind: 'sin', re: "\\bsin\\b|\\bsocial\\s+insurance(?:\\s+(?:number|no\\.?|#))?|\\bnas\\b|num[ée]ro\\s+d['’]assurance\\s+sociale|社会保险号(?:码)?" },
  { kind: 'ssn', re: "\\bssn\\b|\\bsocial\\s+security(?:\\s+(?:number|no\\.?|#))?|社会安全号(?:码)?|社会保障号(?:码)?" },
];
const CHECK: Record<IdKind, (s: string) => boolean> = { tfn: isValidTfn, sin: isValidSin, ssn: isValidSsn };

/** Business/document context words that make an unlabelled 9-digit number NOT personal. */
const BUSINESS_PREFIX = /\b(abn|acn|bn|ein|gst|hst|qst|vat|invoice|inv|order|ref|reference|po|account|acct|routing|bsb|receipt|tracking|confirmation|policy|booking|ticket|case|number\s+of)\b[^\d]{0,20}$/i;
/** Words a few tokens before that count as "within a few words". */
function hasBusinessPrefix(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index);
  return BUSINESS_PREFIX.test(before) || /(?:#|no\.?)\s*$/i.test(before);
}

export interface SensitiveIdFinding {
  /** Message should be refused before the brain sees it. */
  refuse: boolean;
  /** A personal-id keyword was followed by a number that FAILED its checksum. */
  labelledInvalid: IdKind | null;
}

export function classifySensitiveIds(text: string): SensitiveIdFinding {
  const s = text || '';
  let labelledInvalid: IdKind | null = null;
  const labelled = new Set<number>();
  for (const { kind, re } of KEYWORDS) {
    const r = new RegExp(`(?:${re})[^\\d]{0,25}(${NINE})`, 'gi');
    for (const m of s.matchAll(r)) {
      const num = m[1];
      labelled.add((m.index ?? 0) + m[0].length - num.length);
      if (CHECK[kind](num)) return { refuse: true, labelledInvalid: null };
      labelledInvalid ??= kind;
    }
  }
  for (const m of s.matchAll(new RegExp(NINE, 'g'))) {
    const idx = m.index ?? 0;
    if (labelled.has(idx)) continue;
    if ((isValidTfn(m[0]) || isValidSin(m[0])) && !hasBusinessPrefix(s, idx)) return { refuse: true, labelledInvalid: null };
  }
  return { refuse: false, labelledInvalid };
}

/** Redact for storage/logging: checksum-valid TFN/SIN and valid-shape SSN, any context. */
export function redactSensitiveIds(text: string): string {
  return (text || '').replace(new RegExp(NINE, 'g'), (m) => {
    const ssnShape = /^\d{3}[\s.-]\d{2}[\s.-]\d{4}$/.test(m);
    return isValidTfn(m) || isValidSin(m) || (ssnShape && isValidSsn(m)) ? '[redacted]' : m;
  });
}

/** Redact every STRING value in a JSON-like value (numbers such as ids are left alone). */
export function redactSensitiveDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSensitiveIds(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactSensitiveDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactSensitiveDeep(v);
    return out as T;
  }
  return value;
}
