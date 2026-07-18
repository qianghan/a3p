import { describe, expect, it, vi } from 'vitest';
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

describe('agentbook-core tenant middleware', () => {
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
