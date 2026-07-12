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
