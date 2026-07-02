/**
 * E2E for the sales rep commission program (see docs/plans jolly-wondering-engelbart).
 *
 * Runs against local dev + local Postgres, following the daily-backup.spec.ts /
 * notification-triggers.spec.ts convention: seed via Prisma, hit real routes
 * via the `request` fixture, assert both HTTP response and DB state.
 *
 * Auth: creates raw Session rows directly (Session.token is just a DB lookup
 * in validateSession — no UI login needed) so this needs no real credentials
 * and can run fully offline against local dev.
 *
 * Commission accrual itself (accrueSalesRepCommission) is unit-verified
 * separately — it's `server-only` and can't be imported from a plain tsx
 * script/Playwright test outside Next's build pipeline (same limitation
 * documented in bank-plaid.spec.ts for agentbook-plaid.ts). This spec seeds
 * accrual rows directly and focuses on the API/route layer: promote, summary,
 * payout submission + idempotency, admin review, mark-paid, and the 1099 badge.
 */

import { test, expect } from '@playwright/test';

const WEB = 'http://localhost:3000';
const RUN_ID = Date.now();
const ADMIN_ID = `e2e-sr-admin-${RUN_ID}`;
const ADMIN_TOKEN = `e2e-sr-admin-token-${RUN_ID}`;
const REP_ID = `e2e-sr-rep-${RUN_ID}`;
const REP_TOKEN = `e2e-sr-rep-token-${RUN_ID}`;
const INVITEE_ID = `e2e-sr-invitee-${RUN_ID}`;

let prisma: typeof import('@naap/database').prisma;

function authHeaders(token: string) {
  return { authorization: `Bearer ${token}` };
}

test.describe.serial('Sales rep commission program', () => {
  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;

    // Admin role must exist for requireAdmin checks in the new routes.
    const adminRole = await prisma.role.upsert({
      where: { name: 'system:admin' },
      update: {},
      create: { name: 'system:admin', displayName: 'Admin', permissions: {}, scope: 'system', isSystem: true },
    });
    const salesRepRole = await prisma.role.upsert({
      where: { name: 'sales_rep' },
      update: {},
      create: { name: 'sales_rep', displayName: 'Sales Rep', permissions: {}, scope: 'agentbook', isSystem: false },
    });

    await prisma.user.create({ data: { id: ADMIN_ID, email: `${ADMIN_ID}@example.com` } });
    await prisma.userRole.create({ data: { userId: ADMIN_ID, roleId: adminRole.id } });
    await prisma.session.create({
      data: { userId: ADMIN_ID, token: ADMIN_TOKEN, expiresAt: new Date(Date.now() + 3600_000) },
    });

    await prisma.user.create({ data: { id: REP_ID, email: `${REP_ID}@example.com` } });
    await prisma.session.create({
      data: { userId: REP_ID, token: REP_TOKEN, expiresAt: new Date(Date.now() + 3600_000) },
    });

    await prisma.user.create({ data: { id: INVITEE_ID, email: `${INVITEE_ID}@example.com` } });

    // Fixed a plan exists to comp the rep onto.
    const pro = await prisma.billPlan.findFirst({ where: { code: 'pro' } });
    if (!pro) throw new Error('pro plan not seeded — run agentbook/seed-billing-plans.ts against the local DB first');

    void salesRepRole; // referenced via the route's own lookup by name, not directly here
  });

  test.afterAll(async () => {
    await prisma.salesRepCommissionAccrual.deleteMany({ where: { salesRepId: REP_ID } });
    await prisma.salesRepPayout.deleteMany({ where: { salesRepId: REP_ID } });
    await prisma.salesRepProfile.deleteMany({ where: { tenantId: REP_ID } });
    await prisma.billReferral.deleteMany({ where: { referrerTenantId: REP_ID } });
    await prisma.billReferralCode.deleteMany({ where: { tenantId: REP_ID } });
    await prisma.billSubscription.deleteMany({ where: { accountId: REP_ID } });
    await prisma.userRole.deleteMany({ where: { userId: { in: [ADMIN_ID, REP_ID] } } });
    await prisma.session.deleteMany({ where: { token: { in: [ADMIN_TOKEN, REP_TOKEN] } } });
    await prisma.user.deleteMany({ where: { id: { in: [ADMIN_ID, REP_ID, INVITEE_ID] } } });
    await prisma.$disconnect();
  });

  test('1. non-admin cannot promote; admin promotes successfully', async ({ request }) => {
    const unauthed = await request.post(`${WEB}/api/v1/admin/users/${REP_ID}/sales-rep`, {
      headers: authHeaders(REP_TOKEN),
      data: { plan: 'pro', commissionBps: 2000 },
    });
    expect(unauthed.status()).toBe(403);

    const res = await request.post(`${WEB}/api/v1/admin/users/${REP_ID}/sales-rep`, {
      headers: authHeaders(ADMIN_TOKEN),
      data: { plan: 'pro', commissionBps: 2000, payoutFrequency: 'monthly' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.referralCode).toBeTruthy();

    const sub = await prisma.billSubscription.findUnique({ where: { accountId: REP_ID } });
    expect(sub?.status).toBe('active');
    expect(sub?.billingSource).toBe('manual');
    expect(sub?.stripeSubscriptionId).toBeNull();

    const profile = await prisma.salesRepProfile.findUnique({ where: { tenantId: REP_ID } });
    expect(profile?.commissionBps).toBe(2000);
    expect(profile?.payoutFrequency).toBe('monthly');

    const code = await prisma.billReferralCode.findFirst({ where: { tenantId: REP_ID } });
    expect(code?.salesRepId).toBe(REP_ID);
  });

  test('2. rep summary reflects a seeded referral + accrual', async ({ request }) => {
    const code = await prisma.billReferralCode.findFirstOrThrow({ where: { tenantId: REP_ID } });
    const referral = await prisma.billReferral.create({
      data: { referrerTenantId: REP_ID, code: code.code, inviteeTenantId: INVITEE_ID, status: 'paid', paidAt: new Date() },
    });

    // Simulate what accrueSalesRepCommission would have written from an
    // invoice.paid webhook event (that function itself is unit-verified
    // separately — see file header).
    const now = new Date();
    const lastMonthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const lastMonthStart = new Date(Date.UTC(lastMonthEnd.getUTCFullYear(), lastMonthEnd.getUTCMonth(), 1));
    await prisma.salesRepCommissionAccrual.create({
      data: {
        salesRepId: REP_ID,
        inviteeTenantId: INVITEE_ID,
        billReferralId: referral.id,
        stripeEventId: `evt_e2e_${RUN_ID}`,
        revenueCents: 1900,
        commissionBpsUsed: 2000,
        commissionCents: 380,
        periodStart: lastMonthStart,
        periodEnd: lastMonthEnd,
      },
    });

    const res = await request.get(`${WEB}/api/v1/agentbook-billing/sales-rep/summary`, { headers: authHeaders(REP_TOKEN) });
    expect(res.status(), await res.text()).toBe(200);
    const body = await res.json();
    expect(body.data.invitees).toHaveLength(1);
    expect(body.data.invitees[0].status).toBe('paid');
    expect(body.data.invitees[0].commissionCents).toBe(380);
    expect(body.data.pendingCommissionCents).toBe(380);
  });

  test('3. rep submits an invoice; duplicate submission for the same period is rejected', async ({ request }) => {
    const first = await request.post(`${WEB}/api/v1/agentbook-billing/sales-rep/payouts`, { headers: authHeaders(REP_TOKEN) });
    expect(first.status(), await first.text()).toBe(200);
    const firstBody = await first.json();
    expect(firstBody.data.totalCents).toBe(380);
    expect(firstBody.data.invoiceNumber).toMatch(/^COMM-\d{4}-\d{4}$/);

    const dup = await request.post(`${WEB}/api/v1/agentbook-billing/sales-rep/payouts`, { headers: authHeaders(REP_TOKEN) });
    expect(dup.status()).toBe(400);
    const dupBody = await dup.json();
    expect(dupBody.error).toContain('Already submitted');

    const list = await request.get(`${WEB}/api/v1/agentbook-billing/sales-rep/payouts`, { headers: authHeaders(REP_TOKEN) });
    const listBody = await list.json();
    expect(listBody.data.payouts).toHaveLength(1);
    expect(listBody.data.payouts[0].status).toBe('submitted');
  });

  test('4. rep sets bank details; admin reviews and marks the invoice paid', async ({ request }) => {
    const saveBank = await request.post(`${WEB}/api/v1/agentbook-billing/sales-rep/bank-details`, {
      headers: authHeaders(REP_TOKEN),
      data: { bankDetails: 'Test Bank, Acct 000111222, Routing 999888777' },
    });
    expect(saveBank.status()).toBe(200);

    const adminList = await request.get(`${WEB}/api/v1/admin/sales-reps/payouts?status=submitted`, { headers: authHeaders(ADMIN_TOKEN) });
    const adminListBody = await adminList.json();
    const payout = adminListBody.data.payouts.find((p: { salesRepId: string }) => p.salesRepId === REP_ID);
    expect(payout).toBeTruthy();

    const detail = await request.get(`${WEB}/api/v1/admin/sales-reps/payouts/${payout.id}`, { headers: authHeaders(ADMIN_TOKEN) });
    expect(detail.status()).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.data.bankDetails).toBe('Test Bank, Acct 000111222, Routing 999888777');

    const markPaid = await request.patch(`${WEB}/api/v1/admin/sales-reps/payouts/${payout.id}`, {
      headers: authHeaders(ADMIN_TOKEN),
      data: { action: 'markPaid', paymentReference: 'E2E-WIRE-1' },
    });
    expect(markPaid.status()).toBe(200);

    const updated = await prisma.salesRepPayout.findUnique({ where: { id: payout.id } });
    expect(updated?.status).toBe('paid');
    expect(updated?.paymentReference).toBe('E2E-WIRE-1');
    expect(updated?.totalCents).toBe(380); // immutable — unchanged by the mark-paid action

    // Already-paid invoices can't be marked paid again.
    const second = await request.patch(`${WEB}/api/v1/admin/sales-reps/payouts/${payout.id}`, {
      headers: authHeaders(ADMIN_TOKEN),
      data: { action: 'markPaid' },
    });
    expect(second.status()).toBe(400);
  });

  test('5. roster shows the rep, but $3.80 lifetime paid does not cross the $600 1099 threshold', async ({ request }) => {
    const res = await request.get(`${WEB}/api/v1/admin/sales-reps`, { headers: authHeaders(ADMIN_TOKEN) });
    expect(res.status()).toBe(200);
    const body = await res.json();
    const rep = body.data.reps.find((r: { tenantId: string }) => r.tenantId === REP_ID);
    expect(rep).toBeTruthy();
    expect(rep.lifetimePaidCents).toBe(380);
    expect(rep.crossed1099Threshold).toBe(false);
  });

  test('6. crossing $600/year paid flips the 1099 badge', async ({ request }) => {
    // Directly seed a second, already-paid payout large enough to cross the
    // threshold together with the first — isolates the badge's own boundary
    // math from the submit/accrual flow already covered above.
    await prisma.salesRepPayout.create({
      data: {
        salesRepId: REP_ID,
        invoiceNumber: `COMM-E2E-${RUN_ID}`,
        periodLabel: 'e2e second period',
        periodStart: new Date(),
        periodEnd: new Date(),
        totalCents: 60_000,
        status: 'paid',
        paidAt: new Date(),
      },
    });

    const res = await request.get(`${WEB}/api/v1/admin/sales-reps`, { headers: authHeaders(ADMIN_TOKEN) });
    const body = await res.json();
    const rep = body.data.reps.find((r: { tenantId: string }) => r.tenantId === REP_ID);
    expect(rep.crossed1099Threshold).toBe(true);
    expect(rep.paidThisYearCents).toBeGreaterThanOrEqual(60_380);
  });
});
