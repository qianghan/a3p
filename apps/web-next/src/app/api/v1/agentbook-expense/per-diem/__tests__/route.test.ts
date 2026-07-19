/**
 * Regression coverage for the AU per-diem gap (roadmap PR AU-6): the
 * POST /per-diem route only short-circuited 'ca' tenants with a 422
 * "not supported" response, coercing any other jurisdiction (including
 * 'au') to 'us' before serving US GSA per-diem rates. AU has no
 * GSA-style per-diem construct, so AU tenants should get the same
 * honest 422 decline CA tenants already get.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const accountFindMany = vi.fn();
const expenseCreate = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) },
    abExpense: { create: (...a: unknown[]) => expenseCreate(...a) },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({
        abExpense: { create: (...a: unknown[]) => expenseCreate(...a) },
        abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
      }),
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  accountFindMany.mockResolvedValue([]);
  eventCreate.mockResolvedValue({});
});

describe('POST /agentbook-expense/per-diem — jurisdiction handling', () => {
  it('an AU tenant gets an honest 422 "not supported" response, not silent US per-diem rates', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    const { POST } = await import('../route');
    const req = new NextRequest('http://x/per-diem', {
      method: 'POST',
      body: JSON.stringify({ city: 'Sydney', startDate: '2026-01-01', days: 2 }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.code).toBe('unsupported_jurisdiction');
    expect(body.error).toMatch(/AU/i);
  });

  it('a CA tenant still gets the pre-existing honest 422 "not supported" response', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });
    const { POST } = await import('../route');
    const req = new NextRequest('http://x/per-diem', {
      method: 'POST',
      body: JSON.stringify({ city: 'Toronto', startDate: '2026-01-01', days: 2 }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.success).toBe(false);
    expect(body.code).toBe('unsupported_jurisdiction');
    expect(body.error).toMatch(/CA/i);
  });

  it('a US tenant still gets the happy-path 201 with GSA per-diem rates', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    expenseCreate.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
      id: 'expense-1',
      ...data,
    }));
    const { POST } = await import('../route');
    const req = new NextRequest('http://x/per-diem', {
      method: 'POST',
      body: JSON.stringify({ city: 'New York City', startDate: '2026-01-01', days: 2 }),
    });
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.success).toBe(true);
  });
});
