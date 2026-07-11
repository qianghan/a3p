import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const profileFindUnique = vi.fn();
const profileUpsert = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitProfile: {
      findUnique: (...a: unknown[]) => profileFindUnique(...a),
      upsert: (...a: unknown[]) => profileUpsert(...a),
    },
  },
}));

import { GET, PUT } from '@/app/api/v1/agentbook-startup/profile/route';

const tenant = { tenantId: 'tenant-1' };

beforeEach(() => {
  resolveTenant.mockReset();
  profileFindUnique.mockReset();
  profileUpsert.mockReset();
  resolveTenant.mockResolvedValue(tenant);
});

function req(body?: unknown): NextRequest {
  return new NextRequest('http://x/profile', {
    method: body !== undefined ? 'PUT' : 'GET',
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe('GET /api/v1/agentbook-startup/profile', () => {
  it('returns null when no profile is saved yet', async () => {
    profileFindUnique.mockResolvedValue(null);
    const r = await GET(req());
    const j = await r.json();
    expect(j.profile).toBeNull();
  });

  it('returns the saved profile', async () => {
    profileFindUnique.mockResolvedValue({ tenantId: 'tenant-1', companyType: 'c_corp' });
    const r = await GET(req());
    const j = await r.json();
    expect(j.profile.companyType).toBe('c_corp');
  });
});

describe('PUT /api/v1/agentbook-startup/profile', () => {
  it('upserts the profile with the given fields', async () => {
    profileUpsert.mockResolvedValue({ tenantId: 'tenant-1', companyType: 'c_corp', headcount: 4, annualRdSpendCents: 40_000_000 });
    const r = await PUT(req({ companyType: 'c_corp', headcount: 4, annualRdSpendCents: 40_000_000 }));
    expect(r.status).toBe(200);
    expect(profileUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: 'tenant-1' },
      create: expect.objectContaining({ tenantId: 'tenant-1', companyType: 'c_corp', headcount: 4, annualRdSpendCents: 40_000_000 }),
      update: expect.objectContaining({ companyType: 'c_corp', headcount: 4, annualRdSpendCents: 40_000_000 }),
    }));
    const j = await r.json();
    expect(j.profile.companyType).toBe('c_corp');
  });

  it('nulls out unset optional fields rather than leaving them stale', async () => {
    profileUpsert.mockResolvedValue({ tenantId: 'tenant-1', companyType: null });
    await PUT(req({}));
    expect(profileUpsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ companyType: null, headcount: null, annualRdSpendCents: null, equityRaisedCents: null }),
    }));
  });
});
