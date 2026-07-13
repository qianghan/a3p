/**
 * Creates/updates a dedicated test account for verifying the student chat
 * skills (find-scholarships, save-scholarship, find-coop-opportunities,
 * save-coop-opportunity, find-roommate-matches) end-to-end in production.
 *
 * Grants: businessType='student' + an ACTIVE student_success subscription
 * (the billAddOn product itself must already be isActive=true in prod —
 * this script does not flip that; it only grants ONE tenant a subscription).
 *
 * Usage:
 *   DATABASE_URL=... npx tsx bin/seed-student-chat-test-account.ts
 */

import crypto from 'node:crypto';
import { prisma as db } from '@naap/database';

const TENANT_ID = 'taylor-student';
const EMAIL = 'taylor@agentbook.test';
const PASSWORD = 'agentbook123';

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  await db.user.upsert({
    where: { id: TENANT_ID },
    create: { id: TENANT_ID, email: EMAIL, passwordHash: hashPassword(PASSWORD), displayName: 'Taylor Nguyen', emailVerified: new Date() },
    update: { email: EMAIL, passwordHash: hashPassword(PASSWORD), displayName: 'Taylor Nguyen', emailVerified: new Date() },
  });

  await db.abTenantConfig.upsert({
    where: { userId: TENANT_ID },
    create: {
      userId: TENANT_ID,
      businessType: 'student',
      jurisdiction: 'ca',
      region: 'ON',
      university: 'University of Waterloo',
      major: 'Chemistry',
      degree: "Bachelor's",
      currency: 'CAD',
    },
    update: { businessType: 'student', jurisdiction: 'ca', region: 'ON', university: 'University of Waterloo', major: 'Chemistry', degree: "Bachelor's" },
  });

  const addOn = await db.billAddOn.findUnique({ where: { code: 'student_success' } });
  if (!addOn) throw new Error('student_success add-on not found — run bin/seed-student-success-addon.ts first');
  if (!addOn.isActive) throw new Error('student_success add-on is not active in this environment');

  const price = await db.billAddOnPrice.findFirst({ where: { addOnId: addOn.id, tier: 'standard' } });
  if (!price) throw new Error('No BillAddOnPrice found for student_success — run bin/seed-student-success-addon.ts first');

  await db.billAddOnSubscription.upsert({
    where: { accountId_addOnId: { accountId: TENANT_ID, addOnId: addOn.id } },
    create: { accountId: TENANT_ID, addOnId: addOn.id, priceId: price.id, status: 'active' },
    update: { status: 'active', priceId: price.id },
  });

  console.log(JSON.stringify({ tenantId: TENANT_ID, email: EMAIL, businessType: 'student', addOnStatus: 'active' }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
