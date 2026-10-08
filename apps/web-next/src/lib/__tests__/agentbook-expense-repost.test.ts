import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFakeLedgerDb } from './fake-ledger-db';

vi.mock('server-only', () => ({}));
const h = vi.hoisted(() => ({ fake: null as any }));
vi.mock('@naap/database', () => ({ prisma: new Proxy({}, { get: (_t, p) => h.fake.db[p as string] }) }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({ ensureChartOfAccounts: vi.fn(), CASH_CODE: '1000', UNCATEGORIZED_CODE: '6999' }));

import { repostExpenseJournalEntry, ExpenseLedgerPeriodClosedError, ExpenseLedgerShapeError } from '../agentbook-expense-ledger';

const JAN = new Date('2026-01-15T12:00:00.000Z');
beforeEach(() => { h.fake = createFakeLedgerDb(); });

describe('repostExpenseJournalEntry', () => {
  it('is a no-op when the ledger already matches the expense (idempotent, self-healing check)', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    const r = await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect(r.reposted).toBe(false);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('reports "not booked" without writing when the expense has no journal entry', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].journalEntryId = null;
    const r = await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect(r).toMatchObject({ reposted: false, journalEntryId: null });
  });

  it('repairs a ledger that drifted from the expense, and a second call is then a no-op', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN });
    h.fake.state.expenses[0].amountCents = 5200; // drift (e.g. the pre-fix edit path)
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(true);
    expect(h.fake.netByAccount()).toEqual({ 'acct-meals': 5200, 'acct-cash': -5200 });
    expect((await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db)).reposted).toBe(false);
    expect(h.fake.state.entries).toHaveLength(3);
  });

  it('does not look at another tenant\'s expense', async () => {
    h.fake.seedBookedExpense({ amountCents: 4200, date: JAN, tenantId: 't2' });
    h.fake.state.expenses[0].amountCents = 5200;
    const r = await repostExpenseJournalEntry('t1', 'exp-1', h.fake.db);
    expect(r.reposted).toBe(false);
    expect(h.fake.state.entries).toHaveLength(1);
  });

  it('exports typed errors the route maps to 422', () => {
    expect(new ExpenseLedgerPeriodClosedError(2026, 1)).toBeInstanceOf(Error);
    expect(new ExpenseLedgerShapeError().message).toMatch(/split|multi/i);
  });
});
