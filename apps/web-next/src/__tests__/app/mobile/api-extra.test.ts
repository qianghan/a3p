/**
 * api-extra through a mocked global fetch — never by mocking the module. Asserts
 * the real requests (URL, method, headers, body) and the failure paths, and
 * that failures are api.ts's ApiError so useMobileData can tell "offline" apart.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getPendingSuggestions,
  getTenantCurrency,
  resolveTenantCurrency,
  confirmDoc,
  createExpense,
  request,
  HttpError,
} from '@/app/app/_lib/api-extra';
import { ApiError, getHome } from '@/app/app/_lib/api';
import { jsonResponse, textResponse } from './test-utils';

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const ROW = {
  expenseId: 'e1',
  vendorName: 'Staples',
  amountCents: 4200,
  date: '2026-10-01T00:00:00.000Z',
  description: null,
  suggestedCategoryId: 'c1',
  suggestedCategoryName: 'Office Supplies',
  confidence: 0.74,
  reason: 'office',
};

describe('getPendingSuggestions', () => {
  it('GETs the existing pending route with same-origin credentials and maps rows to the contract shape', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: true, data: { items: [ROW], uncategorizedCount: 3, totalCount: 10, uncategorizedPct: 30 } }),
    );
    const r = await getPendingSuggestions();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/v1/agentbook-core/auto-categorize/pending');
    expect(init?.credentials).toBe('same-origin');
    expect(init?.method).toBeUndefined(); // a plain GET
    expect(r).toEqual({
      uncategorizedCount: 3,
      items: [
        {
          expenseId: 'e1',
          vendorName: 'Staples',
          amountCents: 4200,
          date: '2026-10-01T00:00:00.000Z',
          description: null,
          suggestedCategoryId: 'c1',
          suggestedCategoryName: 'Office Supplies',
          confidence: 0.74,
        },
      ],
    });
    expect(r.items[0]).not.toHaveProperty('reason');
  });

  it('drops malformed rows instead of rendering undefined, and keeps the good ones', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: {
          items: [{ expenseId: 'e0' }, null, 7, 'x', { ...ROW, suggestedCategoryId: '' }, { ...ROW, expenseId: '' }, ROW],
          uncategorizedCount: 0,
        },
      }),
    );
    expect((await getPendingSuggestions()).items.map((i) => i.expenseId)).toEqual(['e1']);
  });

  it('coerces bad scalar fields rather than throwing (NaN amount, bad date, string confidence)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        success: true,
        data: { items: [{ ...ROW, amountCents: 'lots', date: 'not a date', confidence: '0.9', vendorName: 5 }], uncategorizedCount: 'n/a' },
      }),
    );
    const r = await getPendingSuggestions();
    expect(r.uncategorizedCount).toBe(0);
    expect(r.items[0]).toMatchObject({ amountCents: 0, date: '', confidence: 0, vendorName: null });
  });

  it.each([
    ['missing data', { success: true }],
    ['null data', { success: true, data: null }],
    ['items not an array', { success: true, data: { items: { a: 1 }, uncategorizedCount: 2 } }],
  ])('%s yields an empty list, not a throw', async (_why, body) => {
    fetchMock.mockResolvedValue(jsonResponse(200, body));
    const r = await getPendingSuggestions();
    expect(r.items).toEqual([]);
  });

  it('a non-2xx is an ApiError carrying status, code and the server message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { success: false, error: 'Internal error' }));
    const err = await getPendingSuggestions().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ name: 'ApiError', status: 500, code: 'http_500', message: 'Internal error' });
  });

  it('401 is status 401 / unauthorized whatever the body says', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { success: false, error: 'invalid session' }));
    await expect(getPendingSuggestions()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
  });

  it('a fetch rejection is ApiError status 0 / network (what useMobileData treats as offline)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await getPendingSuggestions().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toBeInstanceOf(HttpError); // alias: one class
    expect(err).toMatchObject({ status: 0, code: 'network' });
  });

  it('the service worker synthetic offline 503 is status 0 / offline', async () => {
    fetchMock.mockResolvedValue(jsonResponse(503, { success: false, error: 'Offline' }, { 'X-Agentbook-Offline': '1' }));
    await expect(getPendingSuggestions()).rejects.toMatchObject({ status: 0, code: 'offline' });
  });

  it('a non-JSON body (a platform 502 page) is bad_json with its status', async () => {
    fetchMock.mockResolvedValue(textResponse(502, 'Bad Gateway'));
    await expect(getPendingSuggestions()).rejects.toMatchObject({ status: 502, code: 'bad_json' });
  });

  it('a JSON body that is not an envelope object (array / null) is an error, not data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, []));
    await expect(getPendingSuggestions()).rejects.toMatchObject({ status: 200, code: 'http_200' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, null));
    await expect(getPendingSuggestions()).rejects.toMatchObject({ status: 200 });
  });
});

describe('request parity with api.ts (same failure → same ApiError)', () => {
  const CASES: [string, () => Response | Promise<Response> | Error][] = [
    ['500 json', () => jsonResponse(500, { success: false, error: 'Internal error' })],
    ['400 with machine code', () => jsonResponse(400, { success: false, code: 'in_progress', error: 'Still processing' })],
    ['400 non-code-shaped code', () => jsonResponse(400, { success: false, code: 'Not A Code', error: 'Bad thing' })],
    ['success:false on 200', () => jsonResponse(200, { success: false, error: 'agent_unavailable' })],
    ['401', () => jsonResponse(401, { error: 'invalid session' })],
    ['429 body retryAfterMs + localized message', () => jsonResponse(429, { success: false, error: 'rate_limited', retryAfterMs: 30000, message: 'Trop de messages' }, { 'Retry-After': '30' })],
    ['429 header only', () => jsonResponse(429, { success: false }, { 'Retry-After': '12' })],
    ['429 non-JSON', () => textResponse(429, 'slow down', { 'Retry-After': '7' })],
    ['413 non-JSON', () => textResponse(413, 'Request Entity Too Large')],
    ['502 html', () => textResponse(502, '<html>')],
    ['200 non-JSON', () => textResponse(200, '<html>')],
    ['array body', () => jsonResponse(200, [])],
    ['offline marker', () => jsonResponse(503, { success: false, error: 'Offline' }, { 'X-Agentbook-Offline': '1' })],
    ['network drop', () => new TypeError('Failed to fetch')],
  ];

  const summarise = (e: unknown) => {
    const a = e as ApiError;
    return { name: a.name, message: a.message, status: a.status, code: a.code, retryAfterMs: a.retryAfterMs };
  };

  it.each(CASES)('%s', async (_name, make) => {
    const respond = () => {
      const r = make();
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    };
    fetchMock.mockImplementation(respond);
    const viaApi = await getHome().catch((e) => e);
    const viaExtra = await request('/x').catch((e) => e);
    expect(viaApi).toBeInstanceOf(ApiError);
    expect(summarise(viaExtra)).toEqual(summarise(viaApi));
    // and both send the same credentials mode
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe((fetchMock.mock.calls[1][1] as RequestInit).credentials);
  });
});

describe('tenant currency', () => {
  it.each([
    [{ currency: 'CAD', jurisdiction: 'ca' }, 'CAD'],
    [{ currency: 'USD', jurisdiction: 'ca' }, 'CAD'],
    [{ currency: 'USD', jurisdiction: 'us' }, 'USD'],
    [{ currency: 'USD', jurisdiction: 'uk' }, 'GBP'],
    [{ currency: '', jurisdiction: 'au' }, 'AUD'],
    [{ currency: 'eur', jurisdiction: 'ca' }, 'EUR'],
    [{ currency: ' cad ', jurisdiction: 'CA' }, 'CAD'],
    [{ currency: 'USD', jurisdiction: 'AU' }, 'AUD'],
    [{ currency: null, jurisdiction: null }, 'USD'],
    [{}, 'USD'],
  ])('%j -> %s', (cfg, want) => {
    expect(resolveTenantCurrency(cfg)).toBe(want);
  });

  it.each([null, undefined, 5, 'CAD', { currency: 5, jurisdiction: ['ca'] }, { currency: 'dollars', jurisdiction: 'ca' }, { currency: 'US', jurisdiction: 'au' }])(
    'never throws on a malformed config (%j)',
    (cfg) => {
      expect(resolveTenantCurrency(cfg as never)).toMatch(/^[A-Z]{3}$/);
    },
  );

  it('a non-currency string falls back to the jurisdiction currency', () => {
    expect(resolveTenantCurrency({ currency: 'dollars', jurisdiction: 'ca' })).toBe('CAD');
  });

  it('GETs tenant-config and resolves the currency', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { currency: 'AUD', jurisdiction: 'au' }, i18nLocalesEnabled: true }));
    await expect(getTenantCurrency()).resolves.toBe('AUD');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe('/api/v1/agentbook-core/tenant-config');
    expect(init?.credentials).toBe('same-origin');
  });

  it('a CA tenant who never saved Business Profile (schema-default USD) gets CAD', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { currency: 'USD', jurisdiction: 'ca' } }));
    await expect(getTenantCurrency()).resolves.toBe('CAD');
  });

  it('tolerates an empty / non-object data payload', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true }));
    await expect(getTenantCurrency()).resolves.toBe('USD');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { success: true, data: 'oops' }));
    await expect(getTenantCurrency()).resolves.toBe('USD');
  });

  it('surfaces a failed fetch as ApiError', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(getTenantCurrency()).rejects.toMatchObject({ name: 'ApiError', status: 0, code: 'network' });
  });
});

describe('confirmDoc', () => {
  it('POSTs to the existing confirm route with an encoded id, a JSON header and an empty-object body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { id: 'a/b', status: 'confirmed' } }));
    await expect(confirmDoc('a/b')).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/agentbook-expense/expenses/a%2Fb/confirm');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(init.credentials).toBe('same-origin');
  });

  it('the route "Already confirmed" success is not an error', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true, data: { id: 'e1' }, message: 'Already confirmed' }));
    await expect(confirmDoc('e1')).resolves.toBeUndefined();
  });

  it('surfaces a 404 as ApiError with the status', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { success: false, error: 'Expense not found' }));
    await expect(confirmDoc('x')).rejects.toMatchObject({ name: 'ApiError', status: 404, message: 'Expense not found' });
  });

  it('401 and network failures keep their codes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: 'unauthorized' }));
    await expect(confirmDoc('x')).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(confirmDoc('x')).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it.each(['', undefined as unknown as string, null as unknown as string])('refuses id %j without calling the server', async (id) => {
    await expect(confirmDoc(id)).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createExpense', () => {
  it('POSTs JSON with an Idempotency-Key header and returns the id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(201, { success: true, data: { id: 'exp_9', amountCents: 1250 } }));
    await expect(createExpense({ amountCents: 1250, vendor: 'Bus', currency: 'CAD', isPersonal: false }, 'key-1')).resolves.toEqual({ id: 'exp_9' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/agentbook-expense/expenses');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Idempotency-Key': 'key-1', 'content-type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ amountCents: 1250, vendor: 'Bus', currency: 'CAD', isPersonal: false });
  });
  it('surfaces the server validation message', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { success: false, error: 'amountCents must be a positive integer' }));
    await expect(createExpense({ amountCents: 0 }, 'k')).rejects.toMatchObject({ status: 400, message: 'amountCents must be a positive integer' });
  });
});
