import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * What a plugin route's 500 tells the caller.
 *
 * It used to tell them `error.message` and eight lines of `error.stack`. That
 * is the class of leak #492 went through 266 handlers to remove, and this one
 * survived because the raw text is assembled in the host wrapper rather than
 * at a throw site — a find-and-replace over route files never touched it.
 *
 * A module-load stack here names file paths inside the deployment, the
 * bundler layout, and — for the Prisma failure this wrapper exists to
 * diagnose — the host and database it could not reach.
 */

vi.mock('server-only', () => ({}));

const dispatchToExpress = vi.fn();
vi.mock('@/lib/express-adapter', () => ({
  dispatchToExpress: (...a: unknown[]) => dispatchToExpress(...a),
}));
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: async () => ({ tenantId: 't1' }),
}));

import { makeRouteHandler } from '../agentbook-route-host';

const req = () => new Request('http://x/api/v1/agentbook-expense/expenses') as never;

beforeEach(() => vi.clearAllMocks());

describe('a failing plugin route', () => {
  it('returns no stack and no internal message', async () => {
    const boom = new Error(
      "Can't reach database server at aws-0-eu.pooler.supabase.com:6543 (project vefoeskvxthrcnggjtlf)",
    );
    boom.stack = [
      'Error: internal',
      '    at loadPrisma (/var/task/apps/web-next/.next/server/chunks/1234.js:99:7)',
      '    at /var/task/node_modules/.prisma/client/index.js:12:1',
    ].join('\n');
    dispatchToExpress.mockRejectedValue(boom);

    const handler = makeRouteHandler('agentbook-expense', async () => ({ app: (() => {}) as never }));
    const res = await handler(req());
    const body = await res.json();

    expect(res.status).toBe(500);
    const raw = JSON.stringify(body);
    for (const leak of ['supabase.com', '6543', 'vefoeskvxthrcnggjtlf', '/var/task', '.prisma', '    at ']) {
      expect(raw, `leaked: ${leak}`).not.toContain(leak);
    }
    expect(body.error).not.toHaveProperty('stack');
  });

  it('still says which plugin failed and on what path', async () => {
    // The response has to remain useful for the person reporting the bug,
    // just not for the person probing the endpoint.
    dispatchToExpress.mockRejectedValue(new Error('internal detail'));
    const handler = makeRouteHandler('agentbook-invoice', async () => ({ app: (() => {}) as never }));
    const body = await (await handler(req())).json();
    expect(body.plugin).toBe('agentbook-invoice');
    expect(body.path).toBe('/api/v1/agentbook-expense/expenses');
    expect(body.success).toBe(false);
  });
});
