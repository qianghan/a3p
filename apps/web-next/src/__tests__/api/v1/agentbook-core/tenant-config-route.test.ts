import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const configFindUnique = vi.fn();
const configCreate = vi.fn();
const configUpsert = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: {
      findUnique: (...a: unknown[]) => configFindUnique(...a),
      create: (...a: unknown[]) => configCreate(...a),
      upsert: (...a: unknown[]) => configUpsert(...a),
    },
  },
}));

import { GET, PUT } from '@/app/api/v1/agentbook-core/tenant-config/route';

const tenant = { tenantId: 'tenant-1' };

beforeEach(() => {
  resolveTenant.mockReset();
  configFindUnique.mockReset();
  configCreate.mockReset();
  configUpsert.mockReset();
  resolveTenant.mockResolvedValue(tenant);
  configFindUnique.mockResolvedValue(null);
  configUpsert.mockImplementation(async ({ update }: { update: Record<string, unknown> }) => ({
    userId: 'tenant-1',
    ...update,
  }));
});

function putReq(body: unknown): NextRequest {
  return new NextRequest('http://x/tenant-config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('PUT /api/v1/agentbook-core/tenant-config', () => {
  it('rejects an unknown businessType', async () => {
    const res = await PUT(putReq({ businessType: 'astronaut' }));
    expect(res.status).toBe(400);
    expect(configUpsert).not.toHaveBeenCalled();
  });

  it('accepts the new startup businessType', async () => {
    const res = await PUT(putReq({ businessType: 'startup' }));
    expect(res.status).toBe(200);
    const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.businessType).toBe('startup');
  });

  // businessType (persona/plugin-classification) and taxEntityType (Tax
  // Dashboard's filing entity type) used to share one field, which meant
  // configuring your tax entity type could silently un-classify a student
  // or startup tenant. Now separate fields/whitelists.
  describe('taxEntityType is a separate field from businessType', () => {
    it.each(['llc_single', 'llc_multi', 'scorp', 'corporation', 'sole_trader', 'pty_ltd', 'partnership', 'trust'])(
      'rejects the tax-entity-type value %s when sent as businessType',
      async (entityType) => {
        const res = await PUT(putReq({ businessType: entityType }));
        expect(res.status).toBe(400);
        expect(configUpsert).not.toHaveBeenCalled();
      },
    );

    it.each(['sole_proprietor', 'llc_single', 'llc_multi', 'scorp', 'corporation', 'sole_trader', 'pty_ltd', 'partnership', 'trust'])(
      'accepts the tax-entity-type value %s via taxEntityType',
      async (entityType) => {
        const res = await PUT(putReq({ taxEntityType: entityType }));
        expect(res.status).toBe(200);
        const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
        expect(call.update.taxEntityType).toBe(entityType);
        expect(call.update.businessType).toBeUndefined();
      },
    );

    it('rejects an unknown taxEntityType', async () => {
      const res = await PUT(putReq({ taxEntityType: 'astronaut' }));
      expect(res.status).toBe(400);
      expect(configUpsert).not.toHaveBeenCalled();
    });

    it('allows clearing taxEntityType back to null', async () => {
      const res = await PUT(putReq({ taxEntityType: null }));
      expect(res.status).toBe(200);
      const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
      expect(call.update.taxEntityType).toBeNull();
    });

    it('setting businessType and taxEntityType together updates both fields independently', async () => {
      const res = await PUT(putReq({ businessType: 'startup', taxEntityType: 'pty_ltd' }));
      expect(res.status).toBe(200);
      const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
      expect(call.update.businessType).toBe('startup');
      expect(call.update.taxEntityType).toBe('pty_ltd');
    });
  });

  // defaultCurrency was a dead, unused field (no downstream consumer besides
  // the UI that wrote it) — removed entirely now that currency is
  // configured once in Business Profile.
  it('ignores a defaultCurrency field in the request body (removed, no longer handled)', async () => {
    const res = await PUT(putReq({ defaultCurrency: 'GBP' }));
    expect(res.status).toBe(200);
    const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.defaultCurrency).toBeUndefined();
  });

  // These fields were previously missing from the PUT whitelist, so editing
  // them in Settings silently no-op'd — regression guard for that fix.
  it('persists companyName, companyEmail, companyPhone, companyAddress, brandColor', async () => {
    const res = await PUT(
      putReq({
        companyName: 'Acme Corp',
        companyEmail: 'billing@acme.com',
        companyPhone: '+1 555 000 0000',
        companyAddress: '123 Main St',
        brandColor: '#123456',
      }),
    );
    expect(res.status).toBe(200);
    const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update).toMatchObject({
      companyName: 'Acme Corp',
      companyEmail: 'billing@acme.com',
      companyPhone: '+1 555 000 0000',
      companyAddress: '123 Main St',
      brandColor: '#123456',
    });
  });

  it('persists student fields: university, major, degree, graduationYear', async () => {
    const res = await PUT(
      putReq({ businessType: 'student', university: 'MIT', major: 'CS', degree: "Bachelor's", graduationYear: 2027 }),
    );
    expect(res.status).toBe(200);
    const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update).toMatchObject({
      businessType: 'student',
      university: 'MIT',
      major: 'CS',
      degree: "Bachelor's",
      graduationYear: 2027,
    });
  });

  it('persists businessDescription and businessTags for non-student types', async () => {
    const res = await PUT(
      putReq({ businessDescription: 'We build a SaaS dashboard.', businessTags: ['saas', 'b2b'] }),
    );
    expect(res.status).toBe(200);
    const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update).toMatchObject({
      businessDescription: 'We build a SaaS dashboard.',
      businessTags: ['saas', 'b2b'],
    });
  });

  it('allows clearing nullable fields back to null', async () => {
    const res = await PUT(putReq({ university: null, businessDescription: null }));
    expect(res.status).toBe(200);
    const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(call.update.university).toBeNull();
    expect(call.update.businessDescription).toBeNull();
  });

  // university/major/degree/graduationYear are critical for scholarship and
  // co-op/internship search skills — a student profile without them
  // silently degrades that advice (graduationYear in particular drives
  // co-op timing).
  describe('student profile completeness', () => {
    const COMPLETE_STUDENT = { businessType: 'student', university: 'MIT', major: 'CS', degree: "Bachelor's", graduationYear: 2027 };

    it('rejects switching to student with none of the required fields', async () => {
      const res = await PUT(putReq({ businessType: 'student' }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/university.*major.*degree.*graduationYear/);
      expect(configUpsert).not.toHaveBeenCalled();
    });

    it('rejects switching to student with only some of the required fields', async () => {
      const res = await PUT(putReq({ businessType: 'student', university: 'MIT', major: 'CS' }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toMatch(/degree.*graduationYear/);
      expect(configUpsert).not.toHaveBeenCalled();
    });

    it('rejects switching to student with university/major/degree but no graduationYear', async () => {
      const res = await PUT(putReq({ businessType: 'student', university: 'MIT', major: 'CS', degree: "Bachelor's" }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe('Student business type requires: graduationYear');
      expect(configUpsert).not.toHaveBeenCalled();
    });

    it('accepts switching to student when university/major/degree/graduationYear are all provided', async () => {
      const res = await PUT(putReq(COMPLETE_STUDENT));
      expect(res.status).toBe(200);
      expect(configUpsert).toHaveBeenCalled();
    });

    it('rejects clearing university on an already-student tenant', async () => {
      configFindUnique.mockResolvedValueOnce(COMPLETE_STUDENT);
      const res = await PUT(putReq({ university: null }));
      expect(res.status).toBe(400);
      expect(configUpsert).not.toHaveBeenCalled();
    });

    it('rejects clearing graduationYear on an already-student tenant', async () => {
      configFindUnique.mockResolvedValueOnce(COMPLETE_STUDENT);
      const res = await PUT(putReq({ graduationYear: null }));
      const body = await res.json();
      expect(res.status).toBe(400);
      expect(body.error).toBe('Student business type requires: graduationYear');
      expect(configUpsert).not.toHaveBeenCalled();
    });

    it('allows an unrelated update on an already-complete student tenant', async () => {
      configFindUnique.mockResolvedValueOnce(COMPLETE_STUDENT);
      const res = await PUT(putReq({ currency: 'CAD' }));
      expect(res.status).toBe(200);
      const call = configUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
      expect(call.update.currency).toBe('CAD');
    });

    it('does not require university/major/degree/graduationYear for non-student business types', async () => {
      const res = await PUT(putReq({ businessType: 'startup' }));
      expect(res.status).toBe(200);
    });
  });
});
