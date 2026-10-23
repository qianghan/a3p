import { test, expect } from './fixtures';
import { MOBILE_VIEWPORT, loginAs, newPersonaContext, settle } from './helpers';
import { PERSONA_KEYS, PERSONAS } from './personas';
import { countByQuery, deleteExpenseQuietly, diffTotals, runTag, totalsSnapshot, type Totals } from './fixtures';
import { inPageFetch } from './page-api';
import * as J from './journeys';

/**
 * Spec 8.1(7) x 8.2: every journey, every persona, on a real deployment, asserting rendered content. No test is skipped
 * per persona: the brand-new account runs the empty-state branch of each journey instead.
 *
 * Strict error collection (fixtures.ts `test`) stays ON. The only console lines cleared are the ones from signing in
 * (the unauthenticated /login load issues 401 probes before the session exists), and the two journeys that provoke a
 * 404 on purpose forgive exactly that probe's "Failed to load resource" line.
 *
 * Mutations: only on fixtures a journey creates, tagged per persona and run, deleted in `finally`, swept again in
 * afterAll, and proven by the last test of each persona (the books are back where they started).
 */
test.use({ viewport: MOBILE_VIEWPORT, serviceWorkers: 'block' });

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';

for (const persona of PERSONA_KEYS) {
  test.describe(`matrix - ${persona}`, () => {
    test.describe.configure({ mode: 'serial' });
    const tag = runTag(`E2EMTX${persona.slice(0, 2).toUpperCase()}`);
    const ctx: J.JourneyCtx = { tag, created: [] };
    const seeded = PERSONAS[persona].seeded;
    let baseline: Totals | null = null;

    test.beforeAll(async ({ browser }) => {
      if (!seeded) return;
      test.setTimeout(120_000);
      const c = await newPersonaContext(browser, BASE);
      try {
        const p = await c.newPage();
        await loginAs(p, persona);
        baseline = await totalsSnapshot(p);
      } finally {
        await c.close();
      }
    });

    test.afterAll(async ({ browser }) => {
      if (!seeded) return; // a throwaway account holds nothing worth sweeping
      const c = await newPersonaContext(browser, BASE);
      try {
        const p = await c.newPage();
        await loginAs(p, persona);
        const list = await inPageFetch<{ data: Array<{ id: string }> }>(p, 'GET', `/api/v1/agentbook-expense/expenses?q=${encodeURIComponent(tag)}&limit=100`);
        for (const r of list.data?.data ?? []) await deleteExpenseQuietly(p, r.id);
        const archived = await inPageFetch<{ data: Array<{ id: string }> }>(p, 'GET', `/api/v1/agentbook-expense/expenses?q=${encodeURIComponent(tag)}&archived=true&limit=100`);
        for (const r of archived.data?.data ?? []) await deleteExpenseQuietly(p, r.id);
        for (const id of ctx.created) await deleteExpenseQuietly(p, id);
      } catch {
        /* nothing to sweep, or the site is unreachable */
      } finally {
        await c.close();
      }
    });

    test.beforeEach(async ({ page, errors }) => {
      await loginAs(page, persona);
      await settle(page);
      errors.console.length = 0; // sign-in noise only (see header); anything after this point is a journey's own
    });

    test('home: banner + 4 KPIs equal the API, jurisdiction-correct', async ({ page }) => J.home(page, persona));
    test('home: every alert action lands on a working mobile screen', async ({ page }) => J.alertActions(page, persona));
    test('docs: every filter truthful; viewer shows the doc', async ({ page }) => J.docs(page, persona));
    test('docs: archive -> Archived -> restore on a fixture; totals unchanged', async ({ page, errors }) => {
      test.setTimeout(150_000);
      await J.archiveRoundTrip(page, persona, { ...ctx, errors });
    });
    test('capture: manual entry -> in Docs, tenant currency (cleaned up)', async ({ page }) => {
      test.setTimeout(150_000);
      await J.capture(page, persona, ctx);
    });
    test('chat: history/empty + a real reply (no Proceed)', async ({ page }) => {
      test.setTimeout(150_000);
      await J.chat(page, persona);
    });
    test('tabs: client-side navigation, no full reload', async ({ page }) => J.tabs(page));
    test('deep links + unknown route', async ({ page, errors }) => J.deepLinks(page, persona, { ...ctx, errors }));
    test('language switch fr-CA -> English (no prod mutation)', async ({ page }) => J.languageSwitch(page));

    test("totals invariant: after every journey the persona's books are exactly where they started", async ({ page }) => {
      test.setTimeout(150_000);
      expect(await countByQuery(page, tag), 'nothing of this run is left in the list').toBe(0);
      if (!seeded) return; // a fresh account has no baseline: the tag sweep above is its invariant
      for (const id of ctx.created) await deleteExpenseQuietly(page, id);
      expect(await countByQuery(page, tag, '&archived=true'), 'nothing archived is left').toBe(0);
      const after = await totalsSnapshot(page);
      expect(diffTotals(baseline as Totals, after), 'fields that did not return to their starting value').toEqual([]);
    });
  });
}

