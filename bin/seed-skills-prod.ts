/**
 * Seed AbSkillManifest (global, tenantId=null) from BUILT_IN_SKILLS.
 * Mirrors the admin/seed-skills route but runnable directly against a DB
 * via DATABASE_URL — used to sync new built-in skills to production.
 *
 * Usage: DATABASE_URL=... DATABASE_URL_UNPOOLED=... npx tsx bin/seed-skills-prod.ts
 */
import { PrismaClient } from '@naap/database';
import { BUILT_IN_SKILLS } from '../plugins/agentbook-core/backend/src/built-in-skills';

const db = new PrismaClient();

async function main() {
  let created = 0;
  let updated = 0;
  for (const skill of BUILT_IN_SKILLS as any[]) {
    const existing = await db.abSkillManifest.findFirst({ where: { tenantId: null, name: skill.name } });
    const data = {
      description: skill.description,
      category: skill.category,
      triggerPatterns: skill.triggerPatterns ?? [],
      requirePatterns: skill.requirePatterns ?? [],
      excludePatterns: skill.excludePatterns ?? [],
      parameters: skill.parameters ?? {},
      endpoint: skill.endpoint ?? null,
      responseTemplate: skill.responseTemplate ?? null,
      source: 'built_in',
      enabled: true,
    };
    if (existing) {
      await db.abSkillManifest.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await db.abSkillManifest.create({ data: { tenantId: null, name: skill.name, ...data } });
      created++;
    }
  }
  console.log(`Seeded skills: created=${created} updated=${updated} total=${BUILT_IN_SKILLS.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
