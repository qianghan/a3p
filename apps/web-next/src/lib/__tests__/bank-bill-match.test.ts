// @vitest-environment node
/**
 * PR 3d.4 — a bank debit for a bill records a bill PAYMENT (lib/purchases),
 * sets AbBankTransaction.matchedBillId and never creates an expense.
 * Proposal path (agentbook-payment-matcher) offers bills; applyBillMatch
 * applies; the match route ("this is for bill X"), the bank-sync auto path
 * (runMatcherOnTransaction) and the candidates route are wired to it.
 * Assertions read the fake ledger's journal lines.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }) }));
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'user' }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: async () => ({ seeded: false, count: 0 }),
  ensureUncategorizedAccount: async () => ({ id: 'acct-suspense' }),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: async () => null }));
const matcherResult = vi.fn();
const candidatesResult = vi.fn();
vi.mock('@/lib/agentbook-payment-matcher', async (orig) => {
  const real = await orig<typeof import('@/lib/agentbook-payment-matcher')>();
  return { ...real, matchTransaction: (...a: unknown[]) => matcherResult(...a), matchTransactionWithCandidates: (...a: unknown[]) => candidatesResult(...a) };
});
vi.mock('plaid', () => ({ Configuration: class {}, PlaidApi: class {}, PlaidEnvironments: {}, Products: {}, CountryCode: {} }));
vi.mock('@/lib/agentbook-bank-token', () => ({ encryptToken: (s: string) => s, decryptToken: (s: string) => s }));

import { createFakeLedgerDb } from './fake-ledger-db';
let f: ReturnType<typeof createFakeLedgerDb>;
let txns: any[];
let events: any[];
vi.mock('@naap/database', () => ({ get prisma() { return f.db; } }));

import { postBill } from '../purchases';
import { applyBillMatch, BankMatchError } from '../agentbook-bank-match';
import { scoreBillMatch, AUTO_MATCH_THRESHOLD, type MatchableTxn } from '../agentbook-payment-matcher';
import { runMatcherOnTransaction } from '../agentbook-plaid';
import { POST as matchRoute } from '@/app/api/v1/agentbook-expense/bank-transactions/[id]/match/route';
import { GET as candidatesRoute } from '@/app/api/v1/agentbook-expense/bank-transactions/[id]/candidates/route';

const AU = { id: 'cfg', userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true, currency: 'AUD', accountingBasis: 'accrual' };

function attachBankTables() {
  txns = [];
  events = [];
  const m = (r: any, w: any = {}) => Object.entries(w).every(([k, v]) => r[k] === v);
  f.db.abBankTransaction = {
    findFirst: async ({ where }: any) => { const r = txns.find((x) => m(x, where)); return r ? { ...r } : null; },
    update: async ({ where, data }: any) => { const r = txns.find((x) => x.id === where.id); Object.assign(r, data); return { ...r }; },
  };
  f.db.abEvent = { create: async ({ data }: any) => { events.push(data); return data; } };
}
const txn = (o: Partial<any> = {}) => {
  const row = { id: `tx-${txns.length + 1}`, tenantId: 't1', amount: 11000, date: new Date('2026-11-20T12:00:00Z'), name: 'OFFICEWORKS 123', merchantName: 'Officeworks', matchStatus: 'pending', matchedBillId: null, matchedExpenseId: null, matchedInvoiceId: null, ...o };
  txns.push(row);
  return row;
};
async function bill(amountCents = 11000, tenantId = 't1') {
  const { bill } = await postBill(f.db, tenantId, {
    vendorName: 'Officeworks', billDate: new Date('2026-11-02T00:00:00Z'), dueDate: new Date('2026-12-02T00:00:00Z'), postingMode: 'at_entry',
    lines: [{ description: 'Paper', amountCents, categoryId: 'acct-meals', taxCode: 'GST' }],
  } as any);
  return bill;
}
function netBySource(sourceType: string): Record<string, number> {
  const ids = new Set(f.state.entries.filter((e) => e.sourceType === sourceType).map((e) => e.id));
  const out: Record<string, number> = {};
  for (const l of f.state.lines.filter((x) => ids.has(x.entryId))) out[l.accountId] = (out[l.accountId] ?? 0) + l.debitCents - l.creditCents;
  return out;
}
const ap = () => -(f.netByAccount()['acct-ap'] ?? 0) || 0;

beforeEach(() => {
  f = createFakeLedgerDb();
  f.state.tenantConfigs.push({ ...AU });
  attachBankTables();
  matcherResult.mockReset();
});

describe('scoreBillMatch (proposal heuristics)', () => {
  const t = (o: Partial<MatchableTxn> = {}): MatchableTxn => ({ id: 'x', amountCents: 11000, date: new Date('2026-11-20T12:00:00Z'), name: 'OFFICEWORKS', merchantName: 'Officeworks', ...o });
  const b = { id: 'b', outstandingCents: 11000, billDate: new Date('2026-11-02T00:00:00Z'), dueDate: new Date('2026-12-02T00:00:00Z'), status: 'open', vendorName: 'Officeworks' };
  it('a debit for the outstanding amount between bill and due date auto-matches', () => {
    expect(scoreBillMatch(t(), b)).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });
  it('credits, paid bills, wrong amounts and far-off dates score 0', () => {
    expect(scoreBillMatch(t({ amountCents: -11000 }), b)).toBe(0);
    expect(scoreBillMatch(t(), { ...b, status: 'paid' })).toBe(0);
    expect(scoreBillMatch(t({ amountCents: 15000 }), b)).toBe(0);
    expect(scoreBillMatch(t({ date: new Date('2027-02-01T00:00:00Z') }), b)).toBe(0);
  });
  it('matches what is still owing on a partial bill, not the total', () => {
    expect(scoreBillMatch(t({ amountCents: 6000 }), { ...b, outstandingCents: 6000, status: 'partial' })).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });
});

describe('applyBillMatch', () => {
  it('posts DR 2000 / CR 1000, sets matchedBillId, AP to 0, no expense row', async () => {
    const b = await bill();
    const tx = txn();
    const r = await applyBillMatch({ tenantId: 't1', txnId: tx.id, billId: b.id, source: 'reconciliation' });
    expect(netBySource('bill_payment')).toEqual({ 'acct-ap': 11000, 'acct-cash': -11000 });
    expect([ap(), f.state.expenses.length, txns[0].matchedBillId, txns[0].matchStatus]).toEqual([0, 0, b.id, 'matched']);
    expect([r.billPaid, r.paymentAmountCents, r.remainingCents]).toEqual([true, 11000, 0]);
    expect(f.state.billPayments[0]).toMatchObject({ idempotencyKey: `bank:${tx.id}`, method: 'bank' });
  });
  it('a smaller debit is a partial payment; a retry replays (one payment)', async () => {
    const b = await bill();
    const tx = txn({ amount: 4000 });
    await applyBillMatch({ tenantId: 't1', txnId: tx.id, billId: b.id, source: 'reconciliation' });
    txns[0].matchStatus = 'pending'; // simulate a crash before the txn update
    const r = await applyBillMatch({ tenantId: 't1', txnId: tx.id, billId: b.id, source: 'reconciliation' });
    expect(f.state.billPayments).toHaveLength(1);
    expect([ap(), r.remainingCents, r.billPaid]).toEqual([7000, 7000, false]);
  });
  it('a debit slightly above what is owing settles the bill without overpaying', async () => {
    const b = await bill();
    await applyBillMatch({ tenantId: 't1', txnId: txn({ amount: 11050 }).id, billId: b.id, source: 'reconciliation' });
    expect([ap(), f.state.billPayments[0].amountCents]).toEqual([0, 11000]);
  });
  it('another tenant’s bill → bill_not_found, nothing posted', async () => {
    f.state.bills.push({ id: 'b-t2', tenantId: 't2', vendorName: 'Officeworks', amountCents: 11000, paidCents: 0, status: 'open', postingMode: 'at_entry', dueDate: new Date('2026-12-02T00:00:00Z'), deletedAt: null, revision: 0 });
    const b2 = { id: 'b-t2' };
    const before = f.state.entries.length;
    await expect(applyBillMatch({ tenantId: 't1', txnId: txn().id, billId: b2.id, source: 'reconciliation' })).rejects.toMatchObject({ code: 'bill_not_found' });
    expect([f.state.entries.length, f.state.billPayments.length]).toEqual([before, 0]);
  });
  it('a credit cannot pay a bill', async () => {
    const b = await bill();
    await expect(applyBillMatch({ tenantId: 't1', txnId: txn({ amount: -11000 }).id, billId: b.id, source: 'reconciliation' })).rejects.toBeInstanceOf(BankMatchError);
    expect(f.state.billPayments).toHaveLength(0);
  });
});

describe('wiring', () => {
  const req = (body: unknown) => ({ url: 'http://x', nextUrl: new URL('http://x'), headers: new Headers(), json: async () => body }) as never;
  it('POST bank-transactions/:id/match { targetType: bill } → payment + matchedBillId, no expense', async () => {
    const b = await bill();
    const tx = txn();
    const res = await matchRoute(req({ targetType: 'bill', targetId: b.id }), { params: Promise.resolve({ id: tx.id }) });
    const body = await res.json();
    expect([res.status, body.data.matchedBillId, body.data.amountCents, body.data.fullyPaid]).toEqual([200, b.id, 11000, true]);
    expect([ap(), f.state.expenses.length]).toEqual([0, 0]);
  });
  it('match route: unknown bill → 404', async () => {
    const res = await matchRoute(req({ targetType: 'bill', targetId: 'nope' }), { params: Promise.resolve({ id: txn().id }) });
    expect(res.status).toBe(404);
  });
  it('bank sync auto-match on a bill candidate pays the bill (runMatcherOnTransaction)', async () => {
    const b = await bill();
    const tx = txn();
    matcherResult.mockResolvedValue({ kind: 'bill', targetId: b.id, score: 0.95 });
    const r = await runMatcherOnTransaction('t1', tx);
    expect([r.matchStatus, txns[0].matchedBillId, ap(), f.state.expenses.length]).toEqual(['matched', b.id, 0, 0]);
  });
  it('a review-band bill guess is stored for one tap, nothing paid yet', async () => {
    const b = await bill();
    const tx = txn();
    matcherResult.mockResolvedValue({ kind: 'bill', targetId: b.id, score: 0.6 });
    const r = await runMatcherOnTransaction('t1', tx);
    expect([r.matchStatus, txns[0].matchedBillId, f.state.billPayments.length, ap()]).toEqual(['exception', b.id, 0, 11000]);
  });
  it('candidates route offers "this is for bill X" with what is still owing', async () => {
    const b = await bill();
    f.state.bills[0].paidCents = 4000;
    const tx = txn({ amount: 7000 });
    candidatesResult.mockResolvedValue([{ kind: 'bill', targetId: b.id, score: 0.9 }, { kind: 'bill', targetId: 'b-foreign', score: 0.8 }]);
    const res = await candidatesRoute({ url: 'http://x', nextUrl: new URL('http://x?limit=3'), headers: new Headers() } as never, { params: Promise.resolve({ id: tx.id }) });
    const body = await res.json();
    expect(body.data.candidates).toEqual([{ kind: 'bill', targetId: b.id, label: 'Officeworks', amountCents: 7000, date: '2026-12-02T00:00:00.000Z', score: 0.9 }]);
  });
});
