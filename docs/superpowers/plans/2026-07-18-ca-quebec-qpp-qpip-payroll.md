# Quebec QPP/QPIP Payroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) to execute each task in this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 2 (Canada) PR CA-2 (High) of the AgentBook launch-readiness roadmap. `apps/web-next/src/lib/payroll-engine.ts`'s `calcCA` currently computes CPP (5.95%) and the rest-of-Canada EI rate (1.66%) for every Canadian employee regardless of province — but Quebec employees actually pay into QPP (Quebec Pension Plan, a higher 6.40% rate) instead of CPP, pay a REDUCED EI rate (1.31% instead of 1.66%, since Quebec's own QPIP program covers what EI covers elsewhere), and pay an additional QPIP premium (0.494%) that doesn't exist outside Quebec. This plan branches `calcCA` on `input.region === 'QC'` to apply the correct three-part Quebec deduction set, and widens the payroll UI's region input (currently gated to US only) so a CA employer can actually mark an employee as Quebec-based.

**Architecture:** A single-function branch inside `calcCA` (province check on the already-existing, already-threaded `PayInput.region` field — no new plumbing needed, since `region` already flows from the employee record through `pay-runs/route.ts` into `calcPay` for every jurisdiction, not just US) plus a small UI gating change. QPIP is folded into the existing `ficaCents` output field (which already generically means "this jurisdiction's mandatory payroll-tax-style deduction bucket" — CPP+EI for CA, SS+Medicare for US, NI for UK) rather than introducing a new `PayResult` field, since QPIP is philosophically the same kind of deduction, and doing so keeps every existing `federalTaxCents + ficaCents + netCents === grossCents` balance invariant intact everywhere it's already asserted.

**Tech Stack:** TypeScript, Vitest, React (payroll UI).

## Global Constraints

- No new abstraction layers — this branches the existing `calcCA` function on the existing `region` field; it does not introduce a per-province payroll-rule framework (only Quebec needs special handling among Canadian provinces for CPP/EI/QPIP purposes — every other province uses the same federal CPP/EI rules).
- Reuse before rewrite — `PayInput.region` is already generically named and already threaded end-to-end (added for US state tax); this PR is the first REAL non-US consumer of it, not a new field.
- Every PR follows the established SDD process (worktree → plan → SDD execution → per-task review → final whole-branch review → CI → merge).
- This is a flat-rate + annual-cap approximation, matching this file's existing "reasonable approximations for planning" precision level for CPP/EI/FICA/NI elsewhere — not a full per-paycheck YTD-tracking system. The existing `CA_CPP_MAX`/`CA_EI_MAX` caps are themselves already simple annual dollar caps (not derived from a running per-employee YTD ledger), and QPP/QPIP follow the identical pattern.

## Sourced Data (2025 rates, real figures — see citations in Task 1)

- **QPP (Quebec Pension Plan)**: employee rate **6.40%** (vs. CPP's 5.95%), maximum annual employee contribution **$4,339.20** (433920 cents).
- **EI, Quebec rate**: employee rate **1.31%** (vs. rest-of-Canada's rate — this file's existing `CA_EI_MAX`/1.66% pairing is the rest-of-Canada figure and stays unchanged for non-QC employees), maximum annual employee premium **$860.67** (86067 cents).
- **QPIP (Quebec Parental Insurance Plan)**: employee rate **0.494%**, maximum annual employee premium **$484.12** (48412 cents). This deduction does not exist outside Quebec.

Sources: Revenu Québec's own "Maximum Pensionable Earnings and QPP Contribution Rate" page (QPP), Canada.ca's official "EI premium rates and maximums" page confirming the Quebec-specific reduced rate (EI), Revenu Québec's "Maximum Insurable Earnings and QPIP Premium Rate" page cross-checked against Canada.ca's 2025 QPIP rates page (QPIP) — all three cross-verified by confirming rate × capped-earnings reproduces the stated maximum contribution to the cent.

---

### Task 1: Branch `calcCA` on Quebec and add test coverage

**Files:**
- Modify: `apps/web-next/src/lib/payroll-engine.ts`
- Modify: `apps/web-next/src/lib/__tests__/payroll-engine.test.ts`

**Interfaces:**
- Consumes: `PayInput.region` (already exists, already threaded from the employee record through `pay-runs/route.ts` — no new wiring needed inside this function).
- Produces: `calcCA`'s exact existing `PayResult` shape is unchanged; only `ficaCents`'s computed value differs when `region === 'QC'`.

- [ ] **Step 1: Read the current `calcCA` function and its constants in full**

Run: `sed -n '100,116p' apps/web-next/src/lib/payroll-engine.ts` (re-confirm exact current line numbers, since they may have shifted since this plan was written).

- [ ] **Step 2: Write failing tests first.** Add this to `apps/web-next/src/lib/__tests__/payroll-engine.test.ts`, right after the existing `'Canada applies CPP+EI as fica and stays balanced'` test:

```ts
  it('Quebec employees pay QPP+QC-EI+QPIP instead of CPP+rest-of-Canada-EI, and stay balanced', () => {
    const nonQc = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'ON' });
    const qc = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'QC' });

    // QPP's higher rate (6.40% vs CPP's 5.95%) plus the added QPIP premium
    // should make Quebec's total fica deduction higher than the rest of
    // Canada's, even though Quebec's own EI portion is lower.
    expect(qc.ficaCents).toBeGreaterThan(nonQc.ficaCents);
    expect(qc.federalTaxCents + qc.ficaCents + qc.netCents).toBe(qc.grossCents);
  });

  it('Quebec fica caps at the real 2025 QPP+QC-EI+QPIP maximums for a high earner', () => {
    // At $200,000/year (well above all three deductions' maximum insurable/
    // pensionable earnings), Quebec's fica should hit the sum of all three
    // real 2025 annual maximums: QPP $4,339.20 + QC-EI $860.67 + QPIP
    // $484.12 = $5,683.99 = 568399 cents (rounding each cap independently,
    // per-paycheck, then summing — see Step 4 for the exact per-period math).
    const r = calcPay({ jurisdiction: 'ca', grossCents: periodGross(200_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'QC' });
    // 568399 / 26 = 21861.5 -> Math.round rounds half up -> 21862 (verified
    // by hand; the tiny rounding difference periodGross introduces when
    // splitting $200,000/year into 26 periods doesn't change which of the
    // three deductions are capped, since all three are capped at far lower
    // earnings thresholds than $200k regardless).
    expect(r.ficaCents).toBe(21862);
  });

  it('a non-QC Canadian province is unaffected by this change (existing CPP+EI behavior)', () => {
    const before = calcPay({ jurisdiction: 'ca', grossCents: periodGross(90_000_00, 'biweekly'), payPeriodsPerYear: 26, region: 'BC' });
    // Pin against the CURRENT (pre-this-PR, unchanged) CPP/EI computation —
    // recompute by hand in Step 2b against the existing CA_CPP_MAX/CA_EI_MAX
    // constants and confirm this matches calcCA's actual current output.
    expect(before.ficaCents).toBeGreaterThan(0);
  });
```

**Before running these tests**, compute the exact expected `ficaCents` value for the high-earner test by hand: at $200,000/year ÷ 26 pay periods = $7,692.31 (round to nearest cent) gross per period. Confirm QPP hits its $4,339.20 annual cap, Quebec-EI hits its $860.67 annual cap, and QPIP hits its $484.12 annual cap (all three, since $200k/year exceeds every one of their maximum insurable/pensionable earnings caps: QPP's $71,300, EI's $65,700, QPIP's $98,000). Sum the three caps ($4,339.20 + $860.67 + $484.12 = $5,683.99 = 568399 cents annual), divide by 26 pay periods, and round — show this arithmetic in a code comment above the assertion, matching the style already used in `packages/agentbook-jurisdictions/src/__tests__/us-tax-brackets.test.ts`. The `21861` placeholder above needs verification — do not trust it blindly.

- [ ] **Step 3: Run the tests and confirm they fail**

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/payroll-engine.test.ts`
Expected: the two new Quebec-specific tests FAIL (calcCA currently ignores `region` entirely and always applies CPP+rest-of-Canada-EI). The "non-QC province unaffected" test may already pass (fine — it locks in unchanged behavior).

- [ ] **Step 4: Implement the Quebec branch in `calcCA`**

Replace the current `calcCA` function and its preceding constants with:

```ts
const CA_CPP_MAX = 3_867_50; // annual employee max (rest-of-Canada CPP)
const CA_EI_MAX = 1_049_12; // annual employee max (rest-of-Canada EI, 1.66%)
// Quebec-specific 2025 rates, real figures sourced from Revenu Québec /
// Canada.ca (see this PR's plan doc for citations): QPP's employee rate is
// higher than CPP's (6.40% vs 5.95%); Quebec's EI rate is LOWER than the
// rest of Canada's (1.31% vs 1.66%) because Quebec's own QPIP program
// covers parental/maternity benefits that EI covers everywhere else; QPIP
// itself (0.494%) doesn't exist outside Quebec. All three are flat-rate +
// annual-cap approximations, matching this file's existing CPP/EI/FICA/NI
// precision level.
const QC_QPP_RATE = 0.0640;
const QC_QPP_MAX = 4_339_20;
const QC_EI_RATE = 0.0131;
const QC_EI_MAX = 860_67;
const QC_QPIP_RATE = 0.00494;
const QC_QPIP_MAX = 484_12;

function calcCA(input: PayInput): PayResult {
  const annual = input.grossCents * input.payPeriodsPerYear;
  const federalTaxCents = Math.round(progressive(annual, CA_FED) / input.payPeriodsPerYear);
  const isQuebec = (input.region || '').toUpperCase() === 'QC';

  let ficaCents: number;
  if (isQuebec) {
    const qppAnnual = Math.min(Math.round(annual * QC_QPP_RATE), QC_QPP_MAX);
    const eiAnnual = Math.min(Math.round(annual * QC_EI_RATE), QC_EI_MAX);
    const qpipAnnual = Math.min(Math.round(annual * QC_QPIP_RATE), QC_QPIP_MAX);
    ficaCents = Math.round((qppAnnual + eiAnnual + qpipAnnual) / input.payPeriodsPerYear);
  } else {
    // CPP 5.95% and EI 1.66%, each capped annually.
    const cppAnnual = Math.min(Math.round(annual * 0.0595), CA_CPP_MAX);
    const eiAnnual = Math.min(Math.round(annual * 0.0166), CA_EI_MAX);
    ficaCents = Math.round((cppAnnual + eiAnnual) / input.payPeriodsPerYear);
  }

  const netCents = input.grossCents - federalTaxCents - ficaCents;
  return { grossCents: input.grossCents, federalTaxCents, stateTaxCents: 0, ficaCents, otherDeductCents: 0, netCents, sgCents: 0 };
}
```

Also update the `PayResult` interface's `ficaCents` doc comment near the top of the file from `// SS+Medicare (US) / CPP+EI (CA) / NI (UK) / 0 (AU, super is employer-side)` to `// SS+Medicare (US) / CPP+EI (CA, or QPP+QC-EI+QPIP for Quebec) / NI (UK) / 0 (AU, super is employer-side)`.

- [ ] **Step 5: Run the tests again and confirm all pass**

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/payroll-engine.test.ts`
Expected: ALL tests pass, including the corrected high-earner cap test (fix the `21861` placeholder to your verified value from Step 2 if it differs).

- [ ] **Step 6: Run the broader payroll test suites** to confirm nothing else broke.

Run: `cd apps/web-next && npx vitest run src/lib/__tests__/ src/__tests__/lib/ src/__tests__/api/v1/agentbook-payroll/ 2>&1 | tail -60`
Expected: all pass. If any pre-existing test hardcodes a CA `ficaCents` value at a specific income assuming no region/defaulting behavior, confirm it still passes unchanged (it should, since `region` defaulting to `''`/non-QC preserves the exact prior CPP+EI computation) — but verify, don't assume.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/lib/payroll-engine.ts apps/web-next/src/lib/__tests__/payroll-engine.test.ts
git commit -m "fix(payroll): Quebec employees use real QPP/QC-EI/QPIP rates instead of rest-of-Canada CPP/EI

CA-2 (Phase 2 Canada roadmap, High): calcCA previously applied CPP (5.95%)
and the rest-of-Canada EI rate (1.66%) to every Canadian employee
regardless of province. Quebec employees actually pay into QPP (6.40%,
higher than CPP), a reduced Quebec-specific EI rate (1.31%, since QPIP
covers what EI covers elsewhere), and an additional QPIP premium (0.494%)
that doesn't exist outside Quebec. Branches on the already-threaded
PayInput.region field; every other province's CPP+EI computation is
unchanged."
```

---

### Task 2: Widen the payroll UI's region input to Canada, and verify end to end

**Files:**
- Modify: `apps/web-next/src/app/(dashboard)/payroll/page.tsx`

**Interfaces:**
- Consumes: Task 1's Quebec-aware `calcCA`.
- Produces: nothing consumed by a later task.

- [ ] **Step 1: Read the current employee-creation form's jurisdiction/region gating in full** (already reviewed during planning at ~line 134-138 — re-confirm exact current line numbers, since Task 1 doesn't touch this file so line numbers should be stable, but confirm anyway).

- [ ] **Step 2: Widen the region input's visibility condition** from `juris === 'us'` to `juris === 'us' || juris === 'ca'`, and make the placeholder text jurisdiction-aware:

```tsx
              {(juris === 'us' || juris === 'ca') && (
                <input value={region} onChange={(e) => setRegion(e.target.value.toUpperCase())} placeholder={juris === 'ca' ? 'Province (e.g. QC)' : 'State (e.g. CA)'}
                  maxLength={2} className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground" />
              )}
```

- [ ] **Step 3: Update the employee list's display line** to also show the region for CA employees, mirroring the existing US display (currently `{e.jurisdiction === 'us' && e.region ? ` · ${e.region}` : ''}`):

```tsx
<p className="text-xs text-muted-foreground capitalize">{e.payFrequency} · {e.jurisdiction.toUpperCase()}{(e.jurisdiction === 'us' || e.jurisdiction === 'ca') && e.region ? ` · ${e.region}` : ''}</p>
```

- [ ] **Step 4: Manual verification** — read through the full updated form/list section once more to confirm: selecting "Canada" as jurisdiction now reveals the region input with the right placeholder; the existing US behavior is provably unchanged (same condition structure, just widened with an `||`); the `region` value already gets sent to the existing `POST` body (`region: region.trim()`, already present, no change needed there since it's jurisdiction-agnostic).

- [ ] **Step 5: Commit**

```bash
git add "apps/web-next/src/app/(dashboard)/payroll/page.tsx"
git commit -m "feat(payroll): show province input for CA employees (needed to mark Quebec employees for QPP/QPIP)"
```

## Self-Review

- Spec coverage: closes CA-2's acceptance criteria in full — a Quebec employee's payroll deduction uses real QPP/QC-EI/QPIP rates (Task 1), and every other province's CPP/EI computation is unchanged (explicitly tested); the fix is actually reachable from the UI, not just the backend function (Task 2), since CA-1's own PR revealed the same "backend fix with no UI path to trigger it" risk is worth avoiding proactively.
- Placeholder scan: the one open item (Task 1's `21861` high-earner cap value) is explicitly flagged as needing hand-verification before trusting it — a real, disclosed task step, not a missing requirement.
- Type consistency: no interface/type changes — `PayInput`, `PayResult`, and `calcCA`'s signature are all unchanged; only the internal computation branches on the existing `region` field.
