import { prisma as db } from '@naap/database';
import { US_STARTUP_BENEFIT_PROGRAMS } from '../plugins/agentbook-startup/backend/src/catalog/us-programs.js';
import { AU_STARTUP_BENEFIT_PROGRAMS } from '../plugins/agentbook-startup/backend/src/catalog/au-programs.js';

const ALL_STARTUP_BENEFIT_PROGRAMS = [...US_STARTUP_BENEFIT_PROGRAMS, ...AU_STARTUP_BENEFIT_PROGRAMS];

async function main() {
  let created = 0;
  let updated = 0;
  const now = new Date();

  for (const program of ALL_STARTUP_BENEFIT_PROGRAMS) {
    const existing = await db.startupBenefitProgram.findUnique({
      where: { jurisdiction_programCode: { jurisdiction: program.jurisdiction, programCode: program.programCode } },
    });

    const data = {
      jurisdiction: program.jurisdiction,
      programCode: program.programCode,
      name: program.name,
      authority: program.authority,
      typicalValueLowCents: program.typicalValueLowCents,
      typicalValueHighCents: program.typicalValueHighCents,
      eligibilityCriteria: program.eligibilityCriteria,
      requiredDocuments: program.requiredDocuments,
      sourceUrl: program.sourceUrl,
      lastVerifiedAt: now,
      enabled: true,
    };

    if (existing) {
      await db.startupBenefitProgram.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await db.startupBenefitProgram.create({ data });
      created++;
    }
  }

  console.log(JSON.stringify({ created, updated, total: ALL_STARTUP_BENEFIT_PROGRAMS.length }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
