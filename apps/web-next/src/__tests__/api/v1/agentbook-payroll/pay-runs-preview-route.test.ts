/**
 * GET /api/v1/agentbook-payroll/pay-runs/preview (PARITY-6, Task 3).
 *
 * A non-persisting preview of the exact per-employee withholding the real
 * POST /pay-runs route would compute — reuses calcPay/periodGross/
 * PERIODS_PER_YEAR from @/lib/payroll-engine identically, but never writes
 * an AbPayRun/AbPayStub. Used by the chat/MCP `run-payroll` skill (Task 4)
 * to show real withholding math instead of a rough gross-only estimate.
 *
 * Mocking convention follows tax-estimate-route.test.ts (PARITY-1): declare
 * each vi.fn() at the top, then wrap in lazy closures inside vi.mock's
 * factory to avoid the TDZ "Cannot access before initialization" error that
 * a direct top-level object reference would hit (vi.mock factories run
 * before later const declarations execute).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('server-only', () => ({}));

const employeeFindMany = vi.fn();
const payRunCreate = vi.fn();
const payStubCreate = vi.fn();
const transaction = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'test-tenant' })),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    abEmployee: { findMany: (...a: unknown[]) => employeeFindMany(...a) },
    abPayRun: { create: (...a: unknown[]) => payRunCreate(...a) },
    abPayStub: { create: (...a: unknown[]) => payStubCreate(...a) },
    $transaction: (...a: unknown[]) => transaction(...a),
  },
}));

import { GET } from '@/app/api/v1/agentbook-payroll/pay-runs/preview/route';
import { NextRequest } from 'next/server';
import { calcPay, periodGross, PERIODS_PER_YEAR } from '@/lib/payroll-engine';

function makeRequest(): NextRequest {
  return new NextRequest('https://example.com/api/v1/agentbook-payroll/pay-runs/preview');
}

const US_EMPLOYEE = {
  id: 'emp-us', name: 'Alex US', payType: 'salary', payRateCents: 8_000_000,
  payFrequency: 'biweekly', jurisdiction: 'us', filingStatus: 'single', region: 'TX',
};
const CA_QC_EMPLOYEE = {
  id: 'emp-qc', name: 'Marie QC', payType: 'salary', payRateCents: 9_000_000,
  payFrequency: 'biweekly', jurisdiction: 'ca', filingStatus: undefined, region: 'QC',
};

describe('GET /api/v1/agentbook-payroll/pay-runs/preview (PARITY-6)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('computes real US withholding via the same calcPay engine the POST route uses', async () => {
    employeeFindMany.mockResolvedValueOnce([US_EMPLOYEE]);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    const returned = body.data.employees.find((e: { employeeId: string }) => e.employeeId === 'emp-us');
    expect(returned).toBeTruthy();

    const periodsPerYear = PERIODS_PER_YEAR[US_EMPLOYEE.payFrequency];
    const grossCents = periodGross(US_EMPLOYEE.payRateCents, US_EMPLOYEE.payFrequency);
    const expected = calcPay({
      jurisdiction: US_EMPLOYEE.jurisdiction,
      grossCents,
      payPeriodsPerYear: periodsPerYear,
      filingStatus: US_EMPLOYEE.filingStatus,
      region: US_EMPLOYEE.region,
    });

    expect(returned.grossCents).toBe(expected.grossCents);
    expect(returned.federalTaxCents).toBe(expected.federalTaxCents);
    expect(returned.ficaCents).toBe(expected.ficaCents);
    expect(returned.netCents).toBe(expected.netCents);
  });

  it("computes real CA/Quebec ficaCents (CPP/QPP+EI+QPIP combined) via the same calcPay engine", async () => {
    employeeFindMany.mockResolvedValueOnce([CA_QC_EMPLOYEE]);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(body.success).toBe(true);
    const returned = body.data.employees.find((e: { employeeId: string }) => e.employeeId === 'emp-qc');
    expect(returned).toBeTruthy();

    const periodsPerYear = PERIODS_PER_YEAR[CA_QC_EMPLOYEE.payFrequency];
    const grossCents = periodGross(CA_QC_EMPLOYEE.payRateCents, CA_QC_EMPLOYEE.payFrequency);
    const expected = calcPay({
      jurisdiction: CA_QC_EMPLOYEE.jurisdiction,
      grossCents,
      payPeriodsPerYear: periodsPerYear,
      filingStatus: CA_QC_EMPLOYEE.filingStatus,
      region: CA_QC_EMPLOYEE.region,
    });

    expect(returned.ficaCents).toBe(expected.ficaCents);
    expect(returned.netCents).toBe(expected.netCents);
  });

  it('returns success:false with a 400 status when there are no active employees', async () => {
    employeeFindMany.mockResolvedValueOnce([]);

    const res = await GET(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
  });

  it('never persists — abPayRun.create/abPayStub.create/$transaction are never called', async () => {
    employeeFindMany.mockResolvedValueOnce([US_EMPLOYEE, CA_QC_EMPLOYEE]);

    await GET(makeRequest());

    expect(payRunCreate).not.toHaveBeenCalled();
    expect(payStubCreate).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });
});
