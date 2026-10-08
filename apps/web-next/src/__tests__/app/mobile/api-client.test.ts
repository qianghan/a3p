/**
 * The /app API client, tested through a mocked global fetch — never by mocking
 * the module. Mocking api.ts in screen tests gives zero coverage of the
 * fetch/await/parse bugs that live inside it; this file is where they are caught.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ApiError,
  rowToDoc,
  getHome,
  getUpcoming,
  listDocs,
  getDoc,
  patchDoc,
  categorizeDoc,
  archiveDoc,
  unarchiveDoc,
  deleteDoc,
  listExpenseCategories,
  reviewSuggestions,
  runAutoCategorize,
  uploadReceipt,
  remindInvoice,
} from '@/app/app/_lib/api';
import { jsonResponse, textResponse, routeFetch } from './test-utils';

const HOME = {
  currency: 'CAD',
  generatedAt: '2026-10-07T15:00:00.000Z',
  isBrandNew: false,
  kpis: { monthNetCents: 1, cashTodayCents: 2, outstandingCents: 3, overdueCount: 0, overdueCents: 0, estTaxOwedCents: 4 },
  alerts: [],
  nextUp: [],
  recent: [],
};

const ROW = {
  id: 'e1',
  date: '2026-10-01T00:00:00.000Z',
  amountCents: 4250,
  vendor: { id: 'v1', name: 'Staples' },
  vendorName: 'Staples',
  description: 'Toner',
  categoryId: null,
  categoryName: null,
  categorySource: null,
  confidence: null,
  status: 'pending_review',
  isPersonal: false,
  receiptUrl: 'https://x.public.blob.vercel-storage.com/r.jpg',
  receiptStatus: 'attached',
  archivedAt: null,
  // The raw expense row carries the journal link, not `booked` (merged PR 1).
  journalEntryId: null,
};

const PENDING = {
  success: true,
  data: { items: [{ expenseId: 'e1', suggestedCategoryId: 'c-office', suggestedCategoryName: 'Office', confidence: 0.83 }] },
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  // stubGlobal records the real fetch so afterEach restores it — including
  // after routeFetch (which assigns global.fetch directly) replaced the stub.
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toBeInstanceOf(Error);
    return e as ApiError;
  }
  throw new Error('expected a rejection');
}

describe('error normalisation (shared by every endpoint)', () => {
  it('returns `data` on success and sends same-origin credentials', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: HOME }));
    await expect(getHome()).resolves.toEqual(HOME);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/agentbook-core/mobile/home');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('same-origin');
  });

  it('a non-2xx JSON error carries the status and the server message', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { success: false, error: 'Internal error' }));
    const e = await rejection(getHome());
    expect(e.status).toBe(500);
    expect(e.code).toBe('http_500');
    expect(e.message).toBe('Internal error');
  });

  it('malformed JSON on a 200 is an error, not undefined data', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(200, '<html>'));
    const e = await rejection(getHome());
    expect(e.status).toBe(200);
    expect(e.code).toBe('bad_json');
  });

  it('a non-JSON platform error (HTML 502 / text 413) keeps its status', async () => {
    fetchMock.mockResolvedValueOnce(textResponse(502, '<html>Bad gateway</html>'));
    const e = await rejection(getHome());
    expect(e.status).toBe(502);
    expect(e.code).toBe('bad_json');
  });

  it('a network failure is status 0 / network', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const e = await rejection(getHome());
    expect(e.status).toBe(0);
    expect(e.code).toBe('network');
  });

  it("the service worker's synthetic offline 503 is status 0 / offline", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { success: false, error: 'Offline' }, { 'X-Agentbook-Offline': '1' }));
    const e = await rejection(getHome());
    expect(e.status).toBe(0);
    expect(e.code).toBe('offline');
  });

  it('429 carries retryAfterMs and the localized server message from the body', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(429, { success: false, error: 'rate_limited', retryAfterMs: 30_000, message: 'Trop de messages' }, { 'Retry-After': '30' }),
    );
    const e = await rejection(getHome());
    expect(e.status).toBe(429);
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(30_000);
    expect(e.message).toBe('Trop de messages');
  });

  it('429 without a body value falls back to the Retry-After header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { success: false, error: 'rate_limited' }, { 'Retry-After': '12' }));
    const e = await rejection(getHome());
    expect(e.retryAfterMs).toBe(12_000);
  });

  it('success:false on a 200 is still an error, with a machine code when the server sent one', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: false, error: 'agent_unavailable' }));
    const e = await rejection(getHome());
    expect(e.status).toBe(200);
    expect(e.code).toBe('agent_unavailable');
  });

  it.each([
    [409, 'in_progress', 'This receipt is still being processed; retry shortly'],
    [503, 'storage_unavailable', 'Receipt storage is unavailable; nothing was saved. Retry shortly.'],
    [413, 'file_too_large', 'file must be at most 10485760 bytes'],
  ])('a %s whose body carries a machine `code` exposes it (from-receipt shape), keeping status + message', async (status, code, error) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(status, { success: false, code, error }));
    const e = await rejection(uploadReceipt(new Blob(['x']), { idempotencyKey: 'key-12345' }));
    expect(e.status).toBe(status);
    expect(e.code).toBe(code);
    expect(e.message).toBe(error);
  });

  it('a body `code` that is not code-shaped is ignored', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { success: false, code: 'Not A Code', error: 'Bad thing happened' }));
    const e = await rejection(getHome());
    expect(e.code).toBe('http_400');
  });

  it('a 429 stays rate_limited even when the body has a different code', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { success: false, code: 'too_many', error: 'slow down' }, { 'Retry-After': '5' }));
    const e = await rejection(getHome());
    expect(e.code).toBe('rate_limited');
    expect(e.retryAfterMs).toBe(5_000);
  });
});

describe('rowToDoc — booked', () => {
  it.each([
    [{ journalEntryId: null }, false],
    [{ journalEntryId: undefined }, false],
    [{ journalEntryId: 'je-1' }, true],
    [{ journalEntryId: 'je-1', booked: false }, false],
    [{ journalEntryId: null, booked: true }, true],
  ])('%o → booked=%s', (extra, booked) => {
    expect(rowToDoc({ ...ROW, ...extra }, null).booked).toBe(booked);
  });
});

describe('getHome', () => {
  it('shares one in-flight request between concurrent callers (shell badges + Home screen)', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((r) => { resolve = r; }));
    const a = getHome();
    const b = getHome();
    resolve(jsonResponse(200, { success: true, data: HOME }));
    await expect(a).resolves.toEqual(HOME);
    await expect(b).resolves.toEqual(HOME);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches again once the previous request settled — including after a failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(getHome()).rejects.toBeInstanceOf(ApiError);
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: HOME }));
    await expect(getHome()).resolves.toEqual(HOME);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getUpcoming', () => {
  it.each([
    [undefined, 30],
    [0, 1],
    [7, 7],
    [500, 90],
  ])('days=%s is sent as %s and items are returned', async (days, sent) => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { items: [{ id: 'u1' }] } }));
    await expect(getUpcoming(days as number | undefined)).resolves.toEqual([{ id: 'u1' }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe(`/api/v1/agentbook-core/calendar/upcoming?days=${sent}`);
  });
});

describe('listDocs', () => {
  it.each([
    ['needs-review', 'status=pending_review'],
    ['no-category', 'categoryId=none'],
    ['no-receipt', 'hasReceipt=false'],
    ['archived', 'archived=true'],
  ] as const)('filter %s sends %s', async (filter, param) => {
    const mock = routeFetch({
      '/api/v1/agentbook-expense/expenses': () => jsonResponse(200, { success: true, data: [], meta: { nextCursor: null } }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    await listDocs({ filter });
    const url = mock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/expenses?')) as string;
    expect(url).toContain(param);
  });

  it('"all" sends no filter, caps limit at 100, trims q, and forwards cursor + withCounts', async () => {
    const mock = routeFetch({
      '/api/v1/agentbook-expense/expenses': () => jsonResponse(200, { success: true, data: [] }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    await listDocs({ filter: 'all', limit: 500, q: '  staples ', cursor: 'c-9', withCounts: true });
    const url = new URL(mock.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/expenses?')) as string, 'https://x');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(url.searchParams.get('q')).toBe('staples');
    expect(url.searchParams.get('cursor')).toBe('c-9');
    expect(url.searchParams.get('withCounts')).toBe('1');
    for (const k of ['status', 'categoryId', 'hasReceipt', 'archived']) expect(url.searchParams.has(k)).toBe(false);
  });

  it('maps rows to MobileDoc, attaches the pending AI suggestion, and returns cursor + counts', async () => {
    routeFetch({
      '/api/v1/agentbook-expense/expenses': () =>
        jsonResponse(200, {
          success: true,
          data: [ROW],
          meta: { nextCursor: 'c-2', counts: { needsReview: 3, noCategory: 2, noReceipt: 1, archived: 0 } },
        }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    const out = await listDocs({ filter: 'needs-review', withCounts: true });
    expect(out.nextCursor).toBe('c-2');
    expect(out.counts).toEqual({ needsReview: 3, noCategory: 2, noReceipt: 1, archived: 0 });
    expect(out.items).toEqual([
      {
        id: 'e1',
        date: '2026-10-01',
        amountCents: 4250,
        vendorName: 'Staples',
        description: 'Toner',
        categoryId: null,
        categoryName: null,
        categorySource: null,
        confidence: null,
        status: 'pending_review',
        isPersonal: false,
        receiptUrl: 'https://x.public.blob.vercel-storage.com/r.jpg',
        receiptStatus: 'attached',
        archivedAt: null,
        booked: false,
        suggestion: { categoryId: 'c-office', categoryName: 'Office', confidence: 0.83 },
      },
    ]);
  });

  it('a failing suggestions call degrades to no suggestion — the list still loads', async () => {
    routeFetch({
      '/api/v1/agentbook-expense/expenses': () => jsonResponse(200, { success: true, data: [ROW] }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(500, { success: false, error: 'x' }),
    });
    const out = await listDocs({});
    expect(out.items[0].suggestion).toBeNull();
    expect(out.counts).toBeNull();
    expect(out.nextCursor).toBeNull();
  });

  it('a failing list call rejects', async () => {
    routeFetch({
      '/api/v1/agentbook-expense/expenses': () => jsonResponse(500, { success: false, error: 'boom' }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    await expect(listDocs({})).rejects.toBeInstanceOf(ApiError);
  });
});

describe('single-document calls', () => {
  it('getDoc maps the row and drops a suggestion once the doc is categorized', async () => {
    routeFetch({
      '/api/v1/agentbook-expense/expenses/e1': () =>
        jsonResponse(200, { success: true, data: { ...ROW, categoryId: 'c-meals', categoryName: 'Meals', categorySource: 'user', status: 'confirmed' } }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    const doc = await getDoc('e1');
    expect(doc.categoryName).toBe('Meals');
    expect(doc.categorySource).toBe('user');
    expect(doc.suggestion).toBeNull();
  });

  it('getDoc on a foreign/missing id rejects with 404', async () => {
    routeFetch({
      '/api/v1/agentbook-expense/expenses/nope': () => jsonResponse(404, { success: false, error: 'Expense not found' }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    expect((await rejection(getDoc('nope'))).status).toBe(404);
  });

  it('patchDoc PATCHes only the given fields and returns the re-read document', async () => {
    const mock = routeFetch({
      '/api/v1/agentbook-expense/expenses/e1': (_u, init) =>
        init?.method === 'PATCH'
          ? jsonResponse(200, { success: true, data: { id: 'e1' } })
          : jsonResponse(200, { success: true, data: { ...ROW, amountCents: 5000, vendorName: 'Costco' } }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    const doc = await patchDoc('e1', { amountCents: 5000, vendor: 'Costco' });
    const patch = mock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'PATCH')!;
    expect(JSON.parse(String((patch[1] as RequestInit).body))).toEqual({ amountCents: 5000, vendor: 'Costco' });
    expect(doc.amountCents).toBe(5000);
    expect(doc.vendorName).toBe('Costco');
  });

  it('categorizeDoc posts a USER categorization and returns the re-read document', async () => {
    const mock = routeFetch({
      '/api/v1/agentbook-expense/expenses/e1/categorize': () => jsonResponse(200, { success: true, data: { id: 'e1' } }),
      '/api/v1/agentbook-expense/expenses/e1': () =>
        jsonResponse(200, { success: true, data: { ...ROW, categoryId: 'c-office', categoryName: 'Office', categorySource: 'user' } }),
      '/api/v1/agentbook-core/auto-categorize/pending': () => jsonResponse(200, PENDING),
    });
    const doc = await categorizeDoc('e1', 'c-office');
    const post = mock.mock.calls.find((c) => String(c[0]).endsWith('/categorize'))!;
    expect((post[1] as RequestInit).method).toBe('POST');
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ categoryId: 'c-office', source: 'user' });
    expect(doc.categoryId).toBe('c-office');
  });

  it('archive / unarchive / delete hit the right method + URL and encode ids', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { id: 'a/b', archivedAt: '2026-10-07T00:00:00.000Z' } }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { id: 'a/b', archivedAt: null } }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: { id: 'a/b' } }));
    await expect(archiveDoc('a/b')).resolves.toEqual({ id: 'a/b', archivedAt: '2026-10-07T00:00:00.000Z' });
    await expect(unarchiveDoc('a/b')).resolves.toEqual({ id: 'a/b', archivedAt: null });
    await expect(deleteDoc('a/b')).resolves.toEqual({ id: 'a/b' });
    expect(fetchMock.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit).method])).toEqual([
      ['/api/v1/agentbook-expense/expenses/a%2Fb/archive', 'POST'],
      ['/api/v1/agentbook-expense/expenses/a%2Fb/unarchive', 'POST'],
      ['/api/v1/agentbook-expense/expenses/a%2Fb', 'DELETE'],
    ]);
  });
});

describe('categories, review, auto-categorize', () => {
  it('listExpenseCategories reads expense accounts and drops malformed rows', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { success: true, data: [{ id: 'c1', name: 'Meals', code: '5300', accountType: 'expense' }, { id: 7 }] }),
    );
    await expect(listExpenseCategories()).resolves.toEqual([{ id: 'c1', name: 'Meals', code: '5300' }]);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/agentbook-core/accounts?type=expense');
  });

  it('reviewSuggestions posts the items and returns per-item results', async () => {
    const results = [{ expenseId: 'e1', ok: true }, { expenseId: 'zz', ok: false, error: 'not_found' }];
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { results } }));
    const items = [{ expenseId: 'e1', action: 'accept' as const }, { expenseId: 'zz', action: 'reject' as const }];
    await expect(reviewSuggestions(items)).resolves.toEqual(results);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/v1/agentbook-core/auto-categorize/review');
    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ items });
  });

  it('reviewSuggestions refuses 0 or more than 50 items without calling the server', async () => {
    await expect(reviewSuggestions([])).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    const many = Array.from({ length: 51 }, (_, i) => ({ expenseId: `e${i}`, action: 'accept' as const }));
    await expect(reviewSuggestions(many)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('runAutoCategorize posts and returns the three counts', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { appliedCount: 4, pendingCount: 2, skippedCount: 1 } }));
    await expect(runAutoCategorize()).resolves.toEqual({ appliedCount: 4, pendingCount: 2, skippedCount: 1 });
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });
});

describe('uploadReceipt', () => {
  it('sends multipart with the file, the idempotency key and only the given overrides', async () => {
    const result = { doc: { id: 'e9' }, duplicate: false, ocr: { amountCents: 1200, vendor: 'Cafe', date: '2026-10-06' } };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: result }));
    const file = new File(['x'], 'r.jpg', { type: 'image/jpeg' });
    await expect(uploadReceipt(file, { idempotencyKey: 'k-1', amountCents: 1200.4, isPersonal: false })).resolves.toEqual(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/agentbook-expense/expenses/from-receipt');
    expect(init.method).toBe('POST');
    expect(init.headers).toBeUndefined(); // the browser must set the multipart boundary
    const form = init.body as FormData;
    expect(form.get('idempotencyKey')).toBe('k-1');
    expect(form.get('amountCents')).toBe('1200');
    expect(form.get('isPersonal')).toBe('false');
    expect(form.has('vendor')).toBe(false);
    expect((form.get('file') as File).name).toBe('r.jpg');
  });

  it('passes a replayed-then-deleted result through unchanged', async () => {
    const result = { doc: { id: 'e9' }, duplicate: true, ocr: { amountCents: null, vendor: null, date: null }, deleted: true };
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: result }));
    await expect(uploadReceipt(new Blob(['x']), { idempotencyKey: 'key-12345' })).resolves.toEqual(result);
  });

  it('refuses an upload without an idempotency key', async () => {
    await expect(uploadReceipt(new Blob(['x']), { idempotencyKey: '' })).rejects.toMatchObject({ code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('remindInvoice', () => {
  it('POSTs the endpoint the alert supplied', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: { tone: 'gentle' } }));
    await expect(remindInvoice('/api/v1/agentbook-invoice/invoices/inv-1/remind')).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/agentbook-invoice/invoices/inv-1/remind');
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('surfaces a 422 (already paid) as an ApiError', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(422, { success: false, error: 'Cannot remind — invoice is paid' }));
    expect((await rejection(remindInvoice('/api/v1/agentbook-invoice/invoices/inv-1/remind'))).status).toBe(422);
  });

  it.each([
    'https://evil.example/api/v1/x',
    '//evil.example/api/v1/x',
    '/api/v1/../admin',
    '/api/v1//x',
    '/agentbook/invoices',
  ])('refuses %s without calling anything', async (endpoint) => {
    await expect(remindInvoice(endpoint)).rejects.toMatchObject({ code: 'invalid_endpoint' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
