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
  requireAuth: process.env.NODE_ENV === 'production',
  publicRoutes: ['/healthz', '/api/v1/agentbook-startup'],
});

const { router } = server;

function getTenantId(req: any): string {
  return (req.headers['x-tenant-id'] as string) || req.user?.id || 'default';
}

router.use((req: any, _res, next) => {
  req.tenantId = getTenantId(req);
  next();
});

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
