// @vitest-environment node
/**
 * PR 3bc.2 — property test: 200 seeded random sequences of
 * post / pay / partial pay / void payment / void bill / amend, some run
 * concurrently, across two tenants. After every sequence:
 *   Σdr = Σcr;
 *   journal 2000 balance per tenant == Σ(open+partial at_entry totals − paid);
 *   0 ≤ paidCents ≤ amountCents and paidCents == Σ live payments.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async (t: string) => ({ id: t === 't1' ? 'acct-suspense' : 't2-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: vi.fn(async () => null) }));

import { createFakeLedgerDb } from './fake-ledger-db';
import { postBill, payBill, voidBill, voidPayment, amendBill, PurchaseError } from '../purchases';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fresh() {
  const f = createFakeLedgerDb();
  f.state.accounts.push(
    { id: 't2-cash', tenantId: 't2', code: '1000', accountType: 'asset', isActive: true },
    { id: 't2-ap', tenantId: 't2', code: '2000', accountType: 'liability', isActive: true },
    { id: 't2-gst', tenantId: 't2', code: '2100', accountType: 'liability', isActive: true },
    { id: 't2-suspense', tenantId: 't2', code: '6999', accountType: 'expense', isActive: true },
  );
  f.state.tenantConfigs.push(
    { userId: 't1', jurisdiction: 'au', region: 'NSW', gstRegistered: true, currency: 'AUD' },
    { userId: 't2', jurisdiction: 'us', region: 'CA', gstRegistered: null, currency: 'USD' },
  );
  return f;
}

const CAT: Record<string, string> = { t1: 'acct-meals', t2: 't2-meals' };
const AP: Record<string, string> = { t1: 'acct-ap', t2: 't2-ap' };

describe('purchases engine invariants (seeded property test)', () => {
  it('200 random sequences keep the ledger balanced and AP == open bills', async () => {
    for (let seq = 1; seq <= 200; seq++) {
      const r = rng(seq * 7919);
      const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
      const f = fresh();
      const db = f.db as never;
      const op = async () => {
        const t = r() < 0.6 ? 't1' : 't2';
        const bills = f.state.bills.filter((b) => b.tenantId === t);
        const choice = r();
        const amount = 100 + Math.floor(r() * 50000);
        try {
          if (choice < 0.3 || bills.length === 0) {
            await postBill(db, t, {
              vendorName: 'V', billDate: new Date('2026-11-01T00:00:00Z'), dueDate: new Date('2026-12-01T00:00:00Z'),
              postingMode: r() < 0.8 ? 'at_entry' : 'at_payment',
              lines: [{ description: 'L', amountCents: amount, categoryId: t === 't1' ? CAT.t1 : null, taxCode: t === 't1' && r() < 0.7 ? 'GST' : null }],
              idempotencyKey: r() < 0.2 ? `k${Math.floor(r() * 3)}` : null,
            });
          } else if (choice < 0.6) {
            const b = pick(bills);
            const partial = b.postingMode === 'at_entry' && r() < 0.6;
            await payBill(db, t, b.id, partial ? { amountCents: 1 + Math.floor(r() * b.amountCents) } : {});
          } else if (choice < 0.75) {
            const ps = f.state.billPayments.filter((p) => p.tenantId === t && !p.voidedAt);
            if (ps.length) await voidPayment(db, t, pick(ps).id);
          } else if (choice < 0.88) {
            await voidBill(db, t, pick(bills).id);
          } else {
            await amendBill(db, t, pick(bills).id, { lines: [{ description: 'A', amountCents: amount, categoryId: t === 't1' ? CAT.t1 : null }] });
          }
        } catch (err) {
          if (!(err instanceof PurchaseError) || err.status >= 500) throw err;
        }
      };
      for (let i = 0; i < 25; i++) {
        if (r() < 0.25) await Promise.all([op(), op()]);
        else await op();
      }

      const dr = f.state.lines.reduce((s, l) => s + l.debitCents, 0);
      const cr = f.state.lines.reduce((s, l) => s + l.creditCents, 0);
      expect(dr, `seq ${seq}`).toBe(cr);
      for (const t of ['t1', 't2']) {
        const ap = f.state.lines.filter((l) => l.accountId === AP[t]).reduce((s, l) => s + l.creditCents - l.debitCents, 0);
        const expected = f.state.bills
          .filter((b) => b.tenantId === t && b.postingMode === 'at_entry' && (b.status === 'open' || b.status === 'partial'))
          .reduce((s, b) => s + b.amountCents - b.paidCents, 0);
        expect(ap, `seq ${seq} ${t}`).toBe(expected);
      }
      for (const b of f.state.bills) {
        expect(b.paidCents).toBeGreaterThanOrEqual(0);
        expect(b.paidCents).toBeLessThanOrEqual(b.amountCents);
        const live = f.state.billPayments.filter((p) => p.billId === b.id && !p.voidedAt).reduce((s, p) => s + p.amountCents, 0);
        expect(b.paidCents, `seq ${seq} bill ${b.id}`).toBe(live);
      }
    }
  }, 60_000);
});
