import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const validateSession = vi.fn();
const programFindUnique = vi.fn();
const programUpdate = vi.fn();
const programCreate = vi.fn();
const addOnUpsert = vi.fn();
const priceFindUnique = vi.fn();
const priceUpdate = vi.fn();
const priceCreate = vi.fn();

vi.mock('@/lib/api/auth', () => ({ validateSession: (...a: unknown[]) => validateSession(...a) }));
vi.mock('@naap/database', () => ({
  prisma: {
    startupBenefitProgram: {
      findUnique: (...a: unknown[]) => programFindUnique(...a),
      update: (...a: unknown[]) => programUpdate(...a),
      create: (...a: unknown[]) => programCreate(...a),
    },
    billAddOn: { upsert: (...a: unknown[]) => addOnUpsert(...a) },
    billAddOnPrice: {
      findUnique: (...a: unknown[]) => priceFindUnique(...a),
      update: (...a: unknown[]) => priceUpdate(...a),
      create: (...a: unknown[]) => priceCreate(...a),
    },
  },
}));

import { POST } from '@/app/api/v1/agentbook-startup/admin/seed-catalog/route';

const adminUser = { id: 'admin-1', email: 'admin@a3p.io' };

beforeEach(() => {
  validateSession.mockReset();
  programFindUnique.mockReset();
  programUpdate.mockReset();
  programCreate.mockReset();
  addOnUpsert.mockReset();
  priceFindUnique.mockReset();
  priceUpdate.mockReset();
  priceCreate.mockReset();
  process.env.ADMIN_EMAILS = 'admin@a3p.io';
  programFindUnique.mockResolvedValue(null);
  programCreate.mockResolvedValue({});
  addOnUpsert.mockResolvedValue({ id: 'addon-1' });
  priceFindUnique.mockResolvedValue(null);
  priceCreate.mockResolvedValue({});
});

function adminReq(): NextRequest {
  const r = new NextRequest('http://x/seed-catalog', { method: 'POST' });
  r.cookies.set('naap_auth_token', 'tok');
  return r;
}

describe('POST /api/v1/agentbook-startup/admin/seed-catalog', () => {
  it('rejects non-admin with 401/403', async () => {
    validateSession.mockResolvedValue({ id: 'u', email: 'maya@agentbook.test' });
    const r = await POST(adminReq());
    expect([401, 403]).toContain(r.status);
  });

  it('seeds the 3 US + 3 AU programs and 12 add-on price rows (us/ca/uk/au x 3 tiers) for an admin', async () => {
    validateSession.mockResolvedValue(adminUser);
    const r = await POST(adminReq());
    expect(r.status).toBe(200);
    expect(programCreate).toHaveBeenCalledTimes(6);
    expect(priceCreate).toHaveBeenCalledTimes(12);
    const j = await r.json();
    expect(j.programs).toEqual({ created: 6, updated: 0 });
    expect(j.addOnPrices).toEqual({ created: 12, updated: 0 });
  });

  it('seeds all 3 au_* program codes with jurisdiction "au"', async () => {
    validateSession.mockResolvedValue(adminUser);
    await POST(adminReq());
    const auProgramCalls = programCreate.mock.calls.filter(([{ data }]) => data.jurisdiction === 'au');
    expect(auProgramCalls.map(([{ data }]) => data.programCode).sort()).toEqual([
      'au_esic_offset', 'au_rd_tax_incentive', 'au_small_business_cgt_concessions',
    ]);
  });

  it('seeds the au region with its own researched AUD pricing, not US parity', async () => {
    validateSession.mockResolvedValue(adminUser);
    await POST(adminReq());
    const auCalls = priceCreate.mock.calls.filter(([{ data }]) => data.region === 'au');
    expect(auCalls).toHaveLength(3);
    expect(auCalls.find(([{ data }]) => data.tier === 'founding_member')?.[0].data).toMatchObject({ currency: 'aud', priceCents: 12900 });
    expect(auCalls.find(([{ data }]) => data.tier === 'standard')?.[0].data).toMatchObject({ currency: 'aud', priceCents: 29900 });
    expect(auCalls.find(([{ data }]) => data.tier === 'scaled')?.[0].data).toMatchObject({ currency: 'aud', priceCents: 59900 });
  });

  it('is idempotent — re-running updates instead of duplicating', async () => {
    validateSession.mockResolvedValue(adminUser);
    programFindUnique.mockResolvedValue({ id: 'existing-program' });
    priceFindUnique.mockResolvedValue({ id: 'existing-price' });
    const r = await POST(adminReq());
    const j = await r.json();
    expect(j.programs).toEqual({ created: 0, updated: 6 });
    expect(j.addOnPrices).toEqual({ created: 0, updated: 12 });
    expect(programCreate).not.toHaveBeenCalled();
    expect(priceCreate).not.toHaveBeenCalled();
  });
});
