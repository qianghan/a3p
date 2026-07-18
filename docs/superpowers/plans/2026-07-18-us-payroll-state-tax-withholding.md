# US Payroll State Income Tax Withholding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop AgentBook's payroll engine from silently withholding $0 state income tax for every US employee in every state, by adding a per-employee work-state field and a flat-rate state withholding table matching the engine's existing "reasonable planning approximation" precision level.

**Architecture:** Add a `region` column to `AbEmployee` (the employee's work state — mirrors `AbTenantConfig.region`'s existing free-text state/province convention), thread it through `calcPay`/`calcUS` in `payroll-engine.ts` via a new `STATE_INCOME_TAX_RATES` flat-rate table (same shape/precision as the existing `US_STATE_RATES` sales-tax table introduced in PR US-1 — this file's own header comment already states its numbers are "reasonable 2024-ish approximations for planning, not a substitute for certified payroll software," so a flat per-state rate is consistent with the file's existing precision level, not a regression from it), and expose a state-selector field in the employee-creation form. No new abstraction — one new column, one new lookup table, one new form field.

**Tech Stack:** Prisma/Postgres, Next.js API routes, React, Vitest.

## Global Constraints

- No new abstraction layers — `region` on `AbEmployee` mirrors the exact existing pattern already used for `AbTenantConfig.region`.
- This is additive: `region` defaults to `''` (empty), and an employee with no region set gets `$0` state tax (explicit, not silently wrong) — existing employees created before this PR are unaffected until someone sets their state.
- Non-US jurisdictions (`ca`/`uk`/`au`) are completely untouched — `calcCA`/`calcUK`/`calcAU` are not modified.
- **The schema migration is a separate, explicitly-confirmed production step** — per this roadmap's Global Constraints, do not run `prisma db push` against the production database as part of this task; validate against an isolated local/verify database only. Flag the production migration as a distinct follow-up action requiring the user's explicit go-ahead.
- No progressive state brackets — a flat per-state rate is the correct precision level for this file (matching its own documented "planning approximation" scope and the existing sales-tax table's precision), not an under-implementation.

---

### Task 1: Add `region` to `AbEmployee` and validate against an isolated DB

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (`AbEmployee` model)

**Interfaces:**
- Produces: `AbEmployee.region: string` (default `""`), consumed by Task 2 (engine) and Task 3 (routes/UI).

- [ ] **Step 1: Add the column**

```prisma
model AbEmployee {
  id           String   @id @default(uuid())
  tenantId     String
  name         String
  email        String?
  type         String   @default("w2") // w2 | contractor_1099
  payType      String   @default("salary") // salary | hourly
  payRateCents Int
  payFrequency String   @default("biweekly")
  jurisdiction String   @default("us") // us | ca | uk | au
  region       String   @default("") // employee's work state/province — drives US state withholding
  filingStatus String   @default("single")
  allowances   Int      @default(0)
  startDate    DateTime @default(now())
  isActive     Boolean  @default(true)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([tenantId, isActive])
  @@schema("plugin_agentbook_payroll")
}
```

- [ ] **Step 2: Validate and push to an isolated verify database** (per [[feedback_shared_local_db_worktrees]] — never `--accept-data-loss` against the shared local DB):

```bash
cd packages/database
npx prisma validate
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/agentbook_verify_us_payroll" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/agentbook_verify_us_payroll" \
npx prisma db push --skip-generate
```

If no local Postgres is reachable in this environment, skip the live push and instead confirm `prisma validate` passes and that the diff is purely additive (one new column with a default) — record this explicitly in the report rather than silently skipping.

- [ ] **Step 3: Regenerate the Prisma client** so TypeScript sees the new field:

```bash
cd packages/database && npx prisma generate
```

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/schema.prisma
git commit -m "feat(payroll): add region column to AbEmployee for state withholding"
```

---

### Task 2: Wire state withholding into the payroll engine

**Files:**
- Modify: `apps/web-next/src/lib/payroll-engine.ts`
- Test: `apps/web-next/src/__tests__/lib/payroll-engine.test.ts` (new file — no test currently exists for this module at all; establish real coverage as part of this fix, following the mocking-free pure-function test style already used in `apps/web-next/src/__tests__/lib/agentbook-invoice-tax.test.ts` for its non-DB-dependent helpers, or a plain describe/it style with no mocks since `calcPay` takes no DB dependency at all)

**Interfaces:**
- Consumes: `AbEmployee.region` is not read directly by this file — the caller (Task 3) passes it in via a new `PayInput.region?: string` field.
- Produces: `calcUS` now returns a non-zero `stateTaxCents` for a recognized, taxed state; `PayInput.region` is optional so any existing caller that doesn't pass it keeps getting `$0` (explicit "not configured" behavior, not a crash).

- [ ] **Step 1: Write failing tests** covering: (a) a US employee in California gets non-zero state tax at the documented CA rate; (b) a US employee in a no-income-tax state (e.g. Texas or Florida) gets exactly `$0` state tax; (c) a US employee with no region set gets `$0` state tax (today's unchanged behavior, now explicit rather than hardcoded); (d) CA/UK/AU calculations are completely unaffected by this change (call `calcPay` for each and assert `stateTaxCents` stays `0` as before).

- [ ] **Step 2: Run tests, confirm they fail** (no `region` field on `PayInput`, `stateTaxCents` still hardcoded to 0).

- [ ] **Step 3: Add the state table and wire it in**

```ts
// Flat per-state income-tax approximation, matching this file's documented
// precision level ("reasonable 2024-ish approximations for planning") — not
// progressive brackets. No-income-tax states are explicit 0s, not omissions.
// Mirrors the shape of packages/agentbook-jurisdictions/src/us/sales-tax.ts's
// STATE_RATES table (a different tax, same per-state lookup convention).
const US_STATE_INCOME_TAX_RATES: Record<string, number> = {
  CA: 0.093, NY: 0.0685, TX: 0, FL: 0, WA: 0,
  IL: 0.0495, PA: 0.0307, OH: 0.0399, GA: 0.0549, NC: 0.0475,
  OR: 0.099, NH: 0, MT: 0.0675, DE: 0.066, AK: 0,
};

function calcUS(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const brackets = input.filingStatus === 'married' ? US_MARRIED : US_SINGLE;
  const federalTaxCents = Math.round(progressive(annual, brackets) / input.payPeriodsPerYear);
  const ssAnnual = Math.min(annual, US_SS_WAGE_BASE);
  const ssCents = Math.round((ssAnnual * 0.062) / input.payPeriodsPerYear);
  const medicareCents = Math.round((input.grossCents) * 0.0145);
  const ficaCents = ssCents + medicareCents;
  const stateRate = US_STATE_INCOME_TAX_RATES[(input.region || '').toUpperCase()] ?? 0;
  const stateTaxCents = Math.round(input.grossCents * stateRate);
  const netCents = input.grossCents - federalTaxCents - ficaCents - stateTaxCents;
  return { grossCents: input.grossCents, federalTaxCents, stateTaxCents, ficaCents, otherDeductCents: 0, netCents, sgCents: 0 };
}
```

Also add `region?: string;` to the `PayInput` interface, next to the existing `filingStatus?: string; // single | married (US)` line.

- [ ] **Step 4: Run tests, confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/payroll-engine.ts apps/web-next/src/__tests__/lib/payroll-engine.test.ts
git commit -m "feat(payroll): withhold real per-state income tax for US employees"
```

---

### Task 3: Thread `region` through the employee routes and the payroll UI

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-payroll/employees/route.ts` (POST — add `region` to `CreateEmployeeBody` and the `db.abEmployee.create` call)
- Modify: `apps/web-next/src/app/api/v1/agentbook-payroll/employees/[id]/route.ts` (read this file first — if it has a PUT/PATCH handler with its own field whitelist, add `region` there too, matching whatever pattern it already uses for `jurisdiction`/`filingStatus`)
- Modify: `apps/web-next/src/app/api/v1/agentbook-payroll/pay-runs/route.ts` (line ~67: add `region: emp.region` to the `calcPay(...)` call)
- Modify: `apps/web-next/src/app/(dashboard)/payroll/page.tsx` (employee-creation form)

**Interfaces:**
- Consumes: `AbEmployee.region` from Task 1's schema, `PayInput.region` from Task 2.
- Produces: nothing consumed by a later task — this plan has 3 tasks.

- [ ] **Step 1: Read `employees/[id]/route.ts` in full** to learn its exact PUT/PATCH field-whitelist shape before editing it.

- [ ] **Step 2: Extend the employees POST route**

```ts
interface CreateEmployeeBody {
  name?: string;
  email?: string;
  type?: string;
  payType?: string;
  payRateCents?: number;
  payFrequency?: string;
  jurisdiction?: string;
  region?: string;
  filingStatus?: string;
}
```

And in the `db.abEmployee.create` call, add:

```ts
        region: body.region || '',
```

- [ ] **Step 3: Extend the `[id]` route's update handler** the same way, following its established pattern for optional-field updates (read the file first — don't guess its exact shape).

- [ ] **Step 4: Pass `region` into `calcPay` in the pay-runs route**

```ts
        const pay = calcPay({
          jurisdiction: emp.jurisdiction,
          grossCents,
          payPeriodsPerYear: periodsPerYear,
          filingStatus: emp.filingStatus,
          region: emp.region,
        });
```

- [ ] **Step 5: Add a state field to the employee-creation form in `payroll/page.tsx`**

Add a `region` state hook next to the existing `juris` one:

```tsx
  const [region, setRegion] = useState('');
```

Add `region` to the POST body (line ~58):

```tsx
        body: JSON.stringify({ name: name.trim(), payRateCents: Math.round(Number(salary) * 100), payFrequency: freq, jurisdiction: juris, region: region.trim() }),
```

Add an input next to the existing jurisdiction `<select>` (around line 133), only shown when `juris === 'us'` (region only matters for US withholding today — CA/UK/AU calculations don't consume it, so don't imply it does anything for those jurisdictions):

```tsx
              {juris === 'us' && (
                <input value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} placeholder="State (e.g. CA)"
                  maxLength={2} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              )}
```

Update the local `Employee` interface (line 8) to include `region: string`, and the employee-list row display (line ~148) to show it for US employees, e.g. appending `· {e.region}` when `e.jurisdiction === 'us' && e.region`.

- [ ] **Step 6: Manual verification** — no existing test harness covers this specific page (confirm by checking for a colocated test file; if genuinely none exists across the payroll dashboard pages, this is a static read-through, matching this project's established precedent of no test coverage for several plugin/dashboard frontend pages — say so explicitly in the report). Confirm the state field only appears for `jurisdiction === 'us'`, and that its value round-trips through the POST body correctly.

- [ ] **Step 7: Run the full payroll-related test suite** to confirm no regression: `cd apps/web-next && npx vitest run src/__tests__/lib/payroll-engine.test.ts`

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-payroll/employees/route.ts apps/web-next/src/app/api/v1/agentbook-payroll/employees/\[id\]/route.ts apps/web-next/src/app/api/v1/agentbook-payroll/pay-runs/route.ts apps/web-next/src/app/\(dashboard\)/payroll/page.tsx
git commit -m "feat(payroll): thread employee work-state through routes and the UI"
```

## Self-Review

- Spec coverage: schema, engine, route, and UI all covered; this closes the roadmap's PR US-2 entry in full.
- Placeholder scan: none — every step has real code.
- Note for the controller: this PR's schema change needs a production `prisma db push` run as an explicit, separately-confirmed step before/alongside deploy, per this roadmap's Global Constraints — do not run it against production without the user's go-ahead.
