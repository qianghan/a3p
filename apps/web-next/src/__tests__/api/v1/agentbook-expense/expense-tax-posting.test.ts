// @vitest-environment node
/**
 * PR 2b.5 — posting tax-typed expenses through the REAL routes.
 *
 * Asserts journal lines in cents per account for: AU registrant (incl. GST),
 * CA ON HST, QC with/without QST registration, US (unchanged 2-line),
 * unregistered AU (unchanged), unknown registration (gross + prompt flag),
 * vendor default code, amend reposts a recomputed split, and the
 * amount-below-recoverable-tax refusal (PR 2a Minor-3).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));
vi.mock('@/lib/agentbook-chart-of-accounts', () => ({
  ensureChartOfAccounts: vi.fn(async () => ({ seeded: false, count: 0 })),
  ensureUncategorizedAccount: vi.fn(async () => ({ id: 'acc-susp' })),
  CASH_CODE: '1000',
  UNCATEGORIZED_CODE: '6999',
}));
vi.mock('@/lib/agentbook-auto-categorize', () => ({ autoCategorizeForTenant: vi.fn(), getPendingSuggestions: vi.fn(async () => []) }));
vi.mock('@/lib/agentbook-suggest-category', () => ({ rememberVendorCategory: vi.fn(async () => true) }));
vi.mock('@/lib/agentbook-idempotency', () => ({
  withHttpIdempotency: async (request: Request, opts: { handler: (raw: string) => Promise<{ status: number; body: unknown }> }) => {
    const r = await opts.handler(await request.text().catch(() => ''));
    return new Response(JSON.stringify(r.body), { status: r.status });
  },
}));

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { POST } from '@/app/api/v1/agentbook-expense/expenses/route';
import { PATCH } from '@/app/api/v1/agentbook-expense/expenses/[id]/route';

const ACCOUNTS: Row[] = [
  { id: 'acc-cash', tenantId: 't1', code: '1000', name: 'Cash', accountType: 'asset', isActive: true },
  { id: 'acc-gst', tenantId: 't1', code: '2100', name: 'GST/HST Payable', accountType: 'liability', isActive: true },
  { id: 'acc-office', tenantId: 't1', code: '5200', name: 'Office Supplies', accountType: 'expense', isActive: true },
  { id: 'acc-meals', tenantId: 't1', code: '5100', name: 'Meals & Entertainment', accountType: 'expense', isActive: true },
  { id: 'acc-susp', tenantId: 't1', code: '6999', name: 'Uncategorized', accountType: 'expense', isActive: true },
];

function seed(cfg: Row, extra: { vendors?: Row[]; periods?: Row[] } = {}) {
  memDb.reset(
    {
      abAccount: ACCOUNTS,
      abTenantConfig: [{ id: 'cfg', userId: 't1', currency: 'AUD', ...cfg }],
      abVendor: extra.vendors ?? [],
      abFiscalPeriod: extra.periods ?? [],
    },
    { unique: { abJournalEntry: [['tenantId', 'sourceType', 'sourceId']] } },
  );
}

const AU_REG = { jurisdiction: 'au', region: 'NSW', gstRegistered: true };

async function create(body: Row) {
  const res = await POST(tenantReq('/api/v1/agentbook-expense/expenses', 't1', { method: 'POST', body }));
  return { status: res.status, body: await json<{ success: boolean; data: Row; meta: Row; code?: string }>(res) };
}
async function amend(id: string, body: Row) {
  const res = await PATCH(tenantReq(`/api/v1/agentbook-expense/expenses/${id}`, 't1', { method: 'PATCH', body }), { params: Promise.resolve({ id }) });
  return { status: res.status, body: await json<{ success: boolean; code?: string; error?: string }>(res) };
}

/** The current entry's lines as { account: [debit, credit] }. */
function linesOf(expenseId: string): Record<string, [number, number]> {
  const exp = memDb.table('abExpense').rows.find((e) => e.id === expenseId)!;
  const out: Record<string, [number, number]> = {};
  for (const l of memDb.table('abJournalLine').rows.filter((x) => x.entryId === exp.journalEntryId)) {
    out[l.accountId] = [l.debitCents, l.creditCents];
  }
  return out;
}
const row = (id: string) => memDb.table('abExpense').rows.find((e) => e.id === id)!;

beforeEach(() => seed(AU_REG));

describe('POST /expenses — typed purchases', () => {
  it('AU registrant, $110 incl GST → DR cat 10000 | DR 2100 1000 | CR cash 11000', async () => {
    const r = await create({ amountCents: 11000, vendor: 'Officeworks', categoryId: 'acc-office', taxCode: 'GST', date: '2026-06-10' });
    expect(r.status).toBe(201);
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1000, 0], 'acc-cash': [0, 11000] });
    expect(row(r.body.data.id)).toMatchObject({ taxCode: 'GST', taxAmountCents: 1000, recoverableTaxCents: 1000 });
  });

  it('AU registrant with no code gets the jurisdiction default (GST)', async () => {
    const r = await create({ amountCents: 11000, categoryId: 'acc-office' });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1000, 0], 'acc-cash': [0, 11000] });
  });

  it("the vendor's default tax code applies when the caller gives none (FRE → no credit, 2-line)", async () => {
    seed(AU_REG, { vendors: [{ id: 'v-fre', tenantId: 't1', name: 'Fresh Food', normalizedName: 'freshfood', defaultTaxCode: 'FRE', transactionCount: 1 }] });
    const r = await create({ amountCents: 5000, vendor: 'Fresh Food', categoryId: 'acc-office' });
    expect(row(r.body.data.id)).toMatchObject({ taxCode: 'FRE', recoverableTaxCents: 0 });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [5000, 0], 'acc-cash': [0, 5000] });
  });

  it('CA ON registrant, $113 HST → DR cat 10000 | DR 2100 1300 | CR cash 11300', async () => {
    seed({ jurisdiction: 'ca', region: 'ON', gstRegistered: true, currency: 'CAD' });
    const r = await create({ amountCents: 11300, categoryId: 'acc-office', taxCode: 'HST' });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1300, 0], 'acc-cash': [0, 11300] });
  });

  it('CA ON meals: half the HST is recoverable', async () => {
    seed({ jurisdiction: 'ca', region: 'ON', gstRegistered: true, currency: 'CAD' });
    const r = await create({ amountCents: 11300, categoryId: 'acc-meals', taxCode: 'HST' });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-meals': [10650, 0], 'acc-gst': [650, 0], 'acc-cash': [0, 11300] });
  });

  it('QC, QST registered: GST 500 + QST 998 recoverable', async () => {
    seed({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: true, currency: 'CAD' });
    const r = await create({ amountCents: 11498, categoryId: 'acc-office', taxCode: 'GST_QST' });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1498, 0], 'acc-cash': [0, 11498] });
  });

  it('QC, QST NOT registered: only GST 500 recoverable, QST stays in cost', async () => {
    seed({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: false, currency: 'CAD' });
    const r = await create({ amountCents: 11498, categoryId: 'acc-office', taxCode: 'GST_QST' });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [10998, 0], 'acc-gst': [500, 0], 'acc-cash': [0, 11498] });
  });

  it('US: unchanged 2-line gross, even with SALES_TAX', async () => {
    seed({ jurisdiction: 'us', region: 'CA', gstRegistered: null, currency: 'USD' });
    const a = await create({ amountCents: 10725, categoryId: 'acc-office', taxCode: 'SALES_TAX' });
    expect(linesOf(a.body.data.id)).toEqual({ 'acc-office': [10725, 0], 'acc-cash': [0, 10725] });
    expect(row(a.body.data.id)).toMatchObject({ recoverableTaxCents: 0, taxAmountCents: 725 });
    const b = await create({ amountCents: 4200, categoryId: 'acc-office' });
    expect(linesOf(b.body.data.id)).toEqual({ 'acc-office': [4200, 0], 'acc-cash': [0, 4200] });
    expect(row(b.body.data.id).taxCode ?? null).toBeNull();
    expect(a.body.meta.taxRegistrationPrompt).toBe(false);
  });

  it('unregistered AU: unchanged 2-line gross, no default code', async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: false });
    const r = await create({ amountCents: 11000, categoryId: 'acc-office' });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
    expect(row(r.body.data.id).taxCode ?? null).toBeNull();
    const typed = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST' });
    expect(linesOf(typed.body.data.id)).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
    expect(row(typed.body.data.id).recoverableTaxCents).toBe(0);
  });

  it('unknown registration (null): posts gross and returns the prompt flag', async () => {
    seed({ jurisdiction: 'au', region: 'NSW', gstRegistered: null });
    const r = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST' });
    expect(linesOf(r.body.data.id)).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
    expect(r.body.meta.taxRegistrationPrompt).toBe(true);
  });

  it('an unknown explicit tax code is a 400, nothing written', async () => {
    const r = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'HST' });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('invalid_tax_code');
    expect(memDb.table('abExpense').rows).toHaveLength(0);
    expect(memDb.table('abJournalEntry').rows).toHaveLength(0);
  });

  it('printed tax within 2¢ wins; outside keeps computed and flags review', async () => {
    const near = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST', taxAmountCents: 1002 });
    expect(linesOf(near.body.data.id)).toEqual({ 'acc-office': [9998, 0], 'acc-gst': [1002, 0], 'acc-cash': [0, 11000] });
    expect(near.body.meta.taxReview).toBe(false);
    const far = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST', taxAmountCents: 1500 });
    expect(linesOf(far.body.data.id)).toEqual({ 'acc-office': [10000, 0], 'acc-gst': [1000, 0], 'acc-cash': [0, 11000] });
    expect(row(far.body.data.id).taxAmountCents).toBe(1000);
    expect(far.body.meta.taxReview).toBe(true);
  });

  it('a closed period refuses the posting (422) and writes nothing', async () => {
    seed(AU_REG, { periods: [{ id: 'p', tenantId: 't1', year: 2026, month: 3, status: 'closed' }] });
    const r = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST', date: '2026-03-15' });
    expect(r.status).toBe(422);
    expect(memDb.table('abJournalEntry').rows).toHaveLength(0);
  });

  it('the entry is keyed by the expense (one entry per expense)', async () => {
    const r = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST' });
    const entries = memDb.table('abJournalEntry').rows;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ sourceType: 'expense', sourceId: r.body.data.id });
  });
});

describe('PATCH /expenses/:id — typed amend', () => {
  it('changing the amount of a typed row reposts the recomputed split', async () => {
    const r = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST', date: '2026-06-10' });
    const id = r.body.data.id as string;
    const a = await amend(id, { amountCents: 22000 });
    expect(a.status).toBe(200);
    expect(row(id)).toMatchObject({ amountCents: 22000, recoverableTaxCents: 2000, taxAmountCents: 2000 });
    expect(linesOf(id)).toEqual({ 'acc-office': [20000, 0], 'acc-gst': [2000, 0], 'acc-cash': [0, 22000] });
  });

  it('changing the tax code reposts (GST → FRE drops the credit)', async () => {
    const r = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST' });
    const id = r.body.data.id as string;
    expect((await amend(id, { taxCode: 'FRE' })).status).toBe(200);
    expect(linesOf(id)).toEqual({ 'acc-office': [11000, 0], 'acc-cash': [0, 11000] });
    expect(row(id)).toMatchObject({ taxCode: 'FRE', recoverableTaxCents: 0 });
  });

  it('an amount at or below the recoverable tax gets its own error, not the split message', async () => {
    // Stored recoverable tax that the engine can't recompute (tenant moved to an unsupported jurisdiction).
    const r = await create({ amountCents: 11000, categoryId: 'acc-office', taxCode: 'GST' });
    const id = r.body.data.id as string;
    memDb.table('abTenantConfig').rows[0].jurisdiction = 'uk';
    const a = await amend(id, { amountCents: 900 });
    expect(a.status).toBe(422);
    expect(a.body.code).toBe('amount_below_recoverable_tax');
    expect(a.body.error).not.toMatch(/split/);
    // (mem-db has no $transaction rollback, so the row write is not asserted here;
    // the ledger is: no amend entry was appended.)
    expect(memDb.table('abJournalEntry').rows.filter((e) => e.sourceType === 'expense_amend')).toHaveLength(0);
  });
});
