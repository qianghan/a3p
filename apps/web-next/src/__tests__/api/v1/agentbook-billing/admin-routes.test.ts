import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const validateSession = vi.fn();
const productsCreate = vi.fn();
const productsUpdate = vi.fn();
const pricesCreate = vi.fn();
const planCreate = vi.fn();
const planUpdate = vi.fn();
const planFindMany = vi.fn();
const planFindUnique = vi.fn();
const resolveTenant = vi.fn();
const tenantConfigFindUnique = vi.fn();

vi.mock('@/lib/api/auth', () => ({ validateSession: (...a: unknown[]) => validateSession(...a) }));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    products: { create: (...a: unknown[]) => productsCreate(...a), update: (...a: unknown[]) => productsUpdate(...a) },
    prices: { create: (...a: unknown[]) => pricesCreate(...a) },
  }),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    billPlan: {
      create: (...a: unknown[]) => planCreate(...a),
      update: (...a: unknown[]) => planUpdate(...a),
      findMany: (...a: unknown[]) => planFindMany(...a),
      findUnique: (...a: unknown[]) => planFindUnique(...a),
    },
    abTenantConfig: { findUnique: (...a: unknown[]) => tenantConfigFindUnique(...a) },
  },
}));

import { POST as createPlan, GET as listPlans } from '@/app/api/v1/agentbook-billing/plans/route';
import { PATCH as editPlan, DELETE as archivePlan } from '@/app/api/v1/agentbook-billing/plans/[id]/route';
import { GET as getTemplates } from '@/app/api/v1/agentbook-billing/templates/route';

const adminUser = { id: 'admin-1', email: 'admin@a3p.io' };

beforeEach(() => {
  validateSession.mockReset(); productsCreate.mockReset(); productsUpdate.mockReset();
  pricesCreate.mockReset(); planCreate.mockReset(); planUpdate.mockReset();
  planFindMany.mockReset(); planFindUnique.mockReset();
  resolveTenant.mockReset(); tenantConfigFindUnique.mockReset();
  resolveTenant.mockResolvedValue({ tenantId: 'tenant-1' });
  tenantConfigFindUnique.mockResolvedValue({ jurisdiction: 'us' });
  process.env.ADMIN_EMAILS = 'admin@a3p.io';
});

function adminReq(body?: unknown): NextRequest {
  const r = new NextRequest('http://x/p', { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
  r.cookies.set('naap_auth_token', 'tok');
  return r;
}

describe('GET /templates', () => {
  it('returns the 3 seed templates for admin', async () => {
    validateSession.mockResolvedValue(adminUser);
    const r = await getTemplates(new NextRequest('http://x/t', { headers: { cookie: 'naap_auth_token=tok' } }));
    const req2 = new NextRequest('http://x/t');
    req2.cookies.set('naap_auth_token', 'tok');
    const r2 = await getTemplates(req2);
    expect(r2.status).toBe(200);
    const j = await r2.json();
    expect(j.templates).toHaveLength(3);
    expect(j.templates.map((t: { code: string }) => t.code)).toEqual(['free', 'pro', 'business']);
  });

  it('rejects non-admin with 403', async () => {
    validateSession.mockResolvedValue({ id: 'u', email: 'maya@agentbook.test' });
    const req2 = new NextRequest('http://x/t');
    req2.cookies.set('naap_auth_token', 'tok');
    const r = await getTemplates(req2);
    expect(r.status).toBe(403);
  });
});

describe('POST /plans', () => {
  it('creates Stripe Product + Price + DB row', async () => {
    validateSession.mockResolvedValue(adminUser);
    productsCreate.mockResolvedValue({ id: 'prod_x' });
    pricesCreate.mockResolvedValue({ id: 'price_y' });
    planCreate.mockResolvedValue({ id: 'plan-1', code: 'pro', stripeProductId: 'prod_x', stripePriceId: 'price_y' });

    const body = {
      code: 'pro', region: 'us', name: 'Pro', priceCents: 1900, currency: 'usd', interval: 'month',
      features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
      quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
    };
    const r = await createPlan(adminReq(body));
    expect(r.status).toBe(201);
    expect(productsCreate).toHaveBeenCalledTimes(1);
    expect(pricesCreate).toHaveBeenCalledTimes(1);
    expect(planCreate).toHaveBeenCalledTimes(1);
  });

  it('rolls back Stripe Product when DB write fails', async () => {
    validateSession.mockResolvedValue(adminUser);
    productsCreate.mockResolvedValue({ id: 'prod_x' });
    pricesCreate.mockResolvedValue({ id: 'price_y' });
    planCreate.mockRejectedValue(new Error('db'));
    productsUpdate.mockResolvedValue({});

    const r = await createPlan(adminReq({
      code: 'pro', region: 'us', name: 'Pro', priceCents: 1900, currency: 'usd', interval: 'month',
      features: { telegram_bot: true, tax_package_generation: false, multi_user_teams: false },
      quotas: { expenses_created: 0, ocr_scans: 0, ai_messages: 0, invoices_sent: 0, bank_connections: 0 },
    }));
    expect(r.status).toBe(500);
    expect(productsUpdate).toHaveBeenCalledWith('prod_x', { active: false });
  });

  it('returns 403 for non-admin', async () => {
    validateSession.mockResolvedValue({ id: 'u', email: 'maya@agentbook.test' });
    const r = await createPlan(adminReq({}));
    expect(r.status).toBe(403);
  });

  it('returns 400 for invalid body', async () => {
    validateSession.mockResolvedValue(adminUser);
    const r = await createPlan(adminReq({ code: 'BAD CODE' }));
    expect(r.status).toBe(400);
  });
});

describe('GET /plans', () => {
  it('returns active plans only, scoped to the caller tenant\'s region', async () => {
    planFindMany.mockResolvedValue([{ id: 'p1', code: 'free', isActive: true }]);
    const r = await listPlans(new NextRequest('http://x/p'));
    expect(r.status).toBe(200);
    expect(planFindMany.mock.calls[0][0].where.isActive).toBe(true);
    expect(planFindMany.mock.calls[0][0].where.region).toBe('us');
  });

  it('?all=true bypasses the region filter for admin plan management, gated behind requireAdmin', async () => {
    validateSession.mockResolvedValue(adminUser);
    planFindMany.mockResolvedValue([
      { id: 'p1', code: 'free', region: 'us', isActive: true },
      { id: 'p2', code: 'free', region: 'ca', isActive: true },
    ]);
    const r = new NextRequest('http://x/p?all=true');
    r.cookies.set('naap_auth_token', 'tok');
    const res = await listPlans(r);
    expect(res.status).toBe(200);
    const where = planFindMany.mock.calls[0][0].where;
    expect(where.isActive).toBe(true);
    expect(where.region).toBeUndefined();
    const body = await res.json();
    expect(body.plans).toHaveLength(2);
  });

  it('?all=true rejects a non-admin caller (401/403), never falling back to region-scoped results', async () => {
    validateSession.mockResolvedValue(null);
    const r = new NextRequest('http://x/p?all=true');
    const res = await listPlans(r);
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(planFindMany).not.toHaveBeenCalled();
  });
});

describe('PATCH /plans/:id', () => {
  it('updates display fields only — never price', async () => {
    validateSession.mockResolvedValue(adminUser);
    planUpdate.mockResolvedValue({ id: 'p1' });
    const r = await editPlan(adminReq({ name: 'Pro 2', description: 'new' }), { params: Promise.resolve({ id: 'p1' }) });
    expect(r.status).toBe(200);
    const data = planUpdate.mock.calls[0][0].data;
    expect(data.name).toBe('Pro 2');
    expect(data).not.toHaveProperty('priceCents');
  });
});

describe('DELETE /plans/:id', () => {
  it('soft-archives (isActive=false) + archives Stripe Product', async () => {
    validateSession.mockResolvedValue(adminUser);
    planFindUnique.mockResolvedValue({ id: 'p1', stripeProductId: 'prod_x' });
    productsUpdate.mockResolvedValue({});
    planUpdate.mockResolvedValue({});
    const r = await archivePlan(adminReq(), { params: Promise.resolve({ id: 'p1' }) });
    expect(r.status).toBe(200);
    expect(productsUpdate).toHaveBeenCalledWith('prod_x', { active: false });
    expect(planUpdate.mock.calls[0][0].data.isActive).toBe(false);
  });

  it('returns 404 when plan does not exist', async () => {
    validateSession.mockResolvedValue(adminUser);
    planFindUnique.mockResolvedValue(null);
    const r = await archivePlan(adminReq(), { params: Promise.resolve({ id: 'p404' }) });
    expect(r.status).toBe(404);
  });
});
