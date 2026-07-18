import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Response, NextFunction } from 'express';
import { createAuthMiddleware, type AuthenticatedRequest } from '../auth';

function mockReq(headers: Record<string, string> = {}, path = '/some/route'): AuthenticatedRequest {
  return { headers, path } as AuthenticatedRequest;
}

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

describe('createAuthMiddleware — CRON_SECRET bearer short-circuit', () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.CRON_SECRET = 'test-cron-secret';
    global.fetch = vi.fn(); // any call to this proves we did NOT take the short-circuit
  });

  afterEach(() => {
    process.env.CRON_SECRET = originalCronSecret;
    global.fetch = originalFetch;
  });

  it('sets req.user from x-tenant-id and calls next() when the bearer matches CRON_SECRET, without calling the auth service', async () => {
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({
      authorization: 'Bearer test-cron-secret',
      'x-tenant-id': 'tenant-abc-123',
    });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(req.user).toEqual({ id: 'tenant-abc-123' });
    expect(next).toHaveBeenCalledOnce();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when the bearer matches CRON_SECRET but x-tenant-id is missing', async () => {
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({ authorization: 'Bearer test-cron-secret' });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('does NOT short-circuit when the bearer does not match CRON_SECRET (falls through to normal auth-service validation)', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'real-user-1', email: 'a@b.com' }),
    });
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({
      authorization: 'Bearer some-real-session-token',
      'x-tenant-id': 'tenant-should-be-ignored',
    });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(global.fetch).toHaveBeenCalledOnce();
    expect(req.user?.id).toBe('real-user-1'); // NOT 'tenant-should-be-ignored'
    expect(next).toHaveBeenCalledOnce();
  });

  it('does NOT short-circuit when CRON_SECRET is unset, even if a caller sends a matching-looking bearer', async () => {
    delete process.env.CRON_SECRET;
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 401, text: async () => 'no' });
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({ authorization: 'Bearer test-cron-secret', 'x-tenant-id': 'tenant-x' });
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(global.fetch).toHaveBeenCalledOnce(); // fell through to real validation, which then fails
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('still returns 401 for a missing Authorization header entirely (existing behavior, unchanged)', async () => {
    const middleware = createAuthMiddleware({ publicPaths: ['/healthz'] });
    const req = mockReq({});
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
