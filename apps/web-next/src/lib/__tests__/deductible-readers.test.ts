import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

// One AU registrant typed expense ($110 incl GST, $10 recoverable) + one untyped ($50).
const ROWS = [
  { id: 'e1', tenantId: 't', vendorId: 'v1', categoryId: 'c1', amountCents: 11000, recoverableTaxCents: 1000, date: new Date(), isPersonal: false, vendor: { name: 'V1' } },
  { id: 'e2', tenantId: 't', vendorId: 'v1', categoryId: 'c1', amountCents: 5000, recoverableTaxCents: 0, date: new Date(), isPersonal: false, vendor: { name: 'V1' } },
];
const sum = (k: 'amountCents' | 'recoverableTaxCents') => ROWS.reduce((s, r) => s + r[k], 0);

vi.mock('@naap/database', () => ({
  prisma: {
    abExpense: {
      findMany: vi.fn(async () => ROWS),
      groupBy: vi.fn(async (args: { by: string[]; _sum: Record<string, boolean> }) => [{
        [args.by[0]]: args.by[0] === 'vendorId' ? 'v1' : 'c1',
        _sum: Object.fromEntries(Object.keys(args._sum).map((k) => [k, sum(k as 'amountCents')])),
        _count: { _all: 2 },
      }]),
    },
    abAccount: { findMany: vi.fn(async () => [{ id: 'c1', name: 'Cat' }]) },
    abVendor: { findMany: vi.fn(async () => [{ id: 'v1', name: 'V1' }]) },
  },
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 't' })),
  resolveAgentbookTenant: vi.fn(async () => 't'),
}));

const req = () => new NextRequest('http://x/api?startDate=2020-01-01');
const json = async (r: Response) => (await r.json()).data;

describe('table readers use the deductible figure (15000, not 16000)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('category-breakdown', async () => {
    const { GET } = await import('@/app/api/v1/agentbook-tax/reports/category-breakdown/route');
    const d = await json(await GET(req()));
    expect(d[0].totalCents).toBe(15000);
  });
  it('expense-by-vendor', async () => {
    const { GET } = await import('@/app/api/v1/agentbook-tax/reports/expense-by-vendor/route');
    const d = await json(await GET(req()));
    expect(d[0].totalCents).toBe(15000);
  });
  it('expense vendors list', async () => {
    const { GET } = await import('@/app/api/v1/agentbook-expense/vendors/route');
    const d = await json(await GET(req()));
    expect(d[0].totalCents).toBe(15000);
  });
  it('category-summary', async () => {
    const { GET } = await import('@/app/api/v1/agentbook-expense/category-summary/route');
    const d = await json(await GET(req()));
    const s = JSON.stringify(d);
    expect(s).toContain('15000');
    expect(s).not.toContain('16000');
  });
});

// Guard: migrated modules must not read amountCents directly (apart from
// select/aggregate field lists, which must be paired with recoverableTaxCents).
const MIGRATED = [
  'app/api/v1/agentbook-tax/reports/category-breakdown/route.ts',
  'app/api/v1/agentbook-tax/reports/expense-by-vendor/route.ts',
  'app/api/v1/agentbook-tax/reports/monthly-expense-trend/route.ts',
  'app/api/v1/agentbook-tax/reports/spending-trend/route.ts',
  'app/api/v1/agentbook-expense/vendors/route.ts',
  'app/api/v1/agentbook-expense/category-summary/route.ts',
  'app/api/v1/agentbook-expense/advisor/chart/route.ts',
  'app/api/v1/agentbook-expense/advisor/ask/route.ts',
  'app/api/v1/agentbook-expense/advisor/proactive-alerts/route.ts',
  'app/api/v1/agentbook/cron/proactive-alerts/route.ts',
  'app/api/v1/cpa-portal/[token]/dashboard/route.ts',
  'lib/agentbook-tax-package.ts',
  'lib/agentbook-grounding.ts',
  'lib/mcp/read-tools.ts',
];
// Gross reads that remain legitimate: display of a single document's amount, invoices/bills/payments.
const ALLOWED_GROSS = [
  /formatCents\(e\.amountCents\)/, // advisor/ask: one document row shown as-is
  /amountCents: e\.amountCents,/, // cpa-portal recentExpenses: per-document display
  /amount: money\(r\.amountCents/, // read-tools list rows: per-document display
  /last30dByCategory\.reduce/, // cpa-portal: re-sums the already-deductible breakdown
  /inv\.amountCents|i\.amountCents|b\.amountCents|p\.amountCents|\.payments/, // AR/AP/payments
];

describe('guard: no direct gross reads in deductible readers', () => {
  for (const rel of MIGRATED) {
    it(rel, () => {
      const src = readFileSync(resolve(__dirname, '../..', rel), 'utf8');
      expect(src).toMatch(/expense-amounts/);
      // Direct gross read of an expense row / expense aggregate.
      const GROSS_READ = /\b(e|g|exp|spend|r)\.(_sum\.)?amountCents\b/;
      const bad = src.split('\n').filter(
        (l) => !/^\s*(\/\/|\*)/.test(l) && GROSS_READ.test(l) && !ALLOWED_GROSS.some((re) => re.test(l)),
      );
      expect(bad).toEqual([]);
    });
  }
});
