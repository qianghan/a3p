# Fix Reachable US-Default Chart-of-Accounts Duplicate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to execute each task in this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 (Canada) PR CA-5 (Medium) of the AgentBook launch-readiness roadmap. `plugins/agentbook-core/backend/src/server.ts`'s `POST /api/v1/agentbook-core/accounts/seed-jurisdiction` route hardcodes a US-only chart of accounts (`US_ACCOUNTS`) for every tenant regardless of jurisdiction — its own code comment admits this: `// TODO: also select US_ACCOUNTS variants by jurisdiction when a CA chart lands.` A real, jurisdiction-aware implementation of this exact same route already exists at `apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts` (built in an earlier roadmap PR, using the real `us`/`ca`/`au` `ChartOfAccountsTemplate` packs from `packages/agentbook-jurisdictions`) — but `agentbook/seed-personas.ts` (the local demo-persona regeneration script) calls the OLD, buggy Express route directly via `http://localhost:4050`, not the correct Next.js one. Regenerating "Maya (CA consultant)"'s demo persona locally therefore produces a US Schedule-C chart of accounts, not a real T2125 one.

**Architecture:** Investigated two candidate fixes from the roadmap's own text — "stop calling localhost:4050 directly; go through the Next.js route" vs. "delete the Express duplicate if it's truly dead in production." Neither alone is right here: the Express route IS dead in production (prod traffic only hits Next.js routes), but it can't simply be deleted, because `apps/web-next/src/lib/agentbook-tenant.ts`'s `resolveAgentbookTenant` (used by the Next.js route) requires EITHER a `CRON_SECRET` bearer token OR a real `naap_auth_token` session cookie — it has no dev-mode "trust a bare `x-tenant-id` header" fallback the way the Express backend's `tenantMiddleware` does. `seed-personas.ts` only ever sends a plain `x-tenant-id` header, so redirecting it to call the Next.js route directly would break (401/400) without a much bigger change (either giving the seed script a real login flow, or loosening the Next.js route's auth — neither of which this Medium-severity, narrowly-scoped fix should do). The correct fix is instead to close the ACTUAL bug: make the Express route import and use the exact same jurisdiction-pack chart-of-accounts templates (`usChartOfAccounts`/`caChartOfAccounts`/`auChartOfAccounts`) the Next.js route already correctly uses, instead of its own hardcoded, jurisdiction-blind `US_ACCOUNTS` array. `plugins/agentbook-core/backend/package.json` already depends on `@agentbook/jurisdictions` (confirmed by reading it) — this import is not a new dependency.

**Tech Stack:** TypeScript, Vitest, Express.

## Global Constraints

- No new abstraction layers — reuses the exact `ChartOfAccountsTemplate` interface and `us`/`ca`/`au` pack implementations already built and already correctly consumed by the Next.js route; does not introduce a second jurisdiction-selection mechanism.
- Reuse before rewrite — the fix is deleting the Express route's own hardcoded `US_ACCOUNTS`/jurisdiction-blindness and replacing it with the same `CHART_PROVIDERS` map pattern already proven in the Next.js route, not re-deriving new logic.
- `seed-personas.ts`'s HTTP-call pattern and the Express route's auth model are explicitly left unchanged — this PR's fix lives entirely inside the Express route's own account-selection logic, avoiding the auth-mismatch complication described above.
- Every PR follows the established SDD process (worktree → plan → SDD execution → per-task review → final whole-branch review → CI → merge).

---

### Task 1: Make the Express `seed-jurisdiction` route jurisdiction-aware, matching the Next.js route

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/seed-jurisdiction-route.test.ts` (new — confirm none exists first: `find plugins/agentbook-core/backend/src/__tests__ -iname "*seed-jurisdiction*"`)

**Interfaces:**
- Consumes: `usChartOfAccounts`/`caChartOfAccounts`/`auChartOfAccounts` from `@agentbook/jurisdictions` (already a declared dependency of this package).
- Produces: no change to the route's request/response shape — same `POST /api/v1/agentbook-core/accounts/seed-jurisdiction`, same `{ success, data: { count } }` response.

- [ ] **Step 1: Read the current Express route handler in full**

Run: `sed -n '1915,1975p' plugins/agentbook-core/backend/src/server.ts` (re-confirm exact current line numbers — this plan's research was done against a specific commit and lines may have shifted slightly).

- [ ] **Step 2: Also read the Next.js route this must match**, to confirm the exact `CHART_PROVIDERS`/`STUDENT_ACCOUNTS` pattern to mirror: `apps/web-next/src/app/api/v1/agentbook-core/accounts/seed-jurisdiction/route.ts` (read in full — already reviewed during planning).

- [ ] **Step 3: Write failing tests first.** Create `plugins/agentbook-core/backend/src/__tests__/seed-jurisdiction-route.test.ts`. First check how this package's existing tests set up an Express app + supertest-style request (or whatever HTTP-testing convention this backend already uses — check a sibling test file in the same `__tests__` directory for the pattern before inventing one), then write:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the Prisma client this route uses (check server.ts's actual import
// name/path for `db` before assuming — likely '@naap/database' or a local
// db module, matching whatever pattern this file's OTHER route tests
// already use for mocking abTenantConfig/abAccount).

describe('POST /api/v1/agentbook-core/accounts/seed-jurisdiction (CA-5 remediation)', () => {
  // Set up per this package's existing test conventions (read a sibling
  // test file first). For each case, mock abTenantConfig.findUnique to
  // return the given jurisdiction/businessType, mock abAccount.upsert to
  // resolve, and assert on what values were actually upserted.

  it('a CA tenant gets the real CA chart of accounts (T2125-style codes/names), not the US Schedule-C one', async () => {
    // Mock tenantConfig: { jurisdiction: 'ca', businessType: 'freelancer' }.
    // Call the route. Assert the upserted accounts match
    // caChartOfAccounts.getDefaultAccounts('freelancer') exactly (import
    // caChartOfAccounts directly in the test and compare), NOT the old
    // hardcoded US_ACCOUNTS array (e.g. assert NO upserted account has
    // taxCategory starting with 'Line ' — the old US-only Schedule-C line
    // number convention — for a CA tenant).
  });

  it('an AU tenant gets the real AU chart of accounts', async () => {
    // Same shape, jurisdiction: 'au', compare against auChartOfAccounts.getDefaultAccounts(...).
  });

  it('a US tenant is unaffected — still gets the real US chart of accounts', async () => {
    // jurisdiction: 'us' (or undefined, the existing default), compare
    // against usChartOfAccounts.getDefaultAccounts(...) — confirm this
    // matches what the OLD hardcoded US_ACCOUNTS array would have produced
    // for the codes/names that exist in both, so US behavior is
    // provably unchanged in substance (the source of the data moves from
    // an inline array to the jurisdiction pack, but the actual codes/
    // names/types for a US freelancer should be equivalent).
  });

  it('a student tenant still gets the student-specific chart, regardless of jurisdiction', async () => {
    // jurisdiction: 'ca', businessType: 'student' — assert STUDENT_ACCOUNTS
    // (unchanged) is used, not caChartOfAccounts.
  });
});
```

- [ ] **Step 4: Run the tests and confirm they fail** (the CA/AU tests fail because the route currently always returns US-shaped accounts).

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/seed-jurisdiction-route.test.ts`
Expected: the CA and AU tests FAIL; the US and student tests may already pass (fine).

- [ ] **Step 5: Fix the route.** Replace the account-selection logic inside the `/api/v1/agentbook-core/accounts/seed-jurisdiction` handler in `plugins/agentbook-core/backend/src/server.ts`. First, add the import near the top of the file with the other imports:

```ts
import { usChartOfAccounts } from '@agentbook/jurisdictions/us/chart-of-accounts.js';
import { caChartOfAccounts } from '@agentbook/jurisdictions/ca/chart-of-accounts.js';
import { auChartOfAccounts } from '@agentbook/jurisdictions/au/chart-of-accounts.js';
import type { ChartOfAccountsTemplate } from '@agentbook/jurisdictions/interfaces.js';
```

(Confirm the exact subpath-import style this backend already uses elsewhere for `@agentbook/jurisdictions` or `@agentbook/framework` — this repo has an established convention of importing specific subpaths rather than a package's barrel `index.ts` to avoid pulling in unrelated code; check for an existing example in this same file or package before assuming the `.js` extension convention shown above is exactly right for this specific package/tsconfig.)

Then replace the route body's account-selection section (keep everything before "Default chart of accounts based on jurisdiction" and everything from `const created = ...` onward unchanged; replace only the `US_ACCOUNTS`/`STUDENT_ACCOUNTS`/final `accounts` selection in between):

```ts
app.post('/api/v1/agentbook-core/accounts/seed-jurisdiction', async (req, res) => {
  try {
    const tenantId = (req as any).tenantId;
    const config = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = config?.jurisdiction || 'us';

    const STUDENT_ACCOUNTS = [
      { code: '1000', name: 'Cash', accountType: 'asset' },
      { code: '1200', name: 'Checking / Debit Account', accountType: 'asset' },
      { code: '3000', name: "Owner's Equity", accountType: 'equity' },
      { code: '4000', name: 'Part-Time Job Income', accountType: 'revenue' },
      { code: '4100', name: 'Tutoring / Gig Income', accountType: 'revenue', taxCategory: 'Schedule C' },
      { code: '4200', name: 'Scholarship / Grant Income', accountType: 'revenue' },
      { code: '4300', name: 'Family Support / Allowance', accountType: 'revenue' },
      { code: '5000', name: 'Tuition & Fees', accountType: 'expense', taxCategory: '1098-T / T2202' },
      { code: '5100', name: 'Textbooks & Course Materials', accountType: 'expense' },
      { code: '5200', name: 'Rent / Housing', accountType: 'expense' },
      { code: '5300', name: 'Meal Plan / Groceries', accountType: 'expense' },
      { code: '5400', name: 'Transportation', accountType: 'expense' },
      { code: '5500', name: 'Phone & Software Subscriptions', accountType: 'expense' },
      { code: '5600', name: 'Student Loan Interest', accountType: 'expense', taxCategory: '1098-E' },
    ];

    // CA-5 remediation: this route previously hardcoded a US-only
    // Schedule-C chart of accounts for every jurisdiction (see git blame
    // for the old US_ACCOUNTS array and its own "TODO: also select
    // US_ACCOUNTS variants by jurisdiction when a CA chart lands" comment
    // — a CA chart landed a while ago; this route just never picked it
    // up). Now uses the same real, tested jurisdiction-pack charts the
    // Next.js equivalent route (apps/web-next/.../accounts/seed-jurisdiction/route.ts)
    // already correctly uses.
    const CHART_PROVIDERS: Record<string, ChartOfAccountsTemplate> = {
      us: usChartOfAccounts,
      ca: caChartOfAccounts,
      au: auChartOfAccounts,
    };

    let accounts: { code: string; name: string; accountType: string; taxCategory?: string }[];
    if (config?.businessType === 'student') {
      accounts = STUDENT_ACCOUNTS;
    } else {
      const provider = CHART_PROVIDERS[jurisdiction] ?? usChartOfAccounts;
      accounts = provider.getDefaultAccounts(config?.businessType ?? 'freelancer').map((a) => ({
        code: a.code,
        name: a.name,
        accountType: a.type,
        taxCategory: a.taxCategory,
      }));
    }

    const created = await db.$transaction(
      accounts.map(a => db.abAccount.upsert({
        where: { tenantId_code: { tenantId, code: a.code } },
        update: { name: a.name, accountType: a.accountType, taxCategory: (a as any).taxCategory },
        create: { tenantId, ...a },
      })),
    );
    // (keep the rest of the handler — response construction, error handling — exactly as it already is)
```

Delete the old inline `US_ACCOUNTS` array entirely (it's now redundant with `usChartOfAccounts`).

- [ ] **Step 6: Run the tests again and confirm all pass.**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/seed-jurisdiction-route.test.ts`
Expected: ALL tests pass.

- [ ] **Step 7: Run the broader `agentbook-core` backend test suite** to confirm nothing else broke.

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: all pass.

- [ ] **Step 8: Manual sanity check** — read through the final edited route handler once more end to end, confirming: the `student` branch is checked BEFORE the jurisdiction branch (a student in any jurisdiction gets the student chart, matching the Next.js route's precedence exactly); the `?? usChartOfAccounts` fallback for an unrecognized jurisdiction string mirrors the Next.js route's own fallback; nothing else in the surrounding 100+ lines of this large file was accidentally touched (this file is `server.ts`, a large multi-thousand-line file — confirm your diff is scoped to exactly this one route).

- [ ] **Step 9: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/seed-jurisdiction-route.test.ts
git commit -m "fix(core): Express seed-jurisdiction route uses real jurisdiction-pack charts, not hardcoded US

CA-5 remediation: this route (only reachable via agentbook/seed-personas.ts's
direct localhost:4050 calls — dead in production, where all traffic goes
through the Next.js equivalent route) hardcoded a US-only Schedule-C chart
of accounts for every jurisdiction, per its own 'TODO: also select
US_ACCOUNTS variants by jurisdiction when a CA chart lands' comment — a CA
(and AU) chart landed in an earlier roadmap PR and this route just never
picked it up. Now imports the same real usChartOfAccounts/caChartOfAccounts/
auChartOfAccounts packs the Next.js route already correctly uses.
Regenerating the 'Maya (CA consultant)' demo persona locally now produces
a real T2125 chart of accounts, not a US one."
```

## Self-Review

- Spec coverage: closes CA-5's acceptance criteria — regenerating the "Maya (CA consultant)" demo persona locally now produces a real T2125 chart of accounts, not a US Schedule-C one, because the ONLY route that persona-regeneration script can reach (the Express one) is now itself jurisdiction-aware.
- Placeholder scan: none — the exact replacement code is given in full.
- Scope check: deliberately does NOT touch `seed-personas.ts` or the Next.js route (both already correct/unrelated to the bug) or the Express route's auth model — narrowly fixes the one real defect (hardcoded US chart) in the one place it lives.
- Type consistency: no interface/type changes to the route's request/response shape; only its internal account-selection logic changes, now delegating to the same `ChartOfAccountsTemplate` interface the Next.js route already uses.
