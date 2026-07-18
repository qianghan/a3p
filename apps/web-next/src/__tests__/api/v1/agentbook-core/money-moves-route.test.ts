import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const accountFindFirst = vi.fn();
const journalLineFindMany = vi.fn();
const expenseAggregate = vi.fn();
const clientFindMany = vi.fn();
const tenantConfigFindUnique = vi.fn();
const taxEstimateFindFirst = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abAccount: { findFirst: (...a: unknown[]) => accountFindFirst(...a) },
    abJournalLine: { findMany: (...a: unknown[]) => journalLineFindMany(...a) },
    abExpense: { aggregate: (...a: unknown[]) => expenseAggregate(...a) },
    abClient: { findMany: (...a: unknown[]) => clientFindMany(...a) },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abTaxEstimate: { findFirst: (...a: unknown[]) => taxEstimateFindFirst(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-core/money-moves/route';

function req(): NextRequest {
  return new NextRequest('http://x/api/v1/agentbook-core/money-moves', { method: 'GET' });
}

beforeEach(() => {
  resolveTenant.mockReset();
  accountFindFirst.mockReset();
  journalLineFindMany.mockReset();
  expenseAggregate.mockReset();
  clientFindMany.mockReset();
  tenantConfigFindUnique.mockReset();
  taxEstimateFindFirst.mockReset();

  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindFirst.mockResolvedValue(null); // skip cash-cushion branch
  journalLineFindMany.mockResolvedValue([]);
  expenseAggregate.mockResolvedValue({ _sum: { amountCents: 0 } });
  clientFindMany.mockResolvedValue([]); // skip revenue-cliff branch
});

describe('GET /api/v1/agentbook-core/money-moves — AU bracket wiring', () => {
  it('produces an AU optimal-timing move using the real 30% bracket, not a hardcoded US/CA table', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    // AU bracket 2 is $45,001–$135,000 @ 30% (4_500_000–13_500_000 cents).
    // Net income $2,000 below the top of that bracket → should trigger the
    // "prepay expenses" nudge using the AU 30%→37% rate jump, not a US/CA one.
    taxEstimateFindFirst.mockResolvedValue({ netIncomeCents: 13_300_000 });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    const move = body.data.find((m: { type: string }) => m.type === 'optimal_timing');
    expect(move).toBeTruthy();
    expect(move.description).toMatch(/30%/);
    const gap = 13_500_000 - 13_300_000; // 200_000 cents = $2,000
    const savings = Math.round(gap * (0.37 - 0.30));
    expect(move.impactCents).toBe(savings);
  });

  it('still produces a correct US move using the real (now-complete) 7-bracket US table', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    // Real usTaxBrackets bracket 4 is $103,350–$197,300 @ 24% (10_335_000–19_730_000
    // cents; corrected 2025 IRS single-filer thresholds, Rev. Proc. 2024-40 —
    // see docs/superpowers/plans/2026-07-18-us-single-bracket-2025-fix.md).
    // Net income $1,900 below the top of that bracket to stay within the
    // route's $5,000 proximity trigger.
    taxEstimateFindFirst.mockResolvedValue({ netIncomeCents: 19_540_000 });

    const res = await GET(req());
    const body = await res.json();
    const move = body.data.find((m: { type: string }) => m.type === 'optimal_timing');

    expect(move).toBeTruthy();
    expect(move.description).toMatch(/24%/);
    const gap = 19_730_000 - 19_540_000; // 190_000 cents = $1,900
    const savings = Math.round(gap * (0.32 - 0.24)); // next real US bracket is 32%, not the old hardcoded table's missing top brackets
    expect(move.impactCents).toBe(savings);
  });

  it('defaults to US brackets when jurisdiction is unset', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    taxEstimateFindFirst.mockResolvedValue({ netIncomeCents: 0 });

    const res = await GET(req());
    expect(res.status).toBe(200);
  });
});
