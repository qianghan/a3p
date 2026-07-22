/**
 * Unit tests for `agentbook-basiq.ts`. Mirrors `agentbook-plaid.test.ts`'s
 * pattern: mock `server-only`, mock global `fetch`, never hit the real
 * Basiq API.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

describe('sanitizeBasiqError', () => {
  it('redacts Basic credentials from error messages', async () => {
    const { sanitizeBasiqError } = await import('./agentbook-basiq');
    const err = new Error('failed with Authorization: Basic abc123XYZ==');
    const out = JSON.stringify(sanitizeBasiqError(err));
    expect(out).not.toContain('abc123XYZ');
    expect(out).toContain('[redacted]');
  });

  it('redacts Bearer credentials from error messages', async () => {
    const { sanitizeBasiqError } = await import('./agentbook-basiq');
    const err = new Error('request failed — Authorization: Bearer super-secret-token.abc_123');
    const out = JSON.stringify(sanitizeBasiqError(err));
    expect(out).not.toContain('super-secret-token');
    expect(out).toContain('[redacted]');
  });

  it('returns a generic fallback for non-Error values', async () => {
    const { sanitizeBasiqError } = await import('./agentbook-basiq');
    expect(sanitizeBasiqError({ foo: 'bar' })).toEqual({ message: 'unknown basiq error' });
    expect(sanitizeBasiqError(null)).toEqual({ message: 'unknown basiq error' });
    expect(sanitizeBasiqError('a raw string with Basic abc123')).toEqual({
      message: 'unknown basiq error',
    });
  });
});

describe('getBasiqServerToken caching', () => {
  const ORIGINAL_ENV = process.env.BASIQ_API_KEY;

  beforeEach(() => {
    vi.resetModules();
    process.env.BASIQ_API_KEY = 'test-basiq-key';
  });

  afterEach(() => {
    process.env.BASIQ_API_KEY = ORIGINAL_ENV;
    vi.unstubAllGlobals();
  });

  it('does not refetch a token that is not close to expiry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) });
    vi.stubGlobal('fetch', fetchMock);

    const { getBasiqServerToken } = await import('./agentbook-basiq');
    const first = await getBasiqServerToken();
    const second = await getBasiqServerToken();

    expect(first).toBe('tok1');
    expect(second).toBe('tok1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches once the cached token is within the 5-minute expiry buffer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 200 }) }) // expires in 200s (< 5min buffer)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok2', expires_in: 3600 }) });
    vi.stubGlobal('fetch', fetchMock);

    const { getBasiqServerToken } = await import('./agentbook-basiq');
    const first = await getBasiqServerToken();
    const second = await getBasiqServerToken();

    expect(first).toBe('tok1');
    expect(second).toBe('tok2');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('sends the API key verbatim as Basic auth, unencoded', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) });
    vi.stubGlobal('fetch', fetchMock);

    const { getBasiqServerToken } = await import('./agentbook-basiq');
    await getBasiqServerToken();

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Basic test-basiq-key');
    expect(init.body).toBe('scope=SERVER_ACCESS');
  });

  it('throws a clear error when BASIQ_API_KEY is not set', async () => {
    delete process.env.BASIQ_API_KEY;
    vi.stubGlobal('fetch', vi.fn());

    const { getBasiqServerToken } = await import('./agentbook-basiq');
    await expect(getBasiqServerToken()).rejects.toThrow('BASIQ_API_KEY not set');
  });
});

describe('pollJob', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BASIQ_API_KEY = 'test-basiq-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses connectionId from the verify-credentials step result.url', async () => {
    const fetchMock = vi
      .fn()
      // token fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      // job fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          type: 'job',
          id: 'e9132638',
          steps: [
            { title: 'verify-credentials', status: 'success', result: { type: 'link', url: '/users/ea3a81/connections/8fce3b' } },
            { title: 'retrieve-accounts', status: 'success', result: null },
            { title: 'retrieve-transactions', status: 'success', result: null },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { pollJob } = await import('./agentbook-basiq');
    const status = await pollJob('e9132638');

    expect(status.status).toBe('success');
    expect(status.connectionId).toBe('8fce3b');
  });

  it('reports in-progress while steps are still pending', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          steps: [
            { title: 'verify-credentials', status: 'success', result: { type: 'link', url: '/users/ea3a81/connections/8fce3b' } },
            { title: 'retrieve-accounts', status: 'in-progress', result: null },
            { title: 'retrieve-transactions', status: 'pending', result: null },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { pollJob } = await import('./agentbook-basiq');
    const status = await pollJob('e9132638');

    expect(status.status).toBe('in-progress');
  });

  it('reports failed with the step error when a step fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          steps: [
            { title: 'verify-credentials', status: 'failed', error: { code: 'invalid-credentials' } },
          ],
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { pollJob } = await import('./agentbook-basiq');
    const status = await pollJob('e9132638');

    expect(status.status).toBe('failed');
    expect(status.error).toContain('invalid-credentials');
  });
});

describe('removeConnection', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.BASIQ_API_KEY = 'test-basiq-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('treats a 404 as a successful no-op (already removed)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 404 });
    vi.stubGlobal('fetch', fetchMock);

    const { removeConnection } = await import('./agentbook-basiq');
    await expect(removeConnection('user-1', 'conn-1')).resolves.toBeUndefined();
  });

  it('calls DELETE on /users/{userId}/connections/{connectionId}', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);

    const { removeConnection } = await import('./agentbook-basiq');
    await removeConnection('user-1', 'conn-1');

    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toBe('https://au-api.basiq.io/users/user-1/connections/conn-1');
    expect(init.method).toBe('DELETE');
  });

  it('throws on a non-404 failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'tok1', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: false, status: 500 });
    vi.stubGlobal('fetch', fetchMock);

    const { removeConnection } = await import('./agentbook-basiq');
    await expect(removeConnection('user-1', 'conn-1')).rejects.toThrow('removeConnection failed: 500');
  });
});
