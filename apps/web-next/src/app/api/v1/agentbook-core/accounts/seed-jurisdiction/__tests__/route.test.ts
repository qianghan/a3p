import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const tenantConfigFindUnique = vi.fn();
const accountUpsert = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    abAccount: {
      upsert: (...a: unknown[]) => {
        accountUpsert(...a);
        return Promise.resolve({ id: 'acct-1', ...(a[0] as { create: Record<string, unknown> }).create });
      },
    },
    $transaction: (ops: Promise<unknown>[]) => Promise.all(ops),
  },
}));

const safeResolveAgentbookTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => safeResolveAgentbookTenant(...a),
}));

function req(): NextRequest {
  return new NextRequest('http://x/accounts/seed-jurisdiction', { method: 'POST' });
}

beforeEach(() => {
  vi.clearAllMocks();
  safeResolveAgentbookTenant.mockResolvedValue({ tenantId: 'tenant-1' });
});

describe('POST /agentbook-core/accounts/seed-jurisdiction', () => {
  it('seeds the real AU BAS-aligned chart for jurisdiction=au', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'au' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(33);
    const codes = accountUpsert.mock.calls.map((c) => (c[0] as { create: { code: string } }).create.code);
    expect(codes).toContain('2100'); // GST Payable
    expect(codes).toContain('2300'); // Superannuation Payable
    const gstLine = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '2100');
    expect((gstLine![0] as { create: { name: string } }).create.name).toBe('GST Payable');
  });

  it('seeds the real CA T2125-aligned chart for jurisdiction=ca', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'ca' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(33);
    const gstHst = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '2100');
    expect((gstHst![0] as { create: { name: string } }).create.name).toBe('GST/HST Payable');
    const revenue = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '4000');
    expect((revenue![0] as { create: { taxCategory?: string } }).create.taxCategory).toBe('Line 8000 - Professional income');
  });

  it('seeds the real (32-account) US Schedule-C chart for jurisdiction=us', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'us' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(32);
    // Depreciation (6800) exists in the real pack but not in the old inline US_ACCOUNTS list.
    const depreciation = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '6800');
    expect(depreciation).toBeDefined();
    expect((depreciation![0] as { create: { name: string } }).create.name).toBe('Depreciation');
  });

  it('falls back to the US chart for a missing/unrecognized jurisdiction, without throwing', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: '' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.count).toBe(32);
  });

  it('still seeds STUDENT_ACCOUNTS for businessType=student regardless of jurisdiction (regression)', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'student', jurisdiction: 'au' });
    const { POST } = await import('../route');
    const res = await POST(req());
    const json = await res.json();

    expect(json.data.count).toBe(14);
    const codes = accountUpsert.mock.calls.map((c) => (c[0] as { create: { code: string } }).create.code);
    expect(codes).toContain('4200'); // Scholarship / Grant Income
    // Confirm this did NOT pick up the AU chart's GST Payable account.
    expect(codes).not.toContain('2100');
  });

  it('upserts by (tenantId, code) with update+create, matching the existing re-runnable pattern', async () => {
    tenantConfigFindUnique.mockResolvedValue({ businessType: 'freelancer', jurisdiction: 'us' });
    const { POST } = await import('../route');
    await POST(req());

    const cashCall = accountUpsert.mock.calls.find((c) => (c[0] as { create: { code: string } }).create.code === '1000');
    expect(cashCall![0]).toMatchObject({
      where: { tenantId_code: { tenantId: 'tenant-1', code: '1000' } },
      update: { name: 'Cash', accountType: 'asset', taxCategory: undefined },
      create: { tenantId: 'tenant-1', code: '1000', name: 'Cash', accountType: 'asset', taxCategory: undefined },
    });
  });
});
