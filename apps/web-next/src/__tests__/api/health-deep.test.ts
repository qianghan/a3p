import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The deep health endpoint and the uptime cron.
 *
 * Two things are being guarded, and only one of them is "does it work".
 *
 * The other is what the endpoint SAYS. It is public and unauthenticated by
 * design — a monitor that needs a credential is a monitor somebody turns off
 * — and `/api/health` in this codebase once returned `substring(0, 40)` of
 * four Postgres connection strings to anyone who curled it, stopping one
 * character short of the password. So the tests below assert on what does
 * NOT appear in the body as hard as on what does.
 */

vi.mock('server-only', () => ({}));

const queryRaw = vi.fn();
const tenantConfigCount = vi.fn();
const llmFindFirst = vi.fn();
const healthStateFindUnique = vi.fn();
const healthStateUpsert = vi.fn();
const eventCreate = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
    abTenantConfig: { count: (...a: unknown[]) => tenantConfigCount(...a) },
    abLLMProviderConfig: { findFirst: (...a: unknown[]) => llmFindFirst(...a) },
    abHealthState: {
      findUnique: (...a: unknown[]) => healthStateFindUnique(...a),
      upsert: (...a: unknown[]) => healthStateUpsert(...a),
    },
    abEvent: { create: (...a: unknown[]) => eventCreate(...a) },
  },
}));

const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureMessage: (...a: unknown[]) => captureMessage(...a) }));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  tenantConfigCount.mockResolvedValue(3);
  llmFindFirst.mockResolvedValue({ id: 'x' });
  healthStateFindUnique.mockResolvedValue(null);
  healthStateUpsert.mockResolvedValue({});
  eventCreate.mockResolvedValue({});
  process.env.GEMINI_API_KEY = 'k';
  process.env.BLOB_READ_WRITE_TOKEN = 'b';
  process.env.SENTRY_DSN = 'https://x@y.ingest.sentry.io/1';
  process.env.CRON_SECRET = 'cron-secret';
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('GET /api/health/deep', () => {
  const call = async () => {
    const { GET } = await import('@/app/api/health/deep/route');
    const res = await GET();
    return { res, body: await res.json() };
  };

  it('reports every dependency healthy on a good deployment', async () => {
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.status).toBe('healthy');
    expect(body.checks.map((c: { name: string }) => c.name).sort()).toEqual(
      ['blob_storage', 'cron_auth', 'database', 'database_schema', 'error_tracking', 'llm'],
    );
  });

  it('goes 503 when a CRITICAL dependency is down', async () => {
    queryRaw.mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));
    const { res, body } = await call();
    expect(res.status).toBe(503);
    expect(body.status).toBe('unhealthy');
  });

  it('separates "cannot reach the database" from "the schema is wrong"', async () => {
    // A pooler can answer SELECT 1 while every real query 500s. A liveness
    // check that only does SELECT 1 calls that deployment healthy.
    tenantConfigCount.mockRejectedValue(new Error('relation does not exist'));
    const { res, body } = await call();
    expect(res.status).toBe(503);
    const byName = Object.fromEntries(body.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(byName.database).toBe('ok');
    expect(byName.database_schema).toBe('down');
  });

  it('does NOT go red for an unconfigured optional dependency', async () => {
    // A feature nobody turned on is not an outage. It belongs in the body,
    // where a human reads it, not in the status code, where a pager does.
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    const { res, body } = await call();
    expect(res.status).toBe(200);
    expect(body.status).toBe('healthy');
    const byName = Object.fromEntries(body.checks.map((c: { name: string; status: string }) => [c.name, c.status]));
    expect(byName.blob_storage).toBe('unconfigured');
    expect(byName.error_tracking).toBe('unconfigured');
  });

  it('leaks nothing — no connection strings, hosts, keys or error text', async () => {
    // Every probe failing at once, so every error path contributes to the body.
    queryRaw.mockRejectedValue(new Error('postgres://postgres.vefoeskvxthrcnggjtlf:hunter2@aws-0-eu.pooler.supabase.com:6543/postgres'));
    tenantConfigCount.mockRejectedValue(new Error('P1001: Can\'t reach database server at db.internal:5432'));
    const { body } = await call();
    const raw = JSON.stringify(body);
    for (const secret of ['postgres://', 'supabase', 'hunter2', '5432', 'db.internal', 'P1001', 'ECONNREFUSED', process.env.CRON_SECRET!]) {
      expect(raw, `leaked: ${secret}`).not.toContain(secret);
    }
    // What it does say is a fixed phrase from the probe module.
    expect(raw).toContain('check failed');
  });

  it('is never cached — a stale 200 is worse than no monitor', async () => {
    const { res } = await call();
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('the uptime cron', () => {
  const req = (auth?: string) => new Request('http://x/api/v1/agentbook/cron/uptime-check', {
    headers: auth ? { authorization: auth } : {},
  }) as unknown as import('next/server').NextRequest;

  it('refuses an unauthenticated call and probes nothing', async () => {
    const { GET } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(healthStateUpsert).not.toHaveBeenCalled();
  });

  it('fails closed when CRON_SECRET is unset, rather than running for anyone', async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    expect((await GET(req('Bearer '))).status).toBe(401);
  });

  it('records every probe on an authenticated run', async () => {
    const { GET } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    const res = await GET(req('Bearer cron-secret'));
    expect(res.status).toBe(200);
    expect(healthStateUpsert).toHaveBeenCalledTimes(6);
  });
});

describe('nextState — the rule that decides who gets woken up', () => {
  const result = (status: string) => ({ name: 'database', status, latencyMs: 1, critical: true }) as never;

  it('does not call a single failure an outage', async () => {
    // A timed-out query on a serverless cold start is not an incident, and a
    // monitor that cannot tell the difference teaches people to ignore it.
    const { nextState } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    const s = nextState({ status: 'ok', consecutiveFails: 0 }, result('down'));
    expect(s.status).toBe('ok');
    expect(s.changed).toBe(false);
    expect(s.consecutiveFails).toBe(1);
  });

  it('calls the second consecutive failure an outage', async () => {
    const { nextState } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    const s = nextState({ status: 'ok', consecutiveFails: 1 }, result('down'));
    expect(s.status).toBe('down');
    expect(s.changed).toBe(true);
  });

  it('reports a transition once, not once per run', async () => {
    // The whole reason the channel stays readable: six hours down is two
    // messages, not seventy-two.
    const { nextState } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    const s = nextState({ status: 'down', consecutiveFails: 9 }, result('down'));
    expect(s.changed).toBe(false);
  });

  it('recovers on the first good check, with no debounce', async () => {
    // Debouncing a recovery keeps an incident open after it is over.
    const { nextState } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    const s = nextState({ status: 'down', consecutiveFails: 5 }, result('ok'));
    expect(s.status).toBe('ok');
    expect(s.changed).toBe(true);
    expect(s.consecutiveFails).toBe(0);
  });

  it('treats a first-ever sighting as no transition', async () => {
    // Otherwise the first run after a deploy alerts for every probe.
    const { nextState } = await import('@/app/api/v1/agentbook/cron/uptime-check/route');
    expect(nextState(null, result('ok')).changed).toBe(false);
    expect(nextState(null, result('down')).changed).toBe(false);
  });
});
