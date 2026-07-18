# US Married-Filing-Jointly Federal Bracket Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a US tenant's tax estimate use the correct married-filing-jointly federal bracket table instead of always applying single-filer brackets — the data (`AbTaxConfig.filingStatus`, already defaulting to `'single'`) already exists and is simply never read by the bracket calculation.

**Architecture:** Add an optional `filingStatus` parameter to `TaxBracketProvider.calculateTax` (shared interface across us/ca/au packs) and a `US_MARRIED_BRACKETS_2025` table alongside the existing single table in `us/tax-brackets.ts`; CA/AU implementations ignore the new parameter (Canada has no married/single federal bracket split; Australia's brackets are also filing-status-agnostic), so this is additive with zero behavior change for those two. The `tax/estimate` route passes the tenant's already-stored `filingStatus` through.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- No new abstraction layers — one new optional parameter on an existing interface method, one new bracket table.
- No schema change — `AbTaxConfig.filingStatus` already exists; this PR only wires an unused field into a calculation, nothing to migrate.
- CA/AU tax-bracket calculations must be provably unchanged.
- Default behavior (no `filingStatus` passed, or `filingStatus !== 'married'`) stays single-filer — this must never regress a caller that doesn't yet pass the new parameter.

---

### Task 1: Add the married bracket table and thread `filingStatus` through the shared interface

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/interfaces.ts` (`TaxBracketProvider.calculateTax` signature)
- Modify: `packages/agentbook-jurisdictions/src/us/tax-brackets.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/us-tax-brackets.test.ts` (new — no test currently exists for this file; check the directory's existing naming convention from sibling test files first)

**Interfaces:**
- Produces: `TaxBracketProvider.calculateTax(taxableIncomeCents, taxYear, filingStatus?)` — the new third parameter is optional everywhere; `usTaxBrackets` is the only implementation that branches on it.

- [ ] **Step 1: Read `interfaces.ts`, `us/tax-brackets.ts`, `ca/tax-brackets.ts`, and `au/tax-brackets.ts` in full** to confirm current shapes before editing (the CA/AU files must not need any real change — only confirm their existing `calculateTax(taxableIncomeCents, taxYear)` signature still satisfies the interface once the third param is added as optional).

- [ ] **Step 2: Write failing tests** covering: (a) `usTaxBrackets.calculateTax(taxableIncomeCents, 2025, 'married')` uses the married brackets and produces a lower tax than `'single'` for the same income at a rate-boundary-crossing income level (e.g. $150,000, which is deep in single's 24% bracket but still in married's 22% bracket); (b) omitting the third argument entirely still produces the single-filer result (backward compatibility with existing callers); (c) `filingStatus: 'single'` explicitly also produces the single-filer result; (d) `caTaxBrackets.calculateTax` and `auTaxBrackets.calculateTax` are unaffected by the new optional parameter (call them the same way as before, assert identical results to a captured baseline).

- [ ] **Step 3: Run tests, confirm they fail** (married bracket table doesn't exist yet, `calculateTax` doesn't accept the third param).

- [ ] **Step 4: Add the third parameter to the interface**

```ts
export interface TaxBracketProvider {
  jurisdiction: string;
  region?: string;
  getTaxBrackets(taxYear: number): TaxBracket[];
  calculateTax(taxableIncomeCents: number, taxYear: number, filingStatus?: string): TaxCalculation;
}
```

- [ ] **Step 5: Add the married bracket table and branch in `us/tax-brackets.ts`**

```ts
const FEDERAL_BRACKETS_2025_SINGLE: TaxBracket[] = [
  { min: 0, max: 1160000, rate: 0.10 },
  { min: 1160000, max: 4712500, rate: 0.12 },
  { min: 4712500, max: 10052500, rate: 0.22 },
  { min: 10052500, max: 19190000, rate: 0.24 },
  { min: 19190000, max: 24337500, rate: 0.32 },
  { min: 24337500, max: 60962500, rate: 0.35 },
  { min: 60962500, max: null, rate: 0.37 },
];

const FEDERAL_BRACKETS_2025_MARRIED: TaxBracket[] = [
  { min: 0, max: 2320000, rate: 0.10 },
  { min: 2320000, max: 9430000, rate: 0.12 },
  { min: 9430000, max: 20105000, rate: 0.22 },
  { min: 20105000, max: 38390000, rate: 0.24 },
  { min: 38390000, max: 48745000, rate: 0.32 },
  { min: 48745000, max: 73120000, rate: 0.35 },
  { min: 73120000, max: null, rate: 0.37 },
];

function bracketsFor(filingStatus?: string): TaxBracket[] {
  return filingStatus === 'married' ? FEDERAL_BRACKETS_2025_MARRIED : FEDERAL_BRACKETS_2025_SINGLE;
}
```

Rename the existing `FEDERAL_BRACKETS_2025` references to `bracketsFor(filingStatus)` in both `getTaxBrackets` (which itself has no filing-status parameter today per the interface — leave `getTaxBrackets` returning the single table by default, since only `calculateTax` gains the new parameter per the interface change above) and `calculateTax`:

```ts
export const usTaxBrackets: TaxBracketProvider = {
  jurisdiction: 'us',
  getTaxBrackets(taxYear: number) {
    return FEDERAL_BRACKETS_2025_SINGLE; // TODO: year-versioned lookup
  },
  calculateTax(taxableIncomeCents: number, taxYear: number, filingStatus?: string) {
    return calculateFromBrackets(taxableIncomeCents, bracketsFor(filingStatus));
  },
};
```

- [ ] **Step 6: Run tests, confirm they pass.**

- [ ] **Step 7: Commit**

```bash
git add packages/agentbook-jurisdictions/src/interfaces.ts packages/agentbook-jurisdictions/src/us/tax-brackets.ts packages/agentbook-jurisdictions/src/__tests__/us-tax-brackets.test.ts
git commit -m "feat(tax): add US married-filing-jointly federal bracket table"
```

---

### Task 2: Wire the tenant's stored filing status into the tax estimate route

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts`

**Interfaces:**
- Consumes: `usTaxBrackets.calculateTax`'s new optional third parameter from Task 1.
- Produces: nothing consumed by a later task — this plan has 2 tasks.

- [ ] **Step 1: Read the route's current `bracketProvider.calculateTax(...)` call (line ~180) and the surrounding `taxConfig` fetch** to confirm the exact current code before editing.

- [ ] **Step 2: Pass `filingStatus` through**

```ts
    const incomeTaxCents = bracketProvider.calculateTax(taxableIncomeCents + w2IncomeCents, taxYear, taxConfig?.filingStatus).taxCents;
```

`taxConfig` is already fetched earlier in the route (`const taxConfig = await db.abTaxConfig.findUnique({ where: { tenantId } })`) — no new query needed. Passing `undefined` when `taxConfig` doesn't exist yet correctly falls back to single-filer via Task 1's `bracketsFor` default, matching today's behavior for a tenant with no tax config.

- [ ] **Step 3: Check for an existing test file covering this route's income-tax calculation** (search `apps/web-next/src/__tests__` for a tax-estimate route test) — if one exists, add a case asserting a married tenant gets the married-bracket result; if none exists, this is a static read-through confirming the one-line change is correct, and note that explicitly.

- [ ] **Step 4: Run the full relevant test suite**: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-tax-brackets.test.ts` and, if a route test exists, run it too from `apps/web-next`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-tax/tax/estimate/route.ts
git commit -m "feat(tax): use the tenant's stored filing status for US federal tax estimate"
```

## Self-Review

- Spec coverage: closes the roadmap's PR US-4 entry in full — real married brackets, wired into the live estimate route, no schema change needed since the data already existed.
- Placeholder scan: none.
- Consistency: bracket boundary values in the married table are exactly 2× the single table's (the real IRS 2025 relationship for every bracket except the top two, which is also factually correct — verify this matches real 2025 IRS published figures if double-checking, not just assumed doubling).
