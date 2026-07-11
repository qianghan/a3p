import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const validateSession = vi.fn();
const productsCreate = vi.fn();
const pricesCreate = vi.fn();
const addOnFindMany = vi.fn();
const priceFindUnique = vi.fn();
const priceUpdate = vi.fn();

vi.mock('@/lib/api/auth', () => ({ validateSession: (...a: unknown[]) => validateSession(...a) }));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    products: { create: (...a: unknown[]) => productsCreate(...a) },
    prices: { create: (...a: unknown[]) => pricesCreate(...a) },
  }),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    billAddOn: { findMany: (...a: unknown[]) => addOnFindMany(...a) },
    billAddOnPrice: {
      findUnique: (...a: unknown[]) => priceFindUnique(...a),
      update: (...a: unknown[]) => priceUpdate(...a),
    },
  },
}));

import { GET as listAddOns } from '@/app/api/v1/agentbook-billing/addons/route';
import { POST as createStripePrice } from '@/app/api/v1/agentbook-billing/addons/[code]/prices/[priceId]/route';

const adminUser = { id: 'admin-1', email: 'admin@a3p.io' };

beforeEach(() => {
  validateSession.mockReset(); productsCreate.mockReset(); pricesCreate.mockReset();
  addOnFindMany.mockReset(); priceFindUnique.mockReset(); priceUpdate.mockReset();
  process.env.ADMIN_EMAILS = 'admin@a3p.io';
});

function adminReq(body?: unknown): NextRequest {
  const r = new NextRequest('http://x/p', { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
  r.cookies.set('naap_auth_token', 'tok');
  return r;
}

describe('GET /addons', () => {
  it('returns active add-ons with their prices', async () => {
    addOnFindMany.mockResolvedValue([{ id: 'a1', code: 'startup_tax_benefits', name: 'Startup Tax Benefits', prices: [{ region: 'us', tier: 'standard', priceCents: 24900 }] }]);
    const r = await listAddOns(new NextRequest('http://x/addons'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.addOns[0].code).toBe('startup_tax_benefits');
  });
});

describe('POST /addons/:code/prices/:priceId (attach Stripe price)', () => {
  it('creates a Stripe product+price and attaches the IDs, admin only', async () => {
    validateSession.mockResolvedValue(adminUser);
    priceFindUnique.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 24900, currency: 'usd', addOn: { code: 'startup_tax_benefits', name: 'Startup Tax Benefits', interval: 'year' } });
    productsCreate.mockResolvedValue({ id: 'prod_addon' });
    pricesCreate.mockResolvedValue({ id: 'price_addon_std' });
    priceUpdate.mockResolvedValue({ id: 'price-1', stripePriceId: 'price_addon_std' });
    const r = await createStripePrice(adminReq(), { params: Promise.resolve({ code: 'startup_tax_benefits', priceId: 'price-1' }) } as never);
    expect(r.status).toBe(200);
    expect(pricesCreate).toHaveBeenCalledWith(expect.objectContaining({ unit_amount: 24900, currency: 'usd' }));
  });

  it('rejects non-admin with 403', async () => {
    validateSession.mockResolvedValue({ id: 'u', email: 'maya@agentbook.test' });
    const r = await createStripePrice(adminReq(), { params: Promise.resolve({ code: 'startup_tax_benefits', priceId: 'price-1' }) } as never);
    expect(r.status).toBe(403);
  });
});
