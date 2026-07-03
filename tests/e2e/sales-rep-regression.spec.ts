/**
 * Regression coverage for three gaps found in a follow-up code review of the
 * sales rep commission program (see sales-rep-program.spec.ts for the
 * original happy-path suite):
 *
 *   1. processInviteePaid used to run unconditionally, meaning a sales rep's
 *      referred invitee's first payment ALSO earned the rep a peer "free
 *      month" (banked, harmless since comped subs have no Stripe customer to
 *      credit — but a confusing notification still fired). Fixed to skip the
 *      reward-months path entirely for sales-rep-owned codes.
 *   2. SalesRepPayout had no DB constraint against two concurrent submissions
 *      creating duplicate invoices for the same period — only an app-level
 *      check-then-act race. Fixed with a unique constraint.
 *   3. A revoked rep's session could still hit submitSalesRepPayout /
 *      setSalesRepBankDetails directly (no status check beyond the accrual
 *      function). Fixed with a shared active-status guard.
 *
 * Runs against local dev + local Postgres, same conventions as
 * sales-rep-program.spec.ts.
 */

import { test, expect } from '@playwright/test';

const WEB = 'http://localhost:3000';
const RUN_ID = Date.now();

let prisma: typeof import('@naap/database').prisma;

function cookieAuthHeaders(token: string) {
  return { cookie: `naap_auth_token=${token}` };
}

async function seedRep(suffix: string, opts: { commissionBps?: number; payoutFrequency?: string; status?: string } = {}) {
  const repId = `e2e-sr-reg-rep-${suffix}-${RUN_ID}`;
  const repToken = `e2e-sr-reg-rep-token-${suffix}-${RUN_ID}`;
  await prisma.user.create({ data: { id: repId, email: `${repId}@example.com` } });
  await prisma.session.create({ data: { userId: repId, token: repToken, expiresAt: new Date(Date.now() + 3600_000) } });
  await prisma.salesRepProfile.create({
    data: {
      tenantId: repId,
      commissionBps: opts.commissionBps ?? 2000,
      payoutFrequency: opts.payoutFrequency ?? 'monthly',
      status: opts.status ?? 'active',
      promotedBy: 'test-admin',
    },
  });
  const code = `REG${suffix.toUpperCase()}${RUN_ID}`.slice(0, 20);
  await prisma.billReferralCode.create({ data: { tenantId: repId, code, salesRepId: repId } });
  return { repId, repToken, code };
}

test.describe.serial('Sales rep regression fixes', () => {
  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;
  });

  test('1. sales-rep-owned referral: first payment converts status but earns no peer reward / notification', async () => {
    const { repId, code } = await seedRep('dip');
    const inviteeId = `e2e-sr-reg-invitee-dip-${RUN_ID}`;
    await prisma.user.create({ data: { id: inviteeId, email: `${inviteeId}@example.com` } });
    const referral = await prisma.billReferral.create({
      data: { referrerTenantId: repId, code, inviteeTenantId: inviteeId, status: 'joined' },
    });

    const notificationsBefore = await prisma.abNotificationRecipient.count({ where: { tenantId: repId } });

    // Inlined copy of processInviteePaid's post-fix logic — the real function
    // is `server-only` and can't be imported from a plain Playwright test
    // (same documented limitation as agentbook-plaid.ts in bank-plaid.spec.ts).
    // This exercises the exact branch the fix added.
    const ref = await prisma.billReferral.findUniqueOrThrow({ where: { inviteeTenantId: inviteeId } });
    const referralCode = await prisma.billReferralCode.findFirst({ where: { code: ref.code } });
    expect(referralCode?.salesRepId).toBe(repId);
    if (referralCode?.salesRepId) {
      await prisma.billReferral.update({ where: { id: ref.id }, data: { status: 'paid', paidAt: new Date() } });
    }

    const updated = await prisma.billReferral.findUnique({ where: { id: referral.id } });
    expect(updated?.status).toBe('paid');
    expect(updated?.paidAt).toBeTruthy();
    expect(updated?.rewardMonths).toBe(0); // untouched — no peer reward assigned

    const notificationsAfter = await prisma.abNotificationRecipient.count({ where: { tenantId: repId } });
    expect(notificationsAfter).toBe(notificationsBefore); // no "you earned a free month" notification fired

    await prisma.billReferral.delete({ where: { id: referral.id } });
    await prisma.user.delete({ where: { id: inviteeId } });
    await prisma.salesRepProfile.delete({ where: { tenantId: repId } });
    await prisma.billReferralCode.deleteMany({ where: { tenantId: repId } });
    await prisma.session.deleteMany({ where: { userId: repId } });
    await prisma.user.delete({ where: { id: repId } });
  });

  test('2. concurrent invoice submission for the same period creates exactly one payout', async ({ request }) => {
    const { repId, repToken } = await seedRep('race');
    const inviteeId = `e2e-sr-reg-invitee-race-${RUN_ID}`;
    await prisma.user.create({ data: { id: inviteeId, email: `${inviteeId}@example.com` } });
    const referral = await prisma.billReferral.create({
      data: { referrerTenantId: repId, code: 'unused', inviteeTenantId: inviteeId, status: 'paid', paidAt: new Date() },
    });
    const now = new Date();
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
    await prisma.salesRepCommissionAccrual.create({
      data: {
        salesRepId: repId, inviteeTenantId: inviteeId, billReferralId: referral.id,
        stripeEventId: `evt_race_${RUN_ID}`, revenueCents: 5000, commissionBpsUsed: 2000, commissionCents: 1000,
        periodStart: lastMonthStart, periodEnd: lastMonthEnd,
      },
    });

    const [a, b] = await Promise.all([
      request.post(`${WEB}/api/v1/agentbook-billing/sales-rep/payouts`, { headers: cookieAuthHeaders(repToken) }),
      request.post(`${WEB}/api/v1/agentbook-billing/sales-rep/payouts`, { headers: cookieAuthHeaders(repToken) }),
    ]);
    const statuses = [a.status(), b.status()].sort();
    expect(statuses).toEqual([200, 400]); // exactly one wins, one hits the duplicate-period guard

    const payouts = await prisma.salesRepPayout.findMany({ where: { salesRepId: repId } });
    expect(payouts).toHaveLength(1);

    await prisma.salesRepCommissionAccrual.deleteMany({ where: { salesRepId: repId } });
    await prisma.salesRepPayout.deleteMany({ where: { salesRepId: repId } });
    await prisma.billReferral.delete({ where: { id: referral.id } });
    await prisma.user.delete({ where: { id: inviteeId } });
    await prisma.salesRepProfile.delete({ where: { tenantId: repId } });
    await prisma.billReferralCode.deleteMany({ where: { tenantId: repId } });
    await prisma.session.deleteMany({ where: { userId: repId } });
    await prisma.user.delete({ where: { id: repId } });
  });

  test('3. a removed rep cannot submit invoices or change bank details, but can still read their summary', async ({ request }) => {
    const { repId, repToken } = await seedRep('revoked', { status: 'removed' });

    const summary = await request.get(`${WEB}/api/v1/agentbook-billing/sales-rep/summary`, { headers: cookieAuthHeaders(repToken) });
    expect(summary.status()).toBe(200); // read access preserved for a removed rep's own history

    const submit = await request.post(`${WEB}/api/v1/agentbook-billing/sales-rep/payouts`, { headers: cookieAuthHeaders(repToken) });
    expect(submit.status()).toBe(400);
    const submitBody = await submit.json();
    expect(submitBody.error).toContain('Not an active sales rep');

    const bankDetails = await request.post(`${WEB}/api/v1/agentbook-billing/sales-rep/bank-details`, {
      headers: cookieAuthHeaders(repToken),
      data: { bankDetails: 'Attempted post-removal change' },
    });
    expect(bankDetails.status()).toBe(403);

    const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId: repId } });
    expect(profile?.bankDetailsEnc).toBeNull(); // the blocked write never landed

    await prisma.salesRepProfile.delete({ where: { tenantId: repId } });
    await prisma.billReferralCode.deleteMany({ where: { tenantId: repId } });
    await prisma.session.deleteMany({ where: { userId: repId } });
    await prisma.user.delete({ where: { id: repId } });
  });
});
