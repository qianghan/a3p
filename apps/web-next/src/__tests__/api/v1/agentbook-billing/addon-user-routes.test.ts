import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const resolveAddOnPriceMock = vi.fn();
const billSubFindUnique = vi.fn();
const addOnSubFindUnique = vi.fn();
const addOnSubUpsert = vi.fn();
const addOnSubUpdate = vi.fn();
const addOnFindUnique = vi.fn();
const subCreate = vi.fn();
const subUpdate = vi.fn();
const invalidateAccountMock = vi.fn();
const tenantConfigFindUnique = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/billing', () => ({
  hasAddOn: (...a: unknown[]) => hasAddOnMock(...a),
  resolveAddOnPrice: (...a: unknown[]) => resolveAddOnPriceMock(...a),
  invalidateAccount: (...a: unknown[]) => invalidateAccountMock(...a),
}));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    subscriptions: {
      create: (...a: unknown[]) => subCreate(...a),
      update: (...a: unknown[]) => subUpdate(...a),
    },
  }),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    billSubscription: { findUnique: (...a: unknown[]) => billSubFindUnique(...a) },
    billAddOn: { findUnique: (...a: unknown[]) => addOnFindUnique(...a) },
    billAddOnSubscription: {
      findUnique: (...a: unknown[]) => addOnSubFindUnique(...a),
      upsert: (...a: unknown[]) => addOnSubUpsert(...a),
      update: (...a: unknown[]) => addOnSubUpdate(...a),
    },
  },
}));

import { GET as getStatus } from '@/app/api/v1/agentbook-billing/me/addons/route';
import { POST as subscribe } from '@/app/api/v1/agentbook-billing/me/addons/[code]/subscribe/route';
import { POST as cancel } from '@/app/api/v1/agentbook-billing/me/addons/[code]/cancel/route';

const tenant = { tenantId: 'tenant-1' };

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset(); resolveAddOnPriceMock.mockReset();
  billSubFindUnique.mockReset(); addOnSubFindUnique.mockReset(); addOnSubUpsert.mockReset();
  addOnSubUpdate.mockReset(); addOnFindUnique.mockReset(); subCreate.mockReset(); subUpdate.mockReset();
  invalidateAccountMock.mockReset(); tenantConfigFindUnique.mockReset();
  resolveTenant.mockResolvedValue(tenant);
  addOnFindUnique.mockResolvedValue({ id: 'addon-1', code: 'startup_tax_benefits' });
  // Default: a US tenant (existing tests expect US pricing).
  tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
});

function req(body?: unknown): NextRequest {
  return new NextRequest('http://x/p', { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
}
function params(code: string) { return { params: Promise.resolve({ code }) }; }

describe('GET /me/addons', () => {
  it('reports active=false and a resolved price when not subscribed', async () => {
    hasAddOnMock.mockResolvedValue(false);
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'founding_member', priceCents: 9900, currency: 'usd' });
    const r = await getStatus(new NextRequest('http://x/me/addons?code=startup_tax_benefits&region=us'));
    const j = await r.json();
    expect(j.active).toBe(false);
    expect(j.price.tier).toBe('founding_member');
  });
});

describe('POST /me/addons/:code/subscribe', () => {
  it('requires an existing Stripe customer (call /intent first)', async () => {
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 24900, currency: 'usd', stripePriceId: 'price_x' });
    billSubFindUnique.mockResolvedValue(null);
    const r = await subscribe(req({ region: 'us', paymentMethodId: 'pm_1' }), params('startup_tax_benefits') as never);
    expect(r.status).toBe(400);
  });

  it('creates a Stripe subscription with addOnCode metadata and upserts BillAddOnSubscription', async () => {
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'founding_member', priceCents: 9900, currency: 'usd', stripePriceId: 'price_founding' });
    billSubFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    subCreate.mockResolvedValue({ id: 'sub_addon_1', status: 'active' });
    addOnSubUpsert.mockResolvedValue({ id: 'row-1' });
    const r = await subscribe(req({ region: 'us', paymentMethodId: 'pm_1' }), params('startup_tax_benefits') as never);
    expect(r.status).toBe(200);
    expect(subCreate).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_1',
      items: [{ price: 'price_founding' }],
      metadata: expect.objectContaining({ tenantId: 'tenant-1', addOnCode: 'startup_tax_benefits' }),
    }));
    expect(addOnSubUpsert).toHaveBeenCalled();
    expect(invalidateAccountMock).toHaveBeenCalledWith('tenant-1');
  });

  it('prices off the tenant jurisdiction, not a client-supplied region (M1 arbitrage guard)', async () => {
    // Tenant is AU; a crafted request tries to buy at the US region's price.
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'au' });
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-au', tier: 'standard', priceCents: 5900, currency: 'aud', stripePriceId: 'price_au' });
    billSubFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    subCreate.mockResolvedValue({ id: 'sub_1', status: 'active' });
    addOnSubUpsert.mockResolvedValue({ id: 'row-1' });

    await subscribe(req({ region: 'us', paymentMethodId: 'pm_1' }), params('startup_tax_benefits') as never);

    // Must resolve the AU price (tenant's real region), ignoring the body's "us".
    expect(resolveAddOnPriceMock).toHaveBeenCalledWith('startup_tax_benefits', 'au');
  });

  it('rejects a price with no Stripe price ID attached yet', async () => {
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 24900, currency: 'usd', stripePriceId: null });
    billSubFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    const r = await subscribe(req({ region: 'us', paymentMethodId: 'pm_1' }), params('startup_tax_benefits') as never);
    expect(r.status).toBe(400);
  });
});

describe('POST /me/addons/:code/cancel', () => {
  it('cancels at period end and updates the local row', async () => {
    addOnSubFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_addon_1', status: 'active' });
    const r = await cancel(req(), params('startup_tax_benefits') as never);
    expect(r.status).toBe(200);
    expect(subUpdate).toHaveBeenCalledWith('sub_addon_1', { cancel_at_period_end: true });
  });

  it('404s when there is no active subscription', async () => {
    addOnSubFindUnique.mockResolvedValue(null);
    const r = await cancel(req(), params('startup_tax_benefits') as never);
    expect(r.status).toBe(404);
  });
});
