# Fix CA Provincial Tax Bracket Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to execute each task in this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** This is Phase 2 (Canada) PR CA-1 (Critical) of the AgentBook launch-readiness roadmap. `plugins/agentbook-tax/backend/src/tax-forms.ts`'s `PROVINCIAL_BRACKETS` table only has real 2025 bracket data for Ontario, British Columbia, and Alberta — every other Canadian province and territory (Quebec, Manitoba, Saskatchewan, New Brunswick, Nova Scotia, PEI, Newfoundland and Labrador, Yukon, Northwest Territories, Nunavut — 10 jurisdictions) silently falls back to `PROVINCIAL_BRACKETS['ON']` via `PROVINCIAL_BRACKETS[province] || PROVINCIAL_BRACKETS['ON']`, computing Ontario's rates for a resident of any of those 10 places. This plan adds real 2025 bracket data for all 10, making every Canadian province/territory correctly represented and making the ON fallback path unreachable for any real province/territory code.

**Architecture:** A single-file constant-table expansion (`PROVINCIAL_BRACKETS` grows from 3 entries to 13) plus new unit tests for `evaluateFormula`'s `PROVINCIAL_TAX(...)` and `PROGRESSIVE_TAX(...)` formula paths, which had zero prior test coverage. No interface or call-site changes — `calcProgressiveTax`, `evaluateFormula`, and the T1 form definition (`fieldId: 'provincial_tax_42800'`) all keep their exact current shape; only the underlying data table's contents grow.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- No new abstraction layers — this closes the gap by completing the existing `PROVINCIAL_BRACKETS` lookup table, not by building a jurisdiction-provider framework (that already exists one layer up in `packages/agentbook-jurisdictions`, which does NOT currently model CA provincial data at all — confirmed by reading `packages/agentbook-jurisdictions/src/ca/tax-brackets.ts`, which only has federal brackets; adding provincial data there is out of scope for this fix since the only real consumer, `PROVINCIAL_TAX(...)`, lives entirely in `tax-forms.ts` today).
- Reuse before rewrite — `calcProgressiveTax`, `evaluateFormula`, and the `CA_FEDERAL_BRACKETS`/`PROVINCIAL_TAX`/`PROGRESSIVE_TAX` formula-evaluator shape are already correct and keep their exact current behavior; only the data table's contents change.
- Every PR follows the established SDD process (worktree → plan → SDD execution → per-task review → final whole-branch review → CI → merge).
- Quebec's own federal-abatement mechanics (Quebec residents get a ~16.5% reduction on FEDERAL tax, handled entirely separately from provincial tax) are explicitly out of scope for this fix — this PR only adds Quebec's own provincial bracket schedule (as published by Revenu Québec), matching the same "one flat additive provincial-bracket table per jurisdiction" pattern already used for every other province in this simplified engine. Modeling the federal abatement itself is a separate, unaudited enhancement not requested by this gap.

## Sourced Data (Tax Foundation-equivalent official sources — see report below for full citations)

All 10 new provinces/territories, real 2025 personal income tax brackets, converted from whole-dollar thresholds to cents (matching this file's existing `PROVINCIAL_BRACKETS` convention, e.g. ON's `{ limit: 5114200, rate: 0.0505 }` = $51,142.00):

```
QC: 5325500→0.14, 10649500→0.19, 12959000→0.24, Infinity→0.2575
MB: 4700000→0.108, 10000000→0.1275, Infinity→0.174
SK: 5346300→0.105, 15275000→0.125, Infinity→0.145
NB: 5130600→0.094, 10261400→0.14, 19006000→0.16, Infinity→0.195
NS: 3099500→0.0879, 6199100→0.1495, 9741700→0.1667, 15712400→0.175, Infinity→0.21
PE: 3332800→0.095, 6465600→0.1347, 10500000→0.166, 14000000→0.1762, Infinity→0.19
NL: 4419200→0.087, 8838200→0.145, 15779200→0.158, 22091000→0.178, 28221400→0.198, 56442900→0.208, 112885800→0.213, Infinity→0.218
YT: 5737500→0.064, 11475000→0.09, 17788200→0.109, 50000000→0.128, Infinity→0.15
NT: 5196400→0.059, 10393000→0.086, 16896700→0.122, Infinity→0.1405
NU: 5470700→0.04, 10941300→0.07, 17788100→0.09, Infinity→0.115
```

Sources (spot-checkable): Revenu Québec's own rate page (QC), Government of Manitoba Finance (MB), Government of Saskatchewan's official 2025 Personal Income Tax Structure page (SK), Government of New Brunswick Finance (NB), Government of Nova Scotia's "Personal income tax rates and indexation" page (NS), Government of Newfoundland and Labrador Finance (NL), Government of Nunavut's official September 2025 Tax Rate Sheet PDF (NU), cross-checked against TaxTips.ca and EY's published 2025 combined federal/provincial rate tables (PE, YT, NT — official department pages were unreachable directly but two independent sources agreed).

---

### Task 1: Expand `PROVINCIAL_BRACKETS` to all 13 provinces/territories and add formula-evaluator test coverage

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-forms.ts`
- Test: `plugins/agentbook-tax/backend/src/__tests__/tax-forms-provincial-brackets.test.ts` (new — no existing test file covers `evaluateFormula`/`PROVINCIAL_BRACKETS`/`calcProgressiveTax` at all; confirm this via `find plugins/agentbook-tax/backend/src/__tests__ -iname "*tax-forms*"` before assuming, in case one was added since this plan was written)

**Interfaces:**
- Consumes: nothing new.
- Produces: `evaluateFormula('PROVINCIAL_TAX(taxable_income_26000, province_territory)', fields)` and `evaluateFormula('PROGRESSIVE_TAX(income_field, <province_code>)', fields)` keep their exact existing signatures; only `PROVINCIAL_BRACKETS`'s contents change. No later task in this plan depends on this beyond "the table is now complete."

- [ ] **Step 1: Read the current file's relevant section in full**

Run: `sed -n '245,355p' plugins/agentbook-tax/backend/src/tax-forms.ts` — re-confirm the exact current `PROVINCIAL_BRACKETS` constant, `calcProgressiveTax`, and the two `evaluateFormula` branches (`PROGRESSIVE_TAX` and `PROVINCIAL_TAX`) that read it, since line numbers may have shifted slightly since this plan was written.

- [ ] **Step 2: Write failing tests first.** Create `plugins/agentbook-tax/backend/src/__tests__/tax-forms-provincial-brackets.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { evaluateFormula } from '../tax-forms.js';

describe('PROVINCIAL_TAX formula — provincial bracket completeness (CA-GATE remediation)', () => {
  const ALL_PROVINCES_AND_TERRITORIES = ['ON', 'BC', 'AB', 'QC', 'MB', 'SK', 'NB', 'NS', 'PE', 'NL', 'YT', 'NT', 'NU'];

  it('produces a distinct, real (non-Ontario-fallback) tax figure for every previously-uncovered province/territory at $80,000 taxable income', () => {
    // Before this fix, all 10 of these provinces/territories fell through
    // `PROVINCIAL_BRACKETS[province] || PROVINCIAL_BRACKETS['ON']`, silently
    // computing Ontario's tax. $80,000 = 8000000 cents.
    const onResult = evaluateFormula('PROVINCIAL_TAX(income, ON)', { income: 8000000 });

    const expected: Record<string, number> = {
      // Computed by hand against calcProgressiveTax's algorithm (cumulative
      // marginal, `if (incomeCents <= prev) break`) and each province's real
      // 2025 brackets at $80,000 (8,000,000 cents):
      // QC: 5325500*0.14 + (8000000-5325500)*0.19 = 745570 + 508155 = 1253725
      QC: 1253725,
      // MB: 4700000*0.108 + (8000000-4700000)*0.1275 = 507600 + 420750 = 928350
      MB: 928350,
      // SK: 5346300*0.105 + (8000000-5346300)*0.125 = 561361.5 + 331712.5 = 893074
      SK: 893074,
      // NB: 5130600*0.094 + (8000000-5130600)*0.14 = 482276.4 + 401716 = 883992.4 -> round 883992
      NB: 883992,
      // NS: 3099500*0.0879 + (6199100-3099500)*0.1495 + (8000000-6199100)*0.1667
      //   = 272455.95 + 463390.2 + 300210.03 = 1036056.18 -> round 1036056
      NS: 1036056,
      // PE: 3332800*0.095 + (6465600-3332800)*0.1347 + (8000000-6465600)*0.166
      //   = 316616 + 421988.16 + 254710.4 = 993314.56 -> round 993315
      PE: 993315,
      // NL: 4419200*0.087 + (8000000-4419200)*0.145 = 384470.4 + 519216 = 903686.4 -> round 903686
      NL: 903686,
      // YT: 5737500*0.064 + (8000000-5737500)*0.09 = 367200 + 203625 = 570825
      YT: 570825,
      // NT: 5196400*0.059 + (8000000-5196400)*0.086 = 306607.6 + 241109.6 = 547717.2 -> round 547717
      NT: 547717,
      // NU: 5470700*0.04 + (8000000-5470700)*0.07 = 218828 + 177051 = 395879
      NU: 395879,
    };

    for (const [province, expectedCents] of Object.entries(expected)) {
      const result = evaluateFormula(`PROVINCIAL_TAX(income, ${province})`, { income: 8000000 });
      expect(result).toBe(expectedCents);
      expect(result).not.toBe(onResult); // must differ from the old silent-ON-fallback behavior
    }
  });

  it('ON, BC, AB (already-covered provinces) are unaffected by this change', () => {
    const onBefore = evaluateFormula('PROVINCIAL_TAX(income, ON)', { income: 8000000 });
    const bcBefore = evaluateFormula('PROVINCIAL_TAX(income, BC)', { income: 8000000 });
    const abBefore = evaluateFormula('PROVINCIAL_TAX(income, AB)', { income: 8000000 });
    // These 3 should be untouched by this PR — pin their current (existing,
    // unchanged) bracket values so any accidental edit to ON/BC/AB is
    // caught. Computed by hand against the CURRENT (pre-this-PR) tables:
    // ON: 5114200*0.0505 + (8000000-5114200)*0.0915 = 258217.1 + 264130.7 = 522347.8 -> 522348
    // BC: 4707400*0.0506 + (8000000-4707400)*0.077 = 238154.44 + 253550.2 = 491704.64 -> 491705
    // AB: 8000000*0.10 = 800000 (all of $80,000 falls in AB's first bracket, which extends to $142,122)
    expect(onBefore).toBe(522348);
    expect(bcBefore).toBe(491705);
    expect(abBefore).toBe(800000);
  });

  it('an unrecognized province code still falls back to ON (documented, intentional fallback for genuinely invalid input)', () => {
    const result = evaluateFormula('PROVINCIAL_TAX(income, ZZ)', { income: 8000000 });
    const onResult = evaluateFormula('PROVINCIAL_TAX(income, ON)', { income: 8000000 });
    expect(result).toBe(onResult);
  });
});
```

**Before running this test**, compute the exact expected `PROVINCIAL_TAX` cents value for each of the 10 provinces/territories at $80,000 (8,000,000 cents) by hand, using each province's real bracket table from this plan's "Sourced Data" section and the existing `calcProgressiveTax` algorithm (sum of `(min(income, bracket.limit) - prev) * bracket.rate` per bracket, cumulative). Show your work in a comment above each expected value, matching the style of the existing `us-tax-brackets.test.ts` tests in this repo (`packages/agentbook-jurisdictions/src/__tests__/us-tax-brackets.test.ts` is a good reference for this "show your arithmetic in a comment" convention). The values in the `expected` object above are placeholders from initial estimation — VERIFY EACH ONE BY HAND before trusting it, correct any that are wrong, and do not skip this verification step. Also compute and verify the real current ON/BC/AB values for the second test (the `7297720`/`6098096`/`9600000` placeholders above also need hand-verification against the EXISTING, unchanged ON/BC/AB tables in the current file).

- [ ] **Step 3: Run the tests and confirm they fail** (all 10 new provinces currently compute the Ontario figure, not their own).

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-forms-provincial-brackets.test.ts`
Expected: the "distinct tax figure" test FAILS for all 10 (each currently equals the ON figure); the ON/BC/AB pinning test and the ZZ-fallback test may already pass (that's fine — they exist to lock in unchanged/intentional behavior, not all tests need to fail first).

- [ ] **Step 4: Confirm `evaluateFormula` is actually exported** (it must be, for the test above to import it) — check the current `export` statement on `evaluateFormula` in `tax-forms.ts`; it already appears to be exported based on this plan's research, but re-confirm before writing the import.

- [ ] **Step 5: Replace `PROVINCIAL_BRACKETS` with the complete 13-jurisdiction table**

Replace the `PROVINCIAL_BRACKETS` constant in `plugins/agentbook-tax/backend/src/tax-forms.ts` with:

```ts
// Provincial/territorial tax brackets, 2025 tax year, in cents. All 13
// Canadian provinces/territories — CA-GATE remediation: this table
// previously only had ON/BC/AB, with every other province/territory
// silently computing Ontario's rate via the `|| PROVINCIAL_BRACKETS['ON']`
// fallback below. Sources: each jurisdiction's own department of
// finance/revenue page (Revenu Québec for QC, Government of Manitoba,
// Saskatchewan's official 2025 Personal Income Tax Structure page, New
// Brunswick Finance, Nova Scotia's "Personal income tax rates and
// indexation" page, Newfoundland and Labrador Finance, Nunavut's official
// September 2025 Tax Rate Sheet), cross-checked against TaxTips.ca and EY's
// 2025 combined federal/provincial rate tables for PE/YT/NT. Quebec's
// separate ~16.5% federal-abatement mechanic is NOT modeled here — this is
// Quebec's own provincial bracket schedule only, matching every other
// province's "one flat additive provincial-bracket table" treatment in
// this simplified engine.
const PROVINCIAL_BRACKETS: Record<string, { limit: number; rate: number }[]> = {
  ON: [
    { limit: 5114200, rate: 0.0505 },
    { limit: 10228400, rate: 0.0915 },
    { limit: 15000000, rate: 0.1116 },
    { limit: 22000000, rate: 0.1216 },
    { limit: Infinity, rate: 0.1316 },
  ],
  BC: [
    { limit: 4707400, rate: 0.0506 },
    { limit: 9414800, rate: 0.077 },
    { limit: 10805600, rate: 0.105 },
    { limit: 13108800, rate: 0.1229 },
    { limit: 22786800, rate: 0.147 },
    { limit: Infinity, rate: 0.168 },
  ],
  AB: [
    { limit: 14212200, rate: 0.10 },
    { limit: 17070600, rate: 0.12 },
    { limit: 22769200, rate: 0.13 },
    { limit: 34153800, rate: 0.14 },
    { limit: Infinity, rate: 0.15 },
  ],
  QC: [
    { limit: 5325500, rate: 0.14 },
    { limit: 10649500, rate: 0.19 },
    { limit: 12959000, rate: 0.24 },
    { limit: Infinity, rate: 0.2575 },
  ],
  MB: [
    { limit: 4700000, rate: 0.108 },
    { limit: 10000000, rate: 0.1275 },
    { limit: Infinity, rate: 0.174 },
  ],
  SK: [
    { limit: 5346300, rate: 0.105 },
    { limit: 15275000, rate: 0.125 },
    { limit: Infinity, rate: 0.145 },
  ],
  NB: [
    { limit: 5130600, rate: 0.094 },
    { limit: 10261400, rate: 0.14 },
    { limit: 19006000, rate: 0.16 },
    { limit: Infinity, rate: 0.195 },
  ],
  NS: [
    { limit: 3099500, rate: 0.0879 },
    { limit: 6199100, rate: 0.1495 },
    { limit: 9741700, rate: 0.1667 },
    { limit: 15712400, rate: 0.175 },
    { limit: Infinity, rate: 0.21 },
  ],
  PE: [
    { limit: 3332800, rate: 0.095 },
    { limit: 6465600, rate: 0.1347 },
    { limit: 10500000, rate: 0.166 },
    { limit: 14000000, rate: 0.1762 },
    { limit: Infinity, rate: 0.19 },
  ],
  NL: [
    { limit: 4419200, rate: 0.087 },
    { limit: 8838200, rate: 0.145 },
    { limit: 15779200, rate: 0.158 },
    { limit: 22091000, rate: 0.178 },
    { limit: 28221400, rate: 0.198 },
    { limit: 56442900, rate: 0.208 },
    { limit: 112885800, rate: 0.213 },
    { limit: Infinity, rate: 0.218 },
  ],
  YT: [
    { limit: 5737500, rate: 0.064 },
    { limit: 11475000, rate: 0.09 },
    { limit: 17788200, rate: 0.109 },
    { limit: 50000000, rate: 0.128 },
    { limit: Infinity, rate: 0.15 },
  ],
  NT: [
    { limit: 5196400, rate: 0.059 },
    { limit: 10393000, rate: 0.086 },
    { limit: 16896700, rate: 0.122 },
    { limit: Infinity, rate: 0.1405 },
  ],
  NU: [
    { limit: 5470700, rate: 0.04 },
    { limit: 10941300, rate: 0.07 },
    { limit: 17788100, rate: 0.09 },
    { limit: Infinity, rate: 0.115 },
  ],
};
```

- [ ] **Step 6: Run the tests again and confirm all pass**

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-forms-provincial-brackets.test.ts`
Expected: ALL tests PASS, including all 10 previously-failing "distinct tax figure" assertions.

- [ ] **Step 7: Run the broader `agentbook-tax` backend test suite** to confirm no other test relies on the old ON-fallback behavior for a non-ON/BC/AB province.

Run: `cd plugins/agentbook-tax/backend && npx vitest run`
Expected: all pass. If any test hardcodes an expected provincial-tax figure for one of the 10 newly-added provinces (unlikely, since no prior test existed for this path — confirmed in Step 1 — but verify), recompute by hand and update it.

- [ ] **Step 8: Run the `apps/web-next` T1 tax-filing route's tests** to confirm the live auto-populate path isn't broken.

Run: `find apps/web-next/src/__tests__ -iname "*tax-filing*"` first to locate any relevant test file, then run it if one exists (e.g. `cd apps/web-next && npx vitest run <path-found>`). If no test file covers this route at all, note that explicitly in your report rather than skipping silently — this file's `provincial_tax_42800` field is the actual acceptance-criteria-named consumer ("feeding into the live T1 auto-populate route").

- [ ] **Step 9: Commit**

```bash
git add plugins/agentbook-tax/backend/src/tax-forms.ts plugins/agentbook-tax/backend/src/__tests__/tax-forms-provincial-brackets.test.ts
git commit -m "fix(tax): add real 2025 provincial/territorial brackets for all 13 CA jurisdictions

CA-GATE remediation: PROVINCIAL_BRACKETS previously only covered ON/BC/AB;
every other province/territory (QC, MB, SK, NB, NS, PE, NL, YT, NT, NU)
silently fell through to PROVINCIAL_BRACKETS['ON'], computing Ontario's
rate for any other jurisdiction. Adds real 2025 brackets for all 10,
sourced from each province's own department of finance/revenue page, plus
the first-ever test coverage for evaluateFormula's PROVINCIAL_TAX and
PROGRESSIVE_TAX formula paths."
```

## Self-Review

- Spec coverage: closes PR CA-1's full acceptance criteria — every Canadian province and territory now has its own real 2025 bracket table feeding the live T1 auto-populate route; no province silently inherits another's rate. The genuinely-invalid-input fallback (an unrecognized code) intentionally still falls back to ON, which is reasonable defensive behavior for malformed input, not the bug being fixed (the bug was real province codes falling through, which is now impossible since all 13 real codes have explicit entries).
- Placeholder scan: the "Sourced Data" section gives every exact rate/threshold; the test file's `expected` object is explicitly flagged as needing hand-verification before use, which is a real, disclosed task step — not a missing requirement.
- Type consistency: no interface/type changes — `PROVINCIAL_BRACKETS`'s type (`Record<string, { limit: number; rate: number }[]>`), `calcProgressiveTax`, and `evaluateFormula`'s signature are all unchanged; only the data table's size grows from 3 to 13 entries.
