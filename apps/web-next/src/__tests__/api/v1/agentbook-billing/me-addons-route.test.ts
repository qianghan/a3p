import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const resolveAddOnPriceMock = vi.fn();
const activeAddOnCodesMock = vi.fn();
const tenantConfigFindUnique = vi.fn();
const billAddOnFindMany = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/billing', () => ({
  hasAddOn: (...a: unknown[]) => hasAddOnMock(...a),
  resolveAddOnPrice: (...a: unknown[]) => resolveAddOnPriceMock(...a),
  activeAddOnCodes: (...a: unknown[]) => activeAddOnCodesMock(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
    billAddOn: { findMany: (...a: unknown[]) => billAddOnFindMany(...a) },
  },
}));

import { GET } from '@/app/api/v1/agentbook-billing/me/addons/route';

const tenant = { tenantId: 'tenant-1' };

beforeEach(() => {
  resolveTenant.mockReset();
  hasAddOnMock.mockReset();
  resolveAddOnPriceMock.mockReset();
  activeAddOnCodesMock.mockReset();
  tenantConfigFindUnique.mockReset();
  billAddOnFindMany.mockReset();
  resolveTenant.mockResolvedValue(tenant);
});

const CATALOG = [
  { id: 'addon-1', code: 'startup_tax_benefits', name: 'Startup Tax Benefits' },
  { id: 'addon-2', code: 'personal_insights', name: 'Personal Insights' },
  { id: 'addon-3', code: 'sales_rep', name: 'Sales Rep Program' },
];

describe('GET /me/addons (list-all branch, no ?code)', () => {
  it('returns a 3-item list with exactly one active:true for a tenant with one active add-on', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    billAddOnFindMany.mockResolvedValue(CATALOG);
    activeAddOnCodesMock.mockResolvedValue(new Set(['personal_insights']));
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 1900, currency: 'usd', stripePriceId: 'price_x' });

    const r = await GET(new NextRequest('http://x/me/addons'));
    const j = await r.json();

    expect(j.addons).toHaveLength(3);
    const activeOnes = j.addons.filter((a: { active: boolean }) => a.active);
    expect(activeOnes).toHaveLength(1);
    expect(activeOnes[0].code).toBe('personal_insights');
  });

  it('marks every add-on active:false for a tenant with zero active add-ons', async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
    billAddOnFindMany.mockResolvedValue(CATALOG);
    activeAddOnCodesMock.mockResolvedValue(new Set());
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 1900, currency: 'usd', stripePriceId: 'price_x' });

    const r = await GET(new NextRequest('http://x/me/addons'));
    const j = await r.json();

    expect(j.addons).toHaveLength(3);
    expect(j.addons.every((a: { active: boolean }) => a.active === false)).toBe(true);
  });

  it("resolves each add-on's price using the tenant's own region from AbTenantConfig.jurisdiction", async () => {
    tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'ca' });
    billAddOnFindMany.mockResolvedValue(CATALOG);
    activeAddOnCodesMock.mockResolvedValue(new Set());
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-ca', tier: 'standard', priceCents: 2500, currency: 'cad', stripePriceId: 'price_ca' });

    await GET(new NextRequest('http://x/me/addons'));

    expect(tenantConfigFindUnique).toHaveBeenCalledWith({ where: { userId: 'tenant-1' } });
    expect(resolveAddOnPriceMock).toHaveBeenCalledWith('startup_tax_benefits', 'ca');
    expect(resolveAddOnPriceMock).toHaveBeenCalledWith('personal_insights', 'ca');
    expect(resolveAddOnPriceMock).toHaveBeenCalledWith('sales_rep', 'ca');
  });

  it('falls back to region "us" when the tenant has no AbTenantConfig row', async () => {
    tenantConfigFindUnique.mockResolvedValue(null);
    billAddOnFindMany.mockResolvedValue(CATALOG);
    activeAddOnCodesMock.mockResolvedValue(new Set());
    resolveAddOnPriceMock.mockResolvedValue(null);

    await GET(new NextRequest('http://x/me/addons'));

    expect(resolveAddOnPriceMock).toHaveBeenCalledWith('startup_tax_benefits', 'us');
  });
});

describe('GET /me/addons?code=... (existing single-code branch, unchanged)', () => {
  it('still resolves active + price for a single code without touching the tenant-config/catalog lookups', async () => {
    hasAddOnMock.mockResolvedValue(true);
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'founding_member', priceCents: 9900, currency: 'usd' });

    const r = await GET(new NextRequest('http://x/me/addons?code=startup_tax_benefits&region=us'));
    const j = await r.json();

    expect(j.active).toBe(true);
    expect(j.price.tier).toBe('founding_member');
    expect(hasAddOnMock).toHaveBeenCalledWith('tenant-1', 'startup_tax_benefits');
    expect(resolveAddOnPriceMock).toHaveBeenCalledWith('startup_tax_benefits', 'us');
    expect(tenantConfigFindUnique).not.toHaveBeenCalled();
    expect(billAddOnFindMany).not.toHaveBeenCalled();
  });

  it('defaults region to "us" when omitted', async () => {
    hasAddOnMock.mockResolvedValue(false);
    resolveAddOnPriceMock.mockResolvedValue(null);

    await GET(new NextRequest('http://x/me/addons?code=personal_insights'));

    expect(resolveAddOnPriceMock).toHaveBeenCalledWith('personal_insights', 'us');
  });
});
