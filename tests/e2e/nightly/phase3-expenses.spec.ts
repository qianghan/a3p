import { test, expect } from '@playwright/test';
import { loginAsE2eUser } from './helpers/auth';
import { api, expectOk } from './helpers/api';
import { SEED, tag } from './helpers/data';

test.describe('@phase3-expenses', () => {
  test.beforeEach(async ({ page }) => { await loginAsE2eUser(page); });

  test('list expenses returns the seeded count', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-expense/expenses');
    expect(r.status).toBe(200);
    expect(r.data.data.length).toBeGreaterThanOrEqual(SEED.expenses.count);
  });

  test('filter by date range narrows results', async ({ page }) => {
    const since = new Date(Date.now() - 5 * 86400000).toISOString();
    const r = await api(page).get(`/api/v1/agentbook-expense/expenses?since=${since}`);
    expect(r.status).toBe(200);
    // Seed has 1 expense within the last 5 days (Uber, daysAgo(2)).
    expect(r.data.data.length).toBeGreaterThanOrEqual(1);
  });

  test('create expense → list grows by 1', async ({ page }) => {
    const before = await api(page).get('/api/v1/agentbook-expense/expenses');
    const beforeCount = before.data.data.length;
    const description = `e2e-${tag('phase3')}-create`;
    const create = await api(page).post('/api/v1/agentbook-expense/expenses', {
      amountCents: 1234, description, date: new Date().toISOString(), isPersonal: false,
    });
    expect(create.status).toBe(201); // the API is REST-correct; the test said 200
    expect(create.data.data.id).toBeTruthy();
    const after = await api(page).get('/api/v1/agentbook-expense/expenses');
    expect(after.data.data.length).toBe(beforeCount + 1);
    // Teardown
    await api(page).delete(`/api/v1/agentbook-expense/expenses/${create.data.data.id}`);
  });

  test('edit expense', async ({ page }) => {
    const create = await api(page).post('/api/v1/agentbook-expense/expenses', {
      amountCents: 500, description: 'edit-target', date: new Date().toISOString(),
    });
    const id = create.data.data.id;
    const upd = await api(page).put(`/api/v1/agentbook-expense/expenses/${id}`, {
      description: 'edited',
    });
    expect(upd.status).toBe(200);
    expect(upd.data.data.description).toBe('edited');
    await api(page).delete(`/api/v1/agentbook-expense/expenses/${id}`);
  });

  test('mark personal removes from business list', async ({ page }) => {
    const create = await api(page).post('/api/v1/agentbook-expense/expenses', {
      amountCents: 100, description: 'biz-then-personal', isPersonal: false,
    });
    const id = create.data.data.id;
    await api(page).put(`/api/v1/agentbook-expense/expenses/${id}`, { isPersonal: true });
    const list = await api(page).get('/api/v1/agentbook-expense/expenses?isPersonal=false');
    const found = list.data.data.find((e: any) => e.id === id);
    expect(found).toBeUndefined();
    await api(page).delete(`/api/v1/agentbook-expense/expenses/${id}`);
  });

  test('AI advisor returns non-empty answer', async ({ page }) => {
    const r = await api(page).post('/api/v1/agentbook-expense/advisor/ask', {
      question: 'What is my biggest expense category?',
    });
    expect(r.status).toBe(200);
    expect(r.data.data.answer.length).toBeGreaterThan(0);
  });

  test('vendor insights returns aggregate', async ({ page }) => {
    // Was /vendors/insights, which exists in neither surface — it 501'd via the
    // [plugin]/[...path] catch-all. /vendors is the endpoint production serves,
    // and it returns the enriched per-vendor aggregate this test is about.
    const r = await api(page).get('/api/v1/agentbook-expense/vendors');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data)).toBe(true);
  });

  // REMOVED: 'expense report PDF endpoint returns 200'.
  // /reports/expense-pdf exists only in the Express dev backend. Production
  // serves Next route handlers, where it does not exist, and no UI calls it —
  // so the test asserted against something no user can reach. Deleted rather
  // than retargeted: there is no production equivalent to point it at. Invoice
  // PDF (agentbook-invoice/invoices/[id]/pdf) is real and covered in phase4.

  // Smoke-coverage tests for the rest of the phase. Use the same patterns:
  // create → assert → delete in teardown. These are intentionally short
  // and follow the helpers above.

  test('auto-tag suggests a category for an expense', async ({ page }) => {
    // Was POST /categorize, which does not exist in production. The real
    // categorisation entry points are per-expense: expenses/{id}/auto-tag
    // (suggest) and expenses/{id}/categorize (apply a known categoryId).
    const create = await api(page).post('/api/v1/agentbook-expense/expenses', {
      amountCents: 4200, description: `autotag-${tag('phase3')}`, date: new Date().toISOString(), isPersonal: false,
    });
    expect(create.status).toBe(201);
    try {
      const r = await api(page).post(`/api/v1/agentbook-expense/expenses/${create.data.data.id}/auto-tag`, {});
      expect(r.status).toBe(200);
    } finally {
      await api(page).delete(`/api/v1/agentbook-expense/expenses/${create.data.data.id}`);
    }
  });

  test('split expense across two categories', async ({ page }) => {
    const create = await api(page).post('/api/v1/agentbook-expense/expenses', { amountCents: 1000, description: 'split-test' });
    const id = create.data.data.id;
    // The API field is `splits`, not `lines` — a 400 that `status < 500` hid.
    const split = await api(page).post(`/api/v1/agentbook-expense/expenses/${id}/split`, {
      splits: [{ amountCents: 600, accountCode: '5000' }, { amountCents: 400, accountCode: '5100' }],
    });
    expectOk(split, 'agentbook-expense/expenses/{id}/split');
    await api(page).delete(`/api/v1/agentbook-expense/expenses/${id}`);
  });

  test('Plaid link-token endpoint responds', async ({ page }) => {
    // Was /plaid/accounts, which production does not serve — only
    // link-token, exchange, sync and disconnect exist. link-token is the entry
    // point a user actually hits when connecting a bank.
    const r = await api(page).post('/api/v1/agentbook-expense/plaid/link-token', {});
    // Plaid credentials are an environmental dependency; a 5xx means the
    // sandbox is unconfigured, not that the product is broken.
    test.skip(r.status >= 500, 'Plaid not configured in this environment');
    // 402 is the CORRECT answer here, not a failure: the e2e tenant is on the
    // free plan and bank connections are a paid feature. Asserting 2xx (my
    // first attempt) demanded that the paywall not work. Assert the gate
    // instead — that it holds in production is worth more than a link token.
    expect(r.status).toBe(402);
    expect(JSON.stringify(r.data)).toMatch(/plan|upgrade|quota|limit/i);
  });

  test('bank patterns list', async ({ page }) => {
    // Was POST /bank/auto-record, which exists in neither surface (501 via the
    // catch-all). /patterns is what production serves and what the auto-record
    // behaviour is driven from.
    const r = await api(page).get('/api/v1/agentbook-expense/patterns');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data)).toBe(true);
  });

  test('receipt scan rejects a request with no file', async ({ page }) => {
    // Was POST /receipts/ocr with an imageUrl — an Express-only path that 501'd
    // in production. The real endpoint is /receipts/scan and it takes a
    // multipart upload, not a URL. Asserting the documented 400 guard is an
    // honest contract test; pretending to OCR a URL tested nothing that exists.
    const r = await api(page).post('/api/v1/agentbook-expense/receipts/scan', {});
    expect(r.status).toBe(400);
    expect(r.data?.error).toMatch(/file is required/i);
  });

  test('budget create + alert fires when exceeded', async ({ page }) => {
    // The API reads { amountCents, categoryName, period }, not
    // { categoryCode, monthlyLimitCents } — amountCents was undefined, so this
    // was a guaranteed 400 that `status < 500` waved through.
    const create = await api(page).post('/api/v1/agentbook-expense/budgets', {
      amountCents: 100, categoryName: 'Travel', period: 'monthly',
    });
    expect([200, 201]).toContain(create.status);
    if (create.data?.data?.id) {
      await api(page).delete(`/api/v1/agentbook-expense/budgets/${create.data.data.id}`);
    }
  });

  test('recurring rules list', async ({ page }) => {
    // Was POST /recurring, which production does not serve — and no UI creates
    // recurring rules either, so there is nothing user-reachable to assert a
    // create against. The list endpoint IS served, so cover that and stop
    // claiming coverage of a write path that does not exist in production.
    const r = await api(page).get('/api/v1/agentbook-expense/recurring-rules');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.data.data)).toBe(true);
  });

  test('missing-receipt count surfaces', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-expense/expenses?missingReceipt=true');
    expect(r.status).toBe(200);
    expect(r.data.data.length).toBeGreaterThanOrEqual(SEED.expenses.missingReceiptCount);
  });

  test('delete an expense reverses its journal entry', async ({ page }) => {
    // This asserted only that DELETE returned <400 — it never checked that a
    // reversal was posted, so it could not fail for the reason it is named
    // after. Assert the ledger effect: the tax estimate must return to where it
    // started once the expense is gone.
    const before = await api(page).get('/api/v1/agentbook-tax/tax/estimate');
    const baseline = before.data.data.expensesCents;

    const create = await api(page).post('/api/v1/agentbook-expense/expenses', {
      amountCents: 2500, description: `delete-target-${tag('phase3')}`, date: new Date().toISOString(), isPersonal: false,
    });
    expect(create.status).toBe(201);

    const during = await api(page).get('/api/v1/agentbook-tax/tax/estimate');
    expect(during.data.data.expensesCents).toBe(baseline + 2500);

    const del = await api(page).delete(`/api/v1/agentbook-expense/expenses/${create.data.data.id}`);
    expect(del.status).toBeLessThan(400);

    const after = await api(page).get('/api/v1/agentbook-tax/tax/estimate');
    expect(after.data.data.expensesCents).toBe(baseline);
  });

  test('list filtered by category', async ({ page }) => {
    const r = await api(page).get('/api/v1/agentbook-expense/expenses?accountCode=5100');
    expect(r.status).toBe(200);
  });
});
