/**
 * Guards on the e2e reset endpoint — the harness's own auth plumbing.
 *
 * Why this file exists: the nightly suite was dead for ~3 months and the root
 * cause was never product code, it was untested HARNESS code. The password had
 * two independently-editable homes (a GitHub secret CI logged in with, and a
 * Vercel env var the server hashed), they drifted, and login could never
 * succeed. Test infrastructure that nothing tests is exactly where that class
 * of bug hides, so the convergence fix gets the same treatment as a money path.
 *
 * The load-bearing assertion is `passwordSource: 'caller'`: the workflow gates
 * the whole run on it, because a silent fallback to the server's own env var is
 * precisely the failure being designed out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resetE2eUser = vi.fn();
// 7 levels up from src/__tests__/api/v1/e2e-test/ reaches the repo root, which
// is where the route's own dynamic import resolves to. Get this depth wrong and
// the REAL module loads, hits Prisma, and every case fails with a 500 — loudly,
// which is the good outcome; a mock that silently misses would be the bad one.
vi.mock('../../../../../../../scripts/seed-e2e-user', () => ({
  resetE2eUser: (...a: unknown[]) => resetE2eUser(...a),
}));

const ROUTE = '/api/v1/e2e-test/reset-e2e-user';
const URL_ = `https://example.test${ROUTE}`;

function post(body?: unknown, token?: string): NextRequest {
  return new NextRequest(URL_, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-e2e-reset-token': token } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('POST /api/v1/e2e-test/reset-e2e-user', () => {
  const original = process.env.E2E_RESET_TOKEN;

  beforeEach(() => {
    vi.clearAllMocks();
    resetE2eUser.mockResolvedValue({
      userId: 'b9a80acd-fa14-4209-83a9-03231513fa8f',
      expensesCreated: 3,
      invoicesCreated: 2,
      clientsCreated: 1,
    });
    process.env.E2E_RESET_TOKEN = 'correct-token';
  });

  afterEach(() => {
    if (original === undefined) delete process.env.E2E_RESET_TOKEN;
    else process.env.E2E_RESET_TOKEN = original;
  });

  it('is inert (404) when E2E_RESET_TOKEN is unset, so a real production config cannot reach it', async () => {
    delete process.env.E2E_RESET_TOKEN;
    const { POST } = await import('@/app/api/v1/e2e-test/reset-e2e-user/route');
    const res = await POST(post({ password: 'x' }, 'anything'));
    expect(res.status).toBe(404);
    expect(resetE2eUser).not.toHaveBeenCalled();
  });

  it('rejects a wrong token with 401 and never touches the account', async () => {
    const { POST } = await import('@/app/api/v1/e2e-test/reset-e2e-user/route');
    const res = await POST(post({ password: 'x' }, 'wrong-token'));
    expect(res.status).toBe(401);
    expect(resetE2eUser).not.toHaveBeenCalled();
  });

  it('rejects a missing token with 401', async () => {
    const { POST } = await import('@/app/api/v1/e2e-test/reset-e2e-user/route');
    const res = await POST(post({ password: 'x' }));
    expect(res.status).toBe(401);
    expect(resetE2eUser).not.toHaveBeenCalled();
  });

  it("passes the caller's password through and reports passwordSource:'caller'", async () => {
    const { POST } = await import('@/app/api/v1/e2e-test/reset-e2e-user/route');
    const res = await POST(post({ password: 'the-ci-secret' }, 'correct-token'));
    expect(res.status).toBe(200);
    // The server must hash the password CI will authenticate with — not its own.
    expect(resetE2eUser).toHaveBeenCalledWith({ password: 'the-ci-secret' });
    const json = await res.json();
    expect(json.passwordSource).toBe('caller');
    expect(json.ok).toBe(true);
  });

  it("reports passwordSource:'env' when no password is supplied, so the workflow can refuse the run", async () => {
    const { POST } = await import('@/app/api/v1/e2e-test/reset-e2e-user/route');
    const res = await POST(post(undefined, 'correct-token'));
    expect(res.status).toBe(200);
    expect(resetE2eUser).toHaveBeenCalledWith({ password: undefined });
    expect((await res.json()).passwordSource).toBe('env');
  });

  it('never echoes the password back in the response body', async () => {
    const { POST } = await import('@/app/api/v1/e2e-test/reset-e2e-user/route');
    const res = await POST(post({ password: 'super-secret-value' }, 'correct-token'));
    expect(JSON.stringify(await res.json())).not.toContain('super-secret-value');
  });

  it('ignores a blank password rather than setting an empty one', async () => {
    const { POST } = await import('@/app/api/v1/e2e-test/reset-e2e-user/route');
    const res = await POST(post({ password: '' }, 'correct-token'));
    expect(resetE2eUser).toHaveBeenCalledWith({ password: undefined });
    expect((await res.json()).passwordSource).toBe('env');
    expect(res.status).toBe(200);
  });
});
