import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { gwFetch, setAuthContext, getAuthContext } from '../lib/gwFetch.js';

describe('gwFetch', () => {
  const originalFetch = global.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = mockFetch;
    setAuthContext({});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setAuthContext({});
  });

  it('constructs the correct gateway URL', async () => {
    await gwFetch('my-connector', '/some/path');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:3000/api/v1/gw/my-connector/some/path',
      expect.anything(),
    );
  });

  it('sets Content-Type header by default', async () => {
    await gwFetch('test', '/path');
    const [, opts] = mockFetch.mock.calls[0];
    const headers: Headers = opts.headers;
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('forwards global auth context headers', async () => {
    setAuthContext({ authorization: 'Bearer token123', cookie: 'session=abc', teamId: 'team-1' });
    await gwFetch('test', '/path');
    const [, opts] = mockFetch.mock.calls[0];
    const headers: Headers = opts.headers;
    expect(headers.get('Authorization')).toBe('Bearer token123');
    expect(headers.get('Cookie')).toBe('session=abc');
    expect(headers.get('x-team-id')).toBe('team-1');
  });

  it('uses explicit auth context over global', async () => {
    setAuthContext({ authorization: 'Bearer global' });
    await gwFetch('test', '/path', {}, { authorization: 'Bearer local' });
    const [, opts] = mockFetch.mock.calls[0];
    const headers: Headers = opts.headers;
    expect(headers.get('Authorization')).toBe('Bearer local');
  });

  it('setAuthContext and getAuthContext work correctly', () => {
    setAuthContext({ authorization: 'Bearer abc', teamId: 'team-x' });
    const ctx = getAuthContext();
    expect(ctx.authorization).toBe('Bearer abc');
    expect(ctx.teamId).toBe('team-x');
  });

  it('passes through fetch options', async () => {
    await gwFetch('test', '/path', { method: 'POST', body: '{"a":1}' });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"a":1}');
  });

  it('does not override explicitly set headers', async () => {
    setAuthContext({ authorization: 'Bearer ctx-token' });
    await gwFetch('test', '/path', {
      headers: { Authorization: 'Bearer explicit' } as Record<string, string>,
    });
    const [, opts] = mockFetch.mock.calls[0];
    const headers: Headers = opts.headers;
    expect(headers.get('Authorization')).toBe('Bearer explicit');
  });

  it('returns the fetch response', async () => {
    const mockResponse = { ok: true, status: 200, json: async () => ({ result: true }) };
    mockFetch.mockResolvedValueOnce(mockResponse);
    const res = await gwFetch('test', '/path');
    expect(res).toBe(mockResponse);
  });
});
