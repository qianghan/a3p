import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '@naap/plugin-server-sdk';

// Import the tenant middleware as an isolated function — read
// plugins/agentbook-core/backend/src/server.ts first to see whether the
// middleware is already a named, exported function or an inline
// app.use(...) callback. If it's inline (likely, matching the current
// file), extract it into a small named, exported function
// (e.g. `export function tenantMiddleware(req, res, next) {...}`) as
// part of this task's Step 2 change, specifically so it's unit-testable
// without booting the whole Express app — this is a minimal, mechanical
// refactor (extract-function), not new architecture.

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

describe('agentbook-core tenant middleware — production mode', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  it('derives tenantId from req.user.id (set by the SDK auth middleware) when present', () => {
    const req = { user: { id: 'tenant-from-auth' }, headers: {} } as AuthenticatedRequest;
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

describe('agentbook-core tenant middleware — development mode', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'development';
  });

  // In dev, requireAuth is false and the SDK's auth middleware is never
  // registered, so req.user is never set — tenantMiddleware must fall
  // back to trusting the x-tenant-id header directly (the original,
  // pre-Task-2 permissive behavior) rather than 401'ing every request.
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
