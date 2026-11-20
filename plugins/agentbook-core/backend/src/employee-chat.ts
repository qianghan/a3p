/**
 * Employee / pay-frequency chat helpers (PR 4e, spec §5.5, R-EMP-5).
 *
 * Pure functions only — the skill handlers in server.ts do the I/O. Chat may
 * read and edit NON-sensitive employee fields (pay frequency, pay rate). Tax
 * ids (TFN/SIN/SSN), bank and super member numbers are never read, set or
 * echoed by chat: edits go through the profile screen, and a message that
 * CONTAINS such a value is refused before anything is persisted
 * (see containsSensitiveTaxId + agent-brain.ts handleAgentMessage).
 */

export const PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly'] as const;
export type PayFrequency = typeof PAY_FREQUENCIES[number];

/**
 * Chat-catalog key for a frequency label. Mirrors frequencyLabelKey(f, j, 'agent')
 * in apps/web-next/src/lib/payroll-frequency.ts (core cannot import web lib);
 * apps/web-next/src/__tests__/lib/employee-chat-label-parity.test.ts pins the two together.
 */
export function agentFrequencyLabelKey(frequency: string, jurisdiction: string): string {
  if (frequency === 'biweekly' && jurisdiction === 'au') return 'agent.fortnightly';
  const seg: Record<string, string> = { weekly: 'weekly', biweekly: 'bi_weekly', semimonthly: 'semi_monthly', monthly: 'monthly' };
  return `agent.${seg[frequency] ?? 'bi_weekly'}`;
}

// ── Sensitive identifiers ────────────────────────────────────────────────
// SSN 123-45-6789 · SIN/TFN 123-456-789 / 123 456 789 (separated groups, so a
// phone 123-456-7890 or an invoice number does not match) · or any 8–9 digit
// run right after a tax-id keyword ("my TFN is 123456782").
const GROUPED_ID = /(?<!\d)\d{3}[-\s.]\d{2}[-\s.]\d{4}(?!\d)|(?<!\d)\d{3}[-\s.]\d{3}[-\s.]\d{3}(?![-\s.]?\d)/;
const KEYWORD = /\b(ssn|sin|tfn|itin|social\s+security|social\s+insurance|tax\s+file|tax\s+id|bank\s+account|account\s+number|bsb|routing|member\s+number)\b/i;
const KEYWORD_THEN_DIGITS = new RegExp(`${KEYWORD.source}[^\\d]{0,20}\\d[\\d\\s-]{5,}`, 'i');

export function containsSensitiveTaxId(text: string): boolean {
  const s = text || '';
  return GROUPED_ID.test(s) || KEYWORD_THEN_DIGITS.test(s);
}

/** Redact anything containsSensitiveTaxId would flag — for persistence/logging. */
export function redactSensitive(text: string): string {
  let s = text || '';
  s = s.replace(new RegExp(GROUPED_ID.source, 'g'), '[redacted]');
  s = s.replace(new RegExp(`(${KEYWORD.source}[^\\d]{0,20})\\d[\\d\\s-]{5,}`, 'gi'), (_m, lead) => `${lead}[redacted]`);
  return s;
}

/** Does the user ask to change/see a sensitive field (no value needed)? */
export function mentionsSensitiveField(text: string): boolean {
  return KEYWORD.test(text || '');
}

// ── Employee matching ───────────────────────────────────────────────────
export interface EmployeeLike { id: string; name: string }

/** Employees whose full name or any name part appears as a word in text. */
export function matchEmployees<T extends EmployeeLike>(text: string, employees: T[]): T[] {
  const lower = (text || '').toLowerCase();
  const word = (w: string) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}('s)?($|[^\\p{L}])`, 'u').test(lower);
  const full = employees.filter((e) => word(e.name.toLowerCase()));
  if (full.length) return full;
  return employees.filter((e) => e.name.toLowerCase().split(/\s+/).filter((p) => p.length >= 2).some(word));
}

// ── Edit parsing ────────────────────────────────────────────────────────
export function parseFrequency(text: string): PayFrequency | null {
  const s = (text || '').toLowerCase();
  if (/semi-?\s?monthly|twice a month|bimensuel|每半月/.test(s)) return 'semimonthly';
  if (/fortnight|bi-?\s?weekly|every (two|2) weeks|aux deux semaines|每两周/.test(s)) return 'biweekly';
  if (/\bweekly\b|every week|hebdomadaire|每周/.test(s)) return 'weekly';
  if (/\bmonthly\b|every month|mensuel|每月/.test(s)) return 'monthly';
  return null;
}

/** "$80k" → 8_000_000, "$85,000" → 8_500_000, "45.50/hr" → 4_550. Null when no amount. */
export function parseRateCents(text: string): number | null {
  // A $-prefixed amount wins; otherwise a standalone number (not part of a word
  // such as an employee tag "E2E…A3").
  const re = (pre: string) => new RegExp(`${pre}(\\d{1,3}(?:,\\d{3})+|\\d+)(\\.\\d{1,2})?\\s*(k)?\\b`, 'i');
  const m = re('\\$\\s*').exec(text || '') ?? re('(?<![\\w.$])').exec(text || '');
  if (!m) return null;
  let v = Number(m[1].replace(/,/g, '') + (m[2] ?? ''));
  if (m[3]) v *= 1000;
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 100);
}

export type EmployeeEdit =
  | { kind: 'sensitive' }
  | { kind: 'payFrequency'; value: PayFrequency }
  | { kind: 'payRateCents'; value: number }
  | { kind: 'none' };

/** What field the user asked to change. Sensitive always wins (refusal). */
export function parseEmployeeEdit(text: string): EmployeeEdit {
  if (mentionsSensitiveField(text) || containsSensitiveTaxId(text)) return { kind: 'sensitive' };
  const s = (text || '').toLowerCase();
  if (/\b(rate|salary|wage|pay\s+rate|hourly)\b|\$\s*\d/.test(s)) {
    const cents = parseRateCents(text);
    if (cents !== null) return { kind: 'payRateCents', value: cents };
  }
  const f = parseFrequency(text);
  if (f) return { kind: 'payFrequency', value: f };
  return { kind: 'none' };
}

/** A PUT body containing ONLY non-sensitive keys (the route re-validates it). */
export function editToPutBody(edit: EmployeeEdit): Record<string, unknown> | null {
  if (edit.kind === 'payFrequency') return { payFrequency: edit.value };
  if (edit.kind === 'payRateCents') return { payRateCents: edit.value };
  return null;
}
