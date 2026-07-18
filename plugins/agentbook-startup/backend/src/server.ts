/**
 * AgentBook Startup Tax Benefits Backend - v1.0
 *
 * PR 7.3: Phase 1 of the 5-phase workflow — free, pre-purchase discovery.
 * Profile CRUD + recommendations, dispatched through the
 * TaxBenefitProvider jurisdiction interface built in PR 7.1. See
 * startup.html §8 and §10.
 */

import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createPluginServer } from '@naap/plugin-server-sdk';
import { loadBuiltInPacks } from '@agentbook/jurisdictions';
import { db } from './db/client.js';
import { computeRecommendations } from './discovery.js';

loadBuiltInPacks();

let pluginConfig: { backend?: { devPort?: number } } = {};
try {
  pluginConfig = JSON.parse(
    readFileSync(new URL('../../plugin.json', import.meta.url), 'utf8'),
  );
} catch {
  /* bundled environment — defaults are fine */
}

const server = createPluginServer({
  name: 'agentbook-startup',
  port: parseInt(process.env.PORT || String(pluginConfig.backend?.devPort || 4054), 10),
  prisma: db,
  // In development, make API routes publicly accessible for testing.
  // In production, auth is enforced (this plugin's own middleware below)
  // — no longer relying on the Next.js proxy layer alone (Launch-gap
  // PR-10): the whole API prefix used to be listed here as public
  // regardless of requireAuth, so production was never actually
  // enforcing auth despite requireAuth already being true.
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes:
    process.env.NODE_ENV === 'production' ? ['/healthz'] : ['/healthz', '/api/v1/agentbook-startup'],
});

const { router } = server;

// === Middleware ===
// req.user is set by the SDK's createAuthMiddleware — but that middleware
// is only ever REGISTERED when requireAuth is true (see
// packages/plugin-server-sdk/src/server.ts), i.e. only in production. In
// development requireAuth is false above, so the SDK's auth middleware
// never runs and req.user is NEVER set on any request — asserting
// req.user unconditionally here would 401 every route in local dev,
// breaking the documented Quick Start workflow (CLAUDE.md).
//
// So the strictness has to mirror the requireAuth/publicRoutes split
// above exactly:
//   - Production: require req.user.id (set by the SDK's auth
//     middleware, from a real session or the CRON_SECRET
//     service-to-service path). 401 if missing — fail closed.
//   - Development: intentionally permissive for local testing — trust
//     the x-tenant-id header if present, default to 'default'
//     otherwise. This restores the pre-existing dev behavior.
//
// NODE_ENV is read fresh on every call (not captured once at module
// load) so this stays in sync with the server config above and so tests
// can toggle it per-case via process.env.NODE_ENV.
export function tenantMiddleware(req: any, res: any, next: any) {
  if (process.env.NODE_ENV === 'production') {
    const tenantId = req.user?.id;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'No authenticated tenant for this request' },
      });
    }
    req.tenantId = tenantId;
    return next();
  }

  req.tenantId = (req.headers?.['x-tenant-id'] as string) || 'default';
  next();
}

router.use(tenantMiddleware);

server.app.get('/api/v1/agentbook-startup/profile', async (req: any, res) => {
  const profile = await db.startupBenefitProfile.findUnique({ where: { tenantId: req.tenantId } });
  res.json({ profile });
});

server.app.put('/api/v1/agentbook-startup/profile', async (req: any, res) => {
  const { companyType, incorporatedAt, headcount, annualRdSpendCents, equityRaisedCents } = req.body ?? {};
  const data = {
    companyType: companyType ?? null,
    incorporatedAt: incorporatedAt ? new Date(incorporatedAt) : null,
    headcount: typeof headcount === 'number' ? headcount : null,
    annualRdSpendCents: typeof annualRdSpendCents === 'number' ? annualRdSpendCents : null,
    equityRaisedCents: typeof equityRaisedCents === 'number' ? equityRaisedCents : null,
    lastAssessedAt: new Date(),
  };
  const profile = await db.startupBenefitProfile.upsert({
    where: { tenantId: req.tenantId },
    create: { tenantId: req.tenantId, ...data },
    update: data,
  });
  res.json({ profile });
});

server.app.get('/api/v1/agentbook-startup/recommendations', async (req: any, res) => {
  const profile = await db.startupBenefitProfile.findUnique({ where: { tenantId: req.tenantId } });
  if (!profile) {
    return res.status(400).json({ error: 'complete your company profile first' });
  }

  const tenantConfig = await db.abTenantConfig.findUnique({ where: { userId: req.tenantId } });
  const jurisdiction = tenantConfig?.jurisdiction ?? 'us';

  const catalogRows = await db.startupBenefitProgram.findMany({ where: { jurisdiction, enabled: true } });
  const catalog = catalogRows.map((row) => ({
    programCode: row.programCode, name: row.name, authority: row.authority, sourceUrl: row.sourceUrl,
  }));

  const result = computeRecommendations(jurisdiction, {
    companyType: profile.companyType ?? undefined,
    incorporatedAt: profile.incorporatedAt ?? undefined,
    headcount: profile.headcount ?? undefined,
    annualRdSpendCents: profile.annualRdSpendCents ?? undefined,
    equityRaisedCents: profile.equityRaisedCents ?? undefined,
  }, catalog);

  // Audit-trail log, non-blocking — never let a logging failure break the response.
  for (const program of result.programs) {
    const catalogRow = catalogRows.find((c) => c.programCode === program.programCode);
    if (!catalogRow) continue;
    db.startupBenefitEligibilityAssessment.create({
      data: {
        tenantId: req.tenantId, programId: catalogRow.id, status: program.status,
        confidence: program.confidence, reasoning: program.reasoning,
        estValueLowCents: program.estValueLowCents, estValueHighCents: program.estValueHighCents,
      },
    }).catch((err: unknown) => console.error('[agentbook-startup] failed to log eligibility assessment', err));
  }

  res.json(result);
});

export const app = server.app;

const isDirectRun =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  !!process.argv[1] &&
  import.meta.url === new URL(process.argv[1], 'file://').href;

if (isDirectRun) {
  server.start().catch((err) => {
    console.error('Failed to start agentbook-startup-svc:', err);
    process.exit(1);
  });
}
