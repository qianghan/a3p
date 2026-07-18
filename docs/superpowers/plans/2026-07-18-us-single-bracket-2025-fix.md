# Fix Stale 2024-vs-2025 US Single-Filer Federal Bracket Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `FEDERAL_BRACKETS_2025_SINGLE` in `packages/agentbook-jurisdictions/src/us/tax-brackets.ts` is mislabeled — it actually holds 2024 IRS single-filer thresholds, not 2025 ones. This is the US-GATE Attempt-1 remediation for that finding: replace it with the real, correctly-sourced 2025 IRS single-filer thresholds (Rev. Proc. 2024-40), matching the rigor already used for the adjacent `FEDERAL_BRACKETS_2025_MARRIED` table, and pin both tables with a regression test so this can't silently drift stale again.

**Architecture:** Single-file constant-table replacement plus one new test file. No interface changes — `bracketsFor()`, `calculateFromBrackets()`, and the exported `usTaxBrackets` provider shape are all unchanged; only the `FEDERAL_BRACKETS_2025_SINGLE` array's values change.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- No new abstraction layers — this is a data correction to an existing constant table, not a redesign of the bracket-provider interface.
- Reuse before rewrite — `bracketsFor()`, `calculateFromBrackets()`, and the `usTaxBrackets` export are already correct and must not change shape.
- Every PR follows the established SDD process (worktree → plan → SDD execution → per-task review → final whole-branch review → CI → merge).

---

### Task 1: Replace the stale single-filer bracket table with real 2025 IRS thresholds and add a pinning regression test

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/us/tax-brackets.ts`
- Modify: `packages/agentbook-jurisdictions/src/__tests__/us-tax-brackets.test.ts`

**Interfaces:**
- Consumes: nothing new — this task only changes the values inside the existing `FEDERAL_BRACKETS_2025_SINGLE: TaxBracket[]` constant.
- Produces: nothing new is exported; `usTaxBrackets.calculateTax(incomeCents, taxYear, filingStatus)` keeps its existing signature and behavior, just with corrected single-filer numbers.

- [ ] **Step 1: Read the current file in full to confirm exact current line numbers before editing**

Run: `cat packages/agentbook-jurisdictions/src/us/tax-brackets.ts`

The current (stale) `FEDERAL_BRACKETS_2025_SINGLE` table (in cents) is:
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
```
These are actually ~2024 IRS single-filer thresholds ($11,600 / $47,150 / $100,525 / $191,900 / $243,375 / $609,625), not 2025 ones.

- [ ] **Step 2: Write a failing regression test first**, pinning the exact single-filer tax owed at $150,000 under the REAL 2025 thresholds (this will fail against the current stale table, since the stale table produces a different total).

Add this new `describe` block to `packages/agentbook-jurisdictions/src/__tests__/us-tax-brackets.test.ts` (append it after the existing `describe('usTaxBrackets.calculateTax filingStatus', ...)` block, before the CA/AU blocks):

```ts
describe('usTaxBrackets single-filer table uses real 2025 IRS thresholds (not stale 2024 figures)', () => {
  it('matches the real 2025 IRS single-filer bracket calculation at $150,000', () => {
    // Real IRS 2025 single-filer thresholds (Rev. Proc. 2024-40): $11,925 /
    // $48,475 / $103,350 / $197,300 / ... Computed by hand against those
    // brackets:
    // 10%: 1,192,500 * 0.10 = 119,250
    // 12%: (4,847,500 - 1,192,500) * 0.12 = 438,600
    // 22%: (10,335,000 - 4,847,500) * 0.22 = 1,207,250
    // 24%: (15,000,000 - 10,335,000) * 0.24 = 1,119,600
    // total = 2,884,700 cents
    const result = usTaxBrackets.calculateTax(INCOME_150K_CENTS, 2025, 'single');
    expect(result.taxCents).toBe(2_884_700);
    expect(result.marginalRate).toBe(0.24);
  });

  it('pins every 2025 single-filer bracket threshold exactly, so this cannot silently drift stale again', () => {
    const brackets = usTaxBrackets.getTaxBrackets(2025);
    expect(brackets).toEqual([
      { min: 0, max: 1_192_500, rate: 0.10 },
      { min: 1_192_500, max: 4_847_500, rate: 0.12 },
      { min: 4_847_500, max: 10_335_000, rate: 0.22 },
      { min: 10_335_000, max: 19_730_000, rate: 0.24 },
      { min: 19_730_000, max: 25_052_500, rate: 0.32 },
      { min: 25_052_500, max: 62_635_000, rate: 0.35 },
      { min: 62_635_000, max: null, rate: 0.37 },
    ]);
  });
});
```

- [ ] **Step 3: Run the tests and confirm the two new tests fail** (against the current stale table), while all pre-existing tests in the file still pass.

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-tax-brackets.test.ts`
Expected: the two new tests FAIL (wrong `taxCents`/bracket values); all previously-existing tests in this file still PASS.

- [ ] **Step 4: Replace the stale table with the real 2025 IRS single-filer thresholds**

Replace the `FEDERAL_BRACKETS_2025_SINGLE` constant and its surrounding comment in `packages/agentbook-jurisdictions/src/us/tax-brackets.ts` with:

```ts
// Real IRS 2025 single-filer federal brackets (Rev. Proc. 2024-40), in
// cents: $11,925 / $48,475 / $103,350 / $197,300 / $250,525 / $626,350.
// (A previous version of this table held ~2024 single-filer figures
// mislabeled 2025 — see docs/superpowers/plans/2026-07-18-us-single-bracket-2025-fix.md
// for the US-GATE finding that caught this and the corrected sourcing.)
const FEDERAL_BRACKETS_2025_SINGLE: TaxBracket[] = [
  { min: 0, max: 1192500, rate: 0.10 },
  { min: 1192500, max: 4847500, rate: 0.12 },
  { min: 4847500, max: 10335000, rate: 0.22 },
  { min: 10335000, max: 19730000, rate: 0.24 },
  { min: 19730000, max: 25052500, rate: 0.32 },
  { min: 25052500, max: 62635000, rate: 0.35 },
  { min: 62635000, max: null, rate: 0.37 },
];
```

Also update the existing comment above `FEDERAL_BRACKETS_2025_MARRIED` (which currently says "that table is itself a few years stale... see docs/superpowers/sdd/us-mfj-report.md") to remove the now-resolved forward reference to the stale single table and instead note it's confirmed consistent with the now-corrected single table:

```ts
// Real IRS 2025 married-filing-jointly federal brackets (Rev. Proc. 2024-40),
// in cents: $23,850 / $96,950 / $206,700 / $394,600 / $501,050 / $751,600 —
// which is exactly 2x FEDERAL_BRACKETS_2025_SINGLE above for every bracket
// except the top one: the 37% bracket starts at $751,600, not the doubled
// $1,252,700 (a well-known "marriage bonus" cap Congress did not extend to
// the top bracket).
```

- [ ] **Step 5: Run the tests again and confirm everything passes**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-tax-brackets.test.ts`
Expected: ALL tests in the file PASS, including the two new ones and every pre-existing test (the existing `single.marginalRate` assertion of `0.24` at $150,000 still holds under the corrected table, since $150,000 falls within the 24% bracket in both the old and corrected tables — verify this is genuinely true by reading the output, not just assuming it).

- [ ] **Step 6: Run the full `agentbook-jurisdictions` test suite** to confirm no other test in the package was relying on the old stale single-filer values.

Run: `cd packages/agentbook-jurisdictions && npx vitest run`
Expected: all tests pass. If any other test file references `FEDERAL_BRACKETS_2025_SINGLE` values or US single-filer tax amounts at a specific income, update that test's expected value to the corrected figure (recompute by hand against the new thresholds, don't guess).

- [ ] **Step 7: Also run the `apps/web-next` tests that touch US tax estimation**, since `packages/agentbook-jurisdictions` is consumed there — confirm nothing downstream hardcoded an expectation based on the old stale single-filer numbers.

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-tax/ 2>&1 | tail -60` (adjust the path if this exact directory doesn't exist — search for tax-estimate-related test files first with `find src/__tests__ -iname "*tax-estimate*"` if the above path is wrong).
Expected: all relevant tests pass. If a test hardcodes an expected US single-filer tax dollar amount, update it to match the corrected calculation (show your work in a comment, matching the style already used in `us-tax-brackets.test.ts`).

- [ ] **Step 8: Commit**

```bash
git add packages/agentbook-jurisdictions/src/us/tax-brackets.ts packages/agentbook-jurisdictions/src/__tests__/us-tax-brackets.test.ts
git commit -m "fix(tax): correct stale 2024-vs-2025 US single-filer federal bracket table

US-GATE attempt-1 fidelity re-audit found FEDERAL_BRACKETS_2025_SINGLE held
~2024 IRS thresholds mislabeled 2025, while the adjacent MFJ table was
correctly sourced from 2025 figures. Replaces with the real 2025 IRS
single-filer thresholds (Rev. Proc. 2024-40) and pins both tables with a
regression test so this can't silently drift stale again."
```

## Self-Review

- Spec coverage: closes the US-GATE Attempt-1 finding in full — the single-filer table now matches the same 2025 IRS sourcing rigor as the MFJ table, and a threshold-pinning test guards against future silent drift.
- Placeholder scan: none — every step has exact numeric values, computed and shown.
- Type consistency: no interface/type changes — `TaxBracket[]`, `bracketsFor()`, `calculateFromBrackets()`, and `usTaxBrackets`'s exported shape are all unchanged.
