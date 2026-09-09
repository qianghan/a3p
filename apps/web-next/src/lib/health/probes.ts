import 'server-only';
import { prisma } from '@naap/database';

/**
 * Dependency health probes.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT
 *
 * This is not uptime monitoring, and calling it that would be the whole
 * mistake. A check that runs inside the deployment cannot tell you the
 * deployment is down — if the app is gone, so is the thing doing the
 * checking, and the silence looks exactly like everything being fine. Real
 * uptime monitoring has to come from outside.
 *
 * What this does is the half that has to live in here: whether the app can
 * reach the things it depends on, and whether the things it needs configured
 * actually are. `/api/health/deep` exposes it so an EXTERNAL monitor has
 * something meaningful to poll — a 200/503 that turns red when the database
 * goes away, not just when the process dies — and a cron records it so
 * degradation has a history and a transition raises an alert.
 *
 * TWO KINDS OF ANSWER, KEPT APART
 *
 * "Stripe is unreachable" and "no Stripe key is set" are different facts and
 * a monitor should treat them differently: the first is an incident, the
 * second is a deployment that was never finished. Conflating them either
 * pages someone at 3am about a feature nobody enabled, or hides a real
 * outage behind a shrug. Hence `unconfigured` as a status of its own, and
 * `critical` marking only the probes whose failure means the product is
 * actually broken.
 *
 * SAYS NOTHING IT SHOULDN'T
 *
 * `/api/health` once returned `substring(0, 40)` of four Postgres connection
 * strings to anyone who curled it. Nothing here returns an error message, a
 * URL, a host, or an env value — `detail` is a fixed phrase chosen from this
 * file, never interpolated from an exception.
 */

export type ProbeStatus = 'ok' | 'degraded' | 'down' | 'unconfigured';

export interface ProbeResult {
  name: string;
  status: ProbeStatus;
  latencyMs: number;
  /** Fixed, non-sensitive. Never derived from an error. */
  detail?: string;
  /** Whether a failure here means the product is broken for users. */
  critical: boolean;
}

interface Probe {
  name: string;
  critical: boolean;
  run(): Promise<{ status: ProbeStatus; detail?: string }>;
}

/** A probe that hangs is a probe that never reports. */
const PROBE_TIMEOUT_MS = 5_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const PROBES: Probe[] = [
  {
    name: 'database',
    critical: true,
    async run() {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ok' };
    },
  },
  {
    name: 'database_schema',
    critical: true,
    async run() {
      // Distinct from connectivity on purpose. A pooler can answer SELECT 1
      // while the schema is mid-migration or the search_path is wrong, and
      // that failure mode reads as "healthy" to a liveness check while every
      // real query 500s.
      await prisma.abTenantConfig.count();
      return { status: 'ok' };
    },
  },
  {
    name: 'llm',
    critical: true,
    async run() {
      // Presence, not a completion. Calling the model every five minutes to
      // prove it answers would cost more than the outage it detects, and the
      // failure this catches — a key that was never set on this environment
      // — is the one that has actually happened here.
      if (process.env.GEMINI_API_KEY) return { status: 'ok' };
      const cfg = await prisma.abLLMProviderConfig.findFirst({
        where: { enabled: true, isDefault: true },
        select: { id: true },
      });
      return cfg ? { status: 'ok' } : { status: 'unconfigured', detail: 'no enabled LLM provider' };
    },
  },
  {
    name: 'blob_storage',
    critical: false,
    async run() {
      return process.env.BLOB_READ_WRITE_TOKEN
        ? { status: 'ok' }
        : { status: 'unconfigured', detail: 'receipts fall back to source URLs' };
    },
  },
  {
    name: 'error_tracking',
    critical: false,
    async run() {
      // Worth a probe of its own because its failure is invisible by
      // construction: an unset DSN means every reportError call succeeds and
      // goes nowhere, which is indistinguishable from no errors happening.
      return process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN
        ? { status: 'ok' }
        : { status: 'unconfigured', detail: 'errors are recorded nowhere' };
    },
  },
  {
    name: 'cron_auth',
    critical: false,
    async run() {
      // An unset CRON_SECRET does not break a page, so it is not critical —
      // but it silently disables every scheduled job's authentication, and
      // this product has already spent months with the nightly red because
      // of it.
      return process.env.CRON_SECRET
        ? { status: 'ok' }
        : { status: 'unconfigured', detail: 'scheduled jobs cannot authenticate' };
    },
  },
];

/** Run every probe. Never throws; a probe that fails IS the result. */
export async function runProbes(): Promise<ProbeResult[]> {
  return Promise.all(PROBES.map(async (probe) => {
    const started = Date.now();
    try {
      const outcome = await withTimeout(probe.run(), PROBE_TIMEOUT_MS);
      if (outcome === 'timeout') {
        return { name: probe.name, status: 'down' as const, latencyMs: Date.now() - started, detail: 'timed out', critical: probe.critical };
      }
      return { name: probe.name, ...outcome, latencyMs: Date.now() - started, critical: probe.critical };
    } catch (err) {
      // Logged in full, reported as a fixed phrase. The exception carries the
      // host, the port and the database name.
      console.error(`[health] probe ${probe.name} threw`, err);
      return { name: probe.name, status: 'down' as const, latencyMs: Date.now() - started, detail: 'check failed', critical: probe.critical };
    }
  }));
}

/**
 * The overall verdict.
 *
 * `unconfigured` never makes the endpoint red. An external monitor polling
 * this should page for an outage, and a feature nobody turned on is not one
 * — it shows in the body, where a human reads it, rather than in the status
 * code, where a pager reads it.
 */
export function overallStatus(results: ProbeResult[]): 'healthy' | 'degraded' | 'unhealthy' {
  if (results.some((r) => r.critical && r.status === 'down')) return 'unhealthy';
  if (results.some((r) => r.status === 'down' || r.status === 'degraded')) return 'degraded';
  return 'healthy';
}
