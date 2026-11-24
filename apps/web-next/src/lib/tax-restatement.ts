/**
 * Opt-in tax restatement of legacy gross expenses (spec §5.1, PR 2c).
 *
 * A registrant's purchase booked before tax codes existed (taxCode = null,
 * "untyped legacy") carries its GST/HST in the expense account. Restating it
 * types the row and re-books it as amend-reversal + 3-line repost through the
 * existing tax-aware repost (PR 2a) under the existing `expense_amend*` keys —
 * never a free-standing DR 2100 / CR category entry, which a later delete or
 * amend would orphan and the cash-basis view could not see.
 *
 * Rules (each is a test in lib/__tests__/tax-restatement.test.ts):
 *   - Opt-in, per tax year (AU: the 1 Jul – 30 Jun income year named by its
 *     ending year; CA: the calendar year), preview first.
 *   - Only AU/CA tenants with gstRegistered === true have anything to restate.
 *     US, UK, non-registrants and unknown registration: nothing (never guess).
 *   - Conservative inference: a row is restated only when it has a printed tax
 *     amount (taxAmountCents > 0); its code is the vendor's defaultTaxCode, else
 *     the jurisdiction default (AU GST; CA by province); the engine must agree
 *     with the stored tax within 2¢ (the same tolerance as OCR) or the row is
 *     skipped as `tax_mismatch`. Recoverable tax is never invented for a row
 *     with no tax amount, and never exceeds the stored tax.
 *   - Owner call 2 (confirmed): a row in a closed fiscal period is NOT restated;
 *     it is listed as skipped with reason `period_closed`.
 *   - Idempotent: a restated row is typed, so a second run finds it under
 *     "already typed" and writes nothing.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import { taxYearBounds, taxYearOfDate, currentTaxYear } from '@agentbook/jurisdictions/restatement-year';
import { resolveExpenseTax, isMealsAccount } from '@/lib/expense-tax';
import { taxJurisdictionOf, type TenantTaxContext } from '@/lib/tax-codes';
import { assertPeriodOpen, LedgerPeriodClosedError, LedgerKeyConflict } from '@/lib/ledger-writer';
import {
  repostExpenseJournalEntry,
  isExpenseEntryAlreadyReversed,
  ExpenseLedgerShapeError,
  ExpenseLedgerAlreadyReversedError,
} from '@/lib/agentbook-expense-ledger';

const TAX_CONTROL_CODE = '2100';

/** Rows one apply call processes (review I-2): bounded so the route always answers inside its time limit. */
export const RESTATEMENT_BATCH_SIZE = 100;
/** And a wall-clock budget, under the route's maxDuration (60 s). */
export const RESTATEMENT_TIME_BUDGET_MS = 40_000;

export type RestatementSkipReason =
  | 'period_closed'
  | 'tax_mismatch'
  | 'nothing_recoverable'
  | 'no_tax_account'
  | 'already_reversed'
  | 'unsupported_shape'
  | 'currency_mismatch';

export type RestatementNotApplicable = 'unsupported_jurisdiction' | 'not_registered';

export interface RestatementRow {
  expenseId: string;
  date: string;
  description: string;
  amountCents: number;
  taxAmountCents: number;
  /** The code the row would be typed with. */
  taxCode: string | null;
  /** Recoverable tax the restatement moves from the expense account to 2100. */
  recoverableTaxCents: number;
}

export interface SkippedRestatementRow extends RestatementRow {
  reason: RestatementSkipReason;
}

export interface FailedRestatementRow extends RestatementRow {
  /** Unexpected error; the row was rolled back and stays eligible for the next run. */
  reason: 'error';
}

export interface RestatementPreview {
  year: number;
  jurisdiction: string;
  from: string;
  /** Inclusive last day of the tax year. */
  to: string;
  applicable: boolean;
  notApplicableReason?: RestatementNotApplicable;
  eligible: RestatementRow[];
  skipped: SkippedRestatementRow[];
  counts: {
    eligible: number;
    skippedClosed: number;
    skippedOther: number;
    alreadyTyped: number;
    /** Legacy rows with no tax amount: left as they are (nothing to recover). */
    noTaxAmount: number;
  };
  /** Σ recoverable tax of the eligible rows. */
  recoverableTaxCents: number;
  /** Change to total expenses on the P&L (negative: expenses go down). */
  expenseDeltaCents: number;
  /** Change to net profit on the P&L (= −expenseDeltaCents). */
  netProfitDeltaCents: number;
}

/**
 * What ONE apply call did, row by row. `restated` are committed; `failed`
 * were rolled back; `remaining` eligible rows were not reached this call
 * (batch / time budget) — call again to continue: restated rows are typed, so
 * a re-run picks up exactly the rows still untyped.
 */
export interface RestatementApplyResult extends RestatementPreview {
  restated: RestatementRow[];
  failed: FailedRestatementRow[];
  remaining: number;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** [from, toExclusive) of a tax year (shared definition: @agentbook/jurisdictions/restatement-year). */
export function restatementYearBounds(jurisdiction: string | null | undefined, year: number): { from: Date; toExclusive: Date } {
  const b = taxYearBounds(jurisdiction, year);
  return { from: b.from, toExclusive: b.toExclusive };
}

/** The tax year a date falls in. */
export function restatementYearOf(jurisdiction: string | null | undefined, date: Date): number {
  return taxYearOfDate(jurisdiction, day(date));
}

/** The default tax year for a tenant: today's date in its zone. */
export function defaultRestatementYear(cfg: { jurisdiction?: string | null; timezone?: string | null } | null | undefined, now = new Date()): number {
  return currentTaxYear(cfg?.jurisdiction || 'us', now, cfg?.timezone ?? null);
}

type Client = typeof db;

interface Candidate {
  row: RestatementRow;
  entryId: string;
}

interface Classified {
  jurisdiction: string;
  bounds: { from: Date; toExclusive: Date };
  applicable: boolean;
  notApplicableReason?: RestatementNotApplicable;
  eligible: Candidate[];
  skipped: SkippedRestatementRow[];
  alreadyTyped: number;
  noTaxAmount: number;
}

async function classify(client: Client, tenantId: string, year: number): Promise<Classified> {
  const cfg = await client.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const jurisdiction = (cfg?.jurisdiction || 'us').toLowerCase();
  const bounds = restatementYearBounds(jurisdiction, year);
  const base: Classified = { jurisdiction, bounds, applicable: false, eligible: [], skipped: [], alreadyTyped: 0, noTaxAmount: 0 };
  const j = taxJurisdictionOf(jurisdiction);
  if (j !== 'au' && j !== 'ca') return { ...base, notApplicableReason: 'unsupported_jurisdiction' };
  if (cfg?.gstRegistered !== true) return { ...base, notApplicableReason: 'not_registered' };

  const tenant: TenantTaxContext = {
    jurisdiction,
    region: cfg?.region ?? null,
    gstRegistered: cfg?.gstRegistered ?? null,
    qstRegistered: (cfg as { qstRegistered?: boolean | null } | null)?.qstRegistered ?? null,
  };
  const tenantCurrency = String((cfg as { currency?: string | null } | null)?.currency || '').toUpperCase();
  const out: Classified = { ...base, applicable: true };

  const rows = await client.abExpense.findMany({
    where: {
      tenantId,
      isPersonal: false,
      deletedAt: null,
      status: 'confirmed',
      date: { gte: bounds.from, lt: bounds.toExclusive },
    },
    orderBy: { date: 'asc' },
  });
  const taxControl = await client.abAccount.findFirst({ where: { tenantId, code: TAX_CONTROL_CODE }, select: { id: true } });

  // Batched lookups (review I-2): vendors once, accounts once.
  const vendorIds = [...new Set(rows.map((e) => e.vendorId).filter((x): x is string => !!x))];
  const vendors = vendorIds.length
    ? await client.abVendor.findMany({ where: { tenantId, id: { in: vendorIds } } })
    : [];
  const vendorCode = new Map(vendors.map((v) => [v.id, (v as { defaultTaxCode?: string | null }).defaultTaxCode ?? null]));
  const accounts = await client.abAccount.findMany({ where: { tenantId } });
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const periodOpen = new Map<string, boolean>();
  const isOpen = async (d: Date) => {
    const k = d.toISOString().slice(0, 7);
    if (!periodOpen.has(k)) {
      try {
        await assertPeriodOpen(client, tenantId, d);
        periodOpen.set(k, true);
      } catch (err) {
        if (!(err instanceof LedgerPeriodClosedError)) throw err;
        periodOpen.set(k, false);
      }
    }
    return periodOpen.get(k) as boolean;
  };

  for (const e of rows) {
    if (!e.journalEntryId) continue; // off the books: nothing to restate
    const typedCode = (e as { taxCode?: string | null }).taxCode;
    if (typeof typedCode === 'string' && typedCode !== '') { out.alreadyTyped++; continue; }
    const taxAmount = e.taxAmountCents ?? 0;
    if (!(taxAmount > 0) || taxAmount >= e.amountCents) { out.noTaxAmount++; continue; }

    const baseRow: RestatementRow = {
      expenseId: e.id,
      date: day(e.date),
      description: e.description || '',
      amountCents: e.amountCents,
      taxAmountCents: taxAmount,
      taxCode: null,
      recoverableTaxCents: 0,
    };
    const skip = (reason: RestatementSkipReason, row: RestatementRow = baseRow) => out.skipped.push({ ...row, recoverableTaxCents: 0, reason });

    // M-4: amounts are never converted; a row in another currency than the
    // tenant's would be priced against the wrong rates. Expense create
    // defaults currency to 'USD' when a client sends none, so for an AUD/CAD
    // tenant such a row is listed here rather than guessed.
    const rowCurrency = String((e as { currency?: string | null }).currency || '').toUpperCase();
    if (tenantCurrency && rowCurrency && rowCurrency !== tenantCurrency) { skip('currency_mismatch'); continue; }

    // The booked entry decides the shape, the date and the account (M-1, M-2).
    const entry = await client.abJournalEntry.findFirst({ where: { id: e.journalEntryId, tenantId } });
    const lines = entry ? (await client.abJournalLine.findMany({ where: { entryId: entry.id } })) || [] : [];
    const debits = lines.filter((l) => l.debitCents > 0);
    const credits = lines.filter((l) => l.creditCents > 0);
    const plain =
      !!entry && !!taxControl &&
      lines.length === 2 && debits.length === 1 && credits.length === 1 &&
      debits[0].accountId !== taxControl.id &&
      debits[0].debitCents === e.amountCents && credits[0].creditCents === e.amountCents &&
      // M-1: the repost would also MOVE the debit to categoryId if they
      // differ; preview and apply must price the same account, so a drifted
      // row is not restated automatically.
      (!e.categoryId || debits[0].accountId === e.categoryId);
    if (taxControl && !plain) { skip('unsupported_shape'); continue; }

    const booked = debits[0] ? accountById.get(debits[0].accountId) : undefined;
    const resolved = resolveExpenseTax({
      tenant,
      vendorDefaultTaxCode: e.vendorId ? vendorCode.get(e.vendorId) ?? null : null,
      amountCents: e.amountCents,
      isMeal: isMealsAccount((booked ?? null) as { name?: string | null; taxCategory?: string | null } | null),
      printedTaxCents: taxAmount,
    });
    const row: RestatementRow = { ...baseRow, taxCode: resolved.taxCode, recoverableTaxCents: resolved.recoverableTaxCents };

    if (!resolved.taxCode || resolved.taxReview) { skip('tax_mismatch', row); continue; }
    if (!(resolved.recoverableTaxCents > 0) || resolved.recoverableTaxCents > taxAmount) { skip('nothing_recoverable', row); continue; }
    // M-2: the repost reverses on the ORIGINAL entry's date and books on the
    // expense date — both months must be open.
    if (!(await isOpen(e.date)) || (entry && !(await isOpen(entry.date)))) { skip('period_closed', row); continue; }
    if (!taxControl) { skip('no_tax_account', row); continue; }
    if (await isExpenseEntryAlreadyReversed(client, tenantId, e.id, e.journalEntryId, lines)) { skip('already_reversed', row); continue; }

    out.eligible.push({ row, entryId: e.journalEntryId });
  }
  return out;
}

function summarise(year: number, c: Classified, eligible: RestatementRow[], skipped: SkippedRestatementRow[]): RestatementPreview {
  const recoverable = eligible.reduce((s, r) => s + r.recoverableTaxCents, 0);
  const closed = skipped.filter((s) => s.reason === 'period_closed').length;
  return {
    year,
    jurisdiction: c.jurisdiction,
    from: day(c.bounds.from),
    to: day(new Date(c.bounds.toExclusive.getTime() - 86_400_000)),
    applicable: c.applicable,
    ...(c.notApplicableReason ? { notApplicableReason: c.notApplicableReason } : {}),
    eligible,
    skipped,
    counts: {
      eligible: eligible.length,
      skippedClosed: closed,
      skippedOther: skipped.length - closed,
      alreadyTyped: c.alreadyTyped,
      noTaxAmount: c.noTaxAmount,
    },
    recoverableTaxCents: recoverable,
    expenseDeltaCents: -recoverable,
    netProfitDeltaCents: recoverable,
  };
}

/** What restating `year` would do. Read-only. */
export async function previewTaxRestatement(tenantId: string, year: number, client: Client = db): Promise<RestatementPreview> {
  const c = await classify(client, tenantId, year);
  return summarise(year, c, c.eligible.map((x) => x.row), c.skipped);
}

class Skip extends Error {
  constructor(readonly reason: RestatementSkipReason | 'already_typed') { super(reason); }
}

/**
 * Restate `year` (or only `opts.expenseIds` within it): for each eligible row,
 * in its own transaction, type it (taxCode + recoverableTaxCents;
 * taxAmountCents is unchanged) and repost it through
 * repostExpenseJournalEntry, which writes the amend-reversal of the current
 * entry and the 3-line replacement under `expense_amend*` keys.
 * The updateMany guard (taxCode still null, entry unchanged) makes a concurrent
 * or repeated run a no-op for that row.
 *
 * Never throws after a commit (review I-2): every row ends in exactly one of
 * restated / skipped / failed / remaining, and the counts describe what was
 * actually written. At most `opts.limit` rows (and RESTATEMENT_TIME_BUDGET_MS)
 * per call.
 */
export async function applyTaxRestatement(
  tenantId: string,
  year: number,
  client: Client = db,
  opts: { expenseIds?: string[]; limit?: number; timeBudgetMs?: number; now?: () => number } = {},
): Promise<RestatementApplyResult> {
  const c = await classify(client, tenantId, year);
  if (opts.expenseIds) {
    const only = new Set(opts.expenseIds);
    c.eligible = c.eligible.filter((x) => only.has(x.row.expenseId));
    c.skipped = c.skipped.filter((x) => only.has(x.expenseId));
  }
  const limit = Math.max(1, opts.limit ?? RESTATEMENT_BATCH_SIZE);
  const budget = opts.timeBudgetMs ?? RESTATEMENT_TIME_BUDGET_MS;
  const clock = opts.now ?? Date.now;
  const started = clock();

  const restated: RestatementRow[] = [];
  const failed: FailedRestatementRow[] = [];
  const skipped: SkippedRestatementRow[] = [...c.skipped];
  let alreadyTyped = c.alreadyTyped;
  let processed = 0;

  for (const { row, entryId } of c.eligible) {
    if (processed >= limit || clock() - started > budget) break;
    processed++;
    try {
      await client.$transaction(async (tx) => {
        const n = await tx.abExpense.updateMany({
          where: { id: row.expenseId, tenantId, taxCode: null, journalEntryId: entryId, deletedAt: null },
          data: { taxCode: row.taxCode, recoverableTaxCents: row.recoverableTaxCents },
        });
        if (n.count !== 1) throw new Skip('already_typed');
        const r = await repostExpenseJournalEntry(tenantId, row.expenseId, tx as unknown as Parameters<typeof repostExpenseJournalEntry>[2]);
        if (!r.reposted) throw new Skip('unsupported_shape');
      });
      restated.push(row);
    } catch (err) {
      const reason: RestatementSkipReason | 'already_typed' | null =
        err instanceof Skip ? err.reason
        : err instanceof LedgerPeriodClosedError ? 'period_closed'
        : err instanceof ExpenseLedgerAlreadyReversedError ? 'already_reversed'
        : err instanceof ExpenseLedgerShapeError ? 'unsupported_shape'
        : err instanceof LedgerKeyConflict || (err as { code?: string })?.code === 'P2002' ? 'already_typed'
        : null;
      if (reason === 'already_typed') alreadyTyped++;
      else if (reason) skipped.push({ ...row, recoverableTaxCents: 0, reason });
      else {
        console.error('[tax-restatement] row failed, rolled back:', row.expenseId, err);
        failed.push({ ...row, recoverableTaxCents: 0, reason: 'error' });
      }
    }
  }
  return {
    ...summarise(year, { ...c, alreadyTyped }, restated, skipped),
    restated,
    failed,
    remaining: c.eligible.length - processed,
  };
}
