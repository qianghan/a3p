/**
 * seed-sales-rep-contract-templates.ts
 *
 * Upserts the drafted (not attorney-certified) SalesRepContractTemplate rows
 * for US/CA/UK/AU from sales-rep.html §16 — PR 3 of the Partner Program plan.
 * Without these rows the application-submission flow (step 5, e-sign) has
 * nothing to render or sign against.
 *
 * Idempotent: safe to re-run. Re-running after editing
 * sales-rep-contract-templates.ts bumps `version` and updates the content,
 * but never touches `legallyReviewed` — that flag is a real legal sign-off
 * event and must be flipped by hand (or a dedicated admin action), never by
 * this script.
 *
 * Usage:
 *   DATABASE_URL="..." npx tsx bin/seed-sales-rep-contract-templates.ts
 */

import { PrismaClient } from '../packages/database/src/generated/client/index.js';
import { CONTRACT_TEMPLATE_SEEDS } from '../apps/web-next/src/lib/billing/sales-rep-contract-templates.js';

async function main(): Promise<void> {
  const dbUrl =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.POSTGRES_URL ||
    '';

  if (!dbUrl) {
    console.warn('[seed-sales-rep-contract-templates] No DATABASE_URL found — skipping.');
    process.exit(0);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

  try {
    for (const seed of CONTRACT_TEMPLATE_SEEDS) {
      const existing = await prisma.salesRepContractTemplate.findUnique({
        where: { jurisdiction: seed.jurisdiction },
      });

      await prisma.salesRepContractTemplate.upsert({
        where: { jurisdiction: seed.jurisdiction },
        create: {
          jurisdiction: seed.jurisdiction,
          version: 1,
          bodyTemplate: seed.bodyTemplate,
          liabilityClauses: seed.liabilityClauses,
          taxFormType: seed.taxFormType,
          legallyReviewed: false,
        },
        update: {
          version: (existing?.version ?? 0) + 1,
          bodyTemplate: seed.bodyTemplate,
          liabilityClauses: seed.liabilityClauses,
          taxFormType: seed.taxFormType,
          // legallyReviewed intentionally omitted — never reset by this script.
        },
      });
      console.log(
        `[seed-sales-rep-contract-templates] ${seed.jurisdiction}: ${existing ? `updated to v${(existing.version ?? 0) + 1}` : 'created v1'}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('[seed-sales-rep-contract-templates] Failed:', err);
  process.exit(1);
});
