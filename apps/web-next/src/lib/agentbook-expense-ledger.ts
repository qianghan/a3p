/**
 * Expense → ledger posting.
 *
 * An expense only reaches the books via a balanced double-entry journal. The
 * base create posts every BUSINESS expense inline — against its category when
 * one is known, and against the 6999 suspense account when it isn't, because
 * the cash left the bank either way. (Gating the posting on a resolved category
 * is what made an uncategorized expense silently absent from P&L, the trial
 * balance and the tax estimate while still reading as "confirmed".)
 *
 * Mobile receipt-capture, bank import, and any "categorize later" flow assign
 * the category AFTER creation. This helper is the single, idempotent,
 * best-effort path for that second step: call it whenever an expense gains a
 * category, and it will either post the journal that was never written or move
 * an existing suspense debit onto the real category.
 */
import 'server-only';
import { prisma as db } from '@naap/database';
import {
  ensureChartOfAccounts,
  ensureUncategorizedAccount,
  CASH_CODE,
  UNCATEGORIZED_CODE,
} from '@/lib/agentbook-chart-of-accounts';

/**
 * Move an expense's debit off the suspense account onto its real category.
 *
 * Only touches an entry with exactly ONE debit line sitting on 6999 — the shape
 * the create route posts for an uncategorized expense. A split entry, or one
 * already booked to a real category, is left alone.
 *
 * This MUTATES a posted line, against the usual "journal entries are immutable,
 * write a reversing entry instead" rule. That rule doesn't work here: the
 * cash-basis branch of the tax estimate counts expense debits whose entry ALSO
 * credits the cash account (lib/agentbook-tax-estimate.ts). A separate
 * `DR category / CR suspense` reclassification entry credits suspense, not cash,
 * so under cash basis the money would stay attributed to Uncategorized forever
 * while a second, uncounted entry claimed otherwise. Moving the line keeps every
 * report — accrual, cash basis, trial balance, category breakdown — correct with
 * one write, and the entry total never changes, so nothing can unbalance.
 */
async function reclassifyFromSuspense(
  tenantId: string,
  journalEntryId: string,
  categoryId: string,
): Promise<void> {
  const suspense = await db.abAccount.findFirst({ where: { tenantId, code: UNCATEGORIZED_CODE } });
  if (!suspense) return; // tenant never posted to suspense

  const lines = (await db.abJournalLine.findMany({ where: { entryId: journalEntryId } })) || [];
  const debits = lines.filter((l) => l.debitCents > 0);
  if (debits.length !== 1) return; // split or unexpected shape — don't guess
  const debit = debits[0];
  if (debit.accountId !== suspense.id) return; // already on a real category

  await db.abJournalLine.update({
    where: { id: debit.id },
    data: { accountId: categoryId, description: debit.description },
  });
}

/**
 * Post the balanced journal (DR category / CR cash) for an expense if it needs
 * one, or move an existing SUSPENSE posting onto the category it just gained.
 *
 * Returns the existing id or null and posts nothing when the expense is
 * personal or still has no category. Mirrors the create/confirm posting exactly
 * (same lines, same memo/source), so every path produces identical ledger
 * entries.
 */
export async function backfillExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
): Promise<string | null> {
  // A soft-deleted expense is off the books (DELETE reversed it): background
  // categorization must neither re-book nor reclassify it.
  const expense = await db.abExpense.findFirst({ where: { id: expenseId, tenantId, deletedAt: null } });
  if (!expense) return null;
  if (expense.journalEntryId) {
    // Already on the books — but possibly to the SUSPENSE account, because an
    // expense with no category still posts (see UNCATEGORIZED_CODE). Gaining a
    // category means that debit has to move.
    if (expense.categoryId && !expense.isPersonal) {
      // A restored (never re-booked) or bot-orphaned expense's entry was
      // already reversed: moving its debit would split the reversal across
      // two accounts (+category / −suspense). Leave it for a bookkeeper.
      const lines = (await db.abJournalLine.findMany({ where: { entryId: expense.journalEntryId } })) || [];
      if (!(await isExpenseEntryAlreadyReversed(db, tenantId, expense.id, expense.journalEntryId, lines))) {
        await reclassifyFromSuspense(tenantId, expense.journalEntryId, expense.categoryId);
      }
    }
    return expense.journalEntryId;
  }
  if (!expense.categoryId || expense.isPersonal) return null; // nothing bookable

  // Seed the chart of accounts on demand rather than silently skipping. The
  // chart is only created by the onboarding flow, so a tenant who skipped
  // onboarding would otherwise never book anything — their P&L and tax estimate
  // would quietly omit real money.
  let cashAccount = await db.abAccount.findFirst({ where: { tenantId, code: CASH_CODE } });
  if (!cashAccount) {
    await ensureChartOfAccounts(tenantId);
    cashAccount = await db.abAccount.findFirst({ where: { tenantId, code: CASH_CODE } });
  }
  if (!cashAccount) return null; // seeding genuinely failed — don't post a half entry

  const amount = expense.amountCents;
  const desc = expense.description || 'Expense';
  const je = await db.abJournalEntry.create({
    data: {
      tenantId,
      date: expense.date,
      memo: `Expense: ${desc}`,
      sourceType: 'expense',
      sourceId: expense.id,
      verified: true,
      lines: {
        create: [
          { tenantId, accountId: expense.categoryId, debitCents: amount, creditCents: 0, description: desc },
          { tenantId, accountId: cashAccount.id, debitCents: 0, creditCents: amount, description: 'Payment' },
        ],
      },
    },
  });
  await db.abExpense.update({ where: { id: expense.id }, data: { journalEntryId: je.id } });
  return je.id;
}

/**
 * Reverse an expense's journal entry when the expense is deleted.
 *
 * Deleting an expense used to stamp `deletedAt` and leave the journal entry in
 * place, so the expense vanished from the user's list while P&L, the trial
 * balance and the tax estimate kept counting it — the mirror image of the
 * "categorized but never booked" bug, and just as silent.
 *
 * Journal entries are immutable by design ("create a reversing entry instead"),
 * so this mirrors the ORIGINAL lines with debit/credit swapped — the same
 * approach invoice void uses. Mirroring is correct for any line shape (2-line
 * untaxed, 3-line with a tax liability, split categories) and needs no
 * knowledge of what the original entry represented.
 *
 * Keyed ('expense_delete', <the id of the entry being reversed>). It used to be
 * keyed by the EXPENSE id, which is one key for the expense's whole life: once
 * Restore re-books an expense (a fresh entry), its next delete collided with
 * the first delete's reversal. Keyed by the entry, a re-booked expense deletes
 * under a new key, and a second attempt on the SAME entry is still rejected.
 *
 * Idempotent, without ever relying on that rejection inside a transaction: an
 * entry that already has a reversal is detected up front and nothing is
 * inserted. (A P2002 raised mid-transaction aborts it in Postgres — "caught"
 * or not, every later statement fails and the commit is a rollback — so the
 * old swallow-the-P2002 idempotency turned a double delete into a 500.)
 * Accepts an optional transaction client so callers can reverse and soft-delete
 * atomically.
 */
export async function reverseExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
  tx?: Pick<typeof db, 'abJournalLine' | 'abJournalEntry'>,
): Promise<{ reversed: boolean; reason?: string }> {
  const client = tx ?? db;
  const expense = await db.abExpense.findFirst({
    where: { id: expenseId, tenantId },
    select: { journalEntryId: true, description: true },
  });
  if (!expense?.journalEntryId) return { reversed: false, reason: 'no journal entry to reverse' };

  const originalLines = await client.abJournalLine.findMany({
    where: { entryId: expense.journalEntryId },
  });
  if (originalLines.length === 0) return { reversed: false, reason: 'original entry has no lines' };

  // Already reversed — by a previous delete (new or legacy key) or by the bot's
  // undo. Reversing again would book the expense NEGATIVE.
  if (await findEntryReversal(client, tenantId, expenseId, expense.journalEntryId, originalLines)) {
    return { reversed: false, reason: 'already reversed' };
  }

  try {
    await client.abJournalEntry.create({
      data: {
        tenantId,
        date: new Date(),
        memo: `DELETED - Reverse expense: ${expense.description || expenseId}`,
        // 'expense_delete', not 'expense' — the original creation entry may
        // already hold (tenantId, 'expense', expenseId) and the G-021 unique
        // constraint would reject a second row under that tuple.
        sourceType: 'expense_delete',
        sourceId: expense.journalEntryId,
        verified: true,
        lines: {
          create: originalLines.map((l) => ({
            tenantId, // G-009
            accountId: l.accountId,
            debitCents: l.creditCents,
            creditCents: l.debitCents,
            description: `Reverse: ${l.description || 'Expense'}`,
          })),
        },
      },
    });
    return { reversed: true };
  } catch (err) {
    // Standalone (no caller transaction): P2002 is a clean concurrent-double-
    // delete, the books are already right. Inside a transaction it is not
    // recoverable (Postgres aborted it) — surface it so the caller rolls back.
    if (!tx && (err as { code?: string })?.code === 'P2002') {
      return { reversed: false, reason: 'already reversed' };
    }
    throw err;
  }
}

/** Thrown when an edit would rewrite a month that has been closed. */
export class ExpenseLedgerPeriodClosedError extends Error {
  constructor(public readonly year: number, public readonly month: number) {
    super(`Fiscal period ${year}-${String(month).padStart(2, '0')} is closed`);
    this.name = 'ExpenseLedgerPeriodClosedError';
  }
}

/** Thrown when the booked entry's shape can't be re-priced or re-accounted without guessing. */
export class ExpenseLedgerShapeError extends Error {
  constructor() {
    super('This expense is booked as a split or multi-line entry; its amount or category cannot be edited automatically');
    this.name = 'ExpenseLedgerShapeError';
  }
}

/**
 * Thrown when the expense's current entry has ALREADY been mirror-reversed by
 * another path, so reversing it again would drive the books negative.
 *
 * How it still happens: DELETE posts an `expense_delete` reversal of the entry
 * but keeps journalEntryId pointing at it. Restore now re-books (a fresh
 * entry), but rows restored BEFORE that fix, and rows the bot's old "actually
 * it was $52" amount fix orphaned (reversal committed, replacement failed),
 * are still in that state until the repair script re-books them. An edit that
 * reversed the entry again would book −$100 for a $100 expense.
 */
export const ALREADY_REVERSED_MESSAGE =
  "This expense's books were already reversed (it was deleted and restored). Its amount, date, category and personal/business status can't be edited until a bookkeeper re-books it.";

export class ExpenseLedgerAlreadyReversedError extends Error {
  readonly code = 'already_reversed';
  constructor() {
    super(ALREADY_REVERSED_MESSAGE);
    this.name = 'ExpenseLedgerAlreadyReversedError';
  }
}

/** The delegates the edit helpers touch — satisfied by `db` and by an interactive-transaction client. */
type LedgerClient = Pick<typeof db, 'abExpense' | 'abJournalEntry' | 'abJournalLine' | 'abFiscalPeriod' | 'abAccount'>;

interface LedgerLine {
  accountId: string;
  debitCents: number;
  creditCents: number;
  description: string | null;
}

const sameUtcDay = (a: Date, b: Date) =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate();

const sumDebits = (lines: LedgerLine[]) => lines.reduce((s, l) => s + l.debitCents, 0);
const sumCredits = (lines: LedgerLine[]) => lines.reduce((s, l) => s + l.creditCents, 0);

async function assertPeriodOpen(client: LedgerClient, tenantId: string, date: Date): Promise<void> {
  // Same year/month derivation as the manual journal-entry period gate
  // (agentbook-core/journal-entries), so both gates agree on which month a date is in.
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const period = await client.abFiscalPeriod.findUnique({
    where: { tenantId_year_month: { tenantId, year, month } },
  });
  if (period && period.status === 'closed') throw new ExpenseLedgerPeriodClosedError(year, month);
}

/**
 * The expense's current entry and its lines. Lines are read by entryId rather
 * than via `include` so the same code runs against every Prisma double the
 * route tests use; the entry itself is tenant-scoped, so its lines are too.
 */
async function loadEntry(client: LedgerClient, tenantId: string, entryId: string) {
  const entry = await client.abJournalEntry.findFirst({ where: { id: entryId, tenantId } });
  if (!entry) return null;
  const lines: LedgerLine[] = (await client.abJournalLine.findMany({ where: { entryId: entry.id } })) || [];
  return { entry, lines };
}

/**
 * Append one entry and its lines. Refuses anything that does not balance, so a
 * bug upstream can never put a lopsided entry on the books. Must be called with
 * the transaction client: the header and lines commit (or roll back) together.
 */
async function appendBalancedEntry(
  client: LedgerClient,
  tenantId: string,
  header: { date: Date; memo: string; sourceType: string; sourceId: string | null },
  lines: LedgerLine[],
): Promise<string> {
  const debits = sumDebits(lines);
  if (lines.length < 2 || debits <= 0 || debits !== sumCredits(lines)) {
    throw new ExpenseLedgerShapeError();
  }
  const entry = await client.abJournalEntry.create({ data: { tenantId, ...header, verified: true } });
  for (const l of lines) {
    await client.abJournalLine.create({ data: { tenantId, entryId: entry.id, ...l } }); // G-009
  }
  return entry.id;
}

/** An entry, as the reversal lookup returns it. */
interface ReversalEntry {
  id: string;
  date: Date;
  sourceType: string;
  sourceId: string | null;
  memo: string;
}

/**
 * Find the entry that ALREADY reverses the expense's current entry, if any.
 *
 * Two generations of key exist and both are recognised:
 *
 *   keyed by the ENTRY being reversed (current code)
 *     ('expense_delete', <entryId>). Targets exactly one entry, so it can never
 *     be confused with a later re-booking.
 *   keyed by the EXPENSE (written before Restore re-booked; `legacy: true`)
 *     - 'expense_delete' (sourceId = expenseId) from DELETE;
 *     - the Telegram bot's undo / "actually it was $52" amount fix, which wrote
 *       its reversal as ('expense', expenseId) with memo "REVERSAL: …" — its
 *       replacement used the same key and failed, orphaning the reversal;
 *     - belt and braces: any other ('expense', expenseId) entry that exactly
 *       mirrors the current lines is a reversal whatever its memo says.
 *     A legacy key names the expense, not the entry, so it cannot say WHICH
 *     entry it reversed: rebookReversedExpenseEntry re-keys it to the entry id
 *     when it re-books, which retires it for the new entry.
 *
 * Detected by EXISTENCE of a keyed reversal, not by comparing line contents:
 * backfillExpenseJournalEntry → reclassifyFromSuspense rewrites the entry's
 * debit line in place (6999 → category), after which the delete reversal
 * (CR 6999 / DR cash) no longer mirrors it — a content test then let an edit
 * through and booked −$60 for a $100 → $40 edit. (createdAt ordering was not
 * used either: Prisma/Postgres stamp it per transaction, so a DELETE whose
 * transaction began before a concurrent edit's could carry an EARLIER
 * createdAt than the entry it reversed.)
 * Only entries keyed to THIS entry or THIS expense are considered, so manual
 * journal entries can never match; our own amend replacements are keyed by the
 * superseded ENTRY id with a different sourceType and are never candidates.
 */
export async function findEntryReversal(
  client: Pick<LedgerClient, 'abJournalEntry' | 'abJournalLine'>,
  tenantId: string,
  expenseId: string,
  entryId: string,
  lines: LedgerLine[],
): Promise<{ entry: ReversalEntry; legacy: boolean } | null> {
  const keyed = (await client.abJournalEntry.findMany({ where: { tenantId, sourceId: entryId } })) || [];
  // Only a DELETE reversal counts. An 'expense_amend_reversal' keyed to this
  // entry means another request is superseding it RIGHT NOW: the G-021 unique
  // key already makes the loser's own amend a P2002 → 409 "changed by another
  // request", which is the true answer; calling it "already reversed" (422,
  // "ask a bookkeeper") would not be.
  const direct = keyed.find((c) => c.sourceType === 'expense_delete');
  if (direct) return { entry: direct as ReversalEntry, legacy: false };

  const candidates = (await client.abJournalEntry.findMany({ where: { tenantId, sourceId: expenseId } })) || [];
  const key = (l: Pick<LedgerLine, 'accountId' | 'debitCents' | 'creditCents'>) =>
    `${l.accountId}|${l.debitCents}|${l.creditCents}`;
  const mirrored = lines.map((l) => key({ accountId: l.accountId, debitCents: l.creditCents, creditCents: l.debitCents })).sort();
  for (const c of candidates) {
    if (c.id === entryId) continue;
    if (c.sourceType === 'expense_delete') return { entry: c as ReversalEntry, legacy: true };
    if (c.sourceType !== 'expense') continue;
    if (typeof c.memo === 'string' && c.memo.startsWith('REVERSAL:')) return { entry: c as ReversalEntry, legacy: true };
    const cKeys = ((await client.abJournalLine.findMany({ where: { entryId: c.id } })) || []).map(key).sort();
    if (cKeys.length === mirrored.length && cKeys.every((k, i) => k === mirrored[i])) {
      return { entry: c as ReversalEntry, legacy: true };
    }
  }
  return null;
}

/** Has the expense's current entry ALREADY been reversed by another path? See findEntryReversal. */
export async function isExpenseEntryAlreadyReversed(
  client: Pick<LedgerClient, 'abJournalEntry' | 'abJournalLine'>,
  tenantId: string,
  expenseId: string,
  entryId: string,
  lines: LedgerLine[],
): Promise<boolean> {
  return (await findEntryReversal(client, tenantId, expenseId, entryId, lines)) !== null;
}

async function assertNotAlreadyReversed(
  client: LedgerClient,
  tenantId: string,
  expenseId: string,
  entryId: string,
  lines: LedgerLine[],
): Promise<void> {
  if (await isExpenseEntryAlreadyReversed(client, tenantId, expenseId, entryId, lines)) {
    throw new ExpenseLedgerAlreadyReversedError();
  }
}

const mirror = (lines: LedgerLine[]): LedgerLine[] =>
  lines.map((l) => ({
    accountId: l.accountId,
    debitCents: l.creditCents,
    creditCents: l.debitCents,
    description: `Reverse: ${l.description || 'Expense'}`,
  }));

/** A tenant's ACTIVE EXPENSE account, or null — the same rule the categorize path enforces. */
async function validExpenseAccount(client: LedgerClient, tenantId: string, id: string): Promise<string | null> {
  const acct = await client.abAccount.findFirst({
    where: { id, tenantId, accountType: 'expense', isActive: true },
    select: { id: true },
  });
  return acct?.id ?? null;
}

export interface RepostOptions {
  /**
   * The caller changed categoryId in this request. A multi-line entry can't
   * follow a category change without inventing an allocation, so it is refused
   * (422) instead of silently leaving the books on the old account.
   */
  categoryChanged?: boolean;
}

/** The tenant's 6999 suspense account (seeded by ensureExpenseBookingAccounts / the create route). */
async function suspenseAccountId(client: LedgerClient, tenantId: string): Promise<string | null> {
  const acct = await client.abAccount.findFirst({ where: { tenantId, code: UNCATEGORIZED_CODE }, select: { id: true } });
  return acct?.id ?? null;
}

/**
 * Bring an expense's ledger entry back in line after its amount, date or
 * category was edited. Call it INSIDE the transaction that saved the edit,
 * passing the tx.
 *
 * Without this, editing a booked expense changed the row the user sees while
 * P&L, the trial balance and the tax estimate kept the old figure — the third
 * member of the family with "categorized but never booked" (#386) and "deleted
 * but never reversed" (#397).
 *
 * Journal entries are immutable, so this appends two entries rather than
 * touching the original:
 *   1. a mirror reversal of the CURRENT entry, dated at that entry's own date
 *      (so the old month nets to zero — the delete path dates its reversal
 *      "today", which is right for a deletion but would leave an edited
 *      expense counted twice in its original month);
 *   2. a replacement entry at the expense's new amount, date and category.
 * Both are keyed by the id of the entry being superseded, so
 * @@unique([tenantId, sourceType, sourceId]) (G-021) gives each edit a fresh
 * key (a chain of edits never collides) and rejects two edits that both try to
 * supersede the same entry — the loser gets P2002 and rolls back rather than
 * double-posting.
 *
 * The replacement debits the expense's category when it is a valid active
 * expense account of this tenant and the entry is the plain DR one-account /
 * CR one-account shape; otherwise it debits whatever the original debited (so a
 * suspense posting stays on suspense until the expense gets a category).
 *
 * Self-healing and idempotent: it compares the ledger to the expense and does
 * nothing when they already agree.
 */
export async function repostExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
  tx: LedgerClient,
  opts: RepostOptions = {},
): Promise<{ reposted: boolean; journalEntryId: string | null; reason?: string }> {
  const expense = await tx.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!expense?.journalEntryId) return { reposted: false, journalEntryId: null, reason: 'not booked' };
  // A deleted expense was already reversed by DELETE; a rejected one by undo.
  // Re-posting either would resurrect money the user removed.
  if (expense.deletedAt) return { reposted: false, journalEntryId: expense.journalEntryId, reason: 'deleted' };
  if (expense.status === 'rejected') return { reposted: false, journalEntryId: expense.journalEntryId, reason: 'rejected' };

  const loaded = await loadEntry(tx, tenantId, expense.journalEntryId);
  if (!loaded || loaded.lines.length === 0) {
    return { reposted: false, journalEntryId: expense.journalEntryId, reason: 'original entry has no lines' };
  }
  const { entry: original, lines } = loaded;
  if (sumDebits(lines) !== sumCredits(lines)) throw new ExpenseLedgerShapeError(); // corrupt original

  const debits = lines.filter((l) => l.debitCents > 0);
  const credits = lines.filter((l) => l.creditCents > 0);
  // Only the plain DR one-account / CR one-account entry can be re-priced or
  // moved to another account without inventing an allocation.
  const simple = lines.length === 2 && debits.length === 1 && credits.length === 1 && debits[0] !== credits[0];

  const amountChanged = sumDebits(lines) !== expense.amountCents;
  const dateChanged = !sameUtcDay(original.date, expense.date);

  let targetDebitAccountId = simple ? debits[0].accountId : null;
  if (simple) {
    if (expense.categoryId) {
      if (expense.categoryId !== debits[0].accountId) {
        // Never post to an account the tenant doesn't own or that isn't an
        // active expense account — keep the original account instead.
        targetDebitAccountId = (await validExpenseAccount(tx, tenantId, expense.categoryId)) ?? debits[0].accountId;
      }
    } else if (opts.categoryChanged) {
      // Category cleared on a booked business expense: back to suspense, the
      // same place the create route books an uncategorized expense.
      targetDebitAccountId = (await suspenseAccountId(tx, tenantId)) ?? debits[0].accountId;
    }
  }
  const accountChanged = simple && targetDebitAccountId !== debits[0].accountId;

  if (!simple && (amountChanged || opts.categoryChanged)) throw new ExpenseLedgerShapeError();
  if (!amountChanged && !dateChanged && !accountChanged) {
    return { reposted: false, journalEntryId: original.id, reason: 'ledger already matches' };
  }

  await assertNotAlreadyReversed(tx, tenantId, expense.id, original.id, lines);
  await assertPeriodOpen(tx, tenantId, original.date);
  if (dateChanged) await assertPeriodOpen(tx, tenantId, expense.date);

  const newLines: LedgerLine[] = lines.map((l) => ({
    accountId: accountChanged && l.debitCents > 0 ? (targetDebitAccountId as string) : l.accountId,
    debitCents: amountChanged && l.debitCents > 0 ? expense.amountCents : l.debitCents,
    creditCents: amountChanged && l.creditCents > 0 ? expense.amountCents : l.creditCents,
    description: l.description,
  }));

  const desc = expense.description || 'Expense';
  await appendBalancedEntry(
    tx,
    tenantId,
    { date: original.date, memo: `AMENDED - Reverse expense: ${desc}`, sourceType: 'expense_amend_reversal', sourceId: original.id },
    mirror(lines),
  );
  const replacementId = await appendBalancedEntry(
    tx,
    tenantId,
    { date: expense.date, memo: `Expense (amended): ${desc}`, sourceType: 'expense_amend', sourceId: original.id },
    newLines,
  );
  await tx.abExpense.update({ where: { id: expense.id }, data: { journalEntryId: replacementId } });
  return { reposted: true, journalEntryId: replacementId };
}

/**
 * A booked business expense was marked PERSONAL: take it off the books.
 *
 * Appends a mirror reversal of the current entry dated at that entry's own date
 * (so the original month nets to zero, exactly as if it had never been
 * business) and clears expense.journalEntryId. The reversal uses the same
 * G-021 key a repost of that entry would use, so an un-book racing a repost of
 * the same entry is a P2002 for the loser, never a double reversal.
 * Call inside the edit transaction.
 *
 * `opts.memo` renames the reversal for callers other than the personal flip —
 * the bot's undo uses it so the ledger says "undone", not "personal".
 */
export async function unbookExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
  tx: LedgerClient,
  opts: { memo?: string } = {},
): Promise<{ unbooked: boolean; reason?: string }> {
  const expense = await tx.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!expense?.journalEntryId) return { unbooked: false, reason: 'not booked' };
  if (expense.deletedAt) return { unbooked: false, reason: 'deleted' };
  if (expense.status === 'rejected') return { unbooked: false, reason: 'rejected' };

  const loaded = await loadEntry(tx, tenantId, expense.journalEntryId);
  if (!loaded || loaded.lines.length === 0) return { unbooked: false, reason: 'original entry has no lines' };
  const { entry: original, lines } = loaded;
  if (sumDebits(lines) !== sumCredits(lines)) throw new ExpenseLedgerShapeError();

  await assertNotAlreadyReversed(tx, tenantId, expense.id, original.id, lines);
  await assertPeriodOpen(tx, tenantId, original.date);
  await appendBalancedEntry(
    tx,
    tenantId,
    {
      date: original.date,
      memo: opts.memo ?? `PERSONAL - Reverse expense: ${expense.description || 'Expense'}`,
      sourceType: 'expense_amend_reversal',
      sourceId: original.id,
    },
    mirror(lines),
  );
  await tx.abExpense.update({ where: { id: expense.id }, data: { journalEntryId: null } });
  return { unbooked: true };
}

/**
 * A CONFIRMED personal expense was marked BUSINESS: put it on the books, the
 * way the create route would have — DR its category (a valid active expense
 * account of this tenant) or 6999 suspense when it has none, CR cash, at the
 * expense's amount and date.
 *
 * A pending_review row is left alone: unbooked drafts (receipt capture) are
 * booked by confirm / categorize, which run their own rules.
 *
 * No unique source key guards this insert (the create route posts with
 * sourceId null too). Double-posting is prevented by the caller: it UPDATEs the
 * expense row first in the same transaction, which row-locks it, and this
 * function re-reads journalEntryId after that lock — so a second concurrent
 * flip waits, then sees the first one's entry and does nothing.
 * Call inside the edit transaction.
 */
export async function bookExpenseJournalEntry(
  tenantId: string,
  expenseId: string,
  tx: LedgerClient,
): Promise<{ booked: boolean; journalEntryId: string | null; reason?: string }> {
  const expense = await tx.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!expense) return { booked: false, journalEntryId: null, reason: 'not found' };
  if (expense.journalEntryId) return { booked: false, journalEntryId: expense.journalEntryId, reason: 'already booked' };
  if (expense.deletedAt || expense.isPersonal) return { booked: false, journalEntryId: null, reason: 'not bookable' };
  if (expense.status !== 'confirmed') return { booked: false, journalEntryId: null, reason: 'pending review' };

  const debitAccountId =
    (expense.categoryId ? await validExpenseAccount(tx, tenantId, expense.categoryId) : null) ??
    (await suspenseAccountId(tx, tenantId));
  const cash = await tx.abAccount.findFirst({ where: { tenantId, code: CASH_CODE }, select: { id: true } });
  if (!debitAccountId || !cash) {
    // The caller seeds both before the transaction; reaching here means seeding
    // failed. Fail the edit rather than mark it business while leaving it off the books.
    throw new Error('Cannot book this expense: the chart of accounts is missing its cash or suspense account');
  }

  await assertPeriodOpen(tx, tenantId, expense.date);
  const desc = expense.description || 'Expense';
  const journalEntryId = await appendBalancedEntry(
    tx,
    tenantId,
    { date: expense.date, memo: `Expense: ${desc}`, sourceType: 'expense', sourceId: null },
    [
      { accountId: debitAccountId, debitCents: expense.amountCents, creditCents: 0, description: desc },
      { accountId: cash.id, debitCents: 0, creditCents: expense.amountCents, description: 'Payment' },
    ],
  );
  await tx.abExpense.update({ where: { id: expense.id }, data: { journalEntryId } });
  return { booked: true, journalEntryId };
}

/** Does the reversal entry exactly mirror `lines` (same accounts, sides swapped)? */
async function reversalMirrorsLines(
  client: Pick<LedgerClient, 'abJournalLine'>,
  reversalId: string,
  lines: LedgerLine[],
): Promise<boolean> {
  const key = (l: Pick<LedgerLine, 'accountId' | 'debitCents' | 'creditCents'>) =>
    `${l.accountId}|${l.debitCents}|${l.creditCents}`;
  const reversalLines: LedgerLine[] = (await client.abJournalLine.findMany({ where: { entryId: reversalId } })) || [];
  const expected = mirror(lines).map(key).sort();
  const actual = reversalLines.map(key).sort();
  return expected.length === actual.length && expected.every((k, i) => k === actual[i]);
}

export type RebookOutcome =
  | 'rebooked'          // a fresh entry was posted and the expense points at it
  | 'not_booked'        // nothing to re-book: never booked, personal, or rejected (undone)
  | 'already_on_books'  // the current entry is live — nothing reverses it
  | 'needs_review';     // reversed, but the entry was edited since: a bookkeeper must decide

/**
 * Put an expense back on the books after its current entry was reversed by a
 * DELETE (Restore) or orphaned by the bot's old amount-fix. Call inside the
 * transaction that clears `deletedAt`.
 *
 * Cancels the reversal rather than touching anything posted: it appends a copy
 * of the current entry's lines, dated at the reversal it cancels (so the month
 * the expense belongs to keeps it and the delete month nets to zero), keyed
 * ('expense_rebook', <reversal id>) so one reversal can be cancelled once, and
 * points the expense at the new entry — a live entry no reversal targets, so
 * later edits and deletes work and key off it.
 *
 * If that month is closed it is dated today instead (a closed month can't be
 * changed; the correction lands in the open one). If today is closed too it
 * throws ExpenseLedgerPeriodClosedError and nothing is written.
 *
 * Refuses (`needs_review`) unless the reversal exactly mirrors the current
 * lines. After an in-place reclassification (suspense → category, pre-#580) the
 * mirror no longer matches and re-posting the entry's lines would double-count
 * the category; those go to a bookkeeper rather than be guessed at.
 *
 * A reversal written under the legacy expense-id key is re-keyed to the entry id
 * it reversed (same type family, same lines and amounts): that retires it for the
 * NEW entry, which it would otherwise keep flagging as "already reversed".
 */
export async function rebookReversedExpenseEntry(
  tenantId: string,
  expenseId: string,
  tx: LedgerClient,
): Promise<{ rebooked: boolean; journalEntryId: string | null; outcome: RebookOutcome }> {
  const expense = await tx.abExpense.findFirst({ where: { id: expenseId, tenantId } });
  if (!expense?.journalEntryId || expense.isPersonal || expense.status === 'rejected') {
    return { rebooked: false, journalEntryId: expense?.journalEntryId ?? null, outcome: 'not_booked' };
  }
  const loaded = await loadEntry(tx, tenantId, expense.journalEntryId);
  if (!loaded || loaded.lines.length === 0) {
    return { rebooked: false, journalEntryId: expense.journalEntryId, outcome: 'not_booked' };
  }
  const { entry: current, lines } = loaded;

  const found = await findEntryReversal(tx, tenantId, expense.id, current.id, lines);
  if (!found) return { rebooked: false, journalEntryId: current.id, outcome: 'already_on_books' };

  if (!(await reversalMirrorsLines(tx, found.entry.id, lines))) {
    return { rebooked: false, journalEntryId: current.id, outcome: 'needs_review' };
  }

  let date = found.entry.date;
  try {
    await assertPeriodOpen(tx, tenantId, date);
  } catch (err) {
    if (!(err instanceof ExpenseLedgerPeriodClosedError)) throw err;
    date = new Date();
    await assertPeriodOpen(tx, tenantId, date); // closed too → throws, nothing written yet
  }

  if (found.legacy) {
    await tx.abJournalEntry.update({
      where: { id: found.entry.id },
      data: {
        sourceType: found.entry.sourceType === 'expense_delete' ? 'expense_delete' : 'expense_amend_reversal',
        sourceId: current.id,
      },
    });
  }
  const freshId = await appendBalancedEntry(
    tx,
    tenantId,
    {
      date,
      memo: `RESTORED - Re-book expense: ${expense.description || 'Expense'}`,
      sourceType: 'expense_rebook',
      sourceId: found.entry.id,
    },
    lines.map((l) => ({ accountId: l.accountId, debitCents: l.debitCents, creditCents: l.creditCents, description: l.description })),
  );
  await tx.abExpense.update({ where: { id: expense.id }, data: { journalEntryId: freshId } });
  return { rebooked: true, journalEntryId: freshId, outcome: 'rebooked' };
}

export interface OrphanedExpenseReversal {
  tenantId: string;
  expenseId: string;
  description: string | null;
  amountCents: number;
  date: Date;
  /** The expense's current entry — the one that has been reversed. */
  entryId: string;
  reversalId: string;
  reversalType: string;
  /** Keyed by expense id (written before the fix) rather than by entry id. */
  legacy: boolean;
  /** `rebookable`: rebookReversedExpenseEntry will repair it. `needs_review`: a bookkeeper must. */
  outcome: 'rebookable' | 'needs_review';
}

/**
 * READ-ONLY. Find live, confirmed, business expenses whose CURRENT journal
 * entry has already been reversed — they show in the user's list while the
 * books net them to $0 (missing from P&L, the trial balance and the tax
 * estimate). Producers: Restore before it re-booked, and the Telegram bot's old
 * amount fix (reversal committed, replacement rejected by the unique key).
 *
 * Starts from the (small) set of reversal entries and walks back to expenses,
 * rather than scanning every expense. Deleted, undone (rejected) and personal
 * expenses are never reported: being off the books is correct for them.
 */
export async function findOrphanedExpenseReversals(
  client: LedgerClient,
  opts: { tenantId?: string } = {},
): Promise<OrphanedExpenseReversal[]> {
  const { tenantId } = opts;
  const reversals = [
    ...((await client.abJournalEntry.findMany({ where: { tenantId, sourceType: 'expense_delete' } })) || []),
    ...((await client.abJournalEntry.findMany({
      where: { tenantId, sourceType: 'expense', memo: { startsWith: 'REVERSAL:' } },
    })) || []),
  ];
  // A reversal's sourceId is an expense id (legacy) or the reversed entry's id.
  const keys = [...new Set(reversals.map((r) => r.sourceId).filter((k): k is string => !!k))];

  const live = { tenantId, deletedAt: null, status: 'confirmed', isPersonal: false };
  const expenses = new Map<string, Awaited<ReturnType<LedgerClient['abExpense']['findMany']>>[number]>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    for (const where of [{ ...live, id: { in: chunk } }, { ...live, journalEntryId: { in: chunk } }]) {
      for (const e of (await client.abExpense.findMany({ where })) || []) expenses.set(e.id, e);
    }
  }

  const out: OrphanedExpenseReversal[] = [];
  for (const e of expenses.values()) {
    if (!e.journalEntryId) continue;
    const loaded = await loadEntry(client, e.tenantId, e.journalEntryId);
    if (!loaded || loaded.lines.length === 0) continue;
    const found = await findEntryReversal(client, e.tenantId, e.id, loaded.entry.id, loaded.lines);
    if (!found) continue;
    out.push({
      tenantId: e.tenantId,
      expenseId: e.id,
      description: e.description ?? null,
      amountCents: e.amountCents,
      date: e.date,
      entryId: loaded.entry.id,
      reversalId: found.entry.id,
      reversalType: found.entry.sourceType,
      legacy: found.legacy,
      outcome: (await reversalMirrorsLines(client, found.entry.id, loaded.lines)) ? 'rebookable' : 'needs_review',
    });
  }
  return out.sort((a, b) => a.tenantId.localeCompare(b.tenantId) || a.expenseId.localeCompare(b.expenseId));
}

/**
 * Seed what bookExpenseJournalEntry / a cleared category may need (cash 1000 and
 * suspense 6999), OUTSIDE the edit transaction — both seeders run their own
 * upserts, as in the create route. Idempotent.
 */
export async function ensureExpenseBookingAccounts(tenantId: string): Promise<void> {
  const cash = await db.abAccount.findFirst({ where: { tenantId, code: CASH_CODE }, select: { id: true } });
  if (!cash) await ensureChartOfAccounts(tenantId);
  await ensureUncategorizedAccount(tenantId);
}
