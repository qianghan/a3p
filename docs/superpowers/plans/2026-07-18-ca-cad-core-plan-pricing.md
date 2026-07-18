# CAD Core-Plan Pricing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to execute each task in this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 (Canada) PR CA-4 (Medium) of the AgentBook launch-readiness roadmap. Core plans (Free/Pro/Pro Annual/Business) are currently USD-only — `CorePlanPrice` has no `region` field, and `BillPlan.code` is globally unique (one row per code, ever). The 3 consumer add-ons already have a proven, live multi-currency pattern (`AddOnTierPrice[]` keyed by `region`, `BillAddOnPrice` rows with a `stripePriceId` per region). This plan extends the SAME nominal-parity pricing convention already established for add-ons to core plans, and makes every code path that reads/writes `BillPlan` region-aware, so a CA tenant sees and can be billed in CAD for Free/Pro/Business — without touching Stripe's live API anywhere in this PR.

**Architecture:** Rejected the naive "split `BillPlan` into a product+price pair" approach (mirroring `BillAddOn`/`BillAddOnPrice`) because `BillSubscription.planId` is a live FK directly into `BillPlan.id`, and real production subscribers already have rows pointing at today's single per-code `BillPlan.id` — retargeting that FK to a new price-table's id would require a data backfill against real subscriber records, which is unnecessary risk for what CA-4 actually needs. Instead: add a `region` column directly to `BillPlan` (default `'us'`, matching every existing row's implicit region) and widen its unique constraint from `@@unique([code])` to `@@unique([code, region])`. Existing subscriptions keep pointing at their exact same `BillPlan.id` — nothing about them changes. New CA rows are simply additional `BillPlan` rows sharing a `code` with their US counterpart but a different `region`/`currency`/`priceCents`/`stripePriceId`.

**Tech Stack:** TypeScript, Prisma, Vitest, Next.js, React.

## Global Constraints

- **No live Stripe API calls in this PR.** Every new `region='ca'` `BillPlan` row ships with `stripePriceId: null` — exactly matching how every add-on seed script (`bin/seed-tax-fast-track-addon.ts` et al.) leaves `stripePriceId` null until a separate, explicitly-confirmed admin action creates the real Stripe Product/Price and backfills the ID. This PR's own admin `POST /plans` route DOES call Stripe (that is its existing, pre-existing, unchanged purpose — creating any new plan, in any region, always goes through Stripe) but this PR does not itself invoke that route or any other Stripe API to actually create CAD products/prices — that is a separate, explicitly-confirmed step after this PR merges, per the roadmap's own stated rule for this PR.
- **Nominal price parity, matching the established add-on convention.** Per `packages/agentbook-pricing/src/index.ts`'s own documented rationale for `ADDON_PRICES` ("us/ca/uk: same nominal number across currencies... these launch at currency-label parity, e.g. $49 USD and $49 CAD, not a converted CAD figure, correctable later from real data with zero code changes"), CAD core plans use the exact same cents figures as USD: Free $0, Pro $19 (1900), Pro Annual $182 (18200), Business $49 (4900) — just `region: 'ca'`, `currency: 'cad'`.
- No new abstraction layers — reuses the exact `region`-keyed array shape (`AddOnTierPrice`) already established for add-ons, applied to `CorePlanPrice`; the schema change is a single additive column + constraint widening, not a new join table.
- Every PR follows the established SDD process (worktree → plan → SDD execution → per-task review → final whole-branch review → CI → merge).
- The schema migration itself is validated only against an isolated verify database in this PR (per this session's established practice) — the actual production `prisma db push` for the new `region` column is its own explicit, separately-confirmed step, run BEFORE the code that starts reading/writing multi-region `BillPlan` rows is deployed (same ordering rule already used for every schema change this session).
- Keep the design generic across CA and the not-yet-started AU-5 (AUD core-plan pricing, explicitly noted in the roadmap as "same shape as PR CA-4") — nothing in this plan is CA-specific beyond the actual CAD data rows themselves.

---

### Task 1: Add `region` to `CorePlanPrice` and CAD rows to `CORE_PLANS`

**Files:**
- Modify: `packages/agentbook-pricing/src/index.ts`
- Modify: `packages/agentbook-pricing/src/__tests__/index.test.ts`

**Interfaces:**
- Produces: `CorePlanPrice` gains a `region: string` field; `CORE_PLANS` grows from 4 rows (one per code, all `region` implicitly `'us'`) to 8 (4 codes × 2 regions). Consumed by Task 3's seed script and Task 2's schema (conceptually — Task 2 doesn't import this file, but its shape must match).

- [ ] **Step 1: Read the current file in full** (already reviewed during planning — re-confirm exact current content before editing).

- [ ] **Step 2: Write failing tests first.** Add to `packages/agentbook-pricing/src/__tests__/index.test.ts` (read the existing file first to match its exact `toMatchObject` convention):

```ts
describe('CORE_PLANS region coverage (CA-4)', () => {
  const CODES = ['free', 'pro', 'pro_yearly', 'business'] as const;

  it('every core plan code has both a us and a ca row, at nominal price parity', () => {
    for (const code of CODES) {
      const rows = CORE_PLANS.filter((p) => p.code === code);
      expect(rows).toHaveLength(2);
      const us = rows.find((r) => r.region === 'us');
      const ca = rows.find((r) => r.region === 'ca');
      expect(us).toBeDefined();
      expect(ca).toBeDefined();
      expect(us!.currency).toBe('usd');
      expect(ca!.currency).toBe('cad');
      // Nominal parity: same cents figure, matching the established
      // add-on convention (see this file's ADDON_PRICES doc comment).
      expect(ca!.priceCents).toBe(us!.priceCents);
      expect(ca!.name).toBe(us!.name);
      expect(ca!.interval).toBe(us!.interval);
      expect(ca!.sortOrder).toBe(us!.sortOrder);
    }
  });

  it('total CORE_PLANS length is exactly 8 (4 codes x 2 regions)', () => {
    expect(CORE_PLANS).toHaveLength(8);
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail** (CAD rows don't exist yet; `region` field doesn't exist on the type at all, so this is a compile/type error, which counts as a failure).

Run: `cd packages/agentbook-pricing && npx vitest run src/__tests__/index.test.ts`
Expected: FAILS.

- [ ] **Step 4: Add the `region` field and CAD rows**

Replace `CorePlanPrice` and `CORE_PLANS` with:

```ts
export interface CorePlanPrice {
  code: 'free' | 'pro' | 'pro_yearly' | 'business';
  name: string;
  priceCents: number;
  currency: string;
  region: string;
  interval: 'month' | 'year';
  sortOrder: number;
}

// CA-4: CAD rows at nominal price parity with USD (same rationale already
// documented below for ADDON_PRICES — no reliable evidence of a specific
// regional discount, so CAD launches at the same nominal cents figure as
// USD, correctable later from real data with zero code changes).
export const CORE_PLANS: CorePlanPrice[] = [
  { code: 'free', name: 'Free', priceCents: 0, currency: 'usd', region: 'us', interval: 'month', sortOrder: 0 },
  { code: 'free', name: 'Free', priceCents: 0, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 0 },
  { code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', region: 'us', interval: 'month', sortOrder: 1 },
  { code: 'pro', name: 'Pro', priceCents: 1900, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 1 },
  // 20% off 12x the monthly price ($228), rounded to a whole dollar —
  // $190/12 would have implied a different (wrong) monthly price; this is
  // the actual math behind the "save 20%" marketing claim.
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 18200, currency: 'usd', region: 'us', interval: 'year', sortOrder: 2 },
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 18200, currency: 'cad', region: 'ca', interval: 'year', sortOrder: 2 },
  { code: 'business', name: 'Business', priceCents: 4900, currency: 'usd', region: 'us', interval: 'month', sortOrder: 3 },
  { code: 'business', name: 'Business', priceCents: 4900, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 3 },
];
```

- [ ] **Step 5: Run the tests again and confirm all pass**, including every pre-existing test in the file (the `ADDON_PRICES` tests are untouched by this task and must still pass).

Run: `cd packages/agentbook-pricing && npx vitest run`
Expected: ALL pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agentbook-pricing/src/index.ts packages/agentbook-pricing/src/__tests__/index.test.ts
git commit -m "feat(pricing): add region field + CAD rows to CORE_PLANS (CA-4)

CA-4 (Phase 2 Canada roadmap, Medium): CorePlanPrice previously had no
region field — every plan was implicitly USD-only. Adds region: string
and CAD rows for Free/Pro/Pro Annual/Business at nominal price parity
with USD, matching the pricing-derivation convention already established
and documented for ADDON_PRICES."
```

---

### Task 2: Schema — add `region` to `BillPlan`, widen the unique constraint (validated on an isolated DB only)

**Files:**
- Modify: `packages/database/prisma/schema.prisma`

**Interfaces:**
- Produces: `BillPlan.region: String @default("us")`; `@@unique([code, region])` replacing `@@unique([code])` (Prisma auto-names this compound key `code_region` for `where` clauses in Task 3).
- Consumed by: Task 3 (every route/script that reads/writes `BillPlan`).

- [ ] **Step 1: Read the current `BillPlan` model in full** (already reviewed during planning at `packages/database/prisma/schema.prisma` — re-confirm exact current line numbers).

- [ ] **Step 2: Edit the model**

```prisma
model BillPlan {
  id              String   @id @default(uuid())
  code            String
  region          String   @default("us")
  name            String
  description     String?
  priceCents      Int
  currency        String   @default("usd")
  interval        String   @default("month")
  stripeProductId String?
  stripePriceId   String?
  features        Json
  quotas          Json
  isActive        Boolean  @default(true)
  sortOrder       Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  subscriptions BillSubscription[]

  @@unique([code, region])
  @@schema("plugin_agentbook_billing")
}
```

(`BillSubscription`'s `planId` FK and every other field on both models are unchanged — this task touches only the `BillPlan` block shown above.)

- [ ] **Step 3: Validate against an isolated verify database — NOT the shared local dev DB, and NOT production.** Follow this session's established pattern (a dedicated, disposable Postgres database, never `--accept-data-loss` against a DB anyone else might be using):

```bash
cd packages/database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agentbook_verify_ca4" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/agentbook_verify_ca4" \
npx prisma validate
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agentbook_verify_ca4" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/agentbook_verify_ca4" \
npx prisma db push --skip-generate
```

Expected: `prisma validate` passes; `db push` succeeds against the throwaway `agentbook_verify_ca4` database, creating the new column and constraint with no errors. If the database doesn't exist yet, create it first (`createdb agentbook_verify_ca4` or via `docker exec` into the project's Postgres container — check `docker-compose.yml` for the exact container name/credentials this repo already uses for its local Postgres). Afterward, this throwaway database can be dropped — it existed only to prove the migration is syntactically and structurally valid, not to persist any data.

- [ ] **Step 4: Regenerate the Prisma client** so TypeScript sees the new `region` field before Task 3 needs it.

Run: `cd packages/database && npx prisma generate`

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma
git commit -m "feat(billing): add region column to BillPlan, widen unique constraint (CA-4)

Additive schema change: BillPlan.region defaults to 'us' (matching every
existing row's implicit region), and the unique constraint widens from
code-only to (code, region) so a CAD variant of each plan can coexist
with its USD counterpart. BillSubscription.planId still FKs directly to
BillPlan.id — existing subscriptions are completely unaffected, since
their referenced row's id never changes.

Validated against an isolated verify database only (agentbook_verify_ca4,
dropped after validation) — the actual production db push for this
column is a separate, explicitly-confirmed step, to run before the code
in the following commits is deployed."
```

---

### Task 3: Region-aware routes, billing-package fallback, seed script, and consistency checker

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-billing/plans/route.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/intent/route.ts`
- Modify: `packages/billing/src/plans.ts`
- Modify: `agentbook/seed-billing-plans.ts`
- Modify: `bin/verify-pricing-consistency.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-billing/plans-route.test.ts` (check if a test file already exists for this route first: `find apps/web-next/src/__tests__ -iname "*plans-route*"`)
- Test: `packages/billing/__tests__/plans.test.ts` (check if one already exists: `find packages/billing/__tests__ -iname "*plans*"`)

**Interfaces:**
- Consumes: Task 1's `region`-keyed `CORE_PLANS`, Task 2's `BillPlan.region` column.
- Produces: `GET /api/v1/agentbook-billing/plans` now filters by the caller's resolved region (reading `abTenantConfig.jurisdiction`, defaulting to `'us'` — the exact same resolution pattern already used by `me/addons/route.ts`'s list branch). `getCurrentPlan`/`getCurrentPlanStrict` in `packages/billing/src/plans.ts` gain an optional `region?: string` parameter (default `'us'`, fully backward-compatible with every existing caller that doesn't pass it) so the Free-plan fallback resolves the correct region's Free plan instead of an arbitrary one.

- [ ] **Step 1: Read all 5 files listed above in full** (already reviewed during planning — re-confirm exact current content, since line numbers may have shifted).

- [ ] **Step 2: Write failing tests first**, for the two files with the clearest region-selection logic to verify:

For `packages/billing/__tests__/plans.test.ts` (create if none exists, otherwise add a new `describe` block — check the existing mocking convention in `packages/billing/__tests__/addons.test.ts` first and mirror it, since it establishes how this package's tests mock `@naap/database`):

```ts
describe('getCurrentPlan region-aware Free fallback (CA-4)', () => {
  it('a CA account with no subscription falls back to the CA-region Free plan, not the US one', async () => {
    // Mock prisma.billSubscription.findUnique to resolve null (no subscription).
    // Mock prisma.billPlan.findFirst to return a fake CA-region Free plan
    // when called with { where: { code: 'free', region: 'ca', isActive: true } },
    // and a DIFFERENT fake US-region Free plan for { region: 'us' } — assert
    // getCurrentPlan(tenantId, 'ca') resolves to the CA one specifically
    // (e.g. by giving the two fakes distinguishable ids/quotas and
    // asserting on which one comes back), not just "some Free plan".
  });

  it('omitting the region argument entirely still defaults to us (backward compatibility)', async () => {
    // Same mocking shape; call getCurrentPlan(tenantId) with no second
    // argument; assert prisma.billPlan.findFirst was called with
    // region: 'us' in its where clause (or that the US fake plan came back).
  });
});
```

For `apps/web-next/src/__tests__/api/v1/agentbook-billing/plans-route.test.ts` (create if none exists — read `addon-user-routes.test.ts` first for this package's established route-mocking convention: `vi.mock('@naap/database')`, mock `safeResolveAgentbookTenant`, etc.):

```ts
describe('GET /api/v1/agentbook-billing/plans (CA-4 region filtering)', () => {
  it('a CA tenant only sees the 4 CA-region plans (CAD), not the 4 US ones', async () => {
    // Mock abTenantConfig.findUnique -> { jurisdiction: 'ca' }.
    // Mock billPlan.findMany -> return a mix of us+ca fake rows if the
    // route doesn't filter, or exercise the actual where clause the route
    // now passes and assert it includes region: 'ca'.
  });

  it('a tenant with no configured jurisdiction defaults to us plans', async () => {
    // Mock abTenantConfig.findUnique -> null; assert the query filters region: 'us'.
  });
});
```

- [ ] **Step 3: Run the tests and confirm they fail** (region filtering doesn't exist yet in either file).

Run: `cd packages/billing && npx vitest run __tests__/plans.test.ts` and `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing/plans-route.test.ts`
Expected: both FAIL.

- [ ] **Step 4: Update `packages/billing/src/plans.ts`** — widen `loadCachedPlan`, `getCurrentPlanStrict`, and `getCurrentPlan` with an optional `region` parameter, defaulting to `'us'`:

```ts
async function loadCachedPlan(accountId: string, region: string = 'us'): Promise<CachedPlan> {
  const hit = planCache.get(accountId);
  if (hit) return hit;
  const sub = await prisma.billSubscription.findUnique({
    where: { accountId },
    include: { plan: true },
  });
  if (!sub) {
    const free = await prisma.billPlan.findFirst({ where: { code: 'free', region, isActive: true } });
    // ... (rest of this branch unchanged, using `free` as before)
```

```ts
export async function getCurrentPlanStrict(tenantId: string, region: string = 'us'): Promise<CurrentPlan> {
  const accountId = await resolveAccountId(tenantId);
  const cached = await loadCachedPlan(accountId, region);
  // ... (rest unchanged)
```

```ts
export async function getCurrentPlan(tenantId: string, region: string = 'us'): Promise<CurrentPlan> {
  try {
    return await getCurrentPlanStrict(tenantId, region);
  } catch (err) {
    // ... (rest unchanged — the catch-block SYNTHETIC_FREE fallback doesn't need a region, it's a hardcoded universal safety net, not a real DB row)
```

Leave every other line in this file (the `activeCount` no-plans-at-all check, `SYNTHETIC_FREE`, `BILLING_INACTIVE`, `loadUsage`) exactly as-is — this task only widens the 3 function signatures shown and threads `region` into the one `billPlan.findFirst` call that needs it.

- [ ] **Step 5: Update `apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/route.ts`'s GET handler** to resolve and pass the tenant's region:

```ts
export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const cur = await getCurrentPlan(tenantId, cfg?.jurisdiction || 'us');
  return NextResponse.json(cur);
}
```

(This route already imports `prisma` from `@naap/database` for its POST handler — reuse that same import, don't add a duplicate.)

- [ ] **Step 6: Update `me/subscription/intent/route.ts`'s Free-plan seeding** to resolve the tenant's region before the `findFirst`:

```ts
export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const stripe = getStripe();
  const existing = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const cust = await stripe.customers.create({ metadata: { tenantId } });
    customerId = cust.id;
    const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const region = cfg?.jurisdiction || 'us';
    const freePlanId = (await prisma.billPlan.findFirst({ where: { code: 'free', region } }))?.id;
    // ... (rest of this block unchanged, using freePlanId as before)
```

- [ ] **Step 7: Update `plans/route.ts`'s GET handler** to filter by the tenant's region, and its POST handler's `PlanBody`/create call to accept and persist a `region` field:

```ts
export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const cfg = await prisma.abTenantConfig.findUnique({ where: { userId: tenantId } });
  const region = cfg?.jurisdiction || 'us';
  const plans = await prisma.billPlan.findMany({
    where: { isActive: true, region },
    orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
  });
  return NextResponse.json({ plans });
}
```

(This changes the GET route's auth requirement — it previously took no `request` parameter meaningfully and required no tenant resolution at all; confirm this doesn't break any existing unauthenticated caller by checking `plans-route.test.ts`'s existing tests, if any, before making auth mandatory here. If an unauthenticated public-pricing-page use case exists for this exact route, keep an explicit `?region=us|ca` query-param override as a fallback for that caller instead of hard-requiring tenant resolution — check for this before assuming.)

For the POST handler, add `region: z.string().length(2)` to `PlanBody`'s schema, and thread `body.region` into both the `where`/`create` — since `code` is no longer globally unique, `prisma.billPlan.create({ data: { ..., region: body.region } })` is sufficient (no `where` needed for `create`), but any FUTURE upsert-style admin action against this table needs the compound key `where: { code_region: { code, region } }`, not `where: { code } }` — note this in a comment since Task 3's own admin POST route uses `create` (not `upsert`), so it isn't directly affected, but Task 3 Step 8 (the seed script) IS affected and must use the compound key.

- [ ] **Step 8: Update `agentbook/seed-billing-plans.ts`** to iterate `CORE_PLANS`' 8 rows (now that Task 1 doubled it) and upsert using the compound key:

```ts
for (const plan of CORE_PLANS) {
  const details = PLAN_DETAILS[plan.code];
  const data = {
    code: plan.code,
    region: plan.region,
    name: plan.name,
    description: details.description,
    priceCents: plan.priceCents,
    currency: plan.currency,
    interval: plan.interval,
    features: details.features,
    quotas: details.quotas,
    sortOrder: plan.sortOrder,
  };
  await prisma.billPlan.upsert({
    where: { code_region: { code: plan.code, region: plan.region } },
    create: { ...data, isActive: true },
    update: { ...data, isActive: true },
  });
}
```

- [ ] **Step 9: Update `bin/verify-pricing-consistency.ts`** to also check `region` when comparing `CORE_PLANS` rows against their `BillPlan` DB counterparts (read the file first — it's a manual drift-checker script, not a unit test; extend its existing core-plan loop to key on `(code, region)` instead of just `code`, matching how it presumably already handles `ADDON_PRICES`' `(region, tier)` keying for add-ons).

- [ ] **Step 10: Run the tests again and confirm all pass.**

Run: `cd packages/billing && npx vitest run`, then `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing/`
Expected: ALL pass, including every pre-existing test in both directories (the add-on route tests must be completely unaffected).

- [ ] **Step 11: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/plans/route.ts apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/route.ts apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/intent/route.ts packages/billing/src/plans.ts agentbook/seed-billing-plans.ts bin/verify-pricing-consistency.ts apps/web-next/src/__tests__/api/v1/agentbook-billing/plans-route.test.ts packages/billing/__tests__/plans.test.ts
git commit -m "feat(billing): thread region through plan listing, subscribe, and free-plan seeding (CA-4)

CA-4: every code path that reads or writes BillPlan is now region-aware
— GET /plans filters by the tenant's configured jurisdiction, the
Free-plan seed on first SetupIntent resolves the right region's Free
plan, getCurrentPlan/getCurrentPlanStrict take an optional region
parameter (default 'us', fully backward-compatible with every existing
caller), and the seed script + drift-checker both key on (code, region)
instead of code alone."
```

---

### Task 4: Frontend currency-awareness — `BillingTab` and `SubscribeModal`

**Files:**
- Modify: `apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx` (`BillingTab`)
- Modify: `apps/web-next/src/components/settings/SubscribeModal.tsx`

**Interfaces:**
- Consumes: Task 3's region-filtered `GET /plans` response (each plan row now carries the correct `currency` for the tenant's region — `currency` already exists as a `BillPlan` column and was already returned by the old GET handler, just never displayed correctly on the frontend).
- Produces: no new exported interface — this task replaces hardcoded `$` formatting with the existing `formatCurrencyCents` helper.

- [ ] **Step 1: Read `BillingTab`'s current `fmt()` function and `SubscribeModal`'s `fmtPrice()` function in full**, plus `apps/web-next/src/lib/jurisdiction-currency.ts`'s `formatCurrencyCents` signature (already exists — confirm its exact exported signature before using it).

- [ ] **Step 2: Add `currency` to the `BillingPlan` interface in `AgentBookSettingsPanel.tsx`**:

```ts
interface BillingPlan { id: string; code: string; name: string; description?: string | null; priceCents: number; currency: string; interval: string }
```

- [ ] **Step 3: Replace `BillingTab`'s hardcoded `fmt()` calls for core plans with `formatCurrencyCents(cents, currency)`**, passing each plan's own `currency` field (not the tenant's region-derived `currency` used for add-ons, though in practice they should always agree since both are now sourced from the same tenant's jurisdiction — use the plan row's own `currency` field directly, since it's the more precise source right next to the number being formatted).

- [ ] **Step 4: Widen `SubscribeModal`'s `PlanTarget` interface** to carry `currency`, and update `fmtPrice`'s call site for the `kind: 'plan'` branch to use `formatCurrencyCents` instead of its hardcoded `$` prefix (the `kind: 'addon'` branch may already handle this correctly — check before assuming, since Task 4 of the earlier US-9 PR may or may not have already fixed the add-on branch; if it already did, mirror the exact same approach for the plan branch rather than reinventing it):

```ts
interface PlanTarget {
  kind: 'plan';
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  interval: string;
}
```

- [ ] **Step 5: Update `BillingTab`'s plan-subscribe call site** to pass `currency: p.currency` into the `SubscribeModal` target, alongside the existing `id`/`name`/`priceCents`/`interval` fields.

- [ ] **Step 6: Manual verification** — no dedicated test file exists for `SubscribeModal.tsx` (a client-side Stripe Elements component, per this session's established precedent for this file) or for `BillingTab`'s rendering specifically; read through both updated files once more to confirm: the core-plan display now uses `formatCurrencyCents` consistently instead of a hardcoded `$`, and the existing US/USD display is provably unchanged in substance (formatting `1900` cents at `currency: 'usd'` through `formatCurrencyCents` should produce the same visual result, e.g. `$19`, as the old hardcoded `fmt()` did — confirm this by reading `formatCurrencyCents`'s actual implementation, don't assume).

- [ ] **Step 7: Rebuild nothing** — `BillingTab`/`SubscribeModal` live in `apps/web-next`, not a plugin frontend bundle, so no `dist/production` build-and-copy step applies here (unlike plugin-frontend changes elsewhere in this roadmap).

- [ ] **Step 8: Run the broader relevant test suites** to catch any regression.

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing/ src/lib/__tests__/ 2>&1 | tail -80`
Expected: all pass (aside from the pre-existing, unrelated `DATABASE_URL`-dependent integration test failures already documented earlier this session).

- [ ] **Step 9: Commit**

```bash
git add apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx apps/web-next/src/components/settings/SubscribeModal.tsx
git commit -m "fix(billing): core-plan UI displays real per-region currency, not hardcoded USD

CA-4: BillingTab and SubscribeModal both hardcoded a '\$' prefix for core
plans regardless of the tenant's actual currency. Now uses the existing
formatCurrencyCents helper (already used elsewhere for add-ons/jurisdiction
display), reading each plan row's own currency field — a CA tenant now
sees their Pro/Business prices formatted as CAD, not mislabeled USD."
```

## Self-Review

- Spec coverage: closes CA-4's acceptance criteria in full for the code side — a CA tenant's `GET /plans` call returns real CAD-priced rows, the Free-plan seeding/fallback resolves the right region, and the UI displays the correct currency. The live Stripe product/price creation (the other half of "sees AND IS BILLED IN CAD") is explicitly, correctly deferred as its own separately-confirmed step per the roadmap's own stated rule for this PR — this plan does not silently skip that requirement, it defers it to the correct place.
- Placeholder scan: none — every code change is given in full; the one open judgment call (Task 3 Step 7's "confirm the GET route's auth requirement doesn't break an unauthenticated caller") is a real, disclosed investigation step for the implementer, not a missing requirement.
- Scope check: deliberately avoids splitting `BillPlan` into a product+price pair (unlike the add-on model) specifically because of the live-subscriber-FK risk identified during planning — a smaller, safer additive column change achieves the identical acceptance criteria.
- Type consistency: `CorePlanPrice` gains one field (`region`); `BillPlan` gains one column; `getCurrentPlan`/`getCurrentPlanStrict`/`loadCachedPlan` gain one optional, default-valued parameter each — every existing caller of any of these continues to compile and behave identically without modification.

## Explicitly Deferred (separate, confirmed steps — NOT part of this PR)

1. **Production schema migration**: `prisma db push` for `BillPlan.region` + the new unique constraint, against the real Supabase database — run once this PR's code is merged and ready to deploy, as its own explicitly-confirmed action, BEFORE the deploy that starts reading/writing multi-region `BillPlan` rows (same ordering rule as every other schema change this session).
2. **Live Stripe CAD product/price creation**: for each of Free/Pro/Pro Annual/Business's new `region='ca'` row, create the real Stripe Product + Price (Free needs no Stripe object at all, matching how the existing USD Free plan already has `stripePriceId: null`) and backfill `stripePriceId`/`stripeProductId` — via either the existing admin `POST /plans` route (if it's adapted to also support "attach a price to an existing code's new region" rather than only "create a brand-new code") or a small one-off script mirroring `bin/create-pro-yearly-plan.ts`'s existing live-Stripe-call pattern. This is a real live-billing action affecting a production Stripe account and must be explicitly confirmed by the user before it runs, exactly as the roadmap itself states for this PR.
