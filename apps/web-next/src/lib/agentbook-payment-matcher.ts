/**
 * Payment matcher — scores how likely a bank transaction maps to a
 * specific outstanding invoice (incoming credit) or recent expense
 * (outgoing debit). The scorer is pure (no DB); the orchestrator
 * `matchTransaction` wraps it with Prisma queries.
 *
 * Score bands the orchestrator uses:
 *   ≥ AUTO_MATCH_THRESHOLD (0.85) → auto-match (mark invoice paid)
 *   ≥ REVIEW_THRESHOLD     (0.55) → queue for review (matchStatus='exception')
 *   <  REVIEW_THRESHOLD            → leave pending
 *
 * Scoring is a weighted sum of three signals:
 *   - amount agreement (50% weight) — must be within ±0.5% or ±$1, else 0
 *   - date proximity   (30% weight) — must be within ±DATE_WINDOW_DAYS, else 0
 *   - name overlap     (20% weight) — fuzzy match against client/vendor name
 *
 * Both amount and date are *gates*: if either fails we return 0 outright
 * (multiplying through doesn't help when the candidate is impossible).
 * Name is additive — it disambiguates between two same-amount candidates.
 */

import 'server-only';
import { prisma as db } from '@naap/database';

// === Public threshold constants ===

/** Score at/above this auto-applies the match (e.g. mark invoice paid). */
export const AUTO_MATCH_THRESHOLD = 0.85;

/** Score in [REVIEW_THRESHOLD, AUTO_MATCH_THRESHOLD) is queued for review. */
export const REVIEW_THRESHOLD = 0.55;

// === Internal tuning knobs (commented for the auditor's benefit) ===

/** Max days between txn.date and invoice.issuedDate / expense.date. */
const DATE_WINDOW_DAYS = 3;

/**
 * Amount tolerance — Plaid amounts can drift by sub-cent rounding,
 * and bank-side fees (Stripe, wire fee, etc.) may shave cents off.
 * 0.5% or $1, whichever is larger, accommodates both.
 */
const AMOUNT_TOLERANCE_PCT = 0.005;
const AMOUNT_TOLERANCE_MIN_CENTS = 100;

const AMOUNT_WEIGHT = 0.5;
const DATE_WEIGHT = 0.3;
const NAME_WEIGHT = 0.2;

const ONE_DAY_MS = 86_400_000;

// === Public types ===

export interface MatchableTxn {
  id: string;
  /** Cents. Negative = inflow (credit / payment received). Positive = outflow. */
  amountCents: number;
  date: Date;
  name: string;
  merchantName: string | null;
}

export interface MatchableInvoice {
  id: string;
  amountCents: number;
  issuedDate: Date;
  dueDate: Date;
  status: string;
  clientName: string | null;
}

export interface MatchableExpense {
  id: string;
  amountCents: number;
  date: Date;
  description: string | null;
  vendorName: string | null;
}

export type MatchKind = 'invoice' | 'expense' | 'none';

export interface MatchResult {
  kind: MatchKind;
  score: number;
  targetId?: string;
}

// === Helpers ===

function withinAmountTolerance(a: number, b: number): boolean {
  const diff = Math.abs(a - b);
  const tol = Math.max(AMOUNT_TOLERANCE_MIN_CENTS, Math.round(b * AMOUNT_TOLERANCE_PCT));
  return diff <= tol;
}

function amountScore(a: number, b: number): number {
  // 1.0 when exact, gentle quarter-decay across the window — the gate
  // already filtered anything outside tol, so within-tol differences
  // (sub-cent rounding, fees) shouldn't drag the score down hard.
  const tol = Math.max(AMOUNT_TOLERANCE_MIN_CENTS, Math.round(b * AMOUNT_TOLERANCE_PCT));
  const diff = Math.abs(a - b);
  if (diff > tol) return 0;
  // 0 diff → 1.0, full-tol diff → 0.75
  return 1 - 0.25 * (diff / Math.max(tol, 1));
}

function dateScore(txnDate: Date, refDate: Date): number {
  // Within the window we score on a soft curve so a 1-day gap (extremely
  // common: invoice issued Mon, ACH lands Tue) is barely penalized. Beyond
  // the window we return 0 — the gate.
  const diffDays = Math.abs(txnDate.getTime() - refDate.getTime()) / ONE_DAY_MS;
  if (diffDays > DATE_WINDOW_DAYS) return 0;
  // 0 days → 1.0, 1 day → 0.95, 2 days → 0.8, 3 days → 0.55
  if (diffDays <= 1) return 1 - 0.05 * diffDays;
  return Math.max(0, 0.95 - 0.2 * (diffDays - 1));
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Levenshtein distance, capped at `max` for early exit. Used so we can
 * say "≤2 edits away" without paying the full O(n*m) for long strings.
 */
function levenshtein(a: string, b: string, max = 4): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    let minRow = curr[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < minRow) minRow = curr[j];
    }
    if (minRow > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return prev[b.length];
}

function nameScore(txnText: string, refName: string | null): number {
  if (!refName) return 0.3; // neutral — no name to compare against
  const t = normalize(txnText);
  const r = normalize(refName);
  if (!t || !r) return 0.3;

  // Substring match — bank descriptions often embed the merchant name.
  if (t.includes(r) || r.includes(t)) return 1;

  // Token-level overlap — "STRIPE TRF 9981" vs "Stripe Inc" share "stripe".
  // Tokens must be ≥3 chars to be meaningful; ≥4-char overlap (e.g. company
  // names like "Stripe", "Acme") is a much stronger signal than 3-char ("inc").
  const tTokens = new Set(t.split(' ').filter((x) => x.length >= 3));
  const rTokens = new Set(r.split(' ').filter((x) => x.length >= 3));
  let strongOverlap = 0;
  let weakOverlap = 0;
  for (const tok of tTokens) {
    if (rTokens.has(tok)) {
      if (tok.length >= 4) strongOverlap++;
      else weakOverlap++;
    }
  }
  if (strongOverlap > 0) {
    return Math.min(1, 0.85 + 0.05 * strongOverlap);
  }
  if (weakOverlap > 0) {
    const denom = Math.max(tTokens.size, rTokens.size, 1);
    return Math.min(1, 0.5 + 0.5 * (weakOverlap / denom));
  }

  // Fuzzy fallback — Levenshtein on the shorter token form.
  const dist = levenshtein(t.slice(0, 32), r.slice(0, 32), 3);
  if (dist <= 2) return 0.7;
  if (dist <= 3) return 0.5;
  return 0;
}

// === Public scorers ===

/**
 * Score how well a bank transaction matches an outstanding invoice.
 * Inputs are pre-fetched DB rows (see types above) — this function does
 * NOT touch the database, which makes it cheap to unit-test and cheap to
 * call inside a loop.
 */
export function scoreInvoiceMatch(txn: MatchableTxn, invoice: MatchableInvoice): number {
  // Inflows only — outflows can't be invoice payments.
  if (txn.amountCents >= 0) return 0;

  // Already-paid invoices don't accept new payments.
  if (invoice.status === 'paid' || invoice.status === 'void') return 0;

  // Plaid: incoming credits are negative; invoice amount is positive.
  const txnAbs = Math.abs(txn.amountCents);

  if (!withinAmountTolerance(txnAbs, invoice.amountCents)) return 0;
  const ds = dateScore(txn.date, invoice.issuedDate);
  if (ds === 0) return 0;

  const as = amountScore(txnAbs, invoice.amountCents);
  const ns = nameScore(`${txn.merchantName || ''} ${txn.name}`, invoice.clientName);

  return AMOUNT_WEIGHT * as + DATE_WEIGHT * ds + NAME_WEIGHT * ns;
}

/**
 * Score how well a bank transaction matches a recorded expense (outflow).
 * Mirror of `scoreInvoiceMatch` but for debits.
 */
export function scoreExpenseMatch(txn: MatchableTxn, expense: MatchableExpense): number {
  // Outflows only.
  if (txn.amountCents <= 0) return 0;

  if (!withinAmountTolerance(txn.amountCents, expense.amountCents)) return 0;
  const ds = dateScore(txn.date, expense.date);
  if (ds === 0) return 0;

  const as = amountScore(txn.amountCents, expense.amountCents);
  const ns = nameScore(
    `${txn.merchantName || ''} ${txn.name}`,
    expense.vendorName || expense.description,
  );

  return AMOUNT_WEIGHT * as + DATE_WEIGHT * ds + NAME_WEIGHT * ns;
}

// === DB-coupled orchestrator ===

/**
 * Find the best invoice/expense match for a transaction and return it.
 * Searches:
 *   - inflows: outstanding invoices (status in sent | viewed | overdue)
 *     within the date + amount window for this tenant
 *   - outflows: recent expenses without an existing bank match
 */
export async function matchTransaction(
  tenantId: string,
  txn: MatchableTxn,
): Promise<MatchResult> {
  const windowMs = DATE_WINDOW_DAYS * ONE_DAY_MS;
  const windowStart = new Date(txn.date.getTime() - windowMs);
  const windowEnd = new Date(txn.date.getTime() + windowMs);

  if (txn.amountCents < 0) {
    // Inflow → look for an outstanding invoice.
    const txnAbs = Math.abs(txn.amountCents);
    const tol = Math.max(
      AMOUNT_TOLERANCE_MIN_CENTS,
      Math.round(txnAbs * AMOUNT_TOLERANCE_PCT),
    );
    const candidates = await db.abInvoice.findMany({
      where: {
        tenantId,
        status: { in: ['sent', 'viewed', 'overdue'] },
        amountCents: { gte: txnAbs - tol, lte: txnAbs + tol },
        issuedDate: { gte: windowStart, lte: windowEnd },
      },
      include: { client: { select: { name: true } } },
      take: 20,
    });
    let best: MatchResult = { kind: 'none', score: 0 };
    for (const inv of candidates) {
      const score = scoreInvoiceMatch(txn, {
        id: inv.id,
        amountCents: inv.amountCents,
        issuedDate: inv.issuedDate,
        dueDate: inv.dueDate,
        status: inv.status,
        clientName: inv.client?.name || null,
      });
      if (score > best.score) {
        best = { kind: 'invoice', score, targetId: inv.id };
      }
    }
    return best;
  }

  if (txn.amountCents > 0) {
    // Outflow → look for a recent expense not already matched.
    const tol = Math.max(
      AMOUNT_TOLERANCE_MIN_CENTS,
      Math.round(txn.amountCents * AMOUNT_TOLERANCE_PCT),
    );
    const candidates = await db.abExpense.findMany({
      where: {
        tenantId,
        amountCents: { gte: txn.amountCents - tol, lte: txn.amountCents + tol },
        date: { gte: windowStart, lte: windowEnd },
        isPersonal: false,
      },
      include: { vendor: { select: { name: true } } },
      take: 20,
    });
    let best: MatchResult = { kind: 'none', score: 0 };
    for (const exp of candidates) {
      const score = scoreExpenseMatch(txn, {
        id: exp.id,
        amountCents: exp.amountCents,
        date: exp.date,
        description: exp.description,
        vendorName: exp.vendor?.name || null,
      });
      if (score > best.score) {
        best = { kind: 'expense', score, targetId: exp.id };
      }
    }
    return best;
  }

  return { kind: 'none', score: 0 };
}
