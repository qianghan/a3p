// @vitest-environment node
/**
 * PR 5B (R-X-1) — full-journal property test across the programme's posting
 * paths: bills (taxed, at_entry/at_payment, item lines), payments, voids,
 * opening stock, invoice stock sales / edits / voids, shrinkage adjustments,
 * and payroll entries. 150 seeded random sequences; after every sequence:
 *   Σdr = Σcr;
 *   journal 2000 == Σ(open/partial at_entry bills − paid);
 *   journal 1500 == Σ item onHandValueCents (sub-ledger ties to the GL);
 *   every item at qty 0 has value 0 unless it went negative.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acct-suspense' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-suggest-category', () => ({ suggestCategory: vi.fn(async () => null) }));

import { createFakeLedgerDb } from './fake-ledger-db';
import { postBill, payBill, voidBill, voidPayment, PurchaseError } from '../purchases';
import {
  recordOpeningStock, adjustStock, postInvoiceCogs, voidInvoiceCogs, repostInvoiceLineCogs, InventoryError, toUnits,
} from '../inventory';
import { appendBalancedEntry } from '../ledger-writer';
import { splitPayrollEntry } from '../payroll-ledger';

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

const D = new Date('2026-11-05T00:00:00Z');

describe('full journal invariants (seeded property test)', () => {
  it('150 random sequences keep Σdr = Σcr, AP = open bills, 1500 = stock value', async () => {
    for (let seq = 1; seq <= 150; seq++) {
      const r = rng(seq * 104729);
      const f = createFakeLedgerDb();
      const jurisdiction = ['us', 'ca', 'au'][seq % 3];
      f.state.tenantConfigs.push({ userId: 't1', jurisdiction, region: jurisdiction === 'au' ? 'NSW' : 'ON', gstRegistered: true, currency: 'USD', accountingBasis: 'accrual', trackInventory: true });
      for (const id of ['item-a', 'item-b']) {
        f.state.items.push({ id, tenantId: 't1', name: id, unit: 'each', onHandQty: '0.0000', onHandValueCents: 0, isActive: true, deletedAt: null });
      }
      const db = f.db as never;
      const tx = <T,>(fn: (t: never) => Promise<T>) => f.db.$transaction(fn as never) as Promise<T>;
      const pick = <T,>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
      const sold: Array<{ id: string; itemId: string; rev: number; voided: boolean }> = [];
      let n = 0;

      const op = async () => {
        const c = r();
        const itemId = r() < 0.5 ? 'item-a' : 'item-b';
        const amount = 100 + Math.floor(r() * 20000);
        try {
          if (c < 0.2) {
            await postBill(db, 't1', {
              vendorName: 'V', billDate: D, dueDate: new Date('2026-12-05T00:00:00Z'),
              postingMode: r() < 0.6 ? 'at_entry' : 'at_payment',
              lines: [r() < 0.6
                ? { description: 'stock', amountCents: amount, itemId, qty: 1 + Math.floor(r() * 9), taxCode: jurisdiction === 'au' && r() < 0.5 ? 'GST' : null }
                : { description: 'svc', amountCents: amount, categoryId: 'acct-meals', taxCode: null }],
            } as never);
          } else if (c < 0.35 && f.state.bills.length) {
            await payBill(db, 't1', pick(f.state.bills).id, {});
          } else if (c < 0.42) {
            const ps = f.state.billPayments.filter((p) => !p.voidedAt);
            if (ps.length) await voidPayment(db, 't1', pick(ps).id);
          } else if (c < 0.48 && f.state.bills.length) {
            await voidBill(db, 't1', pick(f.state.bills).id);
          } else if (c < 0.53) {
            await recordOpeningStock(db, 't1', { itemId, qty: 1 + Math.floor(r() * 5), valueCents: amount, date: D });
          } else if (c < 0.68) {
            const id = `line-${++n}`;
            await tx((t) => postInvoiceCogs(t, 't1', { invoiceNumber: `INV-${n}`, date: D, lines: [{ id, itemId, quantity: 0.5 + Math.floor(r() * 8) }] }));
            sold.push({ id, itemId, rev: 0, voided: false });
          } else if (c < 0.76 && sold.some((s) => !s.voided)) {
            const s = pick(sold.filter((x) => !x.voided));
            s.rev += 1;
            await tx((t) => repostInvoiceLineCogs(t, 't1', { invoiceNumber: 'INV', date: D, line: { id: s.id, itemId: s.itemId, quantity: 1 + Math.floor(r() * 6) }, rev: s.rev }));
          } else if (c < 0.84 && sold.some((s) => !s.voided)) {
            const s = pick(sold.filter((x) => !x.voided));
            await tx((t) => voidInvoiceCogs(t, 't1', { invoiceNumber: 'INV', date: D, lineIds: [s.id] }));
            s.voided = true;
          } else if (c < 0.9) {
            await adjustStock(db, 't1', { itemId, qty: -1, date: D, reason: 'shrink', idempotencyKey: `adj-${seq}-${++n}` });
          } else {
            // Payroll entry: random stubs whose net + withheld = gross.
            const gross = 50_000 + Math.floor(r() * 400_000);
            const fed = Math.floor(gross * 0.12), st = Math.floor(gross * 0.04), fica = Math.floor(gross * 0.0765);
            const sg = jurisdiction === 'au' ? Math.round(gross * 0.115) : 0;
            const e = splitPayrollEntry([{ grossCents: gross, federalTaxCents: fed, stateTaxCents: st, ficaCents: fica, otherDeductCents: 0, netCents: gross - fed - st - fica, sgCents: sg }]);
            await appendBalancedEntry(f.db as never, 't1', { date: D, memo: 'payroll', sourceType: 'payroll', sourceId: `pr-${seq}-${++n}` }, [
              { accountId: 'acct-salary', debitCents: e.grossCents, creditCents: 0, description: 'payroll' },
              ...(e.sgCents ? [{ accountId: 'acct-super-exp', debitCents: e.sgCents, creditCents: 0, description: 'payroll' }, { accountId: 'acct-super-pay', debitCents: 0, creditCents: e.sgCents, description: 'payroll' }] : []),
              { accountId: 'acct-cash', debitCents: 0, creditCents: e.netCents, description: 'payroll' },
              { accountId: 'acct-payroll-liab', debitCents: 0, creditCents: e.withheldCents, description: 'payroll' },
            ]);
          }
        } catch (err) {
          const coded = err instanceof PurchaseError || err instanceof InventoryError;
          if (!coded || (err as { status: number }).status >= 500) throw err;
        }
      };
      for (let i = 0; i < 30; i++) await op();

      const dr = f.state.lines.reduce((s, l) => s + l.debitCents, 0);
      const cr = f.state.lines.reduce((s, l) => s + l.creditCents, 0);
      expect(dr, `seq ${seq}`).toBe(cr);
      const net = f.netByAccount();
      const openAp = f.state.bills
        .filter((b) => b.postingMode === 'at_entry' && (b.status === 'open' || b.status === 'partial'))
        .reduce((s, b) => s + b.amountCents - b.paidCents, 0);
      expect(0 - (net['acct-ap'] ?? 0) + 0, `seq ${seq} AP`).toBe(openAp);
      expect(net['acct-inv'] ?? 0, `seq ${seq} 1500`).toBe(f.state.items.reduce((s, i) => s + i.onHandValueCents, 0));
      for (const i of f.state.items) {
        const wentNegative = f.state.movements.some((m) => m.itemId === i.id && m.type === 'stock_adjust' && String(m.sourceId).startsWith('trueup:'));
        if (toUnits(i.onHandQty) === 0 && !wentNegative) expect(i.onHandValueCents, `seq ${seq} ${i.id} zero at zero`).toBe(0);
      }
    }
  }, 120_000);
});
