// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
const llm = vi.hoisted(() => ({ classify: vi.fn(async () => null) }));
vi.mock('@/lib/agentbook-auto-categorize', () => ({ classifyExpenseWithGemini: llm.classify }));

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { GET } from '@/app/api/v1/agentbook-expense/categories/suggest/route';

const get = async (qs: string, tenant = 't1') => {
  const res = await GET(tenantReq(`/api/v1/agentbook-expense/categories/suggest?${qs}`, tenant));
  return { status: res.status, body: await json<{ success: boolean; data: unknown; error?: string }>(res) };
};

beforeEach(() => { memDb.reset(fullSeed()); llm.classify.mockClear(); });

describe('GET /agentbook-expense/categories/suggest', () => {
  it('returns the remembered category for a known vendor', async () => {
    const r = await get('vendor=Shell');
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ categoryId: 'acc-fuel', categoryName: 'Fuel', confidence: 0.95, source: 'vendor' });
  });

  it('returns data:null (not an error) when nothing is known and there is nothing to ask the AI', async () => {
    const r = await get('vendor=');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, data: null });
    expect(llm.classify).not.toHaveBeenCalled();
  });

  it('is tenant-scoped: another tenant cannot read this tenant\'s vendor memory', async () => {
    const r = await get('vendor=Bistro', 't2');
    expect(r.body.data).toBeNull(); // t1 knows Bistro → acc-meals; t2 must not
  });

  it('reads amountCents defensively: junk is ignored, the request still succeeds', async () => {
    expect((await get('vendor=Shell&amountCents=abc')).status).toBe(200);
    expect((await get(`vendor=Shell&amountCents=${'9'.repeat(40)}`)).status).toBe(200);
  });

  it('caps vendor/description length so a request cannot ship an unbounded prompt to the AI', async () => {
    llm.classify.mockClear();
    await get(`vendor=${'x'.repeat(5000)}&description=${'y'.repeat(5000)}`);
    const exp = (llm.classify.mock.calls[0] as unknown as [{ vendorName: string; description: string }])[0];
    expect(exp.vendorName.length).toBeLessThanOrEqual(200);
    expect(exp.description.length).toBeLessThanOrEqual(500);
  });
});
