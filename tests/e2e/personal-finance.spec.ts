/**
 * Phase 3 e2e — personal finance on the deployed app.
 *
 * Logs in as Maya, creates a checking account + a savings account, records
 * income and a spend, then asserts the snapshot reflects net worth, income,
 * spending, savings rate, and business-flagged spend.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, path);
}
async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

const P = '/api/v1/agentbook-personal';

test('personal finance: accounts, transactions, snapshot', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Create a checking account with a starting balance.
  const checking = await apiPost(page, `${P}/accounts`, { name: 'E2E Checking', type: 'checking', balanceCents: 10_000_00 });
  expect(checking.status, JSON.stringify(checking.data)).toBe(201);
  const checkingId = checking.data.data.id;

  // Snapshot reflects the new asset.
  const snap1 = await apiGet(page, `${P}/snapshot`);
  expect(snap1.status).toBe(200);
  const netBefore = snap1.data.data.netWorthCents;
  expect(netBefore).toBeGreaterThanOrEqual(10_000_00);

  // Record income (+) and a business-flagged spend (−).
  const inc = await apiPost(page, `${P}/transactions`, {
    accountId: checkingId, description: 'Salary', amountCents: 5_000_00, category: 'salary',
  });
  expect(inc.status).toBe(201);
  const spend = await apiPost(page, `${P}/transactions`, {
    accountId: checkingId, description: 'Software', amountCents: -200_00, category: 'software', businessFlag: true,
  });
  expect(spend.status).toBe(201);

  // Snapshot now shows income, spending, business-flagged, and a higher net worth.
  const snap2 = await apiGet(page, `${P}/snapshot`);
  expect(snap2.status).toBe(200);
  const m = snap2.data.data.month;
  expect(m.incomeCents).toBeGreaterThanOrEqual(5_000_00);
  expect(m.spendingCents).toBeGreaterThanOrEqual(200_00);
  expect(m.businessFlaggedCents).toBeGreaterThanOrEqual(200_00);
  // net worth moved by +5000 −200 = +4800 vs before
  expect(snap2.data.data.netWorthCents).toBe(netBefore + 5_000_00 - 200_00);
});

test('personal finance: transactions UI records income via the form', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Dedicated account so the form's account picker has a known option.
  const acctName = `E2E UI Checking ${Date.now()}`;
  const acct = await apiPost(page, `${P}/accounts`, { name: acctName, type: 'checking', balanceCents: 1_000_00 });
  expect(acct.status, JSON.stringify(acct.data)).toBe(201);

  const snapBefore = await apiGet(page, `${P}/snapshot`);
  const incomeBefore = snapBefore.data.data.month.incomeCents;
  const spendingBefore = snapBefore.data.data.month.spendingCents;

  await page.goto('/personal');
  await page.waitForSelector('text=Personal finance');

  // Open the "Record transaction" form and submit an income entry via the UI.
  await page.click('button:has-text("Record transaction")');
  await page.selectOption('select[name="accountId"]', { label: acctName });
  const description = `E2E UI Income ${Date.now()}`;
  await page.fill('input[name="description"]', description);
  await page.click('button:has-text("Income")');
  await page.fill('input[name="amount"]', '250');
  await page.fill('input[name="category"]', 'freelance');
  await page.click('button:has-text("Save transaction")');

  // The new row appears in the transaction list.
  await expect(page.locator(`text=${description}`)).toBeVisible({ timeout: 10_000 });

  // The snapshot's month.incomeCents reflects the new income; spending is unchanged.
  const snapAfter = await apiGet(page, `${P}/snapshot`);
  expect(snapAfter.data.data.month.incomeCents).toBeGreaterThanOrEqual(incomeBefore + 250_00);
  expect(snapAfter.data.data.month.spendingCents).toBe(spendingBefore);
});

test('personal finance: budgets UI sets a budget and shows spent/remaining', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Dedicated account + a category-tagged spend to budget against.
  const acctName = `E2E Budget Checking ${Date.now()}`;
  const acct = await apiPost(page, `${P}/accounts`, { name: acctName, type: 'checking', balanceCents: 500_00 });
  expect(acct.status, JSON.stringify(acct.data)).toBe(201);
  const category = `e2e-budget-${Date.now()}`;
  const spend = await apiPost(page, `${P}/transactions`, {
    accountId: acct.data.data.id, description: 'Budget test spend', amountCents: -75_00, category,
  });
  expect(spend.status).toBe(201);

  await page.goto('/personal');
  await page.waitForSelector('text=Personal finance');

  // Set a monthly budget for that category via the UI form.
  await page.click('button:has-text("Set budget")');
  await page.fill('input[name="budgetCategory"]', category);
  await page.fill('input[name="monthlyLimit"]', '200');
  await page.click('button:has-text("Save")');

  // The budget appears in the list.
  await expect(page.locator('p.capitalize', { hasText: category })).toBeVisible({ timeout: 10_000 });

  // Spent/remaining reflect the earlier transaction: $75 spent of a $200 limit, $125 left.
  const budgetsRes = await apiGet(page, `${P}/budget`);
  const created = budgetsRes.data.data.find((b) => b.category === category);
  expect(created).toBeTruthy();
  expect(created.monthlyLimitCents).toBe(200_00);
  expect(created.spentCents).toBe(75_00);
  expect(created.remainingCents).toBe(125_00);
});

test('personal finance: chat records a transaction via record-personal-transaction, personal-snapshot query unaffected', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Dedicated account so the skill's account-resolution pre-processing (see
  // server.ts's `if (selectedSkill.name === 'record-personal-transaction')`
  // block) auto-resolves without a disambiguation question. The name is
  // also woven into the chat phrase below (fuzzy-match fodder for
  // resolveOrdinalOrFuzzyCandidate) so the write still lands on *this*
  // account even if Maya's tenant has accumulated other personal accounts
  // from earlier runs of this same e2e suite against the live deployment.
  const acctSuffix = Date.now().toString(36);
  const acctName = `E2E ChatSkill ${acctSuffix}`;
  const acct = await apiPost(page, `${P}/accounts`, { name: acctName, type: 'checking', balanceCents: 0 });
  expect(acct.status, JSON.stringify(acct.data)).toBe(201);
  const acctId = acct.data.data.id;

  // Verified against built-in-skills.ts's actual triggerPatterns/
  // excludePatterns by tracing selectSkillByPatterns (skill-routing.ts) by
  // hand: "i got paid" + "salary" trigger record-personal-transaction and
  // hit none of its excludePatterns (no business phrase, no "net worth" /
  // "what's my" / etc.); the same "salary" cue trips record-expense's own
  // personal-account-cue exclude clause, so record-expense is rejected too
  // — the two skills stay mutually exclusive regardless of DB row order.
  // server.ts's INCOME_RE ('got paid'|'salary'|...) then infers a positive
  // sign for the amount.
  const phrase = `I got paid $250 salary, put it in my ${acctName} account`;
  const chat = await apiPost(page, '/api/v1/agentbook-core/agent/message', { text: phrase });
  expect(chat.status, JSON.stringify(chat.data)).toBe(200);
  expect(chat.data?.data?.skillUsed).toBe('record-personal-transaction');

  // Don't trust the chat reply — re-fetch the authoritative transactions
  // endpoint (scoped to the dedicated account) and confirm the write
  // actually persisted, with the correct (positive/income) sign and roughly
  // the right amount.
  const txns = await apiGet(page, `${P}/transactions?accountId=${acctId}`);
  expect(txns.status).toBe(200);
  expect(txns.data.data.length).toBeGreaterThanOrEqual(1);
  const createdTxn = txns.data.data[0];
  expect(createdTxn.amountCents).toBeGreaterThan(0);
  expect(createdTxn.amountCents).toBeGreaterThanOrEqual(200_00);
  expect(createdTxn.amountCents).toBeLessThanOrEqual(300_00);

  // Regression: the pre-existing personal-snapshot skill (a read-only query)
  // still routes correctly and isn't shadowed by record-personal-
  // transaction's new triggerPatterns — the main routing-collision risk this
  // skill introduced per the design doc.
  const snapshotChat = await apiPost(page, '/api/v1/agentbook-core/agent/message', { text: "what's my net worth?" });
  expect(snapshotChat.status, JSON.stringify(snapshotChat.data)).toBe(200);
  expect(snapshotChat.data?.data?.skillUsed).toBe('personal-snapshot');
});

// ─── PR-2 — Net worth trend chart, gated behind the Personal Insights add-on ───

test.describe('personal finance: net worth trend UI (Personal Insights add-on)', () => {
  const MAYA_TENANT = 'maya-consultant';
  let prisma: typeof import('@naap/database').prisma;

  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;

    // Grant Maya's tenant the `personal_insights` add-on directly via the DB
    // — there is no payment-collection UI anywhere in this app yet (the
    // subscribe route requires a real Stripe paymentMethodId), so this
    // mirrors the established test-only grant pattern in
    // bin/seed-student-chat-test-account.ts (findOrCreate the BillAddOn +
    // BillAddOnPrice, then upsert an 'active' BillAddOnSubscription).
    // hasAddOn() also requires the add-on itself to be isActive (separate
    // from the subscription's own status), which bin/seed-personal-insights-
    // addon.ts seeds as isActive:false by default — flip it here too.
    const addOn = await prisma.billAddOn.upsert({
      where: { code: 'personal_insights' },
      update: { isActive: true },
      create: { code: 'personal_insights', name: 'Personal Insights', interval: 'year', isActive: true },
    });
    const price = await prisma.billAddOnPrice.upsert({
      where: { addOnId_region_tier: { addOnId: addOn.id, region: 'us', tier: 'standard' } },
      update: { isActive: true },
      create: {
        addOnId: addOn.id, region: 'us', currency: 'usd', tier: 'standard', priceCents: 4900, isActive: true,
      },
    });
    await prisma.billAddOnSubscription.upsert({
      where: { accountId_addOnId: { accountId: MAYA_TENANT, addOnId: addOn.id } },
      create: { accountId: MAYA_TENANT, addOnId: addOn.id, priceId: price.id, status: 'active' },
      update: { status: 'active', priceId: price.id, canceledAt: null },
    });
  });

  test.afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('subscribed tenant (Maya) sees the real 12-point chart with actual data', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
    await page.waitForTimeout(2_000);

    const trendApi = await apiGet(page, `${P}/trend`);
    expect(trendApi.status, JSON.stringify(trendApi.data)).toBe(200);
    expect(trendApi.data.data.length).toBe(12);

    // The trend's most recent point ("this month") reconstructs to each
    // account's live balance with zero future-dated transactions to
    // subtract (see lib/personal-trend.ts) — it should equal the current
    // snapshot's net worth exactly, giving us a concrete value to assert
    // rather than just "a chart element exists".
    const snap = await apiGet(page, `${P}/snapshot`);
    expect(snap.status).toBe(200);
    const lastPoint = trendApi.data.data[11];
    expect(lastPoint.netWorthCents).toBe(snap.data.data.netWorthCents);

    await page.goto('/personal');
    await page.waitForSelector('text=Personal finance');

    const chart = page.locator('svg[aria-label="Net worth trend, last 12 months"]');
    await expect(chart).toBeVisible({ timeout: 10_000 });

    // 12 real data points rendered — not a placeholder or partial series.
    expect(await chart.locator('circle').count()).toBe(12);

    // The current month's exact net-worth value (from the API contract
    // above) is actually rendered as this specific data point in the DOM,
    // not just "some chart".
    const lastCircle = chart.locator(`circle[data-month="${lastPoint.month}"]`);
    await expect(lastCircle).toHaveAttribute('data-net-worth-cents', String(lastPoint.netWorthCents));

    // No teaser/upsell copy for a subscribed tenant.
    await expect(page.locator('text=Enable Personal Insights')).toHaveCount(0);
  });

  // ─── Task 6 — budget-threshold nudge round-trip through the real cron ───

  test('budget-threshold nudge fires via the nudge-check cron (?hour=now) and does not duplicate on immediate re-check', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
    await page.waitForTimeout(2_000);

    // Dedicated account + a fresh, unique budget category so this test's
    // dedup assertions can't collide with budgets/transactions left behind
    // by other e2e runs against this same shared Maya tenant.
    const acctName = `E2E Nudge Checking ${Date.now()}`;
    const acct = await apiPost(page, `${P}/accounts`, { name: acctName, type: 'checking', balanceCents: 1_000_00 });
    expect(acct.status, JSON.stringify(acct.data)).toBe(201);
    const acctId = acct.data.data.id;

    const category = `e2e-nudge-${Date.now()}`;
    const budgetRes = await apiPost(page, `${P}/budget`, { category, monthlyLimitCents: 200_00 });
    expect(budgetRes.status, JSON.stringify(budgetRes.data)).toBe(201);

    // $200 monthly limit; a $160 spend is exactly 80%
    // (lib/agentbook-personal-nudges.ts's checkBudgetThresholds: percent =
    // round(spent/limit*100); fires budget_alert_80 at >= 80,
    // budget_alert_100 at >= 100). 160/200 crosses only the 80% threshold,
    // not 100%, isolating a single nudge type for this test.
    const spend = await apiPost(page, `${P}/transactions`, {
      accountId: acctId, description: 'E2E nudge trigger spend', amountCents: -160_00, category,
    });
    expect(spend.status, JSON.stringify(spend.data)).toBe(201);

    // periodKey matches agentbook-personal-nudges.ts's periodKeyFor(now): "YYYY-MM".
    const now = new Date();
    const periodKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Invoke the nudge-check cron directly with ?hour=now — bypasses the
    // local-hour gate (Task 3b's route) so this test doesn't depend on what
    // hour it happens to run. No Authorization/CRON_SECRET header: this
    // deployed environment's cron routes are callable unauthenticated in
    // e2e today (same pattern as tests/e2e/daily-backup.spec.ts's direct,
    // header-less cron GETs).
    const cronPath = '/api/v1/agentbook/cron/personal-finance-nudge-check?hour=now';
    const firstRun = await apiGet(page, cronPath);
    expect(firstRun.status, JSON.stringify(firstRun.data)).toBe(200);
    // Route's response shape (Task 3b): { ok, checked, skipped, nudgesFired, errors, timestamp }.
    expect(typeof firstRun.data.nudgesFired).toBe('number');
    expect(firstRun.data.nudgesFired).toBeGreaterThanOrEqual(1);

    // nudgesFired is a global count across every personal_insights
    // subscriber (Task 3b's route doesn't break it out per-tenant), so on a
    // shared live environment it isn't a safe oracle for THIS tenant's
    // specific dedup — go straight to the authoritative source: the
    // AbPersonalNudgeLog row Task 3a's checkPersonalFinanceNudges() writes
    // on fire, scoped to our own tenant/category/period.
    const budgetAlert80Rows = await prisma.abPersonalNudgeLog.findMany({
      where: { tenantId: MAYA_TENANT, nudgeType: 'budget_alert_80', periodKey, category },
    });
    expect(budgetAlert80Rows.length).toBe(1);

    // Only crossed 80%, never 100% — the 100% nudge must not have fired.
    const budgetAlert100Rows = await prisma.abPersonalNudgeLog.findMany({
      where: { tenantId: MAYA_TENANT, nudgeType: 'budget_alert_100', periodKey, category },
    });
    expect(budgetAlert100Rows.length).toBe(0);

    // Re-invoke immediately — the same nudge must not fire (and log) again.
    const secondRun = await apiGet(page, cronPath);
    expect(secondRun.status, JSON.stringify(secondRun.data)).toBe(200);
    expect(typeof secondRun.data.nudgesFired).toBe('number');

    const budgetAlert80RowsAfterSecondRun = await prisma.abPersonalNudgeLog.findMany({
      where: { tenantId: MAYA_TENANT, nudgeType: 'budget_alert_80', periodKey, category },
    });
    // Still exactly one row — the second call did not duplicate the nudge.
    expect(budgetAlert80RowsAfterSecondRun.length).toBe(1);
  });

  // ─── Task 6 — personal-snapshot trend-query + current-state regression ───
  //
  // MCP-channel note (per the plan's Task 6 instructions): the `channel`
  // parameter that distinguishes 'mcp' from 'api'/'web' only exists as the
  // 4th argument to `executeClassification()` inside
  // plugins/agentbook-core/backend/src/server.ts — it is never read from an
  // HTTP request body. Confirmed by reading both real HTTP entry points:
  //   - apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts's
  //     `AgentMessageBody` interface has no `channel` field, and the route
  //     hardcodes `channel: 'web'` when calling `handleAgentMessage()`
  //     regardless of what's in the posted JSON body.
  //   - apps/web-next/src/lib/mcp/ask-agentbook-tool.ts's `callAgentBrain()`
  //     does POST `channel: 'mcp'` in its body, but its target
  //     (`AGENTBOOK_CORE_URL`, falling back to the plugin backend) resolves
  //     in this deployed environment to that same Next.js route, which
  //     drops the field the same way.
  // So there is no real HTTP call this e2e suite can make where `channel:
  // 'mcp'` vs any other value produces an observably different response —
  // the distinction is only exercised at the unit level, which
  // plugins/agentbook-core/backend/src/__tests__/personal-snapshot-trend-
  // skill.test.ts already covers directly (calling `executeClassification`
  // with `'mcp'` as the 4th argument). Not forcing an e2e-level MCP test
  // here since the field genuinely isn't wired through this app's real
  // endpoints.
  test('personal finance: chat trend query routes to personal-snapshot with real data (subscribed), current-state query still works (regression)', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
    await page.waitForTimeout(2_000);

    // Trend-shaped phrase: anchor "net worth" + comparison cue "changed" /
    // "over time", matching skill-routing.ts's PERSONAL_TREND_TRIGGER_PATTERNS
    // (anchor "net worth", cue "\bchange(?:d)?\b" and "over time" both
    // present) — verified directly against the actual
    // personal-snapshot-trend-skill.test.ts unit test, which asserts this
    // exact class of phrase ("how has my net worth trended over time")
    // routes to personal-snapshot and is NOT shadowed by query-finance
    // (business revenue trends) or query-past-filings (year-anchored tax
    // phrasing).
    const trendChat = await apiPost(page, '/api/v1/agentbook-core/agent/message', {
      text: 'how has my net worth changed over time',
    });
    expect(trendChat.status, JSON.stringify(trendChat.data)).toBe(200);
    expect(trendChat.data?.data?.skillUsed).toBe('personal-snapshot');
    // Maya is subscribed (this describe's beforeAll) — a real trend answer,
    // never the upsell copy server.ts returns for non-subscribers.
    expect(trendChat.data?.data?.message).not.toMatch(/Personal Insights/);
    expect(trendChat.data?.data?.message).toMatch(/last month/i);
    expect(trendChat.data?.data?.message).toMatch(/this month/i);

    // Regression (Task 4's main routing-collision risk): a bare
    // current-state question — no temporal/comparison cue — must still
    // route to personal-snapshot and answer for free, exactly as it did
    // before this PR, regardless of the tenant's subscription status.
    const snapshotChat = await apiPost(page, '/api/v1/agentbook-core/agent/message', {
      text: "what's my net worth?",
    });
    expect(snapshotChat.status, JSON.stringify(snapshotChat.data)).toBe(200);
    expect(snapshotChat.data?.data?.skillUsed).toBe('personal-snapshot');
    expect(snapshotChat.data?.data?.message).toMatch(/Net worth/i);
    expect(snapshotChat.data?.data?.message).not.toMatch(/Personal Insights/);
  });
});

test('personal finance: non-subscribed tenant sees the Personal Insights teaser, not the chart', async ({ page }) => {
  await page.goto('/login');
  await page.fill('input[type="email"]', 'jordan@agentbook.test');
  await page.fill('input[type="password"]', 'agentbook123');
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const trendApi = await apiGet(page, `${P}/trend`);
  expect(trendApi.status, JSON.stringify(trendApi.data)).toBe(402);

  await page.goto('/personal');
  await page.waitForSelector('text=Personal finance');

  // Visible-but-locked teaser card, not simply hidden.
  await expect(page.locator('text=Personal Insights')).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('button:has-text("Enable Personal Insights")')).toBeVisible();

  // No real trend chart/data anywhere in the DOM for a non-subscriber.
  await expect(page.locator('svg[aria-label="Net worth trend, last 12 months"]')).toHaveCount(0);
});
