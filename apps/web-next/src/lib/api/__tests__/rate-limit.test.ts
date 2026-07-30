import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const updateMany = vi.fn();
const upsert = vi.fn();
const findUnique = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    rateLimit: {
      updateMany: (...a: unknown[]) => updateMany(...a),
      upsert: (...a: unknown[]) => upsert(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
  },
}));

import { enforceRateLimit } from '../rate-limit';

function req(ip = '9.9.9.9'): Request {
  return new Request('http://x/api/v1/auth/login', {
    method: 'POST',
    headers: { 'x-forwarded-for': ip },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  upsert.mockResolvedValue({});
});

describe('enforceRateLimit — shared (database) store', () => {
  it('starts a window and allows the first request when no row exists', async () => {
    updateMany.mockResolvedValue({ count: 0 }); // nothing to increment
    const res = await enforceRateLimit(req(), { keyPrefix: 'auth:login' });
    expect(res).toBeNull();
    expect(upsert).toHaveBeenCalled();
    // keyed by prefix + client IP, so the limit is global rather than per-instance
    expect(upsert.mock.calls[0][0].where).toEqual({ key: 'auth:login:9.9.9.9' });
  });

  it('allows a request that is within the limit', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ count: 3, resetAt: new Date(Date.now() + 30_000) });
    expect(await enforceRateLimit(req(), { keyPrefix: 'auth:login', maxRequests: 10 })).toBeNull();
  });

  it('allows exactly up to maxRequests, then blocks with 429 + Retry-After', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ count: 10, resetAt: new Date(Date.now() + 30_000) });
    expect(await enforceRateLimit(req(), { keyPrefix: 'auth:login', maxRequests: 10 })).toBeNull();

    findUnique.mockResolvedValue({ count: 11, resetAt: new Date(Date.now() + 30_000) });
    const blocked = await enforceRateLimit(req(), { keyPrefix: 'auth:login', maxRequests: 10 });
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(Number(blocked!.headers.get('Retry-After'))).toBeGreaterThan(0);
  });

  it('restarts the window (allows) once the previous one has lapsed', async () => {
    // an expired row is not matched by the `resetAt > now` increment…
    updateMany.mockResolvedValue({ count: 0 });
    const res = await enforceRateLimit(req(), { keyPrefix: 'auth:login', maxRequests: 1 });
    expect(res).toBeNull();
    // …and the window is reset to count 1 rather than incremented
    expect(upsert.mock.calls[0][0].update.count).toBe(1);
  });

  it('only increments an UNEXPIRED window (the atomic guard)', async () => {
    updateMany.mockResolvedValue({ count: 1 });
    findUnique.mockResolvedValue({ count: 2, resetAt: new Date(Date.now() + 10_000) });
    await enforceRateLimit(req(), { keyPrefix: 'auth:login' });
    const where = updateMany.mock.calls[0][0].where;
    expect(where.key).toBe('auth:login:9.9.9.9');
    expect(where.resetAt).toHaveProperty('gt'); // scoped to the live window
    expect(updateMany.mock.calls[0][0].data).toEqual({ count: { increment: 1 } });
  });

  it('separates counters by IP and by key prefix', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    await enforceRateLimit(req('1.1.1.1'), { keyPrefix: 'auth:login' });
    await enforceRateLimit(req('2.2.2.2'), { keyPrefix: 'auth:login' });
    await enforceRateLimit(req('1.1.1.1'), { keyPrefix: 'auth:register' });
    const keys = upsert.mock.calls.map((c) => c[0].where.key);
    expect(new Set(keys).size).toBe(3);
  });

  it('fails OPEN when the store is unreachable (never locks users out of auth)', async () => {
    updateMany.mockRejectedValue(new Error('db down'));
    expect(await enforceRateLimit(req(), { keyPrefix: 'auth:login' })).toBeNull();
  });

  it('skips limiting when the client IP is unknown', async () => {
    const res = await enforceRateLimit(
      new Request('http://x/api/v1/auth/login', { method: 'POST' }),
      { keyPrefix: 'auth:login' },
    );
    expect(res).toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });
});
