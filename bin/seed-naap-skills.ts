import { prisma as db } from '@naap/database';
import { BUILT_IN_SKILLS } from '../plugins/agentbook-core/backend/src/built-in-skills.js';

async function main() {
  let created = 0, updated = 0;
  for (const skill of BUILT_IN_SKILLS as any[]) {
    const existing = await db.abSkillManifest.findFirst({
      where: { tenantId: null, name: skill.name },
    });
    if (existing) {
      await db.abSkillManifest.update({
        where: { id: existing.id },
        data: {
          description: skill.description,
          category: skill.category,
          triggerPatterns: skill.triggerPatterns,
          parameters: skill.parameters,
          endpoint: skill.endpoint,
          responseTemplate: skill.responseTemplate ?? null,
          source: 'built_in',
        },
      });
      updated++;
    } else {
      await db.abSkillManifest.create({
        data: {
          tenantId: null,
          name: skill.name,
          description: skill.description,
          category: skill.category,
          triggerPatterns: skill.triggerPatterns,
          parameters: skill.parameters,
          endpoint: skill.endpoint,
          responseTemplate: skill.responseTemplate ?? null,
          source: 'built_in',
          enabled: true,
        },
      });
      created++;
    }
  }
  console.log(JSON.stringify({ created, updated, total: BUILT_IN_SKILLS.length }));
  await db.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
