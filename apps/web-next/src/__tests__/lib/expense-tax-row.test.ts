// @vitest-environment node
/**
 * PR 2b.8 — the tax row both entry UIs render comes from ONE server view
 * (lib/expense-tax-row): visibility, codes, default, and an engine-computed
 * preview so an exclusive entry converts to the same gross the server books.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const db = vi.hoisted(() => ({ cfg: null as unknown }));
vi.mock('@naap/database', () => ({ prisma: { abTenantConfig: { findUnique: vi.fn(async () => db.cfg) } } }));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 't1' })),
}));

import { buildTaxRowView } from '@/lib/expense-tax-row';
import { GET } from '@/app/api/v1/agentbook-expense/tax-codes/route';
import { NextRequest } from 'next/server';

const AU = { jurisdiction: 'au', region: 'NSW', gstRegistered: true, qstRegistered: null, currency: 'AUD' };

describe('buildTaxRowView — visibility', () => {
  it('US tenants never see the row', () => {
    const v = buildTaxRowView({ jurisdiction: 'us', region: 'NY', gstRegistered: null }, {});
    expect(v.visible).toBe(false);
    expect(v.codes).toEqual([]);
  });
  it('AU registrant: shown, GST default', () => {
    const v = buildTaxRowView(AU, {});
    expect(v.visible).toBe(true);
    expect(v.defaultCode).toBe('GST');
    expect(v.codes.map((c) => c.code)).toContain('FRE');
    expect(v.registrationPrompt).toBe(false);
  });
  it('AU gstRegistered === false: hidden', () => {
    expect(buildTaxRowView({ ...AU, gstRegistered: false }, {}).visible).toBe(false);
  });
  it('AU unknown registration: shown with the registration prompt', () => {
    const v = buildTaxRowView({ ...AU, gstRegistered: null }, {});
    expect(v.visible).toBe(true);
    expect(v.registrationPrompt).toBe(true);
  });
  it('CA ON: HST default, no GST_QST', () => {
    const v = buildTaxRowView({ jurisdiction: 'ca', region: 'ON', gstRegistered: true }, {});
    expect(v.defaultCode).toBe('HST');
    expect(v.codes.map((c) => c.code)).not.toContain('GST_QST');
  });
  it('CA QC registrant: GST_QST default', () => {
    const v = buildTaxRowView({ jurisdiction: 'ca', region: 'QC', gstRegistered: true, qstRegistered: true }, {});
    expect(v.visible).toBe(true);
    expect(v.defaultCode).toBe('GST_QST');
  });
  it('no config / unsupported jurisdiction: hidden', () => {
    expect(buildTaxRowView(null, {}).visible).toBe(false);
    expect(buildTaxRowView({ jurisdiction: 'uk', region: null, gstRegistered: true }, {}).visible).toBe(false);
  });
});

describe('buildTaxRowView — preview', () => {
  it('$100 exclusive AU GST → gross 11000, tax 1000', () => {
    const v = buildTaxRowView(AU, { amountCents: 10000, inclusive: false, taxCode: 'GST' });
    expect(v.preview).toEqual({ taxCode: 'GST', inclusive: false, grossCents: 11000, netCents: 10000, taxCents: 1000 });
  });
  it('$110 inclusive AU GST → tax 1000, gross unchanged', () => {
    const v = buildTaxRowView(AU, { amountCents: 11000, inclusive: true });
    expect(v.preview).toMatchObject({ taxCode: 'GST', grossCents: 11000, taxCents: 1000 });
  });
  it('a code the tenant cannot use gives no preview rather than throwing', () => {
    expect(buildTaxRowView(AU, { amountCents: 100, inclusive: true, taxCode: 'HST' }).preview).toBeNull();
  });
  it('hidden row → no preview', () => {
    expect(buildTaxRowView({ ...AU, gstRegistered: false }, { amountCents: 100, inclusive: true }).preview).toBeNull();
  });
});

describe('GET /agentbook-expense/tax-codes', () => {
  it('reads the tenant config and parses the query', async () => {
    db.cfg = AU;
    const res = await GET(new NextRequest('http://x/api/v1/agentbook-expense/tax-codes?amountCents=10000&inclusive=false&taxCode=GST'));
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.preview.grossCents).toBe(11000);
    expect(body.data.currency).toBe('AUD');
  });
  it('ignores a non-integer amount', async () => {
    db.cfg = AU;
    const body = await (await GET(new NextRequest('http://x/api/v1/agentbook-expense/tax-codes?amountCents=abc'))).json();
    expect(body.data.visible).toBe(true);
    expect(body.data.preview).toBeNull();
  });
});
