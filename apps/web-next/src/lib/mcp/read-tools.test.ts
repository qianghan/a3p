import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The MCP read tools.
 *
 * The assertion that matters most is the boring one: every query is scoped to
 * the caller's tenant. An MCP server instance is long-lived and serves exactly
 * one tenant, so a query that forgets its `tenantId` does not return nothing —
 * it returns another customer's books, to a model, over a connector.
 */

const db = {
  abTenantConfig: { findUnique: vi.fn() },
  abExpense: { findMany: vi.fn(), aggregate: vi.fn(), groupBy: vi.fn() },
  abAccount: { findMany: vi.fn() },
  abInvoice: { findMany: vi.fn(), aggregate: vi.fn() },
};
const getCashPosition = vi.fn();

// read-tools.ts is `import 'server-only'`; vitest resolves the client build of
// that package, which throws on import. Same stub the logger test uses.
vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ prisma: db }));
vi.mock('@agentbook-core/cash-position', () => ({ getCashPosition }));

const TENANT = 'tenant-under-test';

beforeEach(() => {
  vi.clearAllMocks();
  db.abTenantConfig.findUnique.mockResolvedValue({ defaultCurrency: 'CAD', jurisdiction: 'ca' });
  db.abExpense.findMany.mockResolvedValue([]);
  db.abExpense.aggregate.mockResolvedValue({ _sum: { amountCents: 0 }, _count: 0 });
  db.abExpense.groupBy.mockResolvedValue([]);
  db.abAccount.findMany.mockResolvedValue([]);
  db.abInvoice.findMany.mockResolvedValue([]);
  db.abInvoice.aggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  getCashPosition.mockResolvedValue({ totalCents: 0, accounts: [] });
});

const load = () => import('./read-tools');

describe('every query is scoped to the caller tenant', () => {
  /**
   * Checked on the arguments actually passed to Prisma, not on the returned
   * value. A mock that ignores `where` returns the right answer for the wrong
   * reason — this repo has already shipped a bug whose whole cause was a
   * filter the test's fixed-array mock could not fail on.
   */
  const everyWhereClause = () => [
    ...db.abExpense.findMany.mock.calls,
    ...db.abExpense.aggregate.mock.calls,
    ...db.abExpense.groupBy.mock.calls,
    ...db.abInvoice.findMany.mock.calls,
    ...db.abInvoice.aggregate.mock.calls,
  ].map(([args]) => args?.where).filter(Boolean);

  it('list_expenses filters on tenantId', async () => {
    const { readExpenses } = await load();
    await readExpenses(TENANT);
    const wheres = everyWhereClause();
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) expect(w.tenantId).toBe(TENANT);
  });

  it('get_expense_breakdown filters on tenantId', async () => {
    const { readExpenseBreakdown } = await load();
    await readExpenseBreakdown(TENANT);
    const wheres = everyWhereClause();
    expect(wheres.length).toBeGreaterThan(0);
    for (const w of wheres) expect(w.tenantId).toBe(TENANT);
  });

  it('list_invoices filters on tenantId, including the totals', async () => {
    const { readInvoices } = await load();
    await readInvoices(TENANT);
    const wheres = everyWhereClause();
    // three queries: the page, the outstanding total, the overdue total
    expect(wheres.length).toBe(3);
    for (const w of wheres) expect(w.tenantId).toBe(TENANT);
  });

  it('the source contains no query without a tenantId', () => {
    // Belt and braces against a tool added later that the cases above do not
    // cover: every `where: {` in this file must mention tenantId.
    const src = readFileSync(join(__dirname, 'read-tools.ts'), 'utf8');
    const wheres = [...src.matchAll(/where:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)].map((m) => m[1]);
    const unscoped = wheres.filter((w) => !/tenantId|userId|id:\s*\{\s*in:/.test(w));
    expect(unscoped, `where clause with no tenant filter: ${unscoped.join(' | ')}`).toEqual([]);
  });
});

describe('amounts carry their currency', () => {
  it('uses the tenant currency, not a hardcoded dollar', async () => {
    const { readCashPosition } = await load();
    getCashPosition.mockResolvedValue({ totalCents: 20_708_110, accounts: [{ name: 'Cash', balanceCents: 20_708_110 }] });
    const out = await readCashPosition(TENANT);
    expect(out.total).toEqual({ cents: 20_708_110, currency: 'CAD' });
    expect(out.accounts[0].balance.currency).toBe('CAD');
  });

  it('falls back to the jurisdiction when no default is stored', async () => {
    const { readCashPosition } = await load();
    db.abTenantConfig.findUnique.mockResolvedValue({ defaultCurrency: null, jurisdiction: 'au' });
    expect((await readCashPosition(TENANT)).total.currency).toBe('AUD');
  });

  it("an invoice keeps the currency it was ISSUED in, not the tenant's", async () => {
    // A cross-border invoice restated in the tenant's currency is a wrong
    // number, not a formatting choice.
    const { readInvoices } = await load();
    db.abInvoice.findMany.mockResolvedValue([{
      id: 'i1', number: 'INV-1', issuedDate: new Date('2026-01-01'), dueDate: new Date('2026-02-01'),
      status: 'sent', amountCents: 500_000, currency: 'USD', client: { name: 'Acme' },
    }]);
    const out = await readInvoices(TENANT);
    expect(out.invoices[0].amount).toEqual({ cents: 500_000, currency: 'USD' });
    expect(out.outstanding.currency).toBe('CAD');
  });
});

describe('totals describe the whole book, not the page', () => {
  it('list_expenses totals the period even when rows are truncated', async () => {
    const { readExpenses } = await load();
    db.abExpense.findMany.mockResolvedValue([
      { id: 'e1', date: new Date('2026-03-01'), description: 'x', amountCents: 100, categoryId: null, vendor: null },
    ]);
    db.abExpense.aggregate.mockResolvedValue({ _sum: { amountCents: 999_00 }, _count: 412 });
    const out = await readExpenses(TENANT, { limit: 1 });
    // A caller summing `expenses` would get 100. The point of `total` and
    // `count` is that they do not agree with the page — and should not.
    expect(out.expenses).toHaveLength(1);
    expect(out.total.cents).toBe(999_00);
    expect(out.count).toBe(412);
  });
});

describe('bounds', () => {
  it('clamps limit to MAX_ROWS and refuses zero', async () => {
    const { readExpenses, MAX_ROWS } = await load();
    await readExpenses(TENANT, { limit: 10_000 });
    expect(db.abExpense.findMany.mock.calls[0][0].take).toBe(MAX_ROWS);
    vi.clearAllMocks();
    db.abExpense.findMany.mockResolvedValue([]);
    db.abExpense.aggregate.mockResolvedValue({ _sum: { amountCents: 0 }, _count: 0 });
    db.abTenantConfig.findUnique.mockResolvedValue({ defaultCurrency: 'CAD' });
    await readExpenses(TENANT, { limit: 0 });
    expect(db.abExpense.findMany.mock.calls[0][0].take).toBe(1);
  });

  it('defaults the period to this calendar year rather than all time', async () => {
    const { resolvePeriod } = await load();
    const { from } = resolvePeriod();
    expect(from.getUTCMonth()).toBe(0);
    expect(from.getUTCDate()).toBe(1);
    expect(from.getUTCFullYear()).toBe(new Date().getUTCFullYear());
  });

  it('rejects an unparseable or inverted range', async () => {
    const { resolvePeriod } = await load();
    expect(() => resolvePeriod('not-a-date')).toThrow(/ISO/);
    expect(() => resolvePeriod('2026-06-01', '2026-01-01')).toThrow(/after/);
  });
});

describe('uncategorised spend is reported, not dropped', () => {
  it('names it rather than omitting it', async () => {
    const { readExpenseBreakdown } = await load();
    db.abExpense.groupBy.mockResolvedValue([
      { categoryId: 'acc-1', _sum: { amountCents: 7_500 } },
      { categoryId: null, _sum: { amountCents: 2_500 } },
    ]);
    db.abAccount.findMany.mockResolvedValue([{ id: 'acc-1', name: 'Travel' }]);
    const out = await readExpenseBreakdown(TENANT);
    const names = out.categories.map((c) => c.category);
    // Dropping the null bucket would make the shares sum to less than 100%
    // with nothing to explain the gap.
    expect(names).toContain('Uncategorised');
    expect(out.categories.reduce((n, c) => n + c.share, 0)).toBeCloseTo(100, 1);
    expect(out.total.cents).toBe(10_000);
  });
});

describe('the tools are declared read-only', () => {
  it('all four carry readOnlyHint and none is destructive', () => {
    // What lets a client call them without the elicitation round-trip that
    // ask_agentbook needs. A write tool slipping into this set would be
    // callable with no confirmation at all.
    const src = readFileSync(join(__dirname, '..', '..', 'app', 'api', 'v1', 'mcp', 'route.ts'), 'utf8');
    const block = src.slice(src.indexOf('function registerReadTools'), src.indexOf('Builds a brand-new'));
    const registered = [...block.matchAll(/server\.registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(registered.sort()).toEqual(['get_cash_position', 'get_expense_breakdown', 'list_expenses', 'list_invoices']);
    expect(block).toContain('readOnlyHint: true');
    expect(block).not.toMatch(/destructiveHint:\s*true/);
    // every tool must use the shared annotation object
    expect((block.match(/annotations: readOnly/g) || []).length).toBe(registered.length);
  });
});
