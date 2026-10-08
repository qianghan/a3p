// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'test-actor' }));

import { memDb } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { DOC_FILTER_PARAMS } from '@/lib/mobile/doc-filters';
import type { DocCounts, DocFilter } from '@/lib/mobile/types';
import { GET } from '@/app/api/v1/agentbook-expense/expenses/route';
import { GET as GET_ONE } from '@/app/api/v1/agentbook-expense/expenses/[id]/route';

interface ListRow {
  id: string; vendorName: string | null; categoryName: string | null; categoryCode: string | null;
  categorySource: string | null; confidence: number | null; archivedAt: string | null; suggestion: unknown;
}
interface ListBody {
  success: boolean; error?: string; data: ListRow[];
  meta: { total: number; limit: number; offset: number; nextCursor: string | null; counts?: DocCounts };
}

const list = async (qs = '', tenant = 't1') => {
  const res = await GET(tenantReq(`/api/v1/agentbook-expense/expenses${qs}`, tenant));
  return { status: res.status, body: await json<ListBody>(res) };
};
const ids = (b: ListBody) => b.data.map((r) => r.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

describe('GET /expenses — existing contract preserved', () => {
  it('keeps the legacy row shape and meta, newest first, archived hidden by default', async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(ids(body)).toEqual(['e5', 'e6', 'e2', 'e1', 'e3', 'e4']);
    expect(body.meta).toMatchObject({ total: 6, limit: 50, offset: 0, nextCursor: null });
    expect(body.meta.counts).toBeUndefined();
    expect(body.data[2]).toMatchObject({
      id: 'e2', vendorName: 'Bistro', categoryName: 'Meals', categoryCode: '5200',
      categorySource: 'ai', confidence: 0.88, archivedAt: null, suggestion: null,
    });
    expect(body.data[1]).toMatchObject({
      id: 'e6', categorySource: null, suggestion: { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.7 },
    });
  });

  it('the desktop list request (limit=200, isPersonal=false) still gets up to 200 rows', async () => {
    const { body } = await list('?limit=200&isPersonal=false');
    expect(body.meta.limit).toBe(200);
    expect(ids(body)).toEqual(['e5', 'e6', 'e2', 'e1', 'e4']);
  });

  it('includeDeleted still works', async () => {
    memDb.table('abExpense').rows.push({ ...memDb.table('abExpense').rows[0], id: 'del1', deletedAt: NOW });
    expect(ids((await list()).body)).not.toContain('del1');
    expect(ids((await list('?includeDeleted=true')).body)).toContain('del1');
  });

  it('401 without a session', async () => {
    expect((await list('', 'none')).status).toBe(401);
  });
});

describe('GET /expenses — tenant isolation', () => {
  it('only ever returns the caller tenant rows, even when asked for a foreign category', async () => {
    expect(ids((await list('', 't2')).body)).toEqual(['x1']);
    expect(ids((await list('?categoryId=b-meals')).body)).toEqual([]);
    expect(ids((await list('?q=other')).body)).toEqual([]);
  });
});

describe('GET /expenses — mobile filters', () => {
  it('status', async () => {
    expect(ids((await list('?status=pending_review')).body)).toEqual(['e5']);
    expect((await list('?status=bogus')).status).toBe(400);
  });

  it('hasReceipt (false excludes skipped and keeps NULL receiptStatus)', async () => {
    expect(ids((await list('?hasReceipt=false')).body)).toEqual(['e1', 'e3', 'e4']);
    expect(ids((await list('?hasReceipt=true')).body)).toEqual(['e5', 'e2']);
    expect((await list('?hasReceipt=maybe')).status).toBe(400);
  });

  it('categoryId (id or none)', async () => {
    expect(ids((await list('?categoryId=none')).body)).toEqual(['e5', 'e6', 'e3']);
    expect(ids((await list('?categoryId=acc-fuel')).body)).toEqual(['e1', 'e4']);
  });

  it('archived (default false, true = only archived, all = both)', async () => {
    expect(ids((await list('?archived=true')).body)).toEqual(['e7']);
    expect((await list('?archived=all')).body.meta.total).toBe(7);
    expect((await list('?archived=yes')).status).toBe(400);
  });

  it('q matches description or vendor name, case-insensitively', async () => {
    expect(ids((await list('?q=shell')).body)).toEqual(['e1', 'e4']);
    expect(ids((await list('?q=LUNCH')).body)).toEqual(['e2']);
  });
});

describe('GET /expenses — cursor pagination and limit cap', () => {
  it('walks every row exactly once with a keyset cursor', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const qs = `?archived=all&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const { body } = await list(qs);
      seen.push(...ids(body));
      cursor = body.meta.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual(['e5', 'e6', 'e2', 'e1', 'e3', 'e7', 'e4']);
    expect(pages).toBe(4);
  });

  it('breaks same-date ties by id so no row is skipped or repeated', async () => {
    const template = memDb.table('abExpense').rows[0];
    for (const id of ['tie-a', 'tie-b', 'tie-c']) {
      memDb.table('abExpense').rows.push({ ...template, id, description: 'tie', vendor: null, vendorId: null, date: new Date('2026-06-19T00:00:00.000Z') });
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await list(`?q=tie&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...ids(body));
      cursor = body.meta.nextCursor;
    } while (cursor && seen.length < 10);
    expect(seen).toEqual(['tie-c', 'tie-b', 'tie-a']);
  });

  it('rejects a malformed cursor', async () => {
    expect((await list('?cursor=not-a-cursor')).status).toBe(400);
  });

  it('caps limit at 100 in mobile mode, 500 for legacy callers, defaults bad values to 50', async () => {
    expect((await list('?limit=1000&status=confirmed')).body.meta.limit).toBe(100);
    expect((await list('?limit=1000')).body.meta.limit).toBe(500);
    expect((await list('?limit=0')).body.meta.limit).toBe(50);
  });
});

describe('GET /expenses?withCounts=1 — chip counts agree with the filtered lists', () => {
  it('returns DocCounts that equal the total of each filter list', async () => {
    const { body } = await list('?withCounts=1');
    expect(body.meta.counts).toEqual({ needsReview: 1, noCategory: 2, noReceipt: 2, archived: 1 });
    const keyOf: Record<Exclude<DocFilter, 'all'>, keyof DocCounts> = {
      'needs-review': 'needsReview', 'no-category': 'noCategory', 'no-receipt': 'noReceipt', archived: 'archived',
    };
    for (const [filter, key] of Object.entries(keyOf) as [Exclude<DocFilter, 'all'>, keyof DocCounts][]) {
      const qs = `?${new URLSearchParams(DOC_FILTER_PARAMS[filter]).toString()}`;
      expect((await list(qs)).body.meta.total, filter).toBe(body.meta.counts?.[key]);
    }
  });

  // Task 1.3 follow-up: tie every chip in DOC_FILTER_PARAMS to the real route,
  // so a mapping change that still "agrees with itself" cannot ship the wrong list.
  it('each DOC_FILTER_PARAMS chip produces its intended list through the real route', async () => {
    const expected: Record<DocFilter, string[]> = {
      'needs-review': ['e5'],
      'no-category': ['e5', 'e6'],
      'no-receipt': ['e1', 'e4'],
      all: ['e5', 'e6', 'e2', 'e1', 'e3', 'e4'],
      archived: ['e7'],
    };
    for (const filter of Object.keys(expected) as DocFilter[]) {
      const qs = `?${new URLSearchParams(DOC_FILTER_PARAMS[filter]).toString()}`;
      const { status, body } = await list(qs);
      expect(status, filter).toBe(200);
      expect(ids(body), filter).toEqual(expected[filter]);
    }
  });
});

describe('GET /expenses/[id] — mobile fields', () => {
  const one = async (id: string, tenant = 't1') => {
    const res = await GET_ONE(tenantReq(`/api/v1/agentbook-expense/expenses/${id}`, tenant), { params: Promise.resolve({ id }) });
    return { status: res.status, body: await json<{ data: ListRow }>(res) };
  };

  it('carries categorySource and the pending suggestion', async () => {
    const { status, body } = await one('e6');
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ categorySource: null, suggestion: { categoryId: 'acc-meals', confidence: 0.7 } });
    expect((await one('e2')).body.data).toMatchObject({ categorySource: 'ai', categoryName: 'Meals', suggestion: null });
  });

  it('archived rows stay readable by id; foreign ids are 404', async () => {
    expect((await one('e7')).body.data.archivedAt).toBe('2026-06-19T09:00:00.000Z');
    expect((await one('e1', 't2')).status).toBe(404);
  });
});
