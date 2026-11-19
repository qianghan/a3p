// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { GET as basGET } from '@/app/api/v1/agentbook-tax/au/bas-return/route';
import { GET as gstGET } from '@/app/api/v1/agentbook-tax/ca/gst-hst-return/route';

const d = (s: string) => new Date(`${s}T12:00:00.000Z`);
const exp = (id: string, extra: Row = {}): Row => ({
  id, tenantId: 't1', isPersonal: false, date: d('2026-02-10'), amountCents: 22000,
  taxAmountCents: 2000, taxCode: 'GST', recoverableTaxCents: 2000, categoryId: null, deletedAt: null, ...extra,
});
const q = '?periodStart=2026-01-01&periodEnd=2026-03-31';

describe('returns exclude soft-deleted expenses', () => {
  beforeEach(() => memDb.reset());

  it('AU BAS: deleted typed expense does not feed 1B/G11; live one does', async () => {
    const seed = (rows: Row[]) => memDb.reset({
      abTenantConfig: [{ id: 'c', userId: 't1', jurisdiction: 'au', gstRegistered: true }],
      abExpense: rows,
    });
    seed([exp('live'), exp('gone', { deletedAt: d('2026-02-12') })]);
    const both = (await json<any>(await basGET(tenantReq(`/api/v1/agentbook-tax/au/bas-return${q}`)))).data;
    seed([exp('live')]);
    const onlyLive = (await json<any>(await basGET(tenantReq(`/api/v1/agentbook-tax/au/bas-return${q}`)))).data;
    expect(both).toEqual(onlyLive);
    expect(JSON.stringify(both)).toContain('2000'); // live row's 1B present
    seed([exp('gone', { deletedAt: d('2026-02-12') })]);
    const none = (await json<any>(await basGET(tenantReq(`/api/v1/agentbook-tax/au/bas-return${q}`)))).data;
    expect(JSON.stringify(none)).not.toContain('22000');
    expect(JSON.stringify(none)).not.toContain('2000');
  });

  it('CA GST/HST: deleted expense does not feed line 108; live one does', async () => {
    const run = async (rows: Row[]) => {
      memDb.reset({
        abTenantConfig: [{ id: 'c', userId: 't1', jurisdiction: 'ca', region: 'ON', gstRegistered: true }],
        abExpense: rows,
      });
      return (await json<any>(await gstGET(tenantReq(`/api/v1/agentbook-tax/ca/gst-hst-return${q}`)))).data;
    };
    const live = await run([exp('live', { taxCode: 'HST', taxAmountCents: 2000, recoverableTaxCents: 2000 })]);
    expect(live.line108ItcCents).toBe(2000);
    const mixed = await run([
      exp('live', { taxCode: 'HST' }),
      exp('gone', { taxCode: 'HST', deletedAt: d('2026-02-12') }),
    ]);
    expect(mixed.line108ItcCents).toBe(2000);
    const none = await run([exp('gone', { taxCode: 'HST', deletedAt: d('2026-02-12') })]);
    expect(none.line108ItcCents).toBe(0);
  });
});
