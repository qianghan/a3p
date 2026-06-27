/**
 * Creates platform User records for AgentBook test personas.
 * Run this before seed-personas.ts when starting fresh with a new database.
 *
 * Usage:
 *   DATABASE_URL_UNPOOLED="..." npx tsx agentbook/seed-users.ts
 */

import crypto from 'node:crypto';
import { prisma as db } from '@naap/database';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

// IDs match the x-tenant-id values in seed-personas.ts so login → tenantId lookup works
const PERSONAS = [
  { id: 'maya-consultant',   email: 'maya@agentbook.test',   password: 'agentbook123', displayName: 'Maya Chen' },
  { id: 'alex-agency',       email: 'alex@agentbook.test',   password: 'agentbook123', displayName: 'Alex Rivera' },
  { id: 'jordan-sidehustle', email: 'jordan@agentbook.test', password: 'agentbook123', displayName: 'Jordan Kim' },
  { id: 'admin',             email: 'admin@a3p.io',          password: 'a3p-dev',      displayName: 'Admin' },
];

async function main() {
  console.log('Seeding platform users...\n');

  for (const p of PERSONAS) {
    await db.user.upsert({
      where: { id: p.id },
      create: {
        id: p.id,
        email: p.email,
        passwordHash: hashPassword(p.password),
        displayName: p.displayName,
        emailVerified: new Date(),
      },
      update: {
        email: p.email,
        passwordHash: hashPassword(p.password),
        displayName: p.displayName,
        emailVerified: new Date(),
      },
    });
    console.log(`  ✓ ${p.displayName} (${p.email}) — id: ${p.id}`);
  }

  console.log('\nDone. Run agentbook/seed-personas.ts next (backends must be on :4050-4053 with Supabase DATABASE_URL).');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => db.$disconnect());
