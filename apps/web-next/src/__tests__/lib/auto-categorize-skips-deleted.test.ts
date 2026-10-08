// @vitest-environment node
/**
 * The background auto-categorizer (cron / digest) must not touch the books of
 * an expense DELETE took off them:
 *   - a soft-deleted expense is not even selected;
 *   - a restored-but-never-re-booked expense (Restore only clears deletedAt;
 *     its entry was already reversed by DELETE) gets its category, but its
 *     already-reversed entry is NOT reclassified off suspense — that would book
 *     +category / −suspense.
 * Runs the REAL autoCategorizeForTenant + backfill against mem-db (applies
 * `where`), with the Gemini HTTP call stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { autoCategorizeForTenant } from '@/lib/agentbook-auto-categorize';

const JAN = new Date('2026-01-15T12:00:00.000Z');

function booked(id: string, cents: number, opts: { deleted?: boolean; deleteReversal?: boolean } = {}) {
  const je = `je-${id}`;
  const entries: Row[] = [{ id: je, tenantId: 't1', date: JAN, memo: 'Expense', sourceType: 'expense', sourceId: null, createdAt: JAN }];
  const lines: Row[] = [
    { id: `${je}-d`, tenantId: 't1', entryId: je, accountId: 'acc-susp', debitCents: cents, creditCents: 0 },
    { id: `${je}-c`, tenantId: 't1', entryId: je, accountId: 'acc-cash', debitCents: 0, creditCents: cents },
  ];
  if (opts.deleteReversal) {
    const rev = `${je}-delrev`;
    entries.push({ id: rev, tenantId: 't1', date: JAN, memo: 'DELETED - Reverse expense', sourceType: 'expense_delete', sourceId: id, createdAt: JAN });
    lines.push(
      { id: `${rev}-d`, tenantId: 't1', entryId: rev, accountId: 'acc-susp', debitCents: 0, creditCents: cents },
      { id: `${rev}-c`, tenantId: 't1', entryId: rev, accountId: 'acc-cash', debitCents: cents, creditCents: 0 },
    );
  }
  const expense: Row = {
    id, tenantId: 't1', amountCents: cents, date: JAN, description: `Expense ${id}`, categoryId: null, isPersonal: false,
    status: 'confirmed', journalEntryId: je, deletedAt: opts.deleted ? JAN : null, vendorId: null, vendor: null,
  };
  return { entries, lines, expense };
}

const net = () => {
  const out: Record<string, number> = {};
  for (const l of memDb.table('abJournalLine').rows) out[l.accountId as string] = (out[l.accountId as string] ?? 0) + (l.debitCents as number) - (l.creditCents as number);
  for (const k of Object.keys(out)) if (out[k] === 0) delete out[k];
  return out;
};
const debitAccountOf = (je: string) =>
  memDb.table('abJournalLine').rows.find((l) => l.entryId === je && (l.debitCents as number) > 0)?.accountId;

beforeEach(() => {
  const live = booked('live', 1000);
  const deleted = booked('deleted', 2000, { deleted: true, deleteReversal: true });
  const restored = booked('restored', 3000, { deleteReversal: true });
  memDb.reset({
    abAccount: [
      { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
      { id: 'acc-meals', tenantId: 't1', code: '5200', name: 'Meals', accountType: 'expense', isActive: true },
      { id: 'acc-susp', tenantId: 't1', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true },
    ],
    abExpense: [live.expense, deleted.expense, restored.expense],
    abJournalEntry: [...live.entries, ...deleted.entries, ...restored.entries],
    abJournalLine: [...live.lines, ...deleted.lines, ...restored.lines],
    abUserMemory: [],
  });
  vi.stubEnv('GEMINI_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: '{"categoryName":"Meals","confidence":0.95,"reason":"t"}' }] } }],
  }), { status: 200 })));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('autoCategorizeForTenant and deleted / restored expenses', () => {
  it('categorizes + reclassifies the live expense, skips the deleted one, and leaves the restored entry on suspense', async () => {
    const before = net();
    const r = await autoCategorizeForTenant('t1', { force: true });

    expect(r.appliedCount).toBe(2); // live + restored; the deleted row is never selected
    const exp = (id: string) => memDb.table('abExpense').rows.find((e) => e.id === id)!;
    expect(exp('live').categoryId).toBe('acc-meals');
    expect(debitAccountOf('je-live')).toBe('acc-meals');

    expect(exp('deleted').categoryId).toBeNull();
    expect(debitAccountOf('je-deleted')).toBe('acc-susp');

    expect(exp('restored').categoryId).toBe('acc-meals');
    expect(debitAccountOf('je-restored')).toBe('acc-susp'); // already reversed → not moved

    // Only the live expense moved between accounts; nothing else changed.
    expect(before).toEqual({ 'acc-susp': 1000, 'acc-cash': -1000 });
    expect(net()).toEqual({ 'acc-meals': 1000, 'acc-cash': -1000 });
  });
});
