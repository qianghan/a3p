// @vitest-environment node
/**
 * PR 2b.5 — receipt capture posts tax via the table, through the real route
 * and the real ledger (backfillExpenseJournalEntry is NOT mocked).
 * Printed OCR tax within 2¢ of the computed tax wins; further off, the
 * computed figure is kept and the row is held in review, unbooked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));
vi.mock('@vercel/blob', () => ({ put: vi.fn(async (path: string) => ({ url: `https://blob.test/${path}` })) }));
const ocr = vi.fn();
vi.mock('@/lib/agentbook-receipt-ocr', () => ({
  checkOcrQuota: vi.fn(async () => ({ allowed: true })),
  ocrReceiptBytes: (...a: unknown[]) => ocr(...a),
}));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acc-susp' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import type { FromReceiptResult } from '@/lib/mobile/types';
import { POST } from '@/app/api/v1/agentbook-expense/expenses/from-receipt/route';

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const ACCOUNTS: Row[] = [
  { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
  { id: 'acc-gst', tenantId: 't1', code: '2100', name: 'GST Payable', accountType: 'liability', isActive: true },
  { id: 'acc-office', tenantId: 't1', code: '5200', name: 'Office Supplies', accountType: 'expense', isActive: true },
];

function seed(cfg: Row) {
  memDb.reset(
    {
      abAccount: ACCOUNTS,
      abTenantConfig: [{ id: 'cfg', userId: 't1', currency: 'AUD', ...cfg }],
      abVendor: [{ id: 'v-ow', tenantId: 't1', name: 'Officeworks', normalizedName: 'officeworks', defaultCategoryId: 'acc-office', transactionCount: 3 }],
    },
    { unique: { abIdempotencyKey: [['key']], abJournalEntry: [['tenantId', 'sourceType', 'sourceId']] } },
  );
}

const read = (tax_cents: number) => ({
  amount_cents: 11000, vendor: 'Officeworks', date: '2026-06-19', dateFound: true,
  currency: 'AUD', items: null, tax_cents, tip_cents: 0, confidence: 0.95,
});

async function send(key: string) {
  const f = new FormData();
  f.set('file', new File([JPEG], 'r.jpg', { type: 'image/jpeg' }));
  f.set('idempotencyKey', key);
  const res = await POST(tenantReq('/api/v1/agentbook-expense/expenses/from-receipt', 't1', { method: 'POST', form: f }));
  return { status: res.status, body: await json<{ success: boolean; data: FromReceiptResult }>(res) };
}

function linesOf(expenseId: string): Record<string, [number, number]> | null {
  const exp = memDb.table('abExpense').rows.find((e) => e.id === expenseId)!;
  if (!exp.journalEntryId) return null;
  const out: Record<string, [number, number]> = {};
  for (const l of memDb.table('abJournalLine').rows.filter((x) => x.entryId === exp.journalEntryId)) out[l.accountId] = [l.debitCents, l.creditCents];
  return out;
}
const row = (id: string) => memDb.table('abExpense').rows.find((e) => e.id === id)!;

beforeEach(() => {
  seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: true });
  ocr.mockReset();
});

describe('from-receipt — OCR tax fields reach the client (PR 2b.8)', () => {
  it('returns the printed tax and its label beside the amount', async () => {
    ocr.mockResolvedValue({ ...read(1000), tax_label: 'GST' });
    const { body } = await send('key-tax-label1');
    expect(body.data.ocr).toMatchObject({ amountCents: 11000, taxCents: 1000, taxLabel: 'GST' });
  });
  it('no printed tax: taxCents and taxLabel are null', async () => {
    ocr.mockResolvedValue(read(0));
    const { body } = await send('key-tax-label2');
    expect(body.data.ocr).toMatchObject({ taxCents: null, taxLabel: null });
  });
});

describe('from-receipt — tax-typed posting', () => {
  it('AU registrant, printed GST equals computed: confirmed, DR 10000 | DR 2100 1000 | CR 11000', async () => {
    ocr.mockResolvedValue(read(1000));
    const { status, body } = await send('key-tax-0001');
    expect(status).toBe(201);
    const id = body.data.doc.id;
    expect(row(id)).toMatchObject({ status: 'confirmed', taxCode: 'GST', taxAmountCents: 1000, recoverableTaxCents: 1000 });
    expect(linesOf(id)).toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1000, 0], 'acc-cash': [0, 11000] });
  });

  it('printed tax 2¢ off the computed tax wins (1002 vs 1000)', async () => {
    ocr.mockResolvedValue(read(1002));
    const { body } = await send('key-tax-0002');
    const id = body.data.doc.id;
    expect(row(id)).toMatchObject({ status: 'confirmed', taxAmountCents: 1002, recoverableTaxCents: 1002 });
    expect(linesOf(id)).toEqual({ 'acc-office': [9998, 0], 'acc-gst': [1002, 0], 'acc-cash': [0, 11000] });
    expect(body.data.taxReview).toBeUndefined();
  });

  it('printed tax 3¢+ off: computed kept, held in review, nothing booked', async () => {
    ocr.mockResolvedValue(read(1003));
    const { body } = await send('key-tax-0003');
    const id = body.data.doc.id;
    expect(row(id)).toMatchObject({ status: 'pending_review', taxAmountCents: 1000, recoverableTaxCents: 1000 });
    expect(linesOf(id)).toBeNull();
    expect(body.data.taxReview).toBe(true);
  });

  it('unregistered AU: untyped, unchanged 2-line gross', async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: false });
    ocr.mockResolvedValue(read(1000));
    const { body } = await send('key-tax-0004');
    const id = body.data.doc.id;
    expect(row(id).taxCode ?? null).toBeNull();
    expect(row(id).taxAmountCents).toBe(1000);
    expect(linesOf(id)).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
  });

  it('unknown registration: gross 2-line and the prompt flag', async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: null });
    ocr.mockResolvedValue(read(1000));
    const { body } = await send('key-tax-0005');
    expect(linesOf(body.data.doc.id)).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
    expect(body.data.taxRegistrationPrompt).toBe(true);
  });

  it('a replay of the same key stays one expense and one entry', async () => {
    ocr.mockResolvedValue(read(1000));
    await send('key-tax-0006');
    const again = await send('key-tax-0006');
    expect(again.body.data.duplicate).toBe(true);
    expect(memDb.table('abExpense').rows).toHaveLength(1);
    expect(memDb.table('abJournalEntry').rows).toHaveLength(1);
  });
});
