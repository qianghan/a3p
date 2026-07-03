/**
 * seed-sales-rep-contract-templates.ts
 *
 * Upserts the drafted (not attorney-certified) SalesRepContractTemplate rows
 * for US/CA/UK/AU from sales-rep.html §16 — PR 3 of the Partner Program plan.
 * Without these rows the application-submission flow (step 5, e-sign) has
 * nothing to render or sign against.
 *
 * Idempotent and content-aware: re-running with unchanged content is a
 * no-op (no version churn). Re-running after actually editing
 * sales-rep-contract-templates.ts bumps `version`, updates the content, AND
 * resets `legallyReviewed` back to false — a lawyer's sign-off on the OLD
 * wording does not carry over to different wording, even a small edit.
 * Flipping `legallyReviewed` to true is a real legal sign-off event and
 * must be done by hand (or a dedicated admin action) after each such reset.
 *
 * Usage:
 *   DATABASE_URL="..." npx tsx bin/seed-sales-rep-contract-templates.ts
 */

import { PrismaClient } from '../packages/database/src/generated/client/index.js';
import { CONTRACT_TEMPLATE_SEEDS } from '../apps/web-next/src/lib/billing/sales-rep-contract-templates.js';

/**
 * JSON.stringify is key-order-sensitive, but Postgres JSONB does not
 * preserve the original key-insertion order on round-trip — comparing
 * `existing.liabilityClauses` (read back from JSONB) against the seed's JS
 * object literal via plain JSON.stringify would report "changed" on every
 * single run even when nothing actually changed, defeating the no-op path
 * and spuriously resetting legallyReviewed on every re-run. Sort keys
 * (recursively) before stringifying so the comparison is order-independent.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce((sorted: Record<string, unknown>, k) => {
          sorted[k] = (v as Record<string, unknown>)[k];
          return sorted;
        }, {});
    }
    return v;
  });
}

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

      const contentChanged =
        !existing ||
        existing.bodyTemplate !== seed.bodyTemplate ||
        existing.taxFormType !== seed.taxFormType ||
        canonicalJson(existing.liabilityClauses) !== canonicalJson(seed.liabilityClauses);

      if (existing && !contentChanged) {
        console.log(`[seed-sales-rep-contract-templates] ${seed.jurisdiction}: unchanged, skipping`);
        continue;
      }

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
          // A prior sign-off covered different text — it doesn't carry
          // forward to this edit, however small.
          legallyReviewed: false,
        },
      });
      console.log(
        `[seed-sales-rep-contract-templates] ${seed.jurisdiction}: ${existing ? `updated to v${(existing.version ?? 0) + 1} (legallyReviewed reset to false)` : 'created v1'}`,
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
