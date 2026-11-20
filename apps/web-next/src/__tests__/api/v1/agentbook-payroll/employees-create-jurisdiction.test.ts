import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
const resolveTenant = vi.fn();
const cfgFind = vi.fn();
const create = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/database', () => ({
  prisma: { abTenantConfig: { findUnique: (...a: unknown[]) => cfgFind(...a) }, abEmployee: { create: (...a: unknown[]) => create(...a) } },
}));
import { POST } from '@/app/api/v1/agentbook-payroll/employees/route';

const post = (body: Record<string, unknown>) =>
  POST(new NextRequest('http://x/api/v1/agentbook-payroll/employees', { method: 'POST', body: JSON.stringify(body) }));

beforeEach(() => {
  resolveTenant.mockReset().mockResolvedValue({ tenantId: 't1' });
  cfgFind.mockReset(); create.mockReset().mockImplementation(async ({ data }) => ({ id: 'e1', ...data }));
});

describe('POST employees jurisdiction default', () => {
  it('AU tenant, none given -> au', async () => {
    cfgFind.mockResolvedValue({ jurisdiction: 'au', region: 'NSW' });
    await post({ name: 'A', payRateCents: 100 });
    expect(create.mock.calls[0][0].data).toMatchObject({ jurisdiction: 'au', region: 'NSW' });
  });
  it('CA tenant, none given -> ca with tenant province', async () => {
    cfgFind.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
    await post({ name: 'A', payRateCents: 100 });
    expect(create.mock.calls[0][0].data).toMatchObject({ jurisdiction: 'ca', region: 'ON' });
  });
  it('explicit value is respected and does not inherit the tenant region', async () => {
    cfgFind.mockResolvedValue({ jurisdiction: 'au', region: 'NSW' });
    await post({ name: 'A', payRateCents: 100, jurisdiction: 'us' });
    expect(create.mock.calls[0][0].data).toMatchObject({ jurisdiction: 'us', region: '' });
  });
  it('no tenant config -> us', async () => {
    cfgFind.mockResolvedValue(null);
    await post({ name: 'A', payRateCents: 100 });
    expect(create.mock.calls[0][0].data).toMatchObject({ jurisdiction: 'us', region: '' });
  });
});
