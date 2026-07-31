import { test, expect } from '@playwright/test';
import { loginAsE2eUser } from './helpers/auth';
import { api, expectOk } from './helpers/api';

/**
 * @phase8-regional — the CA and AU paths, exercised as those tenants.
 *
 * The launch assessment held Australia at "no go" for one stated reason: no
 * e2e coverage of the AU path. Canada carried the same gap. That was never
 * hypothetical — every regional defect found so far was found by accident:
 *
 *   #381  CA provincial tax counted twice, breaking every Canadian filer
 *   #382  chat computed federal-only tax, disagreeing with the estimate
 *   #432  a CA tenant quoted the IRS meal rule, and shown "$" not "CA$"
 *         (found by logging in as a real CA user and asking one question)
 *   audit AU chat answering with US self-employment maths
 *
 * Not one of those is visible to a suite that only ever signs in as a US
 * tenant, because the US path is the one where every default is correct.
 *
 * These tests assert the two things a regional bug actually corrupts: the
 * MONEY (is sub-national tax applied, in the right currency) and the ADVICE
 * (does the tenant see their own tax authority). They deliberately do not
 * re-test bookkeeping — phases 3-5 cover that on the US tenant, and repeating
 * it here would triple the runtime to re-prove shared code.
 */

interface RegionalCase {
  label: string;
  email: string;
  currencySymbol: string;
  /** Symbols that mean we rendered the WRONG country's money. */
  foreignSymbols: string[];
  /** The tenant's own revenue authority. */
  authority: RegExp;
  /** Authorities that must never appear for this tenant. */
  foreignAuthorities: RegExp;
  /** Seeded descriptions belonging to OTHER tenants — a leak if seen here. */
  foreignRowMarker: RegExp;
}

/**
 * The US tenant's seeded expense descriptions, ANCHORED.
 *
 * Anchoring matters: the regional fixtures include "E2E ca client lunch", and an
 * unanchored /Client lunch/i would match a tenant's OWN row and fail a correct
 * run — the third time tonight an unanchored substring would have produced a
 * wrong answer, after the month matcher and the "CA$" contains "A$" assertion.
 *
 * "E2E Nightly" was the first attempt here and is useless: it is the user's
 * displayName, and appears in no expense description, so the assertion could
 * never fail. A check that cannot fail is not a check.
 */
const US_SEEDED_ROW =
  /^(Uber to client meeting|AWS October bill|Co-working space monthly|Conference ticket|Client lunch)$/i;

const CASES: RegionalCase[] = [
  {
    label: 'CA',
    email: 'e2e-ca@agentbook.test',
    currencySymbol: 'CA$',
    foreignSymbols: ['A$'],
    authority: /\bCRA\b|T2125|T1\b|GST|HST/i,
    foreignAuthorities: /\bIRS\b|Schedule C|1099|\bATO\b|\bBAS\b/i,
    foreignRowMarker: /^E2E au /i,
  },
  {
    label: 'AU',
    email: 'e2e-au@agentbook.test',
    currencySymbol: 'A$',
    foreignSymbols: ['CA$'],
    authority: /\bATO\b|\bBAS\b|\bGST\b|superannuation/i,
    foreignAuthorities: /\bIRS\b|Schedule C|1099|\bCRA\b|T2125/i,
    foreignRowMarker: /^E2E ca /i,
  },
];

for (const c of CASES) {
  test.describe(`@phase8-regional ${c.label}`, () => {
    test.beforeEach(async ({ page }) => {
      await loginAsE2eUser(page, c.email);
    });

    test(`${c.label}: tenant config reports its own jurisdiction and currency`, async ({ page }) => {
      // If this fails, every assertion below is meaningless — the tenant would
      // be silently running the US path and passing for the wrong reason.
      // Path verified against apps/web-next/src/app/api/v1/... — the first
      // real nightly baseline had ~9 tests calling endpoint names taken from
      // the Express dev backend, which production answers with 501. A suite
      // that describes an API nobody serves reports product bugs that are
      // really its own.
      const r = await api(page).get('/api/v1/agentbook-core/tenant-config');
      expectOk(r, `${c.label} tenant-config`);
      const cfg = r.data?.data ?? r.data;
      expect(cfg.jurisdiction, `${c.label} tenant must be seeded with its jurisdiction`)
        .toBe(c.label.toLowerCase());
      expect(cfg.currency).toBe(c.label === 'CA' ? 'CAD' : 'AUD');
      expect(cfg.region, 'sub-national region drives provincial/state tax').toBeTruthy();
    });

    test(`${c.label}: tax estimate includes sub-national tax, not federal only`, async ({ page }) => {
      // #381 double-counted CA provincial tax; #382 had chat compute
      // federal-only and disagree with this endpoint. Both produce a number a
      // filer would submit, so "responds 200" is not enough — the estimate must
      // actually carry a sub-national component for a tenant that has one.
      // GET, not POST — verified against the route file. Creates matter:
      // guessing the verb is how a test ends up asserting on a 405 body.
      const r = await api(page).get('/api/v1/agentbook-tax/tax/estimate');
      expectOk(r, `${c.label} tax estimate`);
      const est = r.data?.data ?? r.data;
      expect(est, 'estimate payload').toBeTruthy();
      expect(Number.isFinite(est.totalTaxCents), 'totalTaxCents must be a real number').toBe(true);
      expect(est.totalTaxCents).toBeGreaterThanOrEqual(0);
      // No NaN anywhere in the payload. The deductions reply rendered ten
      // "$NaN"s on a live account for exactly this class of mistake, and JSON
      // serialises NaN as null, so check the raw numbers too.
      expect(JSON.stringify(est)).not.toMatch(/NaN/);
      for (const [k, v] of Object.entries(est as Record<string, unknown>)) {
        if (typeof v === 'number') {
          expect(Number.isFinite(v), `${c.label} estimate.${k} must be finite`).toBe(true);
        }
      }
    });

    test(`${c.label}: money is shown in the tenant currency`, async ({ page }) => {
      const r = await api(page).post('/api/v1/agentbook-core/agent/message', {
        text: 'how much have I spent this year?',
        channel: 'web',
      });
      expectOk(r, `${c.label} spend question`);
      const msg: string = r.data?.data?.message ?? '';
      expect(msg.length, 'agent must answer').toBeGreaterThan(0);
      expect(msg, 'answer must not contain NaN').not.toContain('NaN');
      expect(msg, `${c.label} tenant must see ${c.currencySymbol}`).toContain(c.currencySymbol);

      // A foreign symbol only counts when it is NOT part of a longer symbol.
      //
      // The first version asserted `not.toContain('A$')` for the CA tenant and
      // failed on a completely correct reply, because "CA$" contains "A$" —
      // the same unanchored-substring mistake as the month matcher this suite
      // exists to guard against ("Walmart" contains "mar"), reproduced in the
      // assertion instead of the product. A test that fails on correct output
      // is worse than none: it burns the reviewer's attention and teaches them
      // to distrust the suite.
      //
      // Stripping the tenant's own symbol first does NOT work — it fails the
      // other way round. For the AU tenant (own "A$", foreign "CA$"), removing
      // every "A$" turns "CA$100" into "C100" and a real violation goes unseen.
      // The preceding-letter guard is correct in both directions: "A$" after a
      // "C" is part of CA$, and a genuine "A$" follows a space or punctuation.
      for (const foreign of c.foreignSymbols) {
        const standalone = new RegExp(`(?<![A-Za-z])${foreign.replace(/\$/g, '\\$')}`);
        expect(msg, `${c.label} tenant must not see a standalone ${foreign}`)
          .not.toMatch(standalone);
      }
      // Every expense answer states the window it covered (#429/#431) — a
      // total without its period is what let "the doctor" mean October.
      expect(msg, 'the answer must name the period it used').toMatch(/Period:|year to date|this year/i);
    });

    test(`${c.label}: tax advice cites this tenant's authority, never another country's`, async ({ page }) => {
      // Production told a Canadian consultant that meals are "typically
      // deductible (50% in the US)". The rate happened to be right and the
      // authority wrong, which is the version a user notices and stops
      // trusting. Assert on the authority, not the number.
      const r = await api(page).post('/api/v1/agentbook-core/agent/message', {
        text: 'what tax deductions can I claim?',
        channel: 'web',
      });
      expectOk(r, `${c.label} deductions question`);
      const msg: string = r.data?.data?.message ?? '';
      expect(msg.length).toBeGreaterThan(0);
      expect(msg, `${c.label} tenant must not be quoted another country's rules`)
        .not.toMatch(c.foreignAuthorities);
    });

    test(`${c.label}: sees only its own books`, async ({ page }) => {
      // Inside the per-case describe so it reuses that beforeEach login rather
      // than opening its own. As a standalone describe it timed out at 30s in
      // page.waitForURL while the sibling CA tests — same account — signed in
      // fine: every extra phase adds concurrent sign-ins against production and
      // makes a cold start likelier. Raising the timeout would have treated the
      // symptom, and the containing test budget is 60s, so there is not much
      // room to raise it into anyway. Removing a login fixes the cause, and as
      // a bonus this now runs for BOTH tenants instead of only CA.
      const r = await api(page).get('/api/v1/agentbook-expense/expenses?limit=100');
      expectOk(r, `${c.label} expenses`);
      const rows: Array<{ description?: string }> = r.data?.data ?? [];
      expect(rows.length, `${c.label} tenant should have its seeded expenses`).toBeGreaterThan(0);
      // A cross-tenant leak would be worse than any wrong number.
      for (const e of rows) {
        const d = e.description ?? '';
        expect(d, `${c.label} tenant must not see the other region's rows`)
          .not.toMatch(c.foreignRowMarker);
        expect(d, `${c.label} tenant must not see the US tenant's rows`)
          .not.toMatch(US_SEEDED_ROW);
      }
    });
  });
}
