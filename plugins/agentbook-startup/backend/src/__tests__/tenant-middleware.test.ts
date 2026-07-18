import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '@naap/plugin-server-sdk';

// tenantMiddleware is exported from server.ts as a named, unit-testable
// function (extract-function refactor matching agentbook-core's
// already-merged Launch-gap PR-10 pattern) — see
// plugins/agentbook-core/backend/src/__tests__/tenant-middleware.test.ts
// for the reference implementation this test mirrors.
import { tenantMiddleware } from '../server';

function mockRes(): Response {
  const res: Partial<Response> = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

// tenantMiddleware reads process.env.NODE_ENV fresh on every call (not a
// module-level const captured at import time), specifically so tests can
// toggle production vs. development behavior per-case without needing
// vi.resetModules()/dynamic re-import. Vitest itself runs with
// NODE_ENV=test by default, which the middleware treats as
// non-production (i.e. dev-permissive) — so the production-mode cases
// below must explicitly set NODE_ENV='production' for the duration of
// the test.
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe('agentbook-startup tenant middleware — production mode', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  it('derives tenantId from req.user.id (set by the SDK auth middleware) when present, ignoring x-tenant-id header', () => {
    const req = {
      user: { id: 'tenant-from-auth' },
      headers: { 'x-tenant-id': 'spoofed-tenant' },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect((req as any).tenantId).toBe('tenant-from-auth');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 401 when req.user is not set (auth middleware did not authenticate this request)', () => {
    const req = { headers: {} } as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('never falls back to the literal string "default" under any circumstance', () => {
    const req = { headers: {} } as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect((req as any).tenantId).not.toBe('default');
  });
});

describe('agentbook-startup tenant middleware — development mode', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  // In dev, requireAuth is false and the SDK's auth middleware is never
  // registered, so req.user is never set — tenantMiddleware must fall
  // back to trusting the x-tenant-id header directly (the original,
  // pre-hardening permissive behavior) rather than 401'ing every request.
  it('trusts the x-tenant-id header when present, and does not 401', () => {
    const req = {
      headers: { 'x-tenant-id': 'tenant-from-header' },
    } as unknown as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect((req as any).tenantId).toBe('tenant-from-header');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('falls back to the "default" tenant when no x-tenant-id header is present, and does not 401', () => {
    const req = { headers: {} } as AuthenticatedRequest;
    const res = mockRes();
    const next = vi.fn() as NextFunction;

    tenantMiddleware(req, res, next);

    expect((req as any).tenantId).toBe('default');
    expect(next).toHaveBeenCalledOnce();
    expect(res.status).not.toHaveBeenCalled();
  });
});
