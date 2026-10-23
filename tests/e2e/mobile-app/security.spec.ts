import { test, expect } from './fixtures';
import type { BrowserContext, Page } from '@playwright/test';
import { loginAs, loginUnavailableReason, newPersonaContext, settle } from './helpers';
import { inPageFetch } from './page-api';
import {
  PERSONA_CURRENCY,
  createExpense,
  deleteExpenseQuietly,
  diffTotals,
  getExpense,
  randomWholeDollars,
  runTag,
  todayIso,
  totalsSnapshot,
  type Totals,
} from './fixtures';

/**
 * Spec 7 / 8.3 security, against the real deployment, with two personas.
 *
 * Alex owns ONE throwaway expense that this spec creates (tagged with a run tag, dated today). Maya then attacks
 * that id through every route the mobile app added or extended. Every probe is a "must NOT happen": a correct
 * server refuses it, so it is a no-op. The spec asserts the REFUSAL (404), never a success.
 *
 * Safety rules this file keeps:
 *  - It never issues a destructive request (PATCH / PUT / DELETE / archive) against an id it did not create. The
 *    only id it ever attacks is the probe row it just made for Alex.
 *  - The probe row is deleted in `finally` and swept again by tag in afterAll; both tenants' headline totals are
 *    snapshotted before and after, and must be identical (the capture.spec invariant).
 *  - A cross-tenant READ that returns data is a P0 finding, not an ordinary assertion failure: the test says so.
 */
test.describe.configure({ mode: 'serial' });
test.use({ serviceWorkers: 'block' });

const EXPENSE = '/api/v1/agentbook-expense';
const CORE = '/api/v1/agentbook-core';

type Probe = { status: number; data: unknown };

/** Refused means 404 (the contract: another tenant's id does not exist). A 200 that carries the row is a leak. */
function expectRefused(r: Probe, what: string, secret: string) {
  const body = JSON.stringify(r.data ?? null);
  if (r.status >= 200 && r.status < 300) {
    throw new Error(
      `P0 CROSS-TENANT ACCESS: ${what} returned ${r.status} to another tenant` +
        (body.includes(secret) ? ' AND the response contains the owner\'s data' : '') +
        '. Stop, revert the offending change (spec 8.5), and fix the route with a test whose DB mock applies the where clause.',
    );
  }
  expect(r.status, `${what} as another tenant (404 expected; 403 still means fix the route)`).toBe(404);
  expect(body, `${what} leaked the owner's data in its refusal`).not.toContain(secret);
}

test.describe('cross-tenant isolation (Alex owns, Maya attacks)', () => {
  const tag = runTag('E2ESECAL');
  const created: string[] = [];
  let alexCtx: BrowserContext;
  let mayaCtx: BrowserContext;
  let alex: Page;
  let maya: Page;
  let alexBaseline: Totals;
  let mayaBaseline: Totals;

  test.beforeAll(async ({ browser }, testInfo) => {
    test.setTimeout(240_000);
    const baseURL = testInfo.project.use.baseURL;
    const reason = loginUnavailableReason(baseURL);
    test.skip(reason !== null, reason ?? '');
    alexCtx = await newPersonaContext(browser, baseURL);
    mayaCtx = await newPersonaContext(browser, baseURL);
    alex = await alexCtx.newPage();
    maya = await mayaCtx.newPage();
    for (const [p, who] of [[alex, 'alex'], [maya, 'maya']] as const) {
      await loginAs(p, who);
      await p.goto('/app');
      await settle(p);
    }
    alexBaseline = await totalsSnapshot(alex);
    mayaBaseline = await totalsSnapshot(maya);
  });

  test.afterAll(async () => {
    if (!alex) return;
    try {
      // Sweep by tag (only ever THIS run's rows), in case the main test died before its finally.
      const list = await inPageFetch<{ data: Array<{ id: string }> }>(alex, 'GET', `${EXPENSE}/expenses?q=${encodeURIComponent(tag)}&limit=100`);
      for (const r of list.data?.data ?? []) if (!created.includes(r.id)) created.push(r.id);
      for (const id of created) await deleteExpenseQuietly(alex, id);
    } catch {
      /* nothing to sweep */
    }
    await alexCtx?.close();
    await mayaCtx?.close();
  });

  test('another tenant\'s expense id returns 404 on every route and nothing changes', async () => {
    test.setTimeout(180_000);
    const dollars = randomWholeDollars();
    const vendor = `${tag} Probe`;
    const id = await createExpense(alex, {
      amountCents: dollars * 100, vendor, description: `${tag} security probe, safe to delete`,
      date: todayIso(), currency: PERSONA_CURRENCY.alex, isPersonal: false,
    });
    created.push(id);
    try {
      // Reads first, then writes; every one of them targets the probe row Alex just created.
      const probes: Array<[string, string, unknown?]> = [
        ['GET', `${EXPENSE}/expenses/${id}`],
        ['PATCH', `${EXPENSE}/expenses/${id}`, { vendor: 'pwned', amountCents: 99900, date: '2020-01-01' }],
        ['PUT', `${EXPENSE}/expenses/${id}`, { amountCents: 99900 }],
        ['POST', `${EXPENSE}/expenses/${id}/archive`],
        ['POST', `${EXPENSE}/expenses/${id}/unarchive`],
        ['DELETE', `${EXPENSE}/expenses/${id}`],
      ];
      for (const [method, path, body] of probes) {
        expectRefused(await inPageFetch(maya, method, path, body), `${method} ${path}`, vendor);
      }

      // The review route answers 200 with a per-item verdict; the verdict must be a refusal.
      const review = await inPageFetch<{ data?: { results?: Array<{ expenseId: string; ok: boolean; error?: string }> } }>(
        maya, 'POST', `${CORE}/auto-categorize/review`, { items: [{ expenseId: id, action: 'accept' }] },
      );
      if (review.status === 200) {
        const results = review.data?.data?.results ?? [];
        expect(results, 'review verdict for another tenant\'s id').toEqual([expect.objectContaining({ expenseId: id, ok: false, error: 'not_found' })]);
      } else {
        expectRefused(review, 'POST auto-categorize/review', vendor);
      }

      // It must not show up in Maya's list or search either.
      const listed = await inPageFetch<{ data: Array<{ id: string }> }>(maya, 'GET', `${EXPENSE}/expenses?limit=100&q=${encodeURIComponent(tag)}`);
      expect(listed.status).toBe(200);
      expect((listed.data?.data ?? []).map((d) => d.id), 'Maya\'s search saw Alex\'s row').not.toContain(id);

      // Alex's row is exactly as created: not edited, not archived, not deleted.
      const after = await getExpense(alex, id);
      expect(after.status, 'the owner can still read the probe row').toBe(200);
      const row = after.data.data as { amountCents: number; vendorName?: string; vendor?: { name?: string }; archivedAt?: string | null; deletedAt?: string | null };
      expect(row.amountCents).toBe(dollars * 100);
      expect(row.archivedAt ?? null).toBeNull();
      expect(row.deletedAt ?? null).toBeNull();
      expect(JSON.stringify(row)).not.toContain('pwned');

      // Chat threads: Alex's thread ids (read-only) are 404 for Maya.
      const threads = await inPageFetch<{ data: Array<{ id: string }> }>(alex, 'GET', `${CORE}/threads`);
      const ids = (threads.data?.data ?? []).map((th) => th.id).slice(0, 3);
      test.info().annotations.push({ type: 'threads-probed', description: String(ids.length) });
      for (const threadId of ids) {
        expectRefused(await inPageFetch(maya, 'GET', `${CORE}/threads/${threadId}/turns`), `GET threads/${threadId}/turns`, threadId);
      }
    } finally {
      await deleteExpenseQuietly(alex, id);
    }

    expect((await getExpense(alex, id)).status, 'the probe row is gone').toBe(404);
    expect(diffTotals(alexBaseline, await totalsSnapshot(alex)), 'Alex\'s totals moved').toEqual([]);
    expect(diffTotals(mayaBaseline, await totalsSnapshot(maya)), 'Maya\'s totals moved').toEqual([]);
  });

  test('from-receipt rejects a wrong type and an oversize file, creating nothing and leaking nothing', async () => {
    test.setTimeout(120_000);
    const idsOf = async () =>
      ((await inPageFetch<{ data: Array<{ id: string }> }>(maya, 'GET', `${EXPENSE}/expenses?limit=20`)).data?.data ?? []).map((d) => d.id);
    const before = await idsOf();
    const post = (kind: 'text' | 'huge') =>
      maya.evaluate(async (k) => {
        const fd = new FormData();
        const blob = k === 'text'
          ? new Blob(['hello'], { type: 'text/plain' })
          : new Blob([new Uint8Array(15 * 1024 * 1024)], { type: 'image/jpeg' });
        fd.append('file', blob, k === 'text' ? 'note.txt' : 'huge.jpg');
        fd.append('idempotencyKey', crypto.randomUUID());
        const r = await fetch('/api/v1/agentbook-expense/expenses/from-receipt', { method: 'POST', body: fd, credentials: 'include' });
        return { status: r.status, body: await r.text() };
      }, kind);
    const wrong = await post('text');
    const huge = await post('huge');
    // Remove anything a broken guard let through BEFORE asserting, so a failure cannot leave rows in Maya's books.
    // Only ids that did not exist before THIS test's requests are touched, i.e. rows these two requests created.
    const leftovers = (await idsOf()).filter((i) => !before.includes(i));
    for (const i of leftovers) await deleteExpenseQuietly(maya, i);
    expect(leftovers, 'a rejected upload still created an expense').toEqual([]);
    expect([400, 415], 'wrong type').toContain(wrong.status);
    expect([400, 413], 'oversize').toContain(huge.status);
    for (const r of [wrong, huge]) expect(r.body).not.toMatch(/\bat \S+ \(|prisma|ECONN|stack/i);
    expect(diffTotals(mayaBaseline, await totalsSnapshot(maya)), 'Maya\'s totals moved').toEqual([]);
  });
});

test('unauthenticated calls return 401', async ({ playwright }) => {
  const baseURL = test.info().project.use.baseURL!;
  // A bare request context: no cookies, no page. Every id below is a placeholder that matches no row.
  const req = await playwright.request.newContext({ baseURL });
  const calls: Array<[string, string]> = [
    ['GET', `${CORE}/mobile/home`],
    ['GET', `${CORE}/calendar/upcoming?days=30`],
    ['GET', `${EXPENSE}/expenses?limit=1`],
    ['GET', `${EXPENSE}/expenses/x`],
    ['PATCH', `${EXPENSE}/expenses/x`],
    ['POST', `${EXPENSE}/expenses/x/archive`],
    ['POST', `${EXPENSE}/expenses/x/unarchive`],
    ['POST', `${CORE}/auto-categorize/review`],
    ['POST', `${EXPENSE}/expenses/from-receipt`],
    ['GET', `${CORE}/threads`],
    ['GET', `${CORE}/threads/x/turns`],
    ['POST', `${CORE}/agent/message`],
  ];
  try {
    for (const [method, path] of calls) {
      const r = await req.fetch(path, { method, maxRedirects: 0, data: method === 'GET' ? undefined : { text: 'x' } });
      expect(r.status(), `${method} ${path} without a session`).toBe(401);
    }
  } finally {
    await req.dispose();
  }
});
