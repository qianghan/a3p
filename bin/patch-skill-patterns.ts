/**
 * One-shot patch: update query-expenses and vendor-insights skill manifests
 * in the DB to match the updated built-in-skills.ts definitions.
 *
 * Run:  DATABASE_URL="..." npx tsx bin/patch-skill-patterns.ts
 */

import 'dotenv/config';
import { prisma as db } from '@naap/database';

async function main() {
  const updates = [
    {
      name: 'query-expenses',
      description: 'Query, search, list, or ask questions about expenses, spending, or vendors',
      triggerPatterns: [
        'show.*expense', 'list.*expense', 'last \\d+ expense', 'how much.*spen', 'recent expense',
        'summary.*expense', 'expense.*summary', 'expense.*overview', 'spending.*summary',
        'top.*spend', 'spend.*most', 'most.*spend', 'biggest.*spend', 'highest.*spend',
        'spend.*in.*', 'spend.*by', 'spend.*month', 'spending.*month',
        'who.*spend', 'vendor.*spend', 'spending.*vendor', 'give.*spend',
        'top.*vendor', 'vendor.*most', 'show.*spend', 'my.*spend',
      ],
      endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/advisor/ask' },
    },
    {
      name: 'vendor-insights',
      description: 'Show spending patterns by vendor — who you spend most with, trends, top vendors by amount',
      triggerPatterns: ['vendor.*pattern', 'vendor.*trend', 'vendor.*insight'],
      endpoint: { method: 'POST', url: '/api/v1/agentbook-expense/advisor/ask' },
      parameters: { question: { type: 'string', required: true, extractHint: 'the full user message' } },
    },
  ];

  for (const update of updates) {
    const existing = await db.abSkillManifest.findFirst({
      where: { name: update.name, tenantId: null },
    });

    if (!existing) {
      console.log(`[skip] ${update.name} not found in DB (will be created on next seed-skills)`);
      continue;
    }

    const patchData: Record<string, unknown> = {
      description: update.description,
      triggerPatterns: update.triggerPatterns,
      endpoint: update.endpoint,
    };
    if ('parameters' in update) patchData.parameters = update.parameters;

    await db.abSkillManifest.update({
      where: { id: existing.id },
      data: patchData as never,
    });
    console.log(`[patched] ${update.name}`);
  }

  console.log('Done.');
  await db.$disconnect().catch(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
