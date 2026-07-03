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

  it('seeds the 3 US programs and 9 add-on price rows for an admin', async () => {
    validateSession.mockResolvedValue(adminUser);
    const r = await POST(adminReq());
    expect(r.status).toBe(200);
    expect(programCreate).toHaveBeenCalledTimes(3);
    expect(priceCreate).toHaveBeenCalledTimes(9);
    const j = await r.json();
    expect(j.programs).toEqual({ created: 3, updated: 0 });
    expect(j.addOnPrices).toEqual({ created: 9, updated: 0 });
  });

  it('is idempotent — re-running updates instead of duplicating', async () => {
    validateSession.mockResolvedValue(adminUser);
    programFindUnique.mockResolvedValue({ id: 'existing-program' });
    priceFindUnique.mockResolvedValue({ id: 'existing-price' });
    const r = await POST(adminReq());
    const j = await r.json();
    expect(j.programs).toEqual({ created: 0, updated: 3 });
    expect(j.addOnPrices).toEqual({ created: 0, updated: 9 });
    expect(programCreate).not.toHaveBeenCalled();
    expect(priceCreate).not.toHaveBeenCalled();
  });
});
