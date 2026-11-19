/**
 * Purchases engine — accounts-payable bills (spec §5.2, PR 3bc).
 *
 * Two posting modes, distinguished ONLY by `AbBill.postingMode` (never by the
 * journal sourceType — legacy entries also use 'bill'):
 *
 *   at_entry   bill entered:  DR expense per line (net + non-recoverable tax)
 *                             | DR 2100 recoverable | CR 2000 gross      bill / bill.id
 *              payment:      DR 2000 | CR 1000                        bill_payment / payment.id
 *              void unpaid:  mirror of the current bill entry         bill_void / bill.id
 *              void payment: mirror of that payment entry             bill_payment_void / payment.id
 *              amend open:   reversal of the current entry            bill_amend_reversal / <entryId>
 *                            then the new entry                       bill_amend / <bill.id>:<revision>
 *   at_payment legacy rows + cash-basis tenants: nothing at entry; payment
 *              posts DR expense / CR 1000 keyed 'bill' / payment.id (legacy
 *              entries with sourceId null are left alone). Full payment only.
 *
 * Concurrency: every state change is guarded by an optimistic
 * `updateMany({ where: { id, paidCents, revision, status } })`; a lost race
 * re-reads and retries (an overpayment detected on the re-read is a 422).
 * Idempotency keys have no unique index, so a keyed create looks up first
 * inside the transaction AND uses an id derived from (tenant, key): two
 * concurrent same-key requests collide on the primary key, and the loser
 * replays the winner's row.
 *
 * Legacy rule: a legacy at_payment bill can be status 'paid' with paidCents 0.
 * Status is authoritative for "paid"; never derive it from paidCents there.
 */
import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendBalancedEntry,
  assertPeriodOpen,
  LedgerKeyConflict,
  LedgerPeriodClosedError,
  type LedgerLine,
} from '@/lib/ledger-writer';
import { resolveExpenseTax, isMealsAccount } from '@/lib/expense-tax';
import { TaxCodeError } from '@/lib/tax-codes';
import { ensureChartOfAccounts, ensureUncategorizedAccount, CASH_CODE } from '@/lib/agentbook-chart-of-accounts';
import { suggestCategory } from '@/lib/agentbook-suggest-category';

export const AP_CODE = '2000';
export const RECOVERABLE_TAX_CODE = '2100';
const MAX_ATTEMPTS = 8;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;
/** The Prisma client (or a transaction-capable test double). */
export type PurchasesDb = any;

export class PurchaseError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'PurchaseError';
  }
}

/** Where-fragment: a bill that still exists (soft delete). */
export function liveBillWhere() {
  return { deletedAt: null } as const;
}

export interface BillLineInput {
  description: string;
  /** GROSS amount of the line (tax-inclusive, as printed). */
  amountCents: number;
  /** AbAccount id of an expense account; absent → suggestion → 6999. */
  categoryId?: string | null;
  /** Tax code; null = explicitly untyped; undefined = vendor/tenant default. */
  taxCode?: string | null;
  printedTaxCents?: number | null;
}

export interface BillInput {
  vendorName: string;
  vendorId?: string | null;
  billNumber?: string | null;
  description?: string | null;
  billDate: Date;
  dueDate: Date;
  currency?: string | null;
  lines: BillLineInput[];
  postingMode?: 'at_entry' | 'at_payment';
  idempotencyKey?: string | null;
  receiptUrl?: string | null;
}

/** A UUID-shaped id derived from (scope, tenant, key) — the replay backstop. */
export function idFromKey(scope: string, tenantId: string, key: string): string {
  const h = createHash('sha256').update(`${scope}\u0000${tenantId}\u0000${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const isP2002 = (e: unknown) => (e as { code?: string })?.code === 'P2002';
const intCents = (n: unknown) => typeof n === 'number' && Number.isInteger(n);

function periodError(err: unknown): never {
  if (err instanceof LedgerPeriodClosedError) throw new PurchaseError(422, 'period_closed', err.message);
  throw err;
}

class StaleWrite {}

/* ----------------------------------------------------------------- accounts */

async function accountByCode(db: PurchasesDb, tenantId: string, code: string): Promise<{ id: string }> {
  let a = await db.abAccount.findFirst({ where: { tenantId, code } });
  if (!a) {
    await ensureChartOfAccounts(tenantId);
    a = await db.abAccount.findFirst({ where: { tenantId, code } });
  }
  if (!a) throw new PurchaseError(422, 'ledger_account_missing', `Account ${code} not found`);
  return a;
}

async function suspenseAccount(tenantId: string): Promise<{ id: string }> {
  return ensureUncategorizedAccount(tenantId);
}

/* -------------------------------------------------------------------- lines */

interface ResolvedLine {
  description: string;
  categoryId: string;
  amountCents: number;
  taxCode: string | null;
  taxCents: number;
  recoverableTaxCents: number;
}

async function resolveLines(db: PurchasesDb, tenantId: string, cfg: Row | null, input: Pick<BillInput, 'vendorName' | 'lines'>, vendorDefaultTaxCode: string | null): Promise<ResolvedLine[]> {
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new PurchaseError(400, 'bill_lines_required');
  const out: ResolvedLine[] = [];
  for (const l of input.lines) {
    if (!intCents(l.amountCents) || l.amountCents <= 0) throw new PurchaseError(400, 'invalid_amount');
    let account: Row | null = null;
    if (l.categoryId) {
      account = await db.abAccount.findFirst({ where: { id: l.categoryId, tenantId, accountType: 'expense', isActive: true } });
      if (!account) throw new PurchaseError(422, 'invalid_category');
    } else {
      const s = await suggestCategory(tenantId, { vendor: input.vendorName, description: l.description, amountCents: l.amountCents });
      if (s?.categoryId) account = await db.abAccount.findFirst({ where: { id: s.categoryId, tenantId } });
      if (!account) account = await suspenseAccount(tenantId);
    }
    let tax;
    try {
      tax = resolveExpenseTax({
        tenant: cfg as never,
        taxCode: l.taxCode,
        vendorDefaultTaxCode,
        amountCents: l.amountCents,
        isMeal: isMealsAccount(account as never),
        printedTaxCents: l.printedTaxCents,
      });
    } catch (err) {
      if (err instanceof TaxCodeError) throw new PurchaseError(422, 'invalid_tax_code', err.message);
      throw err;
    }
    out.push({
      description: l.description,
      categoryId: account!.id,
      amountCents: l.amountCents,
      taxCode: tax.taxCode,
      taxCents: tax.taxAmountCents ?? 0,
      recoverableTaxCents: tax.recoverableTaxCents,
    });
  }
  return out;
}

async function entryLines(db: PurchasesDb, tenantId: string, lines: ResolvedLine[], vendor: string): Promise<LedgerLine[]> {
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  const recoverable = lines.reduce((s, l) => s + l.recoverableTaxCents, 0);
  const ap = await accountByCode(db, tenantId, AP_CODE);
  const out: LedgerLine[] = lines.map((l) => ({
    accountId: l.categoryId, debitCents: l.amountCents - l.recoverableTaxCents, creditCents: 0, description: l.description,
  }));
  if (recoverable > 0) {
    const gst = await accountByCode(db, tenantId, RECOVERABLE_TAX_CODE);
    out.push({ accountId: gst.id, debitCents: recoverable, creditCents: 0, description: `Recoverable tax: ${vendor}` });
  }
  out.push({ accountId: ap.id, debitCents: 0, creditCents: total, description: `Bill: ${vendor}` });
  return out;
}

async function mirrorOf(db: PurchasesDb, entryId: string): Promise<LedgerLine[]> {
  const ls: Row[] = await db.abJournalLine.findMany({ where: { entryId } });
  return ls.map((l) => ({ accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents, description: l.description ?? null }));
}

async function tenantConfig(db: PurchasesDb, tenantId: string): Promise<Row | null> {
  return db.abTenantConfig.findUnique({ where: { userId: tenantId } });
}

async function loadBill(db: PurchasesDb, tenantId: string, billId: string): Promise<Row> {
  const bill = await db.abBill.findFirst({ where: { id: billId, tenantId, ...liveBillWhere() } });
  if (!bill) throw new PurchaseError(404, 'bill_not_found');
  return bill;
}

/** Run `step` until it stops losing optimistic races (or a P2002 replay settles it). */
async function withRetry<T>(step: () => Promise<T | StaleWrite>): Promise<T> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const r = await step();
    if (!(r instanceof StaleWrite)) return r;
  }
  throw new PurchaseError(409, 'concurrent_update', 'Bill changed concurrently; try again');
}

/* ----------------------------------------------------------------- postBill */

export async function postBill(db: PurchasesDb, tenantId: string, input: BillInput): Promise<{ bill: Row; replayed: boolean }> {
  if (!input.vendorName) throw new PurchaseError(400, 'vendor_required');
  if (!(input.billDate instanceof Date) || isNaN(input.billDate.getTime())) throw new PurchaseError(400, 'invalid_bill_date');
  if (!(input.dueDate instanceof Date) || isNaN(input.dueDate.getTime())) throw new PurchaseError(400, 'invalid_due_date');
  const key = input.idempotencyKey?.trim() || null;
  const findByKey = (c: PurchasesDb) => c.abBill.findFirst({ where: { tenantId, idempotencyKey: key, ...liveBillWhere() } });
  if (key) {
    const hit = await findByKey(db);
    if (hit) return { bill: hit, replayed: true };
  }

  const cfg = await tenantConfig(db, tenantId);
  const tenantCurrency = String(cfg?.currency ?? 'USD').toUpperCase();
  if (input.currency && input.currency.toUpperCase() !== tenantCurrency) {
    throw new PurchaseError(422, 'bill_currency_unsupported', `Bills must be in ${tenantCurrency}`);
  }
  const mode = input.postingMode ?? 'at_entry';
  let vendorDefaultTaxCode: string | null = null;
  if (input.vendorId) {
    const v = await db.abVendor.findFirst({ where: { id: input.vendorId, tenantId } });
    if (!v) throw new PurchaseError(404, 'vendor_not_found');
    vendorDefaultTaxCode = v.defaultTaxCode ?? null;
  }
  const lines = await resolveLines(db, tenantId, cfg, input, vendorDefaultTaxCode);
  const total = lines.reduce((s, l) => s + l.amountCents, 0);
  const tax = lines.reduce((s, l) => s + l.taxCents, 0);
  const recoverable = lines.reduce((s, l) => s + l.recoverableTaxCents, 0);
  const ledger = mode === 'at_entry' ? await entryLines(db, tenantId, lines, input.vendorName) : null;
  if (ledger) await assertPeriodOpen(db, tenantId, input.billDate).catch(periodError);

  const id = key ? idFromKey('bill', tenantId, key) : randomUUID();
  try {
    const bill = await db.$transaction(async (tx: PurchasesDb) => {
      if (key) {
        const hit = await findByKey(tx);
        if (hit) return { ...hit, __replayed: true };
      }
      await tx.abBill.create({
        data: {
          id, tenantId, vendorName: input.vendorName, vendorId: input.vendorId ?? null, billNumber: input.billNumber ?? null,
          description: input.description ?? lines[0].description ?? null, amountCents: total,
          categoryCode: null, billDate: input.billDate, dueDate: input.dueDate, status: 'open',
          subtotalCents: total - tax, taxCents: tax, recoverableTaxCents: recoverable, paidCents: 0,
          currency: tenantCurrency, postingMode: mode, revision: 0, idempotencyKey: key,
          receiptUrl: input.receiptUrl ?? null, deletedAt: null, journalEntryId: null, paidDate: null,
        },
      });
      for (const l of lines) await tx.abBillLine.create({ data: { billId: id, tenantId, ...l, qty: 1, unitCostCents: l.amountCents } });
      let journalEntryId: string | null = null;
      if (ledger) {
        await assertPeriodOpen(tx, tenantId, input.billDate);
        journalEntryId = await appendBalancedEntry(tx, tenantId, {
          date: input.billDate, memo: `Bill: ${input.vendorName}`, sourceType: 'bill', sourceId: id,
        }, ledger);
      }
      return tx.abBill.update({ where: { id }, data: { journalEntryId } });
    }, { isolationLevel: 'Serializable' });
    const replayed = Boolean(bill.__replayed);
    delete bill.__replayed;
    return { bill, replayed };
  } catch (err) {
    if (key && (isP2002(err) || err instanceof LedgerKeyConflict)) {
      const hit = await findByKey(db);
      if (hit) return { bill: hit, replayed: true };
    }
    return periodError(err);
  }
}

/* ------------------------------------------------------------------ payBill */

export interface PayInput {
  amountCents?: number;
  date?: Date;
  method?: string;
  idempotencyKey?: string | null;
}

export async function payBill(db: PurchasesDb, tenantId: string, billId: string, input: PayInput = {}): Promise<{ bill: Row; payment: Row; replayed: boolean }> {
  const date = input.date ?? new Date();
  if (isNaN(date.getTime())) throw new PurchaseError(400, 'invalid_date');
  const key = input.idempotencyKey?.trim() || null;
  const findByKey = (c: PurchasesDb) => c.abBillPayment.findFirst({ where: { tenantId, billId, idempotencyKey: key } });

  return withRetry(async () => {
    if (key) {
      const hit = await findByKey(db);
      if (hit) return { bill: await loadBill(db, tenantId, billId), payment: hit, replayed: true };
    }
    const bill = await loadBill(db, tenantId, billId);
    if (bill.status === 'paid') throw new PurchaseError(409, 'bill_already_paid');
    if (bill.status === 'cancelled') throw new PurchaseError(409, 'bill_cancelled');
    if (bill.status === 'draft') throw new PurchaseError(409, 'bill_is_draft');
    const remaining = bill.amountCents - bill.paidCents;
    const amount = input.amountCents ?? remaining;
    if (!intCents(amount) || amount <= 0) throw new PurchaseError(400, 'invalid_amount');
    if (amount > remaining) throw new PurchaseError(422, 'overpayment', `At most ${remaining} cents remain`);
    const atPayment = bill.postingMode !== 'at_entry';
    if (atPayment && amount !== remaining) throw new PurchaseError(422, 'partial_not_supported');

    let lines: LedgerLine[];
    let sourceType: string;
    if (atPayment) {
      const expense = bill.categoryCode ? await accountByCode(db, tenantId, bill.categoryCode) : await suspenseAccount(tenantId);
      const cash = await accountByCode(db, tenantId, CASH_CODE);
      lines = [
        { accountId: expense.id, debitCents: amount, creditCents: 0, description: bill.description || bill.vendorName },
        { accountId: cash.id, debitCents: 0, creditCents: amount, description: `Payment: ${bill.vendorName}` },
      ];
      sourceType = 'bill';
    } else {
      const [ap, cash] = [await accountByCode(db, tenantId, AP_CODE), await accountByCode(db, tenantId, CASH_CODE)];
      lines = [
        { accountId: ap.id, debitCents: amount, creditCents: 0, description: `Bill payment: ${bill.vendorName}` },
        { accountId: cash.id, debitCents: 0, creditCents: amount, description: `Payment: ${bill.vendorName}` },
      ];
      sourceType = 'bill_payment';
    }
    await assertPeriodOpen(db, tenantId, date).catch(periodError);

    const next = bill.paidCents + amount;
    const status = next === bill.amountCents ? 'paid' : 'partial';
    const paymentId = key ? idFromKey('bill_payment', tenantId, `${billId}:${key}`) : randomUUID();
    try {
      return await db.$transaction(async (tx: PurchasesDb) => {
        const g = await tx.abBill.updateMany({
          where: { id: billId, tenantId, paidCents: bill.paidCents, revision: bill.revision, status: bill.status },
          data: { paidCents: next, status, ...(status === 'paid' ? { paidDate: date } : {}) },
        });
        if (g.count === 0) return new StaleWrite();
        await assertPeriodOpen(tx, tenantId, date);
        await tx.abBillPayment.create({
          data: { id: paymentId, billId, tenantId, date, amountCents: amount, method: input.method ?? 'manual', idempotencyKey: key, voidedAt: null, journalEntryId: null },
        });
        const entryId = await appendBalancedEntry(tx, tenantId, {
          date, memo: `Bill payment: ${bill.vendorName}`, sourceType, sourceId: paymentId,
        }, lines);
        const payment = await tx.abBillPayment.update({ where: { id: paymentId }, data: { journalEntryId: entryId } });
        const updated = atPayment
          ? await tx.abBill.update({ where: { id: billId }, data: { journalEntryId: entryId } })
          : await tx.abBill.findFirst({ where: { id: billId, tenantId } });
        return { bill: updated, payment, replayed: false };
      });
    } catch (err) {
      if (key && (isP2002(err) || err instanceof LedgerKeyConflict)) return new StaleWrite(); // re-read → replay
      return periodError(err);
    }
  });
}

/* -------------------------------------------------------------- voidPayment */

export async function voidPayment(db: PurchasesDb, tenantId: string, paymentId: string, input: { date?: Date } = {}): Promise<{ bill: Row; payment: Row }> {
  const date = input.date ?? new Date();
  return withRetry(async () => {
    const payment = await db.abBillPayment.findFirst({ where: { id: paymentId, tenantId } });
    if (!payment) throw new PurchaseError(404, 'payment_not_found');
    if (payment.voidedAt) throw new PurchaseError(409, 'payment_already_voided');
    const bill = await loadBill(db, tenantId, payment.billId);
    if (!payment.journalEntryId) throw new PurchaseError(409, 'payment_has_no_entry');
    const lines = await mirrorOf(db, payment.journalEntryId);
    await assertPeriodOpen(db, tenantId, date).catch(periodError);
    const next = bill.paidCents - payment.amountCents;
    const status = next === 0 ? 'open' : 'partial';
    try {
      return await db.$transaction(async (tx: PurchasesDb) => {
        const g = await tx.abBill.updateMany({
          where: { id: bill.id, tenantId, paidCents: bill.paidCents, revision: bill.revision, status: bill.status },
          data: { paidCents: next, status, paidDate: null, ...(bill.postingMode !== 'at_entry' && next === 0 ? { journalEntryId: null } : {}) },
        });
        if (g.count === 0) return new StaleWrite();
        const p = await tx.abBillPayment.updateMany({ where: { id: paymentId, voidedAt: null }, data: { voidedAt: new Date() } });
        if (p.count === 0) throw new PurchaseError(409, 'payment_already_voided');
        await appendBalancedEntry(tx, tenantId, {
          date, memo: `Void bill payment: ${bill.vendorName}`, sourceType: 'bill_payment_void', sourceId: paymentId,
        }, lines);
        return {
          bill: await tx.abBill.findFirst({ where: { id: bill.id, tenantId } }),
          payment: await tx.abBillPayment.findFirst({ where: { id: paymentId } }),
        };
      });
    } catch (err) {
      return periodError(err);
    }
  });
}

/* ----------------------------------------------------------------- voidBill */

export async function voidBill(db: PurchasesDb, tenantId: string, billId: string, input: { date?: Date } = {}): Promise<{ bill: Row }> {
  const date = input.date ?? new Date();
  return withRetry(async () => {
    const bill = await loadBill(db, tenantId, billId);
    if (bill.status === 'cancelled') return { bill };
    // Legacy 'paid' rows may carry paidCents 0 — status is authoritative.
    if (bill.status === 'paid' || bill.status === 'partial' || bill.paidCents > 0) {
      throw new PurchaseError(409, 'bill_has_payments', 'Void the bill’s payments first');
    }
    const lines = bill.postingMode === 'at_entry' && bill.journalEntryId ? await mirrorOf(db, bill.journalEntryId) : null;
    if (lines) await assertPeriodOpen(db, tenantId, date).catch(periodError);
    try {
      return await db.$transaction(async (tx: PurchasesDb) => {
        const g = await tx.abBill.updateMany({
          where: { id: billId, tenantId, paidCents: 0, revision: bill.revision, status: bill.status },
          data: { status: 'cancelled' },
        });
        if (g.count === 0) return new StaleWrite();
        if (lines) {
          await appendBalancedEntry(tx, tenantId, { date, memo: `Void bill: ${bill.vendorName}`, sourceType: 'bill_void', sourceId: billId }, lines);
        }
        return { bill: await tx.abBill.findFirst({ where: { id: billId, tenantId } }) };
      });
    } catch (err) {
      return periodError(err);
    }
  });
}

/* ---------------------------------------------------------------- amendBill */

export type AmendInput = Partial<Pick<BillInput, 'vendorName' | 'billNumber' | 'description' | 'billDate' | 'dueDate' | 'lines'>>;

export async function amendBill(db: PurchasesDb, tenantId: string, billId: string, input: AmendInput): Promise<{ bill: Row }> {
  const cfg = await tenantConfig(db, tenantId);
  return withRetry(async () => {
    const bill = await loadBill(db, tenantId, billId);
    if (bill.status !== 'open' || bill.paidCents !== 0) throw new PurchaseError(409, 'bill_not_amendable');
    if (bill.postingMode !== 'at_entry') throw new PurchaseError(409, 'bill_not_at_entry');
    const vendorName = input.vendorName ?? bill.vendorName;
    const billDate = input.billDate ?? bill.billDate ?? bill.createdAt;
    const lines: ResolvedLine[] = input.lines
      ? await resolveLines(db, tenantId, cfg, { vendorName, lines: input.lines }, null)
      : ((await db.abBillLine.findMany({ where: { billId } })) as Row[]).map((l) => ({
          description: l.description, categoryId: l.categoryId, amountCents: l.amountCents,
          taxCode: l.taxCode ?? null, taxCents: l.taxCents, recoverableTaxCents: l.recoverableTaxCents,
        }));
    const ledger = await entryLines(db, tenantId, lines, vendorName);
    const reversal = bill.journalEntryId ? await mirrorOf(db, bill.journalEntryId) : null;
    await assertPeriodOpen(db, tenantId, billDate).catch(periodError);
    const total = lines.reduce((s, l) => s + l.amountCents, 0);
    const tax = lines.reduce((s, l) => s + l.taxCents, 0);
    const revision = bill.revision + 1;
    try {
      return await db.$transaction(async (tx: PurchasesDb) => {
        const g = await tx.abBill.updateMany({
          where: { id: billId, tenantId, paidCents: 0, revision: bill.revision, status: 'open' },
          data: {
            revision, vendorName, billDate, amountCents: total, taxCents: tax, subtotalCents: total - tax,
            recoverableTaxCents: lines.reduce((s, l) => s + l.recoverableTaxCents, 0),
            ...(input.billNumber !== undefined ? { billNumber: input.billNumber } : {}),
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.dueDate ? { dueDate: input.dueDate } : {}),
          },
        });
        if (g.count === 0) return new StaleWrite();
        if (reversal) {
          await appendBalancedEntry(tx, tenantId, {
            date: billDate, memo: `Amend bill (reversal): ${vendorName}`, sourceType: 'bill_amend_reversal', sourceId: bill.journalEntryId,
          }, reversal);
        }
        const entryId = await appendBalancedEntry(tx, tenantId, {
          date: billDate, memo: `Bill (amended): ${vendorName}`, sourceType: 'bill_amend', sourceId: `${billId}:${revision}`,
        }, ledger);
        if (input.lines) {
          await tx.abBillLine.deleteMany({ where: { billId } });
          for (const l of lines) await tx.abBillLine.create({ data: { billId, tenantId, ...l, qty: 1, unitCostCents: l.amountCents } });
        }
        return { bill: await tx.abBill.update({ where: { id: billId }, data: { journalEntryId: entryId } }) };
      });
    } catch (err) {
      if (err instanceof LedgerKeyConflict) return new StaleWrite(); // a concurrent amend took this revision
      return periodError(err);
    }
  });
}
