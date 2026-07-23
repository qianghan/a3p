import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();
const payRunFindFirst = vi.fn();
const payRunFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abPayRun: { findFirst: (...a: unknown[]) => payRunFindFirst(...a), findMany: (...a: unknown[]) => payRunFindMany(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-payroll/au/stp/route';

const req = () => new NextRequest('http://x/api/v1/agentbook-payroll/au/stp', { method: 'GET' });

beforeEach(() => {
  resolveTenant.mockReset(); tenantConfigFindUnique.mockReset(); payRunFindFirst.mockReset(); payRunFindMany.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 't1' });
});

describe('GET /agentbook-payroll/au/stp', () => {
  it('aggregates YTD gross/PAYG-W/super per employee across the FY pay runs', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    payRunFindFirst.mockResolvedValue({ id: 'run2', periodStart: new Date('2026-03-01'), periodEnd: new Date('2026-03-14') });
    // Two runs in FY2025-26: employee e1 appears in both → YTD accumulates.
    payRunFindMany.mockResolvedValue([
      { stubs: [{ employeeId: 'e1', employeeName: 'Ann', grossCents: 500_000, federalTaxCents: 90_000, sgCents: 60_000 }] },
      { stubs: [{ employeeId: 'e1', employeeName: 'Ann', grossCents: 500_000, federalTaxCents: 90_000, sgCents: 60_000 }] },
    ]);

    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.payRunId).toBe('run2');
    expect(body.data.financialYear).toBe(2026); // Mar 2026 → FY2025-26
    expect(body.data.payees).toHaveLength(1);
    expect(body.data.payees[0]).toMatchObject({ employeeId: 'e1', ytdGrossCents: 1_000_000, ytdPaygWithheldCents: 180_000, ytdSuperCents: 120_000 });
    expect(body.data.employerTotals.ytdGrossCents).toBe(1_000_000);
    expect(body.data.lodgment).toBe('prepared');
  });

  it('422s for a non-AU tenant', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    const res = await GET(req());
    expect(res.status).toBe(422);
    expect(payRunFindFirst).not.toHaveBeenCalled();
  });

  it('404s when there is no pay run to report', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    payRunFindFirst.mockResolvedValue(null);
    const res = await GET(req());
    expect(res.status).toBe(404);
  });
});
