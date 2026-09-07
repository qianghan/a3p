// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * `/api/health` is public and unauthenticated. It used to return
 * `substring(0, 40)` of four Postgres connection strings plus the raw Prisma
 * error message. For `postgres://postgres.<20-char-ref>` that prefix is
 * exactly 40 characters, so the slice stopped one byte before the password --
 * a shorter project ref would have published the production credential.
 *
 * `/api/health/services` checked six off-Vercel services inherited from the
 * naap fork that AgentBook does not deploy. Each URL defaulted to a localhost
 * port, so all six failed in production and the route returned a permanent
 * 503 while listing the internal service names and ports.
 */

vi.mock('server-only', () => ({}));

const queryRaw = vi.fn();
vi.mock('@naap/database', () => ({ prisma: { $queryRaw: (...a: unknown[]) => queryRaw(...a) } }));

const SECRET_URL =
  'postgres://postgres.vefoeskvxthrcnggjtlf:sup3rsecretpassword@aws-0-us-east-1.pooler.supabase.com:5432/postgres';

describe('GET /api/health', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    queryRaw.mockReset();
    process.env.DATABASE_URL = SECRET_URL;
    process.env.POSTGRES_PRISMA_URL = SECRET_URL;
    process.env.POSTGRES_URL = SECRET_URL;
    process.env.POSTGRES_URL_NON_POOLING = SECRET_URL;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('never echoes any part of a connection string, its host, or its project ref', async () => {
    queryRaw.mockResolvedValue([{ '1': 1 }]);
    const { GET } = await import('@/app/api/health/route');
    const body = JSON.stringify(await (await GET()).json());

    // Any prefix of the URL long enough to identify the deployment, and the
    // credential itself. A substring(0, n) regression trips the shortest one.
    for (const leak of [
      'postgres://',
      'vefoeskvxthrcnggjtlf',
      'sup3rsecretpassword',
      'pooler.supabase.com',
      'DATABASE_URL',
      'POSTGRES_PRISMA_URL',
    ]) {
      expect(body, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it('reports healthy with a latency when the database answers', async () => {
    queryRaw.mockResolvedValue([{ '1': 1 }]);
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const json = (await res.json()) as { status: string; database: { connected: boolean; latencyMs?: number } };
    expect(res.status).toBe(200);
    expect(json.status).toBe('healthy');
    expect(json.database.connected).toBe(true);
    expect(typeof json.database.latencyMs).toBe('number');
  });

  it('503s without leaking the failure detail when the database is down', async () => {
    queryRaw.mockRejectedValue(
      Object.assign(new Error(`Can't reach database server at aws-0-us-east-1.pooler.supabase.com:5432`), {
        name: 'PrismaClientInitializationError',
        code: 'P1001',
      }),
    );
    const { GET } = await import('@/app/api/health/route');
    const res = await GET();
    const body = JSON.stringify(await res.json());
    expect(res.status).toBe(503);
    expect(body).toContain('unhealthy');
    // The Prisma message names the host, port and error code.
    expect(body).not.toContain('pooler.supabase.com');
    expect(body).not.toContain('P1001');
    expect(body).not.toContain("Can't reach");
  });
});

describe('GET /api/health/services', () => {
  const saved = { ...process.env };
  const SVC_VARS = [
    'BASE_SVC_URL',
    'PLUGIN_SERVER_URL',
    'A3P_SVC_URL',
    'PIPELINE_GATEWAY_URL',
    'STORAGE_SVC_URL',
    'INFRASTRUCTURE_SVC_URL',
  ];

  beforeEach(() => {
    for (const v of SVC_VARS) delete process.env[v];
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('is ok, not 503, when none of the optional services are configured', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { GET } = await import('@/app/api/health/services/route');
    const res = await GET();
    const json = (await res.json()) as { status: string; services: unknown[]; summary: { total: number } };

    expect(res.status).toBe(200);
    expect(json.status).toBe('ok');
    expect(json.services).toEqual([]);
    expect(json.summary.total).toBe(0);
    // An unconfigured service must not be probed at all -- probing the
    // localhost default is what made this permanently red in production.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not disclose the internal service names or ports when unconfigured', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const { GET } = await import('@/app/api/health/services/route');
    const body = JSON.stringify(await (await GET()).json());
    for (const leak of ['base-svc', 'storage-svc', 'infrastructure-svc', 'localhost', '4060']) {
      expect(body, `leaked ${leak}`).not.toContain(leak);
    }
  });

  it('checks a service that IS configured, and reports it unhealthy when down', async () => {
    process.env.STORAGE_SVC_URL = 'https://storage.example.com';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 502 }),
    );
    const { GET } = await import('@/app/api/health/services/route');
    const res = await GET();
    const json = (await res.json()) as {
      status: string;
      services: { name: string; status: string }[];
      summary: { total: number; unhealthy: number };
    };

    expect(json.summary.total).toBe(1);
    expect(json.services[0].name).toBe('storage-svc');
    expect(json.services[0].status).toBe('unhealthy');
    expect(json.summary.unhealthy).toBe(1);
    expect(res.status).toBe(503);
  });
});
