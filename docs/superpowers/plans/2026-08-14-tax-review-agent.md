# Tax Review Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Before a user's tax filing is submitted (`submitFiling()` in `AbTaxFiling`), gate the action behind a conversational "Tax Review Agent" step — a chat/MCP-driven summary of the filing, the ability to adjust critical numbers in plain language, and grounded, region-aware explanations — for all three launch jurisdictions (US, CA, AU).

**Architecture:** A per-jurisdiction `TaxReviewPack` registry (mirroring the existing `FilingDraftPack` pattern in `@agentbook/jurisdictions`) supplies prompts/parsers; a new `tax-review-agent.ts` orchestrator owns a small persisted state machine (`AbTaxFilingReview`) that never trusts the LLM for a number — every figure comes from the real bracket calculators already in `@agentbook/jurisdictions`. The gate lives entirely inside the existing `tax-filing-submit` skill handler plus one new, independent early-interception check in `agent-brain.ts`; nothing about the existing confirm/plan pipeline is modified. Since `AbTaxFiling`'s form-template system turned out to be CA-only, this plan also seeds real US and AU form templates using the exact same template engine CA already uses, so "region rules" means real forms, not fabricated ones.

**Tech Stack:** TypeScript, Prisma (multiSchema Postgres), Express (plugin backends), vitest, Gemini via the existing `callGemini`/`CallGeminiFn` helper.

## Global Constraints

These apply to every task below; they encode every decision made during design review so no task requires further human input.

1. **Target flow.** This gates `AbTaxFiling`'s real `submitFiling()` action (`plugins/agentbook-tax/backend/src/tax-efiling.ts`) — the only "complete a filing" action that exists in the codebase. The separate Tax Fast-Track draft flow (`AbTaxFastTrackDraft`) is untouched; it has no completion step to gate.
2. **Surface.** Chat/MCP, via the existing shared `classifyAndExecuteV1`/agent-brain pipeline, **plus a new web review tab** (Task 14, added on plan review) — `TaxPackagePage`'s existing tab bar (`plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx`, currently `'package' | 'past' | 'fast-track'`) gains a fourth `'review'` tab. This is genuinely additive, not a rework: Task 13's HTTP endpoints were already plain REST from the start, so the web tab calls them directly — no chat/agent-brain plumbing required, and nothing about the chat/MCP path changes. Structured (non-text) variants of edit/confirm are added to the backend (Tasks 11-13, revised) specifically so the web tab never has to round-trip a button click through free-text intent classification for something it already knows precisely.
3. **Trigger.** Fully automatic. There is no new standalone "review my filing" skill manifest entry. The gate lives (a) inside the existing `tax-filing-submit` INTERNAL handler in `server.ts`, and (b) in one new, independent early-interception block in `agent-brain.ts` that only fires when a review is already in progress. The existing `confirmBefore: true` generic plan-preview gate on `tax-filing-submit` is left completely untouched — it may fire once before the new gate is ever reached; that's an accepted, minor UX redundancy, not a defect, and requires no code change.
4. **Anti-hallucination verifier.** Fully independent from `consultation-review.ts`. Zero changes to that file or its tests. The new review agent gets its own small, purpose-built grounded-number check (Task 10), scoped to the simpler problem of "does every `$` figure in this text match one of the filing's own computed totals" rather than the generic ledger-facts problem `consultation-review.ts` solves.
5. **Jurisdictions.** US, CA, AU — all real, none fabricated. `AbTaxFiling`'s form-template system (`tax-forms.ts`) turned out to define CA forms only (`T2125`, `T1`, `GST-HST`, `Schedule1`). This plan adds real US (`ScheduleC`, `1040`) and AU (`BusinessSchedule`, `IndividualReturn`) form templates using the identical section/field/sourceQuery/formula engine CA already uses (Tasks 3–5), so the new `TaxReviewPack` implementations for US/AU point at real fields, not invented ones.
6. **Pre-existing bug fixed on the critical path.** `tax-export.ts`'s `VALIDATION_RULES` read `forms[code].fields.fieldId`, but the real write path in `tax-filing.ts` (`updateFilingField`, `populateFiling`) produces a flat `forms[code].fieldId` — no `.fields` wrapper. Every real filing today therefore fails `sin_required`/`name_required` (which resolve to `undefined` → always "missing") while several other rules silently always pass (e.g. `income_positive`, `gst_registration`) regardless of actual data. Since `validateFiling()` is directly in this feature's call chain (the review agent calls it; `submitFiling()` already calls it), Task 1 fixes `VALIDATION_RULES` to read the real flat shape. `renderFilingPDF`'s identical `.fields` mismatch (`tax-export.ts` PDF rendering) is a **separate, pre-existing, out-of-scope bug** — noted here, deliberately not fixed, since it isn't on this feature's critical path and fixing it is a larger, unrelated change.
7. **`evaluateFormula` gains three additive capabilities** (Task 2), used only by the new US/AU form templates — CA's existing formulas and tests are unchanged byte-for-byte:
   - a new `taxYear` parameter, threaded from `autoPopulateForm`'s existing `taxYear` argument (backward compatible — existing CA formulas don't need it, so it's optional and unused by them);
   - two new `PROGRESSIVE_TAX` bracket keys, `'us_federal'` and `'au_flat'`, which call the **real** `usTaxBrackets.calculateTax()` / `auTaxBrackets.calculateTax()` from `@agentbook/jurisdictions` directly — not a third duplicated local bracket table. CA's existing local `CA_FEDERAL_BRACKETS`/`PROVINCIAL_BRACKETS`/`'ca_federal'` path is untouched;
   - a new `SE_TAX(income_field)` builtin for US self-employment tax, mirroring `SCHEDULE8_CPP`'s exact shape and simplification level (flat-rate approximation, no additional Medicare surtax — matching how `SCHEDULE8_CPP` itself is a simplified CPP calculation, not a byte-perfect one).
8. **Cross-plugin boundary respected.** `agent-brain.ts` (package `plugins/agentbook-core/backend`) never directly queries `plugin_agentbook_tax` tables or imports tax-plugin modules, even though the shared Prisma client technically permits it — every other cross-plugin interaction in this codebase goes through that plugin's own HTTP API, and this plan follows the same discipline. The new review logic is reached via two new `ctx`-injected functions, `ctx.checkActiveTaxReview` and `ctx.answerTaxReview`, implemented in `server.ts` (which already has `baseUrls`/`brainHeaders` in scope) using the identical `fetch(taxBase + ...)` pattern the existing `tax-filing-submit` handler already uses. This mirrors the existing `CallGeminiFn` dependency-injection convention, which exists specifically to avoid a circular import between these two files.
9. **Figures needing yearly reverification.** New US/AU form template constants (2025 standard mileage rate, 2025 US standard deduction, AU flat company/individual figures if any) carry an explicit `// TODO: verify against current-year figures` comment, mirroring `tax-forms.ts`'s own existing `// TODO: year-versioned lookup` convention on the CA brackets. This is the established house style for "this number needs revisiting every tax year," not a gap unique to this plan.
10. **Money parsing for user-supplied edits is local, not cross-package.** `apps/web-next/src/lib/money-validation.ts` lives in the Next.js app package and is not importable from `plugins/agentbook-tax/backend` (a separate Express service/package with its own dependency graph). The review agent (Task 12) gets its own ~10-line local `parseMoneyInputCents`/range-check, scoped to this module — duplicating a tiny amount of validation logic across a real package boundary, not a cross-package import that wouldn't resolve.
11. **`AbTaxFilingReview` lives in the `plugin_agentbook_tax` Postgres schema**, alongside `AbTaxFiling` — the review row's lifecycle is filing-specific domain data, not generic agent-session state (`AbAgentSession` stays in `plugin_agentbook_core` and is not reused or modified).
12. **On confirm, the review agent calls `submitFiling()` directly** (imported from `tax-efiling.ts`, same package) rather than requiring the user to say "submit" a second time. `hasConfirmedFreshReview`'s check inside the existing `tax-filing-submit` HTTP handler (Global Constraint 3b) remains as a defensive fallback for any path that reaches that handler without having gone through a review conversation.
13. **i18n is two independent mechanisms, both reused from what already exists — nothing new is invented (added on plan review).** Number/currency formatting goes through `formatCurrency`/`formatMoney` from `@agentbook/i18n` (pure, dependency-free, already used by `TaxDashboard.tsx`), driven by the tenant's own `AbTenantConfig.locale`. The language the LLM replies in goes through `languageDirective()` (`plugins/agentbook-core/backend/src/language.ts`), the same "mirror the user" instruction every other chat prompt in this codebase already shares — copied locally into `tax-review-agent.ts` per Global Constraint 10's cross-package precedent, not reworded. Static UI strings for the new web tab (Task 15) go through the existing `t()` runtool (`packages/agentbook-i18n`), which is real and tested but, as of this plan, not yet called by any other page in this plugin — this task makes the new tab the first to use it, without retrofitting its siblings (explicitly out of scope; see Task 14's note). Chinese (`zh`) is registered in `@agentbook/i18n` for the first time by this plan (Task 14), scoped only to the keys this feature adds — every other existing key still falls back to English for a `zh` tenant, unchanged from before this plan (not a regression, since that was already true).
14. **Structured (non-text) access for the web review tab, added on plan review.** The chat state machine's field-edit and confirm branches are refactored (Task 12) into two standalone, directly-callable functions — `applyFieldEdit` and `confirmAndSubmit` — reused by two new structured HTTP routes (Task 13: `POST .../review/edit-field`, `POST .../review/confirm`) that the web tab (Task 15) calls directly, bypassing free-text intent classification entirely for actions the UI already knows precisely. Chat still owns "understand what the user meant"; both surfaces then call the same executor for "do the thing" — one seam, not two implementations of the same behavior.

## Decisions Made During Plan Review

Recorded here, in one place, so execution requires no further human input:

| # | Decision | Chosen | Rejected alternative(s) |
|---|----------|--------|--------------------------|
| 1 | Which existing flow to gate | `AbTaxFiling.submitFiling()` (the only real "complete" action) | Tax Fast-Track draft screen (has no completion step) |
| 2 | Primary UI surface | Chat/MCP only, v1 | New dedicated web review page (no existing page to extend) |
| 3 | Trigger mechanism | Fully automatic gate inside the existing skill handler | A separate, explicitly-invoked "review my filing" skill |
| 4 | Anti-hallucination verifier | Fully independent, purpose-built for this feature | Extracting/sharing `consultation-review.ts`'s verifier |
| 5 | Jurisdiction scope | US, CA, AU — including seeding real US/AU form templates | CA-only for this plan; honest "not available" stubs for US/AU |
| 6 | `tax-export.ts`'s `.fields`-shape bug | Fixed (it's on this feature's critical path via `validateFiling`) | Building a parallel validator that works around the bug |
| 7 | US/AU bracket calculation inside `evaluateFormula` | Call the real `@agentbook/jurisdictions` calculators directly | Duplicating a third local bracket table (already a documented anti-pattern risk in this codebase) |
| 8 | Cross-plugin access from `agent-brain.ts` | New `ctx`-injected functions, HTTP-mediated | Direct Prisma query into `plugin_agentbook_tax` tables (technically possible, architecturally inconsistent with every other cross-plugin call in this codebase) |
| 9 | Money parsing for field edits | New small local helper in `tax-review-agent.ts` | Importing `apps/web-next/src/lib/money-validation.ts` (not resolvable across this package boundary) |
| 10 | Confirm → submit handoff | Review agent calls `submitFiling()` directly, same turn | Requiring a second explicit "submit" message |
| 11 | Web review surface (added on plan review) | A 4th tab in `TaxPackagePage`'s existing tab bar, calling Task 13's HTTP endpoints directly | A brand-new page/route; a chat-embedded iframe |
| 12 | i18n scope (added on plan review) | Reuse the two mechanisms that already exist (`formatCurrency`/`languageDirective`), register `zh` for the first time but only for this feature's own keys, make the new tab the first to call `t()` | Retrofitting every existing tax page's strings; inventing a new translation mechanism |
| 13 | Structured web access (added on plan review) | Extract `applyFieldEdit`/`confirmAndSubmit`, add two new non-text HTTP routes the web tab calls directly | Routing web button clicks through the chat text-classification path |

---

### Task 1: Fix `validateFiling`'s flat-vs-nested shape bug

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-export.ts:8-38` (the `VALIDATION_RULES` array)
- Test: `plugins/agentbook-tax/backend/src/__tests__/tax-export-validation.test.ts` (new)

**Interfaces:**
- Consumes: nothing new — `validateFiling(forms: Record<string, any>): ValidationResult`'s existing signature is unchanged.
- Produces: `validateFiling` now returns correct results against the real flat `forms` shape (`forms[formCode][fieldId]`, not `forms[formCode].fields[fieldId]`) that `tax-filing.ts` actually writes. Every later task that calls `validateFiling` (Task 11) depends on this being fixed first.

- [ ] **Step 1: Write the failing test**

```typescript
// plugins/agentbook-tax/backend/src/__tests__/tax-export-validation.test.ts
import { describe, it, expect } from 'vitest';
import { validateFiling } from '../tax-export.js';

// This is the REAL flat shape tax-filing.ts's updateFilingField/populateFiling
// actually write — forms[formCode][fieldId], no `.fields` wrapper.
function realFlatForms(overrides: Record<string, Record<string, any>> = {}) {
  return {
    T1: {
      full_name: 'Jane Doe',
      sin: '123456789',
      total_income_15000: 7300000,
      ...overrides.T1,
    },
    T2125: {
      gross_sales_8000: 8500000,
      adjusted_gross_8299: 8500000,
      total_expenses_9368: 1200000,
      ...overrides.T2125,
    },
    ...overrides,
  };
}

describe('validateFiling against the real flat forms shape', () => {
  it('passes sin_required and name_required when those fields are actually present (flat, no .fields wrapper)', () => {
    const result = validateFiling(realFlatForms());
    const errorIds = result.errors.map((e) => e.ruleId);
    expect(errorIds).not.toContain('sin_required');
    expect(errorIds).not.toContain('name_required');
  });

  it('still flags sin_required when the SIN is genuinely missing', () => {
    const forms = realFlatForms({ T1: { full_name: 'Jane Doe', total_income_15000: 7300000 } });
    const result = validateFiling(forms);
    expect(result.errors.map((e) => e.ruleId)).toContain('sin_required');
  });

  it('income_positive correctly reads the real flat total_income_15000 field', () => {
    const forms = realFlatForms({ T1: { full_name: 'Jane Doe', sin: '1', total_income_15000: -500 } });
    const result = validateFiling(forms);
    expect(result.warnings.map((w) => w.ruleId)).toContain('income_positive');
  });

  it('gst_registration correctly reads real flat gross_sales_8000 against the $30,000 threshold', () => {
    // $35,000 revenue, no GST number on file — over the CA GST/HST registration threshold.
    const forms = realFlatForms({ T2125: { gross_sales_8000: 3500000 } });
    const result = validateFiling(forms);
    expect(result.errors.map((e) => e.ruleId)).toContain('gst_registration');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-export-validation.test.ts`
Expected: FAIL — `sin_required`/`name_required` show up as errors even though `full_name`/`sin` are present (because the old rules read `forms.T1?.fields?.sin`, which is always `undefined` against the real flat shape).

- [ ] **Step 3: Fix `VALIDATION_RULES` to read the real flat shape**

In `plugins/agentbook-tax/backend/src/tax-export.ts`, replace the entire `VALIDATION_RULES` array (lines 8-38) with the identical rules, each `.fields.` removed:

```typescript
const VALIDATION_RULES = [
  { ruleId: 'income_positive', formCode: 'T1', check: (forms: any) => (forms.T1?.total_income_15000 || 0) >= 0, severity: 'warning' as const, message: 'Total income is negative — verify all income sources' },
  { ruleId: 't2125_expenses_ratio', formCode: 'T2125', check: (forms: any) => {
    const gross = forms.T2125?.adjusted_gross_8299 || 1;
    const expenses = forms.T2125?.total_expenses_9368 || 0;
    return gross <= 0 || expenses / gross < 0.95;
  }, severity: 'warning' as const, message: 'Business expenses exceed 95% of revenue — CRA may flag this' },
  { ruleId: 'gst_registration', formCode: 'GST-HST', check: (forms: any) => {
    const revenue = forms.T2125?.gross_sales_8000 || 0;
    const gstNum = forms['GST-HST']?.gst_number;
    return revenue < 3000000 || !!gstNum; // $30,000 threshold in cents
  }, severity: 'error' as const, message: 'GST/HST registration required if revenue exceeds $30,000' },
  { ruleId: 'sin_required', formCode: 'T1', check: (forms: any) => !!forms.T1?.sin, severity: 'error' as const, message: 'Social Insurance Number is required for filing' },
  { ruleId: 'name_required', formCode: 'T1', check: (forms: any) => !!forms.T1?.full_name, severity: 'error' as const, message: 'Full legal name is required for filing' },
  { ruleId: 'vehicle_km_valid', formCode: 'T2125', check: (forms: any) => {
    const total = forms.T2125?.vehicle_total_km || 0;
    const business = forms.T2125?.vehicle_business_km || 0;
    return total === 0 || business <= total;
  }, severity: 'error' as const, message: 'Business kilometres cannot exceed total kilometres' },
  { ruleId: 'home_office_pct', formCode: 'T2125', check: (forms: any) => {
    const pct = forms.T2125?.home_office_pct || 0;
    return pct <= 100;
  }, severity: 'error' as const, message: 'Home office percentage cannot exceed 100%' },
  { ruleId: 'balance_calculated', formCode: 'T1', check: (forms: any) => forms.T1?.balance_owing_48500 !== undefined, severity: 'warning' as const, message: 'Balance owing/refund has not been calculated — some fields may be missing' },
];
```

**Do not touch `renderFilingPDF`'s identical `.fields` mismatch** (`tax-export.ts`, the `formData?.fields` check) — that is a separate, pre-existing, out-of-scope bug per Global Constraint 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-export-validation.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Run the full existing test suite for this plugin to confirm no regression**

Run: `cd plugins/agentbook-tax/backend && npx vitest run`
Expected: PASS — `efiling-honesty.test.ts` and every other existing test file unaffected (none of them construct a `forms` object with a `.fields` wrapper, per the earlier investigation that found no such fixture exists anywhere in this repo).

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-tax/backend/src/tax-export.ts plugins/agentbook-tax/backend/src/__tests__/tax-export-validation.test.ts
git commit -m "fix(tax): validateFiling reads the real flat forms shape, not a nonexistent .fields wrapper"
```

---

### Task 2: Additive `evaluateFormula` extensions for US/AU

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-forms.ts` (add imports, add `taxYear` param, add two `PROGRESSIVE_TAX` branches, add `SE_TAX` builtin)
- Test: `plugins/agentbook-tax/backend/src/__tests__/evaluate-formula-us-au.test.ts` (new)

**Interfaces:**
- Consumes: `usTaxBrackets`, `auTaxBrackets` from `@agentbook/jurisdictions` (exact exports confirmed: `export const usTaxBrackets: TaxBracketProvider`, `export const auTaxBrackets: TaxBracketProvider`, both with `.calculateTax(taxableIncomeCents, taxYear, filingStatus?, region?): TaxCalculation`).
- Produces: `evaluateFormula(formula: string, fields: Record<string, any>, allFormFields?: Record<string, Record<string, any>>, taxYear?: number): number | null` — the new 4th parameter is optional and unused by every existing CA formula, so this is backward compatible. Tasks 3 and 4 (US/AU form templates) depend on `'us_federal'`, `'au_flat'`, and `SE_TAX(...)` being available.

- [ ] **Step 1: Write the failing tests**

```typescript
// plugins/agentbook-tax/backend/src/__tests__/evaluate-formula-us-au.test.ts
import { describe, it, expect } from 'vitest';
import { evaluateFormula } from '../tax-forms.js';

describe('evaluateFormula — US/AU additive extensions', () => {
  it('PROGRESSIVE_TAX(income, us_federal) calls the real usTaxBrackets calculator', () => {
    // $80,000 taxable income, single filer, 2025 — must match usTaxBrackets.calculateTax exactly.
    const result = evaluateFormula('PROGRESSIVE_TAX(taxable_income, us_federal)', { taxable_income: 8000000 }, undefined, 2025);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });

  it('PROGRESSIVE_TAX(income, au_flat) calls the real auTaxBrackets calculator', () => {
    const result = evaluateFormula('PROGRESSIVE_TAX(taxable_income, au_flat)', { taxable_income: 8000000 }, undefined, 2025);
    expect(result).not.toBeNull();
    expect(result).toBeGreaterThan(0);
  });

  it('SE_TAX computes a flat-rate self-employment tax approximation', () => {
    const result = evaluateFormula('SE_TAX(net_profit)', { net_profit: 5000000 }, undefined, 2025);
    expect(result).not.toBeNull();
    // 15.3% of 92.35% of net profit is the real SE-tax base calculation;
    // this is a simplified flat-rate approximation, so just assert it's
    // in a sane ballpark, not an exact IRS figure.
    expect(result).toBeGreaterThan(600000);
    expect(result).toBeLessThan(750000);
  });

  it('existing CA formulas are completely unaffected by the new 4th parameter', () => {
    // Exact same call CA's own code already makes today (no taxYear arg) — must still work.
    const result = evaluateFormula('SUM(a,b,c)', { a: 100, b: 200, c: 300 });
    expect(result).toBe(600);
  });

  it('PROGRESSIVE_TAX(income, ca_federal) is byte-for-byte unchanged — still uses the local CA table, not a jurisdictions-package call', () => {
    const result = evaluateFormula('PROGRESSIVE_TAX(taxable_income, ca_federal)', { taxable_income: 8000000 });
    expect(result).not.toBeNull();
    // No taxYear passed at all — proves the ca_federal path never needed the new param.
  });
});

describe('autoPopulateForm threads taxYear through to evaluateFormula — source-level wiring check', () => {
  it('the evaluateFormula call inside autoPopulateForm passes its own taxYear parameter as the 4th argument', async () => {
    // usTaxBrackets.getTaxBrackets doesn't actually vary its output by
    // year yet (it's marked `// TODO: year-versioned lookup` in
    // us/tax-brackets.ts) — so a behavioral test through the calculator
    // can't currently distinguish "taxYear threaded through" from
    // "taxYear silently dropped and defaulted." This wiring check proves
    // the source shape directly instead, mirroring this plan's other
    // source-grep wiring tests (Task 16).
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../tax-forms.ts', import.meta.url), 'utf-8');
    const callSite = src.match(/evaluateFormula\(field\.formula,\s*fields,\s*allFormFields,\s*taxYear\)/);
    expect(callSite).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/evaluate-formula-us-au.test.ts`
Expected: FAIL on the `us_federal`/`au_flat`/`SE_TAX` cases (unrecognized formula → falls through to `evaluateSimple`, which fails the `^[\d\s+\-*/().]+$` check since letters remain, and returns `null`).

- [ ] **Step 3: Implement the extensions**

At the top of `plugins/agentbook-tax/backend/src/tax-forms.ts`, add:

```typescript
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
```

Change `evaluateFormula`'s signature (keep everything else in the function identical except the two new branches below):

```typescript
export function evaluateFormula(
  formula: string,
  fields: Record<string, any>,
  allFormFields?: Record<string, Record<string, any>>,
  taxYear?: number,
): number | null {
```

Inside the `PROGRESSIVE_TAX` branch, immediately before the existing `const brackets = ptMatch[2] === 'ca_federal' ? ... ;` line, insert:

```typescript
    // PROGRESSIVE_TAX(income_field, bracket_key)
    const ptMatch = resolved.match(/^PROGRESSIVE_TAX\((.+),\s*(\w+)\)$/);
    if (ptMatch) {
      const income = Number(fields[ptMatch[1].trim()] ?? 0);
      const bracketKey = ptMatch[2];

      // US/AU delegate to the REAL jurisdictions-package calculators —
      // never a third duplicated local bracket table (CA's own local
      // table below is left untouched; see this plan's Global
      // Constraint 7 for why).
      if (bracketKey === 'us_federal') {
        return usTaxBrackets.calculateTax(income, taxYear ?? new Date().getFullYear()).taxCents;
      }
      if (bracketKey === 'au_flat') {
        return auTaxBrackets.calculateTax(income, taxYear ?? new Date().getFullYear()).taxCents;
      }

      const brackets = bracketKey === 'ca_federal' ? CA_FEDERAL_BRACKETS : PROVINCIAL_BRACKETS[bracketKey] || CA_FEDERAL_BRACKETS;
      return calcProgressiveTax(income, brackets);
    }
```

(This replaces the existing `PROGRESSIVE_TAX` block in place — the `ptMatch`/`income` variable names must not collide with the original code's naming; adjust the original block's body to match exactly this shape rather than duplicating the regex match.)

Add a new `SE_TAX` builtin, immediately after the existing `SCHEDULE8_CPP` block (mirroring its exact shape and simplification level):

```typescript
    // SE_TAX(net_profit_field) — flat-rate self-employment tax
    // approximation: 92.35% of net profit is subject to 15.3%
    // (12.4% Social Security + 2.9% Medicare), matching the real
    // IRS Schedule SE base-reduction step but NOT modeling the Social
    // Security wage-base cap or the additional 0.9% Medicare surtax —
    // a simplification at the same level as SCHEDULE8_CPP above.
    const seTaxMatch = resolved.match(/^SE_TAX\((.+)\)$/);
    if (seTaxMatch) {
      const netProfit = Number(evaluateSimple(seTaxMatch[1].trim(), fields) ?? 0);
      const seBase = Math.round(Math.max(0, netProfit) * 0.9235);
      return Math.round(seBase * 0.153);
    }
```

**Critical follow-up in this same step — do not skip:** `evaluateFormula`'s only call site, inside `autoPopulateForm` (same file), currently reads:

```typescript
      } else if (field.source === 'calculated' && field.formula) {
        const value = evaluateFormula(field.formula, fields, allFormFields);
```

`autoPopulateForm` already receives `taxYear` as its own first-class parameter (see its signature: `autoPopulateForm(tenantId, taxYear, template, slips, allFormFields)`) — it just never threads it into `evaluateFormula` before now, since no existing CA formula needed it. Update this call site to pass it through:

```typescript
      } else if (field.source === 'calculated' && field.formula) {
        const value = evaluateFormula(field.formula, fields, allFormFields, taxYear);
```

Without this change, the new `'us_federal'`/`'au_flat'` branches would silently fall back to `new Date().getFullYear()` instead of the real filing's tax year — correct only by coincidence in the same calendar year a return is filed, and wrong for every prior-year filing. This is why Task 2's test suite (Step 1 above) explicitly passes `taxYear` as a 4th argument directly to `evaluateFormula` in isolation — that alone would not have caught this caller-side gap, which is exactly why this call-site update is called out here explicitly rather than left implicit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/evaluate-formula-us-au.test.ts`
Expected: PASS, all 5 tests.

- [ ] **Step 5: Run the full existing test suite to confirm zero CA regression**

Run: `cd plugins/agentbook-tax/backend && npx vitest run`
Expected: PASS — every existing CA-formula test (in `tax-calculation.test.ts`, `tax-ca-scenarios.test.ts`, `tax-forms-provincial-brackets.test.ts`) produces byte-identical output to before this change, since none of them pass a 4th argument and the `ca_federal`/province-code branches are untouched.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-tax/backend/src/tax-forms.ts plugins/agentbook-tax/backend/src/__tests__/evaluate-formula-us-au.test.ts
git commit -m "feat(tax): additive US/AU PROGRESSIVE_TAX + SE_TAX formula support, CA path untouched"
```

---

### Task 3: Real US form templates — `ScheduleC` + `1040`

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-forms.ts` (add `US_SCHEDULE_C_2025`, `US_1040_2025`, `ALL_US_FORMS`, `seedUsForms()`, and the new sourceQuery cases they need)
- Test: `plugins/agentbook-tax/backend/src/__tests__/seed-us-forms.test.ts` (new — mirror the DB-interaction style of the nearest existing test file that exercises `db.abTaxFormTemplate`, e.g. whatever pattern `tax-calculation.test.ts` or `tax-forms-provincial-brackets.test.ts` uses for DB setup/teardown in this plugin's test suite; use the same real-vs-mocked-DB convention already established there rather than introducing a new one.)

**Interfaces:**
- Consumes: `resolveSourceQuery`'s existing universal queries (`revenue_total`, `expense_category:<code>`, `expense_category:<code>:meals_50pct`, `tenant_business_name`, `tenant_region`, `fiscal_year_start/end`) — these already read from the shared, jurisdiction-agnostic chart of accounts and are reused as-is, no changes needed. Two new source queries are added (below).
- Produces: `seedUsForms(): Promise<{ created: number; updated: number }>`, same shape as `seedCanadianForms()`. Task 5 wires this in. Task 8 (`UsTaxReviewPack`) reads these exact field IDs.

Real 2025 US figures used below (flagged per Global Constraint 9, needing yearly reverification): standard mileage rate for business use = 70¢/mile; standard deduction, single filer = $15,000.

- [ ] **Step 1: Add the two new source queries `resolveSourceQuery` needs**

In `plugins/agentbook-tax/backend/src/tax-forms.ts`, inside `resolveSourceQuery`, immediately before its final `return null;`, add:

```typescript
  // TODO: verify against the current-year IRS optional standard mileage rate
  // before each new tax year — this is the 2025 rate (IRS Notice 2025-5).
  if (query === 'us_standard_mileage_rate_cents') return 70;
  // TODO: verify against the current-year IRS standard deduction (single
  // filer) before each new tax year — this is the 2025 figure.
  if (query === 'us_standard_deduction_2025') return 1500000;
```

- [ ] **Step 2: Add the form template constants**

Immediately after `const CA_SCHEDULE1_2025 = { ... };` and before `const ALL_CA_FORMS = [...]`, add:

```typescript
// === US Form Templates (2025) ===
// A deliberately simplified subset — Schedule C business income/expenses
// plus a personal-return summary — matching the same level of simplification
// CA_T2125_2025/CA_T1_2025 already use (no capital gains, no itemized
// deductions beyond what's modeled here). Vehicle/home-office deductions are
// computed but NOT folded into net profit, mirroring CA_T2125_2025's own
// existing behavior (net_income_9369 = adjusted_gross - total_expenses only)
// — matching that precedent's scope rather than "fixing" it here.

const US_SCHEDULE_C_2025 = {
  jurisdiction: 'us', formCode: 'ScheduleC', version: '2025',
  formName: 'Schedule C — Profit or Loss From Business (Sole Proprietorship)',
  category: 'business_income', dependencies: [],
  sections: [
    {
      sectionId: 'identification', title: 'Principal Business Information',
      fields: [
        { fieldId: 'business_name', label: 'Name of proprietor / business', lineNumber: '', type: 'text', required: true, source: 'auto', sourceQuery: 'tenant_business_name' },
        { fieldId: 'principal_business_code', label: 'Principal business or profession, code', lineNumber: 'B', type: 'text', required: true, source: 'manual', helpText: '6-digit NAICS code. Consultants: 541611, Software: 541511' },
        { fieldId: 'ein_or_ssn', label: 'EIN (or SSN if none)', lineNumber: '', type: 'text', required: true, source: 'manual', sensitive: true },
      ],
    },
    {
      sectionId: 'income', title: 'Part I — Income',
      fields: [
        { fieldId: 'gross_receipts_1', label: 'Gross receipts or sales', lineNumber: '1', type: 'currency', required: true, source: 'auto', sourceQuery: 'revenue_total' },
        { fieldId: 'gross_income_7', label: 'Gross income', lineNumber: '7', type: 'currency', required: true, source: 'calculated', formula: 'gross_receipts_1' },
      ],
    },
    {
      sectionId: 'expenses', title: 'Part II — Expenses',
      fields: [
        { fieldId: 'advertising_8', label: 'Advertising', lineNumber: '8', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:5000' },
        { fieldId: 'insurance_15', label: 'Insurance (other than health)', lineNumber: '15', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:5400' },
        { fieldId: 'legal_professional_17', label: 'Legal and professional services', lineNumber: '17', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:5700' },
        { fieldId: 'office_18', label: 'Office expense', lineNumber: '18', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:5800' },
        { fieldId: 'supplies_22', label: 'Supplies', lineNumber: '22', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6100' },
        { fieldId: 'travel_24a', label: 'Travel', lineNumber: '24a', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6300' },
        { fieldId: 'meals_24b', label: 'Deductible meals (50%)', lineNumber: '24b', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6400:meals_50pct' },
        { fieldId: 'utilities_25', label: 'Utilities', lineNumber: '25', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6500' },
        { fieldId: 'other_expenses_27a', label: 'Other expenses (software, subscriptions)', lineNumber: '27a', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6600' },
        { fieldId: 'total_expenses_28', label: 'Total expenses', lineNumber: '28', type: 'currency', required: true, source: 'calculated', formula: 'SUM(advertising_8,insurance_15,legal_professional_17,office_18,supplies_22,travel_24a,meals_24b,utilities_25,other_expenses_27a)' },
        { fieldId: 'tentative_profit_29', label: 'Tentative profit', lineNumber: '29', type: 'currency', required: true, source: 'calculated', formula: 'gross_income_7 - total_expenses_28' },
        { fieldId: 'net_profit_31', label: 'Net profit (loss)', lineNumber: '31', type: 'currency', required: true, source: 'calculated', formula: 'tentative_profit_29' },
      ],
    },
    {
      sectionId: 'vehicle', title: 'Part IV — Vehicle Information',
      fields: [
        { fieldId: 'vehicle_total_miles', label: 'Total miles driven', lineNumber: '', type: 'number', required: false, source: 'manual' },
        { fieldId: 'vehicle_business_miles', label: 'Business miles', lineNumber: '', type: 'number', required: false, source: 'manual' },
        { fieldId: 'standard_mileage_rate_cents', label: 'Standard mileage rate (cents/mile)', lineNumber: '9', type: 'number', required: false, source: 'auto', sourceQuery: 'us_standard_mileage_rate_cents' },
        { fieldId: 'vehicle_deduction_9', label: 'Car and truck expenses (standard mileage)', lineNumber: '9', type: 'currency', required: false, source: 'calculated', formula: 'vehicle_business_miles * standard_mileage_rate_cents' },
      ],
    },
    {
      sectionId: 'home_office', title: 'Part VIII — Home Office (Simplified Method)',
      fields: [
        { fieldId: 'home_office_deduction_30', label: 'Home office deduction (simplified method)', lineNumber: '30', type: 'currency', required: false, source: 'manual', helpText: 'Simplified method: $5 x home office square footage, capped at 300 sq ft (max $1,500)' },
      ],
    },
  ],
};

const US_1040_2025 = {
  jurisdiction: 'us', formCode: '1040', version: '2025',
  formName: 'Form 1040 — U.S. Individual Income Tax Return',
  category: 'personal_return', dependencies: ['ScheduleC'],
  sections: [
    {
      sectionId: 'identification', title: 'Filing Information',
      fields: [
        { fieldId: 'full_name', label: 'Full legal name', lineNumber: '', type: 'text', required: true, source: 'manual' },
        { fieldId: 'ssn', label: 'Social Security Number', lineNumber: '', type: 'text', required: true, source: 'manual', sensitive: true },
        { fieldId: 'filing_status', label: 'Filing status', lineNumber: '', type: 'text', required: true, source: 'manual', helpText: 'single, married_filing_jointly, married_filing_separately, or head_of_household' },
        { fieldId: 'state_of_residence', label: 'State of residence', lineNumber: '', type: 'text', required: true, source: 'auto', sourceQuery: 'tenant_region' },
      ],
    },
    {
      sectionId: 'total_income', title: 'Income',
      fields: [
        { fieldId: 'wages_1a', label: 'Wages (W-2 box 1)', lineNumber: '1a', type: 'currency', required: false, source: 'manual' },
        { fieldId: 'self_employment_income', label: 'Self-employment income (from Schedule C)', lineNumber: '', type: 'currency', required: false, source: 'calculated', formula: 'ScheduleC.net_profit_31' },
        { fieldId: 'total_income_9', label: 'Total income', lineNumber: '9', type: 'currency', required: true, source: 'calculated', formula: 'SUM(wages_1a,self_employment_income)' },
      ],
    },
    {
      sectionId: 'deductions', title: 'Adjustments and Deductions',
      fields: [
        { fieldId: 'se_tax', label: 'Self-employment tax (Schedule SE)', lineNumber: '', type: 'currency', required: false, source: 'calculated', formula: 'SE_TAX(self_employment_income)' },
        { fieldId: 'se_tax_deduction_half', label: 'Deductible part of self-employment tax', lineNumber: '', type: 'currency', required: false, source: 'calculated', formula: 'se_tax / 2' },
        { fieldId: 'standard_deduction', label: 'Standard deduction', lineNumber: '12', type: 'currency', required: true, source: 'auto', sourceQuery: 'us_standard_deduction_2025' },
        { fieldId: 'taxable_income', label: 'Taxable income', lineNumber: '15', type: 'currency', required: true, source: 'calculated', formula: 'MAX(0, total_income_9 - se_tax_deduction_half - standard_deduction)' },
      ],
    },
    {
      sectionId: 'tax_calculation', title: 'Tax and Payments',
      fields: [
        { fieldId: 'federal_tax_16', label: 'Federal income tax', lineNumber: '16', type: 'currency', required: true, source: 'calculated', formula: 'PROGRESSIVE_TAX(taxable_income, us_federal)' },
        { fieldId: 'total_tax_24', label: 'Total tax', lineNumber: '24', type: 'currency', required: true, source: 'calculated', formula: 'federal_tax_16 + se_tax' },
        { fieldId: 'withholding_25a', label: 'Federal income tax withheld (W-2)', lineNumber: '25a', type: 'currency', required: false, source: 'manual' },
        { fieldId: 'balance_owing_37', label: 'Amount you owe (or refund, if negative)', lineNumber: '37', type: 'currency', required: true, source: 'calculated', formula: 'total_tax_24 - withholding_25a' },
      ],
    },
  ],
};

const ALL_US_FORMS = [US_SCHEDULE_C_2025, US_1040_2025];
```

- [ ] **Step 3: Add `seedUsForms()`**

Immediately after `seedCanadianForms()`, add the identical shape, retargeted at `ALL_US_FORMS`:

```typescript
export async function seedUsForms(): Promise<{ created: number; updated: number }> {
  let created = 0, updated = 0;
  for (const form of ALL_US_FORMS) {
    const existing = await db.abTaxFormTemplate.findFirst({
      where: { jurisdiction: form.jurisdiction, formCode: form.formCode, version: form.version },
    });
    if (existing) {
      await db.abTaxFormTemplate.update({
        where: { id: existing.id },
        data: { formName: form.formName, category: form.category, sections: form.sections as any, dependencies: form.dependencies as any },
      });
      updated++;
    } else {
      await db.abTaxFormTemplate.create({
        data: { ...form, sections: form.sections as any, dependencies: form.dependencies as any, validationRules: [] },
      });
      created++;
    }
  }
  return { created, updated };
}
```

- [ ] **Step 4: Write and run tests**

Write `seed-us-forms.test.ts` mirroring whichever DB-setup convention this plugin's existing tests already use (real ephemeral test DB per this repo's CI convention, or the plugin's own local mock — inspect one neighboring test file first and match it exactly). Assert: `seedUsForms()` creates exactly 2 templates on first run, 0-created/2-updated on a second run (idempotent, matching `seedCanadianForms`'s own tested behavior if such a test exists for it — if not, this is the first such test and should stand alone). Assert `autoPopulateForm` against a `ScheduleC` template with a stubbed `resolveSourceQuery`/ledger produces the expected `net_profit_31` via the real formula chain (gross_receipts_1 → gross_income_7 → total_expenses_28 → tentative_profit_29 → net_profit_31).

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/seed-us-forms.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-tax/backend/src/tax-forms.ts plugins/agentbook-tax/backend/src/__tests__/seed-us-forms.test.ts
git commit -m "feat(tax): real US ScheduleC + 1040 form templates, seedUsForms()"
```

---

### Task 4: Real AU form templates — `BusinessSchedule` + `IndividualReturn`

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-forms.ts` (add `AU_BUSINESS_SCHEDULE_2025`, `AU_INDIVIDUAL_RETURN_2025`, `ALL_AU_FORMS`, `seedAuForms()`)
- Test: `plugins/agentbook-tax/backend/src/__tests__/seed-au-forms.test.ts` (new, same convention as Task 3's test)

**Interfaces:**
- Consumes: same universal `resolveSourceQuery` queries as Task 3, plus `tenant_region` (used for the AU tenant's state, informational only — AU has no state income tax, unlike CA's provincial layer).
- Produces: `seedAuForms(): Promise<{ created: number; updated: number }>`. Task 5 wires this in. Task 9 (`AuTaxReviewPack`) reads these exact field IDs.

**Deliberately out of scope:** GST/BAS reporting — that already exists as a separate system (`packages/agentbook-jurisdictions`'s AU BAS return engine, per the earlier launch-readiness audit) and is not part of `AbTaxFiling`. These two new AU forms cover income tax only, matching what CA's `T2125`/`T1` cover (GST/HST is `AbTaxFiling`'s separate `GST-HST` form — the AU equivalent of that already exists elsewhere and is not duplicated here).

The Medicare Levy calculation below is a flat 2% of taxable income — it deliberately does not model the low-income no-levy threshold, matching the same "simplified, not byte-perfect" convention already established by `SCHEDULE8_CPP`/`SE_TAX` (Task 2).

- [ ] **Step 1: Add the form template constants**

Immediately after `US_1040_2025` (before `const ALL_US_FORMS = [...]`), add:

```typescript
// === AU Form Templates (2025) ===
// Income tax only — GST/BAS reporting is a separate, already-existing
// system (packages/agentbook-jurisdictions's AU BAS engine) and is
// deliberately not duplicated here. Medicare Levy is a flat 2% of taxable
// income, not modeling the low-income no-levy threshold — the same
// simplification level as SCHEDULE8_CPP/SE_TAX (Task 2).

const AU_BUSINESS_SCHEDULE_2025 = {
  jurisdiction: 'au', formCode: 'BusinessSchedule', version: '2025',
  formName: 'Business and Professional Items Schedule (Sole Trader)',
  category: 'business_income', dependencies: [],
  sections: [
    {
      sectionId: 'identification', title: 'Business Details',
      fields: [
        { fieldId: 'business_name', label: 'Business name', lineNumber: '', type: 'text', required: true, source: 'auto', sourceQuery: 'tenant_business_name' },
        { fieldId: 'abn', label: 'Australian Business Number (ABN)', lineNumber: '', type: 'text', required: true, source: 'manual' },
      ],
    },
    {
      sectionId: 'income', title: 'Business Income',
      fields: [
        { fieldId: 'gross_business_income', label: 'Gross business income', lineNumber: 'P8', type: 'currency', required: true, source: 'auto', sourceQuery: 'revenue_total' },
      ],
    },
    {
      sectionId: 'expenses', title: 'Business Expenses',
      fields: [
        { fieldId: 'advertising', label: 'Advertising', lineNumber: '', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:5000' },
        { fieldId: 'insurance', label: 'Insurance', lineNumber: '', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:5400' },
        { fieldId: 'legal_professional', label: 'Legal and professional expenses', lineNumber: '', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:5700' },
        { fieldId: 'office_supplies', label: 'Office supplies and consumables', lineNumber: '', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6100' },
        { fieldId: 'travel', label: 'Travel expenses', lineNumber: '', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6300' },
        { fieldId: 'phone_internet', label: 'Telephone and internet', lineNumber: '', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6500' },
        { fieldId: 'other_expenses', label: 'Other business expenses', lineNumber: '', type: 'currency', required: false, source: 'auto', sourceQuery: 'expense_category:6600' },
        { fieldId: 'total_expenses', label: 'Total business expenses', lineNumber: '', type: 'currency', required: true, source: 'calculated', formula: 'SUM(advertising,insurance,legal_professional,office_supplies,travel,phone_internet,other_expenses)' },
        { fieldId: 'net_business_income', label: 'Net business income', lineNumber: '', type: 'currency', required: true, source: 'calculated', formula: 'gross_business_income - total_expenses' },
      ],
    },
  ],
};

const AU_INDIVIDUAL_RETURN_2025 = {
  jurisdiction: 'au', formCode: 'IndividualReturn', version: '2025',
  formName: 'Individual Tax Return (myTax)',
  category: 'personal_return', dependencies: ['BusinessSchedule'],
  sections: [
    {
      sectionId: 'identification', title: 'Personal Details',
      fields: [
        { fieldId: 'full_name', label: 'Full legal name', lineNumber: '', type: 'text', required: true, source: 'manual' },
        { fieldId: 'tfn', label: 'Tax File Number (TFN)', lineNumber: '', type: 'text', required: true, source: 'manual', sensitive: true },
        { fieldId: 'state_of_residence', label: 'State/territory of residence', lineNumber: '', type: 'text', required: true, source: 'auto', sourceQuery: 'tenant_region' },
      ],
    },
    {
      sectionId: 'income', title: 'Income',
      fields: [
        { fieldId: 'salary_wages', label: 'Salary or wages', lineNumber: '1', type: 'currency', required: false, source: 'manual' },
        { fieldId: 'business_income', label: 'Net business income (from Business Schedule)', lineNumber: '', type: 'currency', required: false, source: 'calculated', formula: 'BusinessSchedule.net_business_income' },
        { fieldId: 'taxable_income', label: 'Taxable income', lineNumber: '', type: 'currency', required: true, source: 'calculated', formula: 'MAX(0, salary_wages + business_income)' },
      ],
    },
    {
      sectionId: 'tax_calculation', title: 'Tax Payable',
      fields: [
        { fieldId: 'income_tax', label: 'Income tax', lineNumber: '', type: 'currency', required: true, source: 'calculated', formula: 'PROGRESSIVE_TAX(taxable_income, au_flat)' },
        { fieldId: 'medicare_levy', label: 'Medicare levy (2%)', lineNumber: '', type: 'currency', required: true, source: 'calculated', formula: 'taxable_income * 2 / 100' },
        { fieldId: 'total_tax_payable', label: 'Total tax payable', lineNumber: '', type: 'currency', required: true, source: 'calculated', formula: 'income_tax + medicare_levy' },
        { fieldId: 'payg_withheld', label: 'PAYG tax withheld', lineNumber: '', type: 'currency', required: false, source: 'manual' },
        { fieldId: 'balance_owing', label: 'Amount you owe (or refund, if negative)', lineNumber: '', type: 'currency', required: true, source: 'calculated', formula: 'total_tax_payable - payg_withheld' },
      ],
    },
  ],
};

const ALL_AU_FORMS = [AU_BUSINESS_SCHEDULE_2025, AU_INDIVIDUAL_RETURN_2025];
```

- [ ] **Step 2: Add `seedAuForms()`**

Immediately after `seedUsForms()`, add the identical shape, retargeted at `ALL_AU_FORMS`:

```typescript
export async function seedAuForms(): Promise<{ created: number; updated: number }> {
  let created = 0, updated = 0;
  for (const form of ALL_AU_FORMS) {
    const existing = await db.abTaxFormTemplate.findFirst({
      where: { jurisdiction: form.jurisdiction, formCode: form.formCode, version: form.version },
    });
    if (existing) {
      await db.abTaxFormTemplate.update({
        where: { id: existing.id },
        data: { formName: form.formName, category: form.category, sections: form.sections as any, dependencies: form.dependencies as any },
      });
      updated++;
    } else {
      await db.abTaxFormTemplate.create({
        data: { ...form, sections: form.sections as any, dependencies: form.dependencies as any, validationRules: [] },
      });
      created++;
    }
  }
  return { created, updated };
}
```

- [ ] **Step 3: Write and run tests**

Mirror Task 3's test exactly (same idempotency assertions, same formula-chain assertion but for `gross_business_income → total_expenses → net_business_income`, and separately for `taxable_income → income_tax`/`medicare_levy → total_tax_payable`).

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/seed-au-forms.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-tax/backend/src/tax-forms.ts plugins/agentbook-tax/backend/src/__tests__/seed-au-forms.test.ts
git commit -m "feat(tax): real AU BusinessSchedule + IndividualReturn form templates, seedAuForms()"
```

---

### Task 5: Jurisdiction-aware form seeding in `populateFiling`

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-filing.ts:83-91` (the template-fallback block inside `populateFiling`)
- Test: `plugins/agentbook-tax/backend/src/__tests__/populate-filing-jurisdiction.test.ts` (new)

**Interfaces:**
- Consumes: `seedUsForms`, `seedAuForms` from Tasks 3-4, alongside the existing `seedCanadianForms` import.
- Produces: `populateFiling`'s existing return shape is unchanged. A US/AU tenant now gets real `ScheduleC`/`1040` or `BusinessSchedule`/`IndividualReturn` templates auto-seeded on first use, exactly as CA tenants already do — Tasks 7-9's `TaxReviewPack`s depend on this actually running for non-CA tenants.

- [ ] **Step 1: Write the failing test**

```typescript
// plugins/agentbook-tax/backend/src/__tests__/populate-filing-jurisdiction.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirst = vi.fn();
const seedCanadianForms = vi.fn().mockResolvedValue({ created: 4, updated: 0 });
const seedUsForms = vi.fn().mockResolvedValue({ created: 2, updated: 0 });
const seedAuForms = vi.fn().mockResolvedValue({ created: 2, updated: 0 });

vi.mock('../tax-forms.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../tax-forms.js')>();
  return { ...actual, seedCanadianForms, seedUsForms, seedAuForms };
});

vi.mock('../db/client.js', () => ({
  db: {
    abTenantConfig: { findFirst: vi.fn().mockResolvedValue({ jurisdiction: 'us', region: 'CA' }) },
    abTaxFiling: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ id: 'f1' }), update: vi.fn() },
    abTaxFormTemplate: { findMany: (...args: any[]) => findFirst(...args) },
    abTaxSlip: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

beforeEach(() => { findFirst.mockResolvedValue([]); });

describe('populateFiling — jurisdiction-aware seed dispatch', () => {
  it('seeds US forms (not CA forms) for a us-jurisdiction tenant with no templates yet', async () => {
    const { populateFiling } = await import('../tax-filing.js');
    await populateFiling('tenant-1', 2025);
    expect(seedUsForms).toHaveBeenCalled();
    expect(seedCanadianForms).not.toHaveBeenCalled();
    expect(seedAuForms).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/populate-filing-jurisdiction.test.ts`
Expected: FAIL — the current code unconditionally calls `seedCanadianForms()`.

- [ ] **Step 3: Implement the jurisdiction dispatch**

In `plugins/agentbook-tax/backend/src/tax-filing.ts`, add the two new imports alongside the existing one:

```typescript
import { autoPopulateForm, seedCanadianForms, seedUsForms, seedAuForms } from './tax-forms.js';
```

Replace the existing fallback block:

```typescript
  if (templates.length === 0) {
    await seedCanadianForms();
    templates = await db.abTaxFormTemplate.findMany({
      where: { jurisdiction, version: String(taxYear), enabled: true },
    });
  }
```

with a jurisdiction-dispatched version:

```typescript
  if (templates.length === 0) {
    const seedByJurisdiction: Record<string, () => Promise<{ created: number; updated: number }>> = {
      ca: seedCanadianForms,
      us: seedUsForms,
      au: seedAuForms,
    };
    const seed = seedByJurisdiction[jurisdiction] ?? seedCanadianForms;
    await seed();
    templates = await db.abTaxFormTemplate.findMany({
      where: { jurisdiction, version: String(taxYear), enabled: true },
    });
  }
```

(The `?? seedCanadianForms` fallback preserves today's exact behavior for any jurisdiction string outside `{ca,us,au}` — unchanged from before this task.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/populate-filing-jurisdiction.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full existing test suite to confirm zero CA regression**

Run: `cd plugins/agentbook-tax/backend && npx vitest run`
Expected: PASS — every CA-jurisdiction call site still resolves to `seedCanadianForms` exactly as before.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-tax/backend/src/tax-filing.ts plugins/agentbook-tax/backend/src/__tests__/populate-filing-jurisdiction.test.ts
git commit -m "feat(tax): populateFiling seeds the correct jurisdiction's form templates"
```

---

### Task 6: `TaxReviewPack` interface + registry loader

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/interfaces.ts` (append a new section)
- Create: `packages/agentbook-jurisdictions/src/tax-review-loader.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/tax-review-loader.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `TaxReviewPack`, `CriticalField`, `ComputedFilingTotals` (exported types from `interfaces.ts`); `registerTaxReviewPack`, `getTaxReviewPack`, `listSupportedJurisdictions` (from `tax-review-loader.ts`). Tasks 7-9 implement the interface; Task 10 consumes the loader.

- [ ] **Step 1: Append the interface block**

In `packages/agentbook-jurisdictions/src/interfaces.ts`, insert a new banner section immediately after the existing `FilingDraftPack` block (right before the `// ─── Startup Tax Benefits ──` banner, per this file's own organization):

```typescript
// ─── Tax Review Agent ───────────────────────────────────────────────────────

export interface CriticalField {
  formCode: string
  fieldId: string
  label: string
  /** Read directly from AbTaxFiling.forms[formCode][fieldId] at review time. */
  currentValue: number | string | boolean | null
}

export interface ComputedFilingTotals {
  totalIncomeCents?: number
  totalDeductionsCents?: number
  taxableIncomeCents?: number
  taxPayableCents?: number
}

export interface TaxReviewPack {
  jurisdiction: string
  /** Pure data — no LLM. Which fields in `forms` are worth surfacing for review, and their human labels. */
  criticalFields(forms: Record<string, Record<string, any>>): CriticalField[]
  summaryPrompt(input: {
    forms: Record<string, Record<string, any>>
    computedTotals: ComputedFilingTotals
    personalProfileContext: string
    /** BCP-47, e.g. 'en-US', 'fr-CA', 'zh-CN' — from AbTenantConfig.locale. Used ONLY for number/currency formatting inside the prompt (via @agentbook/i18n's formatCurrency); the language the LLM replies in is a separate concern, layered on by the orchestrator via languageDirective() — see Task 11. Packs never decide what language to write in. */
    locale: string
  }): string
  parseSummary(parsed: unknown): { summaryText: string }
  explainFieldPrompt(input: {
    field: CriticalField
    forms: Record<string, Record<string, any>>
    computedTotals: ComputedFilingTotals
    personalProfileContext: string
    locale: string
    question?: string
  }): string
  parseFieldExplanation(parsed: unknown): { explanation: string }
}
```

**Why `locale` is a pack input but language-of-reply is not (read before Tasks 7-9):** this codebase already has two genuinely separate i18n mechanisms, and conflating them would be a real design mistake, not a simplification. `@agentbook/i18n` (`packages/agentbook-i18n`, pure/dependency-free, already used by `TaxDashboard.tsx` for `formatMoney`) controls how a *number* is formatted (`"$45.00"` vs `"45,00 $"`) — that's what `locale` is for here, and packs call `formatCurrency` directly (Tasks 7-9). `languageDirective()` (`plugins/agentbook-core/backend/src/language.ts`) controls what *language the LLM's prose* is in, already designed as one general "mirror the user" instruction reused by every chat-facing prompt in the codebase (its own docstring gives "是的" as a worked example — Chinese was already a first-class case, just never wired into this specific feature). The orchestrator (Task 11) prepends that instruction to whatever prompt a pack returns; packs stay jurisdiction-only and never see it. Keeping these orthogonal is also why "US/AU/CA + English/French/Chinese" doesn't multiply into nine special cases: jurisdiction picks the tax rules and currency, locale picks the number formatting, language mirrors the user — three independent axes, not one.

- [ ] **Step 2: Write the failing loader test**

```typescript
// packages/agentbook-jurisdictions/src/__tests__/tax-review-loader.test.ts
import { describe, it, expect } from 'vitest';
import { registerTaxReviewPack, getTaxReviewPack, listSupportedJurisdictions } from '../tax-review-loader.js';
import type { TaxReviewPack } from '../interfaces.js';

describe('tax-review-loader', () => {
  it('CA, US, AU are all registered by default', () => {
    expect(listSupportedJurisdictions().sort()).toEqual(['au', 'ca', 'us']);
  });

  it('getTaxReviewPack throws a descriptive error for an unregistered jurisdiction', () => {
    expect(() => getTaxReviewPack('uk')).toThrow('No TaxReviewPack for jurisdiction: uk');
  });

  it('registerTaxReviewPack allows adding a new jurisdiction without touching existing ones', () => {
    const fakePack: TaxReviewPack = {
      jurisdiction: 'nz',
      criticalFields: () => [],
      summaryPrompt: () => '',
      parseSummary: () => ({ summaryText: '' }),
      explainFieldPrompt: () => '',
      parseFieldExplanation: () => ({ explanation: '' }),
    };
    registerTaxReviewPack(fakePack);
    expect(getTaxReviewPack('nz')).toBe(fakePack);
    expect(listSupportedJurisdictions()).toContain('ca'); // unaffected
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/tax-review-loader.test.ts`
Expected: FAIL — `tax-review-loader.ts` doesn't exist yet (this test file also can't import Tasks 7-9's packs yet; write the loader first with placeholder imports, see Step 4).

- [ ] **Step 4: Create the loader**

Create `packages/agentbook-jurisdictions/src/tax-review-loader.ts`, mirroring `filing-draft-loader.ts` exactly:

```typescript
import type { TaxReviewPack } from './interfaces.js';
import { CaTaxReviewPack } from './ca/tax-review-pack.js';
import { UsTaxReviewPack } from './us/tax-review-pack.js';
import { AuTaxReviewPack } from './au/tax-review-pack.js';

const PACKS: Record<string, TaxReviewPack> = {
  ca: new CaTaxReviewPack(),
  us: new UsTaxReviewPack(),
  au: new AuTaxReviewPack(),
};

export function registerTaxReviewPack(pack: TaxReviewPack): void {
  PACKS[pack.jurisdiction] = pack;
}

export function getTaxReviewPack(jurisdiction: string): TaxReviewPack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No TaxReviewPack for jurisdiction: ${jurisdiction}`);
  return pack;
}

export function listSupportedJurisdictions(): string[] {
  return Object.keys(PACKS);
}
```

This file will not compile until Tasks 7-9 create `ca/tax-review-pack.ts`, `us/tax-review-pack.ts`, `au/tax-review-pack.ts`. **This is intentional and expected** — Tasks 6-9 are a tightly coupled group; if executing via subagent-driven-development, dispatch Task 6's implementer with an explicit note that the loader will not typecheck/test-pass in isolation until Tasks 7-9 land, and treat Tasks 6-9 as one reviewable unit if that's simpler than four separate partial-review cycles.

- [ ] **Step 5: Commit (as part of the Task 6-9 group, once all four are implemented — see Step 4's note)**

```bash
git add packages/agentbook-jurisdictions/src/interfaces.ts packages/agentbook-jurisdictions/src/tax-review-loader.ts packages/agentbook-jurisdictions/src/__tests__/tax-review-loader.test.ts
git commit -m "feat(jurisdictions): TaxReviewPack interface + registry loader"
```

---

### Task 7: `CaTaxReviewPack` implementation

**Files:**
- Create: `packages/agentbook-jurisdictions/src/ca/tax-review-pack.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/ca-tax-review-pack.test.ts`

**Interfaces:**
- Consumes: `TaxReviewPack`, `CriticalField`, `ComputedFilingTotals` from Task 6.
- Produces: `CaTaxReviewPack` class, imported by `tax-review-loader.ts` (Task 6, Step 4).

This is the canonical worked example for all three jurisdiction packs — Tasks 8 and 9 mirror this file's exact structure and prompt style (which itself mirrors `CaFilingDraftPack`'s established house style: explicit "respond with EXACTLY one JSON object" instruction, defensive type-checked parsing with sensible fallbacks, throwing a descriptive `Error` only on a genuinely unusable shape).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/agentbook-jurisdictions/src/__tests__/ca-tax-review-pack.test.ts
import { describe, it, expect } from 'vitest';
import { CaTaxReviewPack } from '../ca/tax-review-pack.js';
import { formatCurrency } from '@agentbook/i18n';

const forms = {
  T2125: { gross_sales_8000: 8500000, total_expenses_9368: 1200000, net_income_9369: 7300000 },
  T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, balance_owing_48500: 50000 },
};
const computedTotals = { totalIncomeCents: 7300000, taxableIncomeCents: 7300000, taxPayableCents: 1150000 };

describe('CaTaxReviewPack', () => {
  const pack = new CaTaxReviewPack();

  it('jurisdiction is ca', () => {
    expect(pack.jurisdiction).toBe('ca');
  });

  it('criticalFields surfaces the real T2125/T1 field IDs with human labels', () => {
    const fields = pack.criticalFields(forms);
    const byId = Object.fromEntries(fields.map((f) => [f.fieldId, f]));
    expect(byId.gross_sales_8000).toMatchObject({ formCode: 'T2125', currentValue: 8500000 });
    expect(byId.total_expenses_9368).toMatchObject({ formCode: 'T2125', currentValue: 1200000 });
    expect(byId.taxable_income_26000).toMatchObject({ formCode: 'T1', currentValue: 7300000 });
    expect(byId.balance_owing_48500).toMatchObject({ formCode: 'T1', currentValue: 50000 });
    expect(byId.gross_sales_8000.label).toMatch(/business sales|gross sales/i);
  });

  it('criticalFields tolerates a completely empty forms object (new filing, nothing entered yet)', () => {
    const fields = pack.criticalFields({});
    expect(fields.every((f) => f.currentValue === null)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });

  it('summaryPrompt includes the real computed totals and personal profile context, en-CA formatting', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: 'Married, no dependents.', locale: 'en-CA' });
    expect(prompt).toContain('$73,000');
    expect(prompt).toContain('$11,500');
    expect(prompt).toContain('Married, no dependents.');
    expect(prompt).toContain('CRA');
  });

  it('summaryPrompt formats the SAME figures per fr-CA number conventions when the tenant is Quebec French — this is a real Intl.NumberFormat call, not a hardcoded en-CA string', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: '', locale: 'fr-CA' });
    // fr-CA groups with a narrow no-break space and puts the symbol after the
    // amount — assert via the real formatCurrency('fr-CA') output rather than
    // a hand-typed literal, since the exact whitespace character Intl uses
    // is easy to get wrong by hand and isn't the point of this test.
    expect(prompt).toContain(formatCurrency(7300000, 'fr-CA', 'CAD'));
  });

  it('parseSummary extracts summaryText', () => {
    const result = pack.parseSummary({ summaryText: 'Your net business income is $73,000...' });
    expect(result.summaryText).toContain('$73,000');
  });

  it('parseSummary throws on a missing summaryText', () => {
    expect(() => pack.parseSummary({})).toThrow('Unexpected review-summary response shape');
  });

  it('explainFieldPrompt grounds the prompt in the specific field and its current value', () => {
    const field = { formCode: 'T2125', fieldId: 'total_expenses_9368', label: 'Total business expenses', currentValue: 1200000 };
    const prompt = pack.explainFieldPrompt({ field, forms, computedTotals, personalProfileContext: '', locale: 'en-CA', question: 'why is this so high' });
    expect(prompt).toContain('$12,000');
    expect(prompt).toContain('Total business expenses');
    expect(prompt).toContain('why is this so high');
  });

  it('parseFieldExplanation extracts explanation', () => {
    const result = pack.parseFieldExplanation({ explanation: 'This total includes...' });
    expect(result.explanation).toContain('This total includes');
  });

  it('parseFieldExplanation throws on a missing explanation', () => {
    expect(() => pack.parseFieldExplanation({})).toThrow('Unexpected field-explanation response shape');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/ca-tax-review-pack.test.ts`
Expected: FAIL — `ca/tax-review-pack.ts` doesn't exist yet.

- [ ] **Step 3: Implement `CaTaxReviewPack`**

```typescript
// packages/agentbook-jurisdictions/src/ca/tax-review-pack.ts
import type { TaxReviewPack, CriticalField, ComputedFilingTotals } from '../interfaces.js';
import { formatCurrency } from '@agentbook/i18n';

const CA_CRITICAL_FIELDS: { formCode: string; fieldId: string; label: string }[] = [
  { formCode: 'T2125', fieldId: 'gross_sales_8000', label: 'Gross business sales' },
  { formCode: 'T2125', fieldId: 'total_expenses_9368', label: 'Total business expenses' },
  { formCode: 'T1', fieldId: 'total_income_15000', label: 'Total income' },
  { formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income' },
  { formCode: 'T1', fieldId: 'balance_owing_48500', label: 'Balance owing (or refund)' },
];

// Real, shared, locale-aware formatter (packages/agentbook-i18n) — not a
// local re-implementation. formatCurrency(4500, 'fr-CA', 'CAD') -> "45,00 $",
// formatCurrency(4500, 'en-CA', 'CAD') -> "$45.00": same jurisdiction (CAD is
// fixed by being the CA pack), different formatting per the tenant's own
// locale. See Task 6's note on why locale and language-of-reply are
// deliberately two different things.
function fmtCad(cents: number | undefined, locale: string): string {
  if (cents == null) return 'not yet entered';
  return formatCurrency(cents, locale, 'CAD');
}

export class CaTaxReviewPack implements TaxReviewPack {
  jurisdiction = 'ca';

  criticalFields(forms: Record<string, Record<string, any>>): CriticalField[] {
    return CA_CRITICAL_FIELDS.map((f) => ({
      ...f,
      currentValue: forms[f.formCode]?.[f.fieldId] ?? null,
    }));
  }

  summaryPrompt(input: {
    forms: Record<string, Record<string, any>>;
    computedTotals: ComputedFilingTotals;
    personalProfileContext: string;
    locale: string;
  }): string {
    const { computedTotals, personalProfileContext, locale } = input;
    return `You are a Canadian tax preparer giving a freelance/self-employed client a plain-language summary of their T1 filing before they submit it. You do NOT calculate any figures yourself — every number below already comes from the CRA's own federal/provincial bracket tables and this client's real booked income and expenses. Your only job is to explain what these numbers mean in a way this specific client will understand, using their personal situation where relevant.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- Computed figures (already correct — restate them, never recalculate) ---
- Total income: ${fmtCad(computedTotals.totalIncomeCents, locale)}
- Taxable income: ${fmtCad(computedTotals.taxableIncomeCents, locale)}
- Tax payable: ${fmtCad(computedTotals.taxPayableCents, locale)}

Write a short (3-5 sentence) plain-language summary a non-accountant would understand, mentioning the CRA by name, and end by asking if anything looks wrong or if they'd like to change a number before submitting.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"summaryText": "<the summary text>"}`;
  }

  parseSummary(parsed: unknown): { summaryText: string } {
    const r = parsed as any;
    if (r && typeof r.summaryText === 'string' && r.summaryText.trim().length > 0) {
      return { summaryText: r.summaryText };
    }
    throw new Error('Unexpected review-summary response shape: ' + JSON.stringify(parsed));
  }

  explainFieldPrompt(input: {
    field: CriticalField;
    forms: Record<string, Record<string, any>>;
    computedTotals: ComputedFilingTotals;
    personalProfileContext: string;
    locale: string;
    question?: string;
  }): string {
    const { field, personalProfileContext, locale, question } = input;
    const valueStr = typeof field.currentValue === 'number' ? fmtCad(field.currentValue, locale) : String(field.currentValue ?? 'not yet entered');
    return `You are a Canadian tax preparer answering a client's question about one specific number on their T1 filing. Ground your answer ONLY in the value given below and general CRA rules — never invent a dollar figure or rate that isn't already stated here.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- The field in question ---
${field.label} (currently ${valueStr})

--- The client's question ---
${question || 'Why is this number what it is?'}

Answer in 2-4 sentences, plain language, mentioning the CRA by name if relevant.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"explanation": "<your answer>"}`;
  }

  parseFieldExplanation(parsed: unknown): { explanation: string } {
    const r = parsed as any;
    if (r && typeof r.explanation === 'string' && r.explanation.trim().length > 0) {
      return { explanation: r.explanation };
    }
    throw new Error('Unexpected field-explanation response shape: ' + JSON.stringify(parsed));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/ca-tax-review-pack.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit (or hold until Tasks 8-9 land, per Task 6 Step 4's note, then commit together)**

```bash
git add packages/agentbook-jurisdictions/src/ca/tax-review-pack.ts packages/agentbook-jurisdictions/src/__tests__/ca-tax-review-pack.test.ts
git commit -m "feat(jurisdictions): CaTaxReviewPack"
```

---

### Task 8: `UsTaxReviewPack` implementation

**Files:**
- Create: `packages/agentbook-jurisdictions/src/us/tax-review-pack.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/us-tax-review-pack.test.ts`

**Interfaces:** identical shape to Task 7. Field IDs point at Task 3's real `ScheduleC`/`1040` templates.

- [ ] **Step 1: Write the failing test** (mirror Task 7's test exactly, substituting these fixtures)

```typescript
// packages/agentbook-jurisdictions/src/__tests__/us-tax-review-pack.test.ts
import { describe, it, expect } from 'vitest';
import { UsTaxReviewPack } from '../us/tax-review-pack.js';
import { formatCurrency } from '@agentbook/i18n';

const forms = {
  ScheduleC: { gross_receipts_1: 9000000, total_expenses_28: 1500000, net_profit_31: 7500000 },
  '1040': { total_income_9: 7500000, taxable_income: 6000000, balance_owing_37: 80000 },
};
const computedTotals = { totalIncomeCents: 7500000, taxableIncomeCents: 6000000, taxPayableCents: 1350000 };

describe('UsTaxReviewPack', () => {
  const pack = new UsTaxReviewPack();

  it('jurisdiction is us', () => {
    expect(pack.jurisdiction).toBe('us');
  });

  it('criticalFields surfaces the real ScheduleC/1040 field IDs with human labels', () => {
    const fields = pack.criticalFields(forms);
    const byId = Object.fromEntries(fields.map((f) => [f.fieldId, f]));
    expect(byId.gross_receipts_1).toMatchObject({ formCode: 'ScheduleC', currentValue: 9000000 });
    expect(byId.total_expenses_28).toMatchObject({ formCode: 'ScheduleC', currentValue: 1500000 });
    expect(byId.taxable_income).toMatchObject({ formCode: '1040', currentValue: 6000000 });
    expect(byId.balance_owing_37).toMatchObject({ formCode: '1040', currentValue: 80000 });
  });

  it('criticalFields tolerates a completely empty forms object', () => {
    const fields = pack.criticalFields({});
    expect(fields.every((f) => f.currentValue === null)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });

  it('summaryPrompt includes the real computed totals, personal context, and names the IRS', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: 'Single, no dependents.', locale: 'en-US' });
    expect(prompt).toContain('$75,000');
    expect(prompt).toContain('$13,500');
    expect(prompt).toContain('Single, no dependents.');
    expect(prompt).toContain('IRS');
  });

  it('summaryPrompt formats the same USD figures per zh-CN number conventions for a Chinese-speaking US tenant — a real Intl.NumberFormat call, not a hardcoded en-US string', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: '', locale: 'zh-CN' });
    expect(prompt).toContain(formatCurrency(7500000, 'zh-CN', 'USD'));
  });

  it('parseSummary extracts summaryText', () => {
    expect(pack.parseSummary({ summaryText: 'Your net profit is $75,000...' }).summaryText).toContain('$75,000');
  });

  it('parseSummary throws on a missing summaryText', () => {
    expect(() => pack.parseSummary({})).toThrow('Unexpected review-summary response shape');
  });

  it('explainFieldPrompt grounds the prompt in the specific field, current value, and question', () => {
    const field = { formCode: 'ScheduleC', fieldId: 'total_expenses_28', label: 'Total business expenses', currentValue: 1500000 };
    const prompt = pack.explainFieldPrompt({ field, forms, computedTotals, personalProfileContext: '', locale: 'en-US', question: 'is this deductible' });
    expect(prompt).toContain('$15,000');
    expect(prompt).toContain('Total business expenses');
    expect(prompt).toContain('is this deductible');
  });

  it('parseFieldExplanation extracts explanation, and throws on a missing one', () => {
    expect(pack.parseFieldExplanation({ explanation: 'Yes, because...' }).explanation).toContain('Yes, because');
    expect(() => pack.parseFieldExplanation({})).toThrow('Unexpected field-explanation response shape');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-tax-review-pack.test.ts` — Expected: FAIL (file doesn't exist).

- [ ] **Step 3: Implement `UsTaxReviewPack`** — identical structure to `CaTaxReviewPack` (Task 7), with these substitutions: currency formatted via `en-US`/`$`; tax authority named as "the IRS"; critical fields drawn from Task 3's real field IDs:

```typescript
// packages/agentbook-jurisdictions/src/us/tax-review-pack.ts
import type { TaxReviewPack, CriticalField, ComputedFilingTotals } from '../interfaces.js';
import { formatCurrency } from '@agentbook/i18n';

const US_CRITICAL_FIELDS: { formCode: string; fieldId: string; label: string }[] = [
  { formCode: 'ScheduleC', fieldId: 'gross_receipts_1', label: 'Gross business receipts' },
  { formCode: 'ScheduleC', fieldId: 'total_expenses_28', label: 'Total business expenses' },
  { formCode: '1040', fieldId: 'total_income_9', label: 'Total income' },
  { formCode: '1040', fieldId: 'taxable_income', label: 'Taxable income' },
  { formCode: '1040', fieldId: 'balance_owing_37', label: 'Amount you owe (or refund)' },
];

// Real, shared, locale-aware formatter (packages/agentbook-i18n), not a
// local re-implementation — see Task 6's note and Task 7's identical CA
// treatment.
function fmtUsd(cents: number | undefined, locale: string): string {
  if (cents == null) return 'not yet entered';
  return formatCurrency(cents, locale, 'USD');
}

export class UsTaxReviewPack implements TaxReviewPack {
  jurisdiction = 'us';

  criticalFields(forms: Record<string, Record<string, any>>): CriticalField[] {
    return US_CRITICAL_FIELDS.map((f) => ({ ...f, currentValue: forms[f.formCode]?.[f.fieldId] ?? null }));
  }

  summaryPrompt(input: { forms: Record<string, Record<string, any>>; computedTotals: ComputedFilingTotals; personalProfileContext: string; locale: string }): string {
    const { computedTotals, personalProfileContext, locale } = input;
    return `You are a U.S. tax preparer giving a freelance/self-employed client a plain-language summary of their Form 1040 filing before they submit it. You do NOT calculate any figures yourself — every number below already comes from the IRS's own federal bracket tables and this client's real booked income and expenses. Your only job is to explain what these numbers mean in a way this specific client will understand, using their personal situation where relevant.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- Computed figures (already correct — restate them, never recalculate) ---
- Total income: ${fmtUsd(computedTotals.totalIncomeCents, locale)}
- Taxable income: ${fmtUsd(computedTotals.taxableIncomeCents, locale)}
- Tax payable: ${fmtUsd(computedTotals.taxPayableCents, locale)}

Write a short (3-5 sentence) plain-language summary a non-accountant would understand, mentioning the IRS by name, and end by asking if anything looks wrong or if they'd like to change a number before submitting.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"summaryText": "<the summary text>"}`;
  }

  parseSummary(parsed: unknown): { summaryText: string } {
    const r = parsed as any;
    if (r && typeof r.summaryText === 'string' && r.summaryText.trim().length > 0) return { summaryText: r.summaryText };
    throw new Error('Unexpected review-summary response shape: ' + JSON.stringify(parsed));
  }

  explainFieldPrompt(input: { field: CriticalField; forms: Record<string, Record<string, any>>; computedTotals: ComputedFilingTotals; personalProfileContext: string; locale: string; question?: string }): string {
    const { field, personalProfileContext, locale, question } = input;
    const valueStr = typeof field.currentValue === 'number' ? fmtUsd(field.currentValue, locale) : String(field.currentValue ?? 'not yet entered');
    return `You are a U.S. tax preparer answering a client's question about one specific number on their Form 1040 filing. Ground your answer ONLY in the value given below and general IRS rules — never invent a dollar figure or rate that isn't already stated here.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- The field in question ---
${field.label} (currently ${valueStr})

--- The client's question ---
${question || 'Why is this number what it is?'}

Answer in 2-4 sentences, plain language, mentioning the IRS by name if relevant.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"explanation": "<your answer>"}`;
  }

  parseFieldExplanation(parsed: unknown): { explanation: string } {
    const r = parsed as any;
    if (r && typeof r.explanation === 'string' && r.explanation.trim().length > 0) return { explanation: r.explanation };
    throw new Error('Unexpected field-explanation response shape: ' + JSON.stringify(parsed));
  }
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-tax-review-pack.test.ts` — Expected: PASS, all 9 tests.

- [ ] **Step 5: Commit (or hold until Task 9 lands, per Task 6 Step 4's note)**

```bash
git add packages/agentbook-jurisdictions/src/us/tax-review-pack.ts packages/agentbook-jurisdictions/src/__tests__/us-tax-review-pack.test.ts
git commit -m "feat(jurisdictions): UsTaxReviewPack"
```

---

### Task 9: `AuTaxReviewPack` implementation

**Files:**
- Create: `packages/agentbook-jurisdictions/src/au/tax-review-pack.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/au-tax-review-pack.test.ts`

**Interfaces:** identical shape to Tasks 7-8. Field IDs point at Task 4's real `BusinessSchedule`/`IndividualReturn` templates.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/agentbook-jurisdictions/src/__tests__/au-tax-review-pack.test.ts
import { describe, it, expect } from 'vitest';
import { AuTaxReviewPack } from '../au/tax-review-pack.js';
import { formatCurrency } from '@agentbook/i18n';

const forms = {
  BusinessSchedule: { gross_business_income: 9500000, total_expenses: 1800000, net_business_income: 7700000 },
  IndividualReturn: { taxable_income: 7700000, total_tax_payable: 1600000, balance_owing: 100000 },
};
const computedTotals = { totalIncomeCents: 7700000, taxableIncomeCents: 7700000, taxPayableCents: 1600000 };

describe('AuTaxReviewPack', () => {
  const pack = new AuTaxReviewPack();

  it('jurisdiction is au', () => {
    expect(pack.jurisdiction).toBe('au');
  });

  it('criticalFields surfaces the real BusinessSchedule/IndividualReturn field IDs with human labels', () => {
    const fields = pack.criticalFields(forms);
    const byId = Object.fromEntries(fields.map((f) => [f.fieldId, f]));
    expect(byId.gross_business_income).toMatchObject({ formCode: 'BusinessSchedule', currentValue: 9500000 });
    expect(byId.net_business_income).toMatchObject({ formCode: 'BusinessSchedule', currentValue: 7700000 });
    expect(byId.taxable_income).toMatchObject({ formCode: 'IndividualReturn', currentValue: 7700000 });
    expect(byId.balance_owing).toMatchObject({ formCode: 'IndividualReturn', currentValue: 100000 });
  });

  it('criticalFields tolerates a completely empty forms object', () => {
    const fields = pack.criticalFields({});
    expect(fields.every((f) => f.currentValue === null)).toBe(true);
    expect(fields.length).toBeGreaterThan(0);
  });

  it('summaryPrompt includes the real computed totals, personal context, and names the ATO', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: 'Sole trader, no dependents.', locale: 'en-AU' });
    expect(prompt).toContain('$77,000');
    expect(prompt).toContain('$16,000');
    expect(prompt).toContain('Sole trader, no dependents.');
    expect(prompt).toContain('ATO');
  });

  it('summaryPrompt formats the same AUD figures per zh-CN number conventions for a Chinese-speaking AU tenant', () => {
    const prompt = pack.summaryPrompt({ forms, computedTotals, personalProfileContext: '', locale: 'zh-CN' });
    expect(prompt).toContain(formatCurrency(7700000, 'zh-CN', 'AUD'));
  });

  it('parseSummary extracts summaryText, and throws on a missing one', () => {
    expect(pack.parseSummary({ summaryText: 'Your net business income is A$77,000...' }).summaryText).toContain('77,000');
    expect(() => pack.parseSummary({})).toThrow('Unexpected review-summary response shape');
  });

  it('explainFieldPrompt grounds the prompt in the specific field, current value, and question, formatted as AUD', () => {
    const field = { formCode: 'BusinessSchedule', fieldId: 'total_expenses', label: 'Total business expenses', currentValue: 1800000 };
    const prompt = pack.explainFieldPrompt({ field, forms, computedTotals, personalProfileContext: '', locale: 'en-AU', question: 'why so high' });
    expect(prompt).toContain('$18,000');
    expect(prompt).toContain('Total business expenses');
    expect(prompt).toContain('why so high');
  });

  it('parseFieldExplanation extracts explanation, and throws on a missing one', () => {
    expect(pack.parseFieldExplanation({ explanation: 'Because...' }).explanation).toContain('Because');
    expect(() => pack.parseFieldExplanation({})).toThrow('Unexpected field-explanation response shape');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-tax-review-pack.test.ts` — Expected: FAIL (file doesn't exist).

- [ ] **Step 3: Implement `AuTaxReviewPack`** — identical structure to Tasks 7-8, with these substitutions: currency formatted via `en-AU`/`$` (AUD, no special prefix needed for this internal prompt text — that's a display-layer concern elsewhere in the app, not this prompt); tax authority named as "the ATO"; critical fields drawn from Task 4's real field IDs:

```typescript
// packages/agentbook-jurisdictions/src/au/tax-review-pack.ts
import type { TaxReviewPack, CriticalField, ComputedFilingTotals } from '../interfaces.js';
import { formatCurrency } from '@agentbook/i18n';

const AU_CRITICAL_FIELDS: { formCode: string; fieldId: string; label: string }[] = [
  { formCode: 'BusinessSchedule', fieldId: 'gross_business_income', label: 'Gross business income' },
  { formCode: 'BusinessSchedule', fieldId: 'total_expenses', label: 'Total business expenses' },
  { formCode: 'BusinessSchedule', fieldId: 'net_business_income', label: 'Net business income' },
  { formCode: 'IndividualReturn', fieldId: 'taxable_income', label: 'Taxable income' },
  { formCode: 'IndividualReturn', fieldId: 'balance_owing', label: 'Amount you owe (or refund)' },
];

// Real, shared, locale-aware formatter (packages/agentbook-i18n), not a
// local re-implementation — see Task 6's note and Task 7's identical CA
// treatment.
function fmtAud(cents: number | undefined, locale: string): string {
  if (cents == null) return 'not yet entered';
  return formatCurrency(cents, locale, 'AUD');
}

export class AuTaxReviewPack implements TaxReviewPack {
  jurisdiction = 'au';

  criticalFields(forms: Record<string, Record<string, any>>): CriticalField[] {
    return AU_CRITICAL_FIELDS.map((f) => ({ ...f, currentValue: forms[f.formCode]?.[f.fieldId] ?? null }));
  }

  summaryPrompt(input: { forms: Record<string, Record<string, any>>; computedTotals: ComputedFilingTotals; personalProfileContext: string; locale: string }): string {
    const { computedTotals, personalProfileContext, locale } = input;
    return `You are an Australian tax agent giving a sole-trader client a plain-language summary of their individual tax return before they submit it. You do NOT calculate any figures yourself — every number below already comes from the ATO's own tax brackets and Medicare Levy rate, applied to this client's real booked income and expenses. Your only job is to explain what these numbers mean in a way this specific client will understand, using their personal situation where relevant.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- Computed figures (already correct — restate them, never recalculate) ---
- Total income: ${fmtAud(computedTotals.totalIncomeCents, locale)}
- Taxable income: ${fmtAud(computedTotals.taxableIncomeCents, locale)}
- Tax payable (including Medicare Levy): ${fmtAud(computedTotals.taxPayableCents, locale)}

Write a short (3-5 sentence) plain-language summary a non-accountant would understand, mentioning the ATO by name, and end by asking if anything looks wrong or if they'd like to change a number before submitting.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"summaryText": "<the summary text>"}`;
  }

  parseSummary(parsed: unknown): { summaryText: string } {
    const r = parsed as any;
    if (r && typeof r.summaryText === 'string' && r.summaryText.trim().length > 0) return { summaryText: r.summaryText };
    throw new Error('Unexpected review-summary response shape: ' + JSON.stringify(parsed));
  }

  explainFieldPrompt(input: { field: CriticalField; forms: Record<string, Record<string, any>>; computedTotals: ComputedFilingTotals; personalProfileContext: string; locale: string; question?: string }): string {
    const { field, personalProfileContext, locale, question } = input;
    const valueStr = typeof field.currentValue === 'number' ? fmtAud(field.currentValue, locale) : String(field.currentValue ?? 'not yet entered');
    return `You are an Australian tax agent answering a client's question about one specific number on their individual tax return. Ground your answer ONLY in the value given below and general ATO rules — never invent a dollar figure or rate that isn't already stated here.

--- This client's situation ---
${personalProfileContext || 'No additional personal context on file.'}

--- The field in question ---
${field.label} (currently ${valueStr})

--- The client's question ---
${question || 'Why is this number what it is?'}

Answer in 2-4 sentences, plain language, mentioning the ATO by name if relevant.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"explanation": "<your answer>"}`;
  }

  parseFieldExplanation(parsed: unknown): { explanation: string } {
    const r = parsed as any;
    if (r && typeof r.explanation === 'string' && r.explanation.trim().length > 0) return { explanation: r.explanation };
    throw new Error('Unexpected field-explanation response shape: ' + JSON.stringify(parsed));
  }
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/au-tax-review-pack.test.ts` — Expected: PASS, all 8 tests.

- [ ] **Step 5: Now that Tasks 6-9 are all complete, run the full package test suite and commit everything together**

Run: `cd packages/agentbook-jurisdictions && npx vitest run`
Expected: PASS — including Task 6's loader test, which only fully resolves once all three packs exist.

```bash
git add packages/agentbook-jurisdictions/src/
git commit -m "feat(jurisdictions): TaxReviewPack registry — CA, US, AU implementations"
```

---

### Task 10: `AbTaxFilingReview` schema + migration

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (add new model)
- Migration: generated via `prisma migrate dev` (or this repo's equivalent additive-migration command — check `packages/database/package.json` scripts and follow whichever one `AbTaxFiling`'s own migration used)

**Interfaces:**
- Produces: the `AbTaxFilingReview` Prisma model + generated client types, consumed by Tasks 11-13.

- [ ] **Step 1: Add the model**

In `packages/database/prisma/schema.prisma`, add a new model near `AbTaxFiling` (same file region, same schema):

```prisma
model AbTaxFilingReview {
  id                String    @id @default(uuid())
  tenantId          String
  taxYear           Int
  status            String    @default("summarizing") // 'summarizing' | 'awaiting_edit' | 'confirmed' | 'stale'
  awaitingFieldId   String?
  summaryText       String?
  editsApplied      Json      @default("[]")
  reviewedFormsHash String?
  confirmedAt       DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  @@unique([tenantId, taxYear])
  @@index([tenantId])
  @@schema("plugin_agentbook_tax")
}
```

- [ ] **Step 2: Generate and run the migration**

Per this repo's standing constraint (never run a migration against a shared/naap/Neon endpoint, never use `--accept-data-loss` against a shared DB): run this against an isolated local/verify database, matching however `AbTaxFiling`'s own original migration was generated (check `packages/database/prisma/migrations/` for the naming convention and follow it — this is a pure additive migration, one new table, zero risk to existing data).

Run (from `packages/database`): `npx prisma migrate dev --name add_ab_tax_filing_review` against your local/isolated dev DB — **not** the shared Supabase instance, per this repo's standing worktree-isolation convention.

- [ ] **Step 3: Confirm the generated client compiles**

Run: `cd packages/database && npx tsc --noEmit` (or this package's equivalent typecheck script)
Expected: PASS — no compile errors referencing `AbTaxFilingReview`.

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/prisma/migrations/
git commit -m "feat(db): add AbTaxFilingReview model"
```

---

### Task 11: `tax-review-agent.ts` — `startReview()` + local anti-hallucination verifier

**Files:**
- Create: `plugins/agentbook-tax/backend/src/tax-review-agent.ts`
- Test: `plugins/agentbook-tax/backend/src/__tests__/tax-review-agent-start.test.ts`

**Interfaces:**
- Consumes: `getTaxReviewPack` (Task 6), `usTaxBrackets`/`caTaxBrackets`/`auTaxBrackets` (already-existing, confirmed exports), `db.abTaxFiling`, `db.abTaxFilingReview` (Task 10), `CallGeminiFn`/`cleanJson` (already-existing, from `plugins/agentbook-core/backend/src/tax-questionnaire-core.ts` — **note:** this is a cross-plugin import of a pure, dependency-free utility function, not domain logic; confirm at implementation time whether `plugins/agentbook-tax/backend`'s `package.json` needs `@naap/plugin-agentbook-core-backend` (or equivalent) added as a dependency for this import to resolve, or whether it's simpler to copy the ~10-line `cleanJson` function locally into `tax-review-agent.ts` to avoid a new cross-package dependency entirely — **prefer the local copy** if adding a new package dependency turns out to require any build/registry change beyond editing `package.json`, since Global Constraint 10 already established the precedent of small local duplication over cross-package imports for this exact kind of tiny, dependency-free helper.
- Produces: `startReview(tenantId: string, taxYear: number, callGemini: CallGeminiFn): Promise<{ message: string; criticalFields: CriticalField[]; computedTotals: ComputedFilingTotals }>` — `message` is the chat-shaped text; `criticalFields`/`computedTotals` are additive fields the web review tab (Task 15) needs to render structured inputs, not just prose. `ComputedFilingTotals` computation logic (`computeFilingTotals`) is reused by Task 12.

This module never trusts the LLM for a number — `computeFilingTotals` below always runs first, and `verifyGroundedNumbers` (this task's own independent verifier, per Global Constraint 4) checks every `$` figure the LLM's summary contains against that real, already-computed set before the summary is ever shown to a user.

**i18n (added on plan review — see Global Constraint 13).** Two separate, deliberately independent mechanisms, both real and already used elsewhere in this codebase:
- **Number formatting** — `formatCurrency`/`formatMoney` from `@agentbook/i18n` (pure, dependency-free, already imported by `TaxDashboard.tsx`), driven by the tenant's own `AbTenantConfig.locale` (e.g. `'fr-CA'`, `'zh-CN'`). Threaded into each pack's `summaryPrompt`/`explainFieldPrompt` as the new `locale` input (Tasks 7-9).
- **Language of the LLM's reply** — `languageDirective()` (`plugins/agentbook-core/backend/src/language.ts`), the existing "mirror the user's language" instruction already used by every other chat-facing prompt in this codebase (its own docstring names Chinese as a real, previously-mishandled case — this isn't a new capability, just reusing an existing one that this feature hadn't wired in yet). Per Global Constraint 10's precedent, this task copies `languageDirective`/`localeLanguageName` locally rather than adding a new cross-plugin-backend dependency — copy the two functions verbatim from `language.ts`, since they're pure and take no dependencies of their own.

- [ ] **Step 1: Write the failing test**

```typescript
// plugins/agentbook-tax/backend/src/__tests__/tax-review-agent-start.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const filingFindFirst = vi.fn();
const reviewUpsert = vi.fn();
const tenantConfigFindFirst = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: (...a: any[]) => filingFindFirst(...a) },
    abTaxFilingReview: { upsert: (...a: any[]) => reviewUpsert(...a) },
    abTenantConfig: { findFirst: (...a: any[]) => tenantConfigFindFirst(...a) },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  tenantConfigFindFirst.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
  reviewUpsert.mockResolvedValue({ id: 'r1' });
});

describe('startReview', () => {
  it('computes real totals via the CA bracket calculator, calls the LLM, verifies the summary is grounded, and persists the review row', async () => {
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
      forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000 }, T2125: {} },
    });
    const callGemini = vi.fn().mockResolvedValue('{"summaryText": "Your taxable income is $73,000 and your estimated tax payable is $11,455. Anything you\'d like to change before submitting?"}');

    const { startReview } = await import('../tax-review-agent.js');
    const result = await startReview('t1', 2025, callGemini);

    expect(result.message).toContain('$73,000');
    expect(result.criticalFields.length).toBeGreaterThan(0); // additive field for the web review tab (Task 15)
    expect(result.computedTotals.taxableIncomeCents).toBe(7300000); // additive field for the web review tab
    expect(reviewUpsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_taxYear: { tenantId: 't1', taxYear: 2025 } },
    }));
  });

  it('prepends the language directive naming the tenant\'s configured language, and calls the LLM with a French instruction for a fr-CA tenant', async () => {
    tenantConfigFindFirst.mockResolvedValue({ jurisdiction: 'ca', region: 'ON', locale: 'fr-CA' });
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
      forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000 }, T2125: {} },
    });
    const callGemini = vi.fn().mockResolvedValue('{"summaryText": "Votre revenu imposable est de 73 000,00 $."}');

    const { startReview } = await import('../tax-review-agent.js');
    await startReview('t1', 2025, callGemini);

    const [systemPrompt] = callGemini.mock.calls[0];
    expect(systemPrompt).toContain('LANGUAGE: Reply in the same language');
    expect(systemPrompt).toContain('French');
  });

  it('falls back to a deterministic, numbers-only message if the LLM invents an ungrounded figure', async () => {
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
      forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000 }, T2125: {} },
    });
    // $99,999 does not match any real computed total — must be caught, not shown.
    const callGemini = vi.fn().mockResolvedValue('{"summaryText": "Your tax payable is $99,999."}');

    const { startReview } = await import('../tax-review-agent.js');
    const result = await startReview('t1', 2025, callGemini);

    expect(result.message).not.toContain('99,999');
    expect(result.message).toContain('$'); // still shows the real numbers, just not narrated by the LLM
  });

  it('throws a clear error if no filing exists for this tenant/year', async () => {
    filingFindFirst.mockResolvedValue(null);
    const { startReview } = await import('../tax-review-agent.js');
    await expect(startReview('t1', 2025, vi.fn())).rejects.toThrow('No filing found');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-review-agent-start.test.ts` — Expected: FAIL (file doesn't exist).

- [ ] **Step 3: Implement `startReview` + `computeFilingTotals` + `verifyGroundedNumbers`**

```typescript
// plugins/agentbook-tax/backend/src/tax-review-agent.ts
import { db } from './db/client.js';
import { getTaxReviewPack } from '@agentbook/jurisdictions/tax-review-loader';
import type { ComputedFilingTotals, CriticalField } from '@agentbook/jurisdictions/interfaces';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';

// Local copy, deliberately not a cross-package import — see this task's
// Interfaces note on why (Global Constraint 10's precedent).
function cleanJson(raw: string): string {
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < s.length - 1)) {
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  return s;
}

export type CallGeminiFn = (systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string | null>;

// Local copy of language.ts's languageDirective()/localeLanguageName() —
// verbatim, not reinvented — same Global Constraint 10 precedent as
// cleanJson above: both are pure, dependency-free functions, and
// plugins/agentbook-core/backend is a separate package. Keeping the exact
// wording matters: it's the one instruction every other chat prompt in
// this codebase already shares, and a subtly different rewording here
// would mean two competing "how to mirror the user's language" texts.
const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', fr: 'French', es: 'Spanish', zh: 'Chinese', de: 'German',
  pt: 'Portuguese', it: 'Italian', ja: 'Japanese', ko: 'Korean', hi: 'Hindi',
  ar: 'Arabic', vi: 'Vietnamese', th: 'Thai', nl: 'Dutch', pl: 'Polish', ru: 'Russian',
};
function localeLanguageName(locale: string | null | undefined): string | null {
  if (typeof locale !== 'string' || !locale.trim()) return null;
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  return LANGUAGE_NAMES[primary] ?? null;
}
function languageDirective(locale: string | null | undefined): string {
  const preferred = localeLanguageName(locale);
  return [
    'LANGUAGE: Reply in the same language the user wrote their message in.',
    'If their message is too short to tell (for example "yes", "ok", "是的", "oui"),',
    'continue in the language the conversation has been using so far' +
      (preferred ? `, and otherwise use ${preferred}.` : '.'),
    'Never switch language mid-conversation unless the user does.',
  ].join(' ');
}

// Direct imports, not a generic jurisdiction-pack loader — mirrors the exact
// existing pattern in tax-fast-track-draft-compute.ts.
const TAX_BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};

// Field IDs each jurisdiction's forms use for the two totals that feed
// calculateTax(). This is the one place this module needs to know a
// concrete field name per jurisdiction — everything else goes through
// TaxReviewPack.criticalFields()/summaryPrompt(), which are jurisdiction-
// agnostic to this module's own code.
const TAXABLE_INCOME_FIELD: Record<string, { formCode: string; fieldId: string }> = {
  ca: { formCode: 'T1', fieldId: 'taxable_income_26000' },
  us: { formCode: '1040', fieldId: 'taxable_income' },
  au: { formCode: 'IndividualReturn', fieldId: 'taxable_income' },
};
const TOTAL_INCOME_FIELD: Record<string, { formCode: string; fieldId: string }> = {
  ca: { formCode: 'T1', fieldId: 'total_income_15000' },
  us: { formCode: '1040', fieldId: 'total_income_9' },
  au: { formCode: 'IndividualReturn', fieldId: 'taxable_income' }, // AU forms don't split these — same field
};

export function computeFilingTotals(
  jurisdiction: string, region: string, taxYear: number, forms: Record<string, Record<string, any>>,
): ComputedFilingTotals {
  const taxableField = TAXABLE_INCOME_FIELD[jurisdiction];
  const totalField = TOTAL_INCOME_FIELD[jurisdiction];
  const taxableIncomeCents = taxableField ? forms[taxableField.formCode]?.[taxableField.fieldId] : undefined;
  const totalIncomeCents = totalField ? forms[totalField.formCode]?.[totalField.fieldId] : undefined;

  const provider = TAX_BRACKET_PROVIDERS[jurisdiction];
  let taxPayableCents: number | undefined;
  if (provider && typeof taxableIncomeCents === 'number') {
    taxPayableCents = provider.calculateTax(taxableIncomeCents, taxYear, undefined, region).taxCents;
  }

  return { totalIncomeCents, taxableIncomeCents, taxPayableCents };
}

/**
 * Independent of consultation-review.ts by design (Global Constraint 4) —
 * a smaller problem (does every $ figure match one of THIS filing's own
 * computed totals) than consultation-review.ts's generic ledger-facts
 * problem, so it gets its own small, purpose-built check rather than
 * sharing that module's more general verifier.
 */
export function verifyGroundedNumbers(text: string, totals: ComputedFilingTotals): boolean {
  const dollarMatches = text.match(/\$[\d,]+(?:\.\d{2})?/g) || [];
  if (dollarMatches.length === 0) return true; // nothing to verify
  const groundedDollars = new Set(
    Object.values(totals)
      .filter((v): v is number => typeof v === 'number')
      .map((cents) => Math.round(cents / 100)),
  );
  for (const match of dollarMatches) {
    const n = Number(match.replace(/[$,]/g, ''));
    if (!groundedDollars.has(Math.round(n))) return false;
  }
  return true;
}

function fmtGeneric(cents?: number): string {
  if (cents == null) return 'not available';
  return `$${(cents / 100).toLocaleString()}`;
}

function deterministicFallbackSummary(totals: ComputedFilingTotals): string {
  return `Here's where your filing stands: total income ${fmtGeneric(totals.totalIncomeCents)}, taxable income ${fmtGeneric(totals.taxableIncomeCents)}, estimated tax payable ${fmtGeneric(totals.taxPayableCents)}. Reply with a number to change, ask a question about any figure, or say "looks good" to submit.`;
}

// Jurisdiction picks the currency code passed to formatCurrency; locale
// (the tenant's own AbTenantConfig.locale) picks the formatting style. A
// tenant with no locale set falls back to the jurisdiction's own default
// market locale — unchanged formatting from before this feature existed,
// not a regression for the common case of an unset locale.
const DEFAULT_LOCALE_FOR_JURISDICTION: Record<string, string> = { ca: 'en-CA', us: 'en-US', au: 'en-AU' };

export async function startReview(
  tenantId: string, taxYear: number, callGemini: CallGeminiFn,
): Promise<{ message: string; criticalFields: CriticalField[]; computedTotals: ComputedFilingTotals }> {
  const filing = await db.abTaxFiling.findFirst({
    where: { tenantId, taxYear, filingType: 'personal_return' },
  });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);

  const forms = (filing.forms as Record<string, Record<string, any>>) || {};
  const totals = computeFilingTotals(filing.jurisdiction, filing.region, taxYear, forms);
  const pack = getTaxReviewPack(filing.jurisdiction);
  const criticalFields = pack.criticalFields(forms);

  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const locale = config?.locale || DEFAULT_LOCALE_FOR_JURISDICTION[filing.jurisdiction] || 'en-US';
  const personalProfileContext = ''; // Task 13 wires the real buildPersonalProfileContext() call at the HTTP boundary; kept out of this pure-DB-and-LLM module to avoid a new cross-plugin dependency here.

  const prompt = languageDirective(locale) + '\n\n' + pack.summaryPrompt({ forms, computedTotals: totals, personalProfileContext, locale });
  const raw = await callGemini(prompt, 'Summarize this filing for review.', 400);

  let message: string;
  if (raw) {
    try {
      const parsed = pack.parseSummary(JSON.parse(cleanJson(raw)));
      message = verifyGroundedNumbers(parsed.summaryText, totals)
        ? parsed.summaryText
        : deterministicFallbackSummary(totals);
    } catch {
      message = deterministicFallbackSummary(totals);
    }
  } else {
    message = deterministicFallbackSummary(totals);
  }

  await db.abTaxFilingReview.upsert({
    where: { tenantId_taxYear: { tenantId, taxYear } },
    create: { tenantId, taxYear, status: 'summarizing', summaryText: message },
    update: { status: 'summarizing', summaryText: message, awaitingFieldId: null, confirmedAt: null },
  });

  return { message, criticalFields, computedTotals: totals };
}
```

**Note on `verifyGroundedNumbers` and non-Latin digits:** `Intl.NumberFormat('zh-CN', ...)` renders Western Arabic numerals by default (e.g. `"$73,000.00"`, not Chinese numeral characters), so the existing `/\$[\d,]+(?:\.\d{2})?/g` regex still matches correctly for a Chinese-locale summary — no change needed to the verifier itself. This is worth stating explicitly rather than leaving implicit, since it's exactly the kind of assumption that's easy to get wrong for a locale you haven't tested against.

- [ ] **Step 4: Run test to verify it passes.** Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-review-agent-start.test.ts` — Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-tax/backend/src/tax-review-agent.ts plugins/agentbook-tax/backend/src/__tests__/tax-review-agent-start.test.ts
git commit -m "feat(tax): startReview() — grounded summary, independent verifier"
```

---

### Task 12: `tax-review-agent.ts` — `answerReviewMessage()` state machine

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/tax-review-agent.ts` (append to the file Task 11 created)
- Test: `plugins/agentbook-tax/backend/src/__tests__/tax-review-agent-answer.test.ts`

**Interfaces:**
- Consumes: `submitFiling` from `./tax-efiling.js`, `updateFilingField` from `./tax-filing.js`, everything from Task 11.
- Produces: `answerReviewMessage(tenantId, taxYear, text, callGemini): Promise<{ message: string }>`, `hasConfirmedFreshReview(tenantId, taxYear): Promise<boolean>`, `getActiveReviewForTenant(tenantId): Promise<{ taxYear: number } | null>` — plus two functions extracted specifically so the web review tab (Task 15) can reuse this exact logic without going through free-text intent classification for something it already knows precisely: `applyFieldEdit(tenantId, taxYear, formCode, fieldId, cents): Promise<{ message: string; computedTotals: ComputedFilingTotals }>` and `confirmAndSubmit(tenantId, taxYear): Promise<{ message: string; filed: boolean }>`. All consumed by Task 13's HTTP endpoints.

Reply classification is deterministic keyword matching, not an LLM call — matching this codebase's own established preference (`consultation-triage.ts`'s explicit rationale: "an LLM triage call... can be argued into anything") for exactly this kind of cheap, high-stakes routing decision.

**Why extract `applyFieldEdit`/`confirmAndSubmit` (added on plan review, per Global Constraint 14):** the web review tab knows exactly which field was edited and exactly when the user clicked Submit — it never needs to guess from free text the way a chat message does. Routing a structured button click through `classifyReply`'s fuzzy label-matching would be a step backward, not a simplification: it introduces exactly the fragility (mismatched label heuristics) that a UI which already has the field's real `formCode`/`fieldId` shouldn't need. So the chat state machine's own field-edit and confirm branches are refactored to call these two extracted functions rather than duplicating "write the field, recompute, respond" or "hash forms, mark confirmed, call submitFiling" logic a second time for the web's structured routes (Task 13). This is the same DRY seam as any "understand intent" (chat-specific) vs. "do the thing" (shared) split — chat still owns turning free text into a decision; both surfaces then call the same executor.

- [ ] **Step 1: Write the failing test**

```typescript
// plugins/agentbook-tax/backend/src/__tests__/tax-review-agent-answer.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const filingFindFirst = vi.fn();
const reviewFindFirst = vi.fn();
const reviewUpdate = vi.fn();
const updateFilingField = vi.fn();
const submitFiling = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: (...a: any[]) => filingFindFirst(...a) },
    abTaxFilingReview: { findFirst: (...a: any[]) => reviewFindFirst(...a), update: (...a: any[]) => reviewUpdate(...a), upsert: vi.fn() },
    abTenantConfig: { findFirst: vi.fn() },
  },
}));
vi.mock('../tax-filing.js', () => ({ updateFilingField: (...a: any[]) => updateFilingField(...a) }));
vi.mock('../tax-efiling.js', () => ({ submitFiling: (...a: any[]) => submitFiling(...a) }));

const baseFiling = {
  id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON',
  forms: { T1: { total_income_15000: 7300000, taxable_income_26000: 7300000 }, T2125: {} },
};

beforeEach(() => vi.clearAllMocks());

describe('answerReviewMessage', () => {
  it('a field-edit reply (naming a critical field + a number) writes the value and recomputes — never guesses at a number the user did not say', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    updateFilingField.mockResolvedValue({ updated: true });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'change total income to 80000', vi.fn());

    expect(updateFilingField).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(result.message).toContain('$80,000');
  });

  it('a bare number reply, when a specific field is awaited, is treated as that field\'s new value', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'awaiting_edit', awaitingFieldId: 'T1:total_income_15000' });
    updateFilingField.mockResolvedValue({ updated: true });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, '80000', vi.fn());

    expect(updateFilingField).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(result.message).toContain('$80,000');
  });

  it('a question routes to explainFieldPrompt and never writes any field', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    const callGemini = vi.fn().mockResolvedValue('{"explanation": "Your total income is $73,000 because..."}');

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'why is my total income what it is', callGemini);

    expect(updateFilingField).not.toHaveBeenCalled();
    expect(result.message).toContain('$73,000');
  });

  it('a confirm reply calls submitFiling directly and returns its real outcome, in the same turn', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    submitFiling.mockResolvedValue({ success: true, data: { message: 'Your return package is finalized and exported.' } });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'looks good, submit it', vi.fn());

    expect(submitFiling).toHaveBeenCalledWith('t1', 2025);
    expect(reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'confirmed' }),
    }));
    expect(result.message).toContain('finalized and exported');
  });

  it('a cancel reply ends the review without calling submitFiling', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'no, cancel', vi.fn());

    expect(submitFiling).not.toHaveBeenCalled();
    expect(result.message).toMatch(/cancel/i);
  });

  it('an unclear reply asks a clarifying question without calling the LLM at all', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    const callGemini = vi.fn();

    const { answerReviewMessage } = await import('../tax-review-agent.js');
    const result = await answerReviewMessage('t1', 2025, 'hmm ok', callGemini);

    expect(callGemini).not.toHaveBeenCalled();
    expect(result.message).toMatch(/looks good|change|question/i);
  });
});

describe('hasConfirmedFreshReview', () => {
  it('is false when there is no review row at all', async () => {
    reviewFindFirst.mockResolvedValue(null);
    const { hasConfirmedFreshReview } = await import('../tax-review-agent.js');
    expect(await hasConfirmedFreshReview('t1', 2025)).toBe(false);
  });

  it('is false when the review is confirmed but the forms hash no longer matches (edited since via the old /field endpoint)', async () => {
    filingFindFirst.mockResolvedValue({ ...baseFiling, forms: { T1: { total_income_15000: 9999999 } } });
    reviewFindFirst.mockResolvedValue({ status: 'confirmed', reviewedFormsHash: 'stale-hash-value' });
    const { hasConfirmedFreshReview } = await import('../tax-review-agent.js');
    expect(await hasConfirmedFreshReview('t1', 2025)).toBe(false);
  });
});

describe('applyFieldEdit — the shared executor the web review tab (Task 15) also calls directly, no text classification involved', () => {
  it('writes the field, recomputes totals, and formats the confirmation using the tenant\'s real locale/currency', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    updateFilingField.mockResolvedValue({ updated: true });

    const { applyFieldEdit } = await import('../tax-review-agent.js');
    const result = await applyFieldEdit('t1', 2025, 'T1', 'total_income_15000', 8000000);

    expect(updateFilingField).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(result.message).toContain('$80,000');
    expect(result.computedTotals).toBeDefined();
  });
});

describe('confirmAndSubmit — the shared executor the web review tab (Task 15) also calls directly on Submit-button click', () => {
  it('hashes the current forms, marks the review confirmed, and calls submitFiling — same as the chat confirm path', async () => {
    filingFindFirst.mockResolvedValue(baseFiling);
    reviewFindFirst.mockResolvedValue({ id: 'r1', status: 'summarizing', awaitingFieldId: null });
    submitFiling.mockResolvedValue({ success: true, data: { message: 'Your return package is finalized and exported.', filed: false } });

    const { confirmAndSubmit } = await import('../tax-review-agent.js');
    const result = await confirmAndSubmit('t1', 2025);

    expect(submitFiling).toHaveBeenCalledWith('t1', 2025);
    expect(reviewUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'confirmed' }) }));
    expect(result.message).toContain('finalized and exported');
    expect(result.filed).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-review-agent-answer.test.ts` — Expected: FAIL (`answerReviewMessage`/`hasConfirmedFreshReview` don't exist yet).

- [ ] **Step 3: Implement**, appending to `plugins/agentbook-tax/backend/src/tax-review-agent.ts`:

```typescript
import { updateFilingField } from './tax-filing.js';
import { submitFiling } from './tax-efiling.js';
import { createHash } from 'node:crypto';
import { formatCurrency } from '@agentbook/i18n';

// Deliberately not a cross-package import of apps/web-next's
// money-validation.ts — that package boundary doesn't resolve from a
// plugin backend (Global Constraint 10). This is intentionally small.
const MAX_MONEY_CENTS = 1_000_000_000; // $10,000,000.00
function parseMoneyInputCents(text: string): number | null {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (!cleaned) return null;
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  const cents = Math.round(dollars * 100);
  return cents >= 0 && cents <= MAX_MONEY_CENTS ? cents : null;
}

type ReplyIntent =
  | { kind: 'confirm' }
  | { kind: 'cancel' }
  | { kind: 'field_value'; cents: number }
  | { kind: 'field_edit_request'; field: { formCode: string; fieldId: string }; cents: number }
  | { kind: 'question'; field?: { formCode: string; fieldId: string } }
  | { kind: 'unclear' };

const CONFIRM_RE = /\b(yes|confirm|submit|looks good|go ahead|that'?s (right|correct)|correct|proceed)\b/i;
const CANCEL_RE = /\b(no|cancel|stop|not yet|wait)\b/i;
const QUESTION_RE = /\b(why|how|what|explain)\b/i;

function classifyReply(
  text: string,
  awaitingField: { formCode: string; fieldId: string } | null,
  criticalFields: { formCode: string; fieldId: string; label: string }[],
): ReplyIntent {
  const trimmed = text.trim();

  if (awaitingField) {
    const cents = parseMoneyInputCents(trimmed);
    if (cents !== null) return { kind: 'field_value', cents };
    // Fall through — a reply to "what's the new value?" that isn't a
    // number is treated as unclear, not silently ignored.
  }

  if (CONFIRM_RE.test(trimmed)) return { kind: 'confirm' };
  if (CANCEL_RE.test(trimmed)) return { kind: 'cancel' };

  const lower = trimmed.toLowerCase();
  const matchedField = criticalFields.find((f) => lower.includes(f.label.toLowerCase().split(' ')[0]));
  const cents = parseMoneyInputCents(trimmed);

  if (matchedField && cents !== null) {
    return { kind: 'field_edit_request', field: { formCode: matchedField.formCode, fieldId: matchedField.fieldId }, cents };
  }
  if (QUESTION_RE.test(trimmed)) {
    return { kind: 'question', field: matchedField ? { formCode: matchedField.formCode, fieldId: matchedField.fieldId } : undefined };
  }
  return { kind: 'unclear' };
}

function hashForms(forms: Record<string, Record<string, any>>): string {
  return createHash('sha256').update(JSON.stringify(forms)).digest('hex');
}

export async function hasConfirmedFreshReview(tenantId: string, taxYear: number): Promise<boolean> {
  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (!review || review.status !== 'confirmed' || !review.reviewedFormsHash) return false;

  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) return false;

  const currentHash = hashForms((filing.forms as Record<string, Record<string, any>>) || {});
  return currentHash === review.reviewedFormsHash;
}

export async function getActiveReviewForTenant(tenantId: string): Promise<{ taxYear: number } | null> {
  const review = await db.abTaxFilingReview.findFirst({
    where: { tenantId, status: { in: ['summarizing', 'awaiting_edit'] } },
    orderBy: { updatedAt: 'desc' },
  });
  return review ? { taxYear: review.taxYear } : null;
}

/**
 * Writes one field, recomputes totals, and clears any pending
 * awaiting-edit state — shared executor for both the chat state machine's
 * field-edit branches below AND the web review tab's structured
 * POST .../review/edit-field route (Task 13). Never guesses a field or
 * value; the caller (chat intent classification, or a web form input)
 * already knows exactly which one.
 */
const CURRENCY_FOR_JURISDICTION: Record<string, string> = { ca: 'CAD', us: 'USD', au: 'AUD' };

export async function applyFieldEdit(
  tenantId: string, taxYear: number, formCode: string, fieldId: string, cents: number,
): Promise<{ message: string; computedTotals: ComputedFilingTotals }> {
  await updateFilingField(tenantId, taxYear, formCode, fieldId, cents);

  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);
  const forms = (filing.forms as Record<string, Record<string, any>>) || {};
  const computedTotals = computeFilingTotals(filing.jurisdiction, filing.region, taxYear, forms);

  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (review) {
    await db.abTaxFilingReview.update({ where: { id: review.id }, data: { status: 'summarizing', awaitingFieldId: null } });
  }

  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const locale = config?.locale || DEFAULT_LOCALE_FOR_JURISDICTION[filing.jurisdiction] || 'en-US';
  const currency = CURRENCY_FOR_JURISDICTION[filing.jurisdiction] || 'USD';
  return { message: `Updated to ${formatCurrency(cents, locale, currency)}. Anything else, or reply "looks good" to submit?`, computedTotals };
}

/**
 * Marks the review confirmed (hashing the CURRENT forms, so a later edit
 * through any other path makes hasConfirmedFreshReview go stale
 * automatically) and calls the real submitFiling() in the same turn —
 * shared executor for the chat 'confirm' intent below AND the web review
 * tab's structured POST .../review/confirm route (Task 13).
 */
export async function confirmAndSubmit(tenantId: string, taxYear: number): Promise<{ message: string; filed: boolean }> {
  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);
  const forms = (filing.forms as Record<string, Record<string, any>>) || {};

  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (review) {
    const reviewedFormsHash = hashForms(forms);
    await db.abTaxFilingReview.update({
      where: { id: review.id },
      data: { status: 'confirmed', confirmedAt: new Date(), reviewedFormsHash, awaitingFieldId: null },
    });
  }

  const result = await submitFiling(tenantId, taxYear);
  if (result.success) return { message: `✅ ${result.data.message}`, filed: !!result.data.filed };
  return { message: `❌ ${result.error}`, filed: false };
}

export async function answerReviewMessage(
  tenantId: string, taxYear: number, text: string, callGemini: CallGeminiFn,
): Promise<{ message: string }> {
  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) throw new Error(`No filing found for tenant ${tenantId} / year ${taxYear}`);

  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (!review) throw new Error(`No active review for tenant ${tenantId} / year ${taxYear} — call startReview first`);

  const forms = (filing.forms as Record<string, Record<string, any>>) || {};
  const pack = getTaxReviewPack(filing.jurisdiction);
  const criticalFields = pack.criticalFields(forms);

  const config = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const locale = config?.locale || DEFAULT_LOCALE_FOR_JURISDICTION[filing.jurisdiction] || 'en-US';

  const awaitingField = review.awaitingFieldId
    ? (() => { const [formCode, fieldId] = review.awaitingFieldId!.split(':'); return { formCode, fieldId }; })()
    : null;

  const intent = classifyReply(text, awaitingField, criticalFields);

  if (intent.kind === 'cancel') {
    await db.abTaxFilingReview.update({ where: { id: review.id }, data: { status: 'summarizing', awaitingFieldId: null } });
    return { message: "No problem — nothing was submitted. Let me know when you'd like to pick the review back up." };
  }

  if (intent.kind === 'field_value' && awaitingField) {
    return applyFieldEdit(tenantId, taxYear, awaitingField.formCode, awaitingField.fieldId, intent.cents);
  }

  if (intent.kind === 'field_edit_request') {
    return applyFieldEdit(tenantId, taxYear, intent.field.formCode, intent.field.fieldId, intent.cents);
  }

  if (intent.kind === 'question') {
    const field = intent.field
      ? criticalFields.find((f) => f.formCode === intent.field!.formCode && f.fieldId === intent.field!.fieldId)!
      : { formCode: '_overall', fieldId: '_overall', label: 'your filing', currentValue: null };
    const totals = computeFilingTotals(filing.jurisdiction, filing.region, taxYear, forms);
    const prompt = languageDirective(locale) + '\n\n' + pack.explainFieldPrompt({ field, forms, computedTotals: totals, personalProfileContext: '', locale, question: text });
    const raw = await callGemini(prompt, 'Answer this question.', 300);
    if (!raw) return { message: "I couldn't generate an answer just now — you can ask again, change a number, or say \"looks good\" to submit." };
    try {
      const parsed = pack.parseFieldExplanation(JSON.parse(cleanJson(raw)));
      if (!verifyGroundedNumbers(parsed.explanation, totals)) {
        return { message: "I can't confirm that figure against your filing's real numbers, so I won't guess — you can ask a more specific question, change a number, or say \"looks good\" to submit." };
      }
      return { message: parsed.explanation };
    } catch {
      return { message: "I couldn't generate an answer just now — you can ask again, change a number, or say \"looks good\" to submit." };
    }
  }

  if (intent.kind === 'confirm') {
    return confirmAndSubmit(tenantId, taxYear);
  }

  // unclear — deterministic, no LLM call.
  return { message: 'I can update a number, answer a question about your filing, or you can say "looks good" to submit — what would you like to do?' };
}
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-review-agent-answer.test.ts` — Expected: PASS, all 10 tests.

- [ ] **Step 5: Run the whole plugin's test suite to confirm zero regression, then commit**

Run: `cd plugins/agentbook-tax/backend && npx vitest run`

```bash
git add plugins/agentbook-tax/backend/src/tax-review-agent.ts plugins/agentbook-tax/backend/src/__tests__/tax-review-agent-answer.test.ts
git commit -m "feat(tax): answerReviewMessage() state machine — edit/question/confirm/cancel"
```

---

### Task 13: Tax-plugin HTTP endpoints for the review agent

**Files:**
- Modify: `plugins/agentbook-tax/backend/src/server.ts` (add 3 new Express routes; find this file's existing route-registration style by looking at how `/tax-filing/:year/submit` is registered and mirror it exactly — same middleware, same tenant-resolution convention, same error-handling shape)
- Test: `plugins/agentbook-tax/backend/src/__tests__/tax-review-routes.test.ts`

**Interfaces:**
- Produces six routes, all under `/api/v1/agentbook-tax`. The first four are chat-shaped (return `message` text); the last two are structured — added on plan review specifically for the web review tab (Task 15), per Global Constraint 14:
  - `GET /tax-filing/review/active` — no year in the path (a tenant's incoming chat message doesn't carry one); calls `getActiveReviewForTenant(tenantId)`; returns `{ success: true, data: { active: false } }` or `{ success: true, data: { active: true, taxYear } }`.
  - `POST /tax-filing/:year/review/start` — calls `startReview(tenantId, year, callGemini)`; returns `{ success: true, data: { message, criticalFields, computedTotals } }`.
  - `POST /tax-filing/:year/review/message` — body `{ text: string }`; calls `answerReviewMessage(tenantId, year, text, callGemini)`; returns `{ success: true, data: { message } }`.
  - `GET /tax-filing/:year/review/status` — calls `hasConfirmedFreshReview(tenantId, year)`; returns `{ success: true, data: { confirmedAndFresh: boolean } }`.
  - `POST /tax-filing/:year/review/edit-field` — body `{ formCode: string, fieldId: string, valueCents: number }`; calls `applyFieldEdit(tenantId, year, formCode, fieldId, valueCents)` directly — **no text classification involved**, since the web UI already knows exactly which field it's editing; returns `{ success: true, data: { message, computedTotals } }`.
  - `POST /tax-filing/:year/review/confirm` — no body needed; calls `confirmAndSubmit(tenantId, year)` directly; returns `{ success: true, data: { message, filed: boolean } }`.

Wire the real `buildPersonalProfileContext` here (not inside `tax-review-agent.ts`, per Task 11's note) if `plugins/agentbook-tax/backend` can import it — check whether `personal-profile-context.ts` (currently in `plugins/agentbook-core/backend/src`) is reachable from this package; if not (same cross-package boundary issue as Global Constraint 10), pass an empty string for `personalProfileContext` here too, and leave a `// TODO(follow-up): thread real personal-profile context into the tax review agent once a shared cross-plugin utility package exists for it` comment — do not attempt a new shared package for this single string in this plan; it is out of scope.

- [ ] **Step 0: Confirm two prerequisites before writing tests**

1. Check `plugins/agentbook-tax/backend/src/server.ts`'s bottom (where it calls `app.listen(...)`) for whether the Express `app` instance is already exported. If not, add a minimal `export { app };` (or `export default app;` if that's the convention other plugin backends already use — check `plugins/agentbook-core/backend/src/server.ts` for precedent) so tests can import and exercise it without starting a real listener. This is a small, additive, test-enabling export — it changes no runtime behavior.
2. Check `plugins/agentbook-tax/backend/package.json`'s `devDependencies` — `supertest` is not currently listed there (confirmed absent during this plan's investigation phase). Add `"supertest": "^7.0.0"` and `"@types/supertest": "^6.0.0"` (or whatever current major versions are already used elsewhere in this monorepo — check another plugin backend's `package.json` for the exact version already in use, and match it rather than introducing a new version) before writing Step 1's test.

- [ ] **Step 1: Write the failing tests**

```typescript
// plugins/agentbook-tax/backend/src/__tests__/tax-review-routes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const startReview = vi.fn();
const answerReviewMessage = vi.fn();
const hasConfirmedFreshReview = vi.fn();
const getActiveReviewForTenant = vi.fn();
const applyFieldEdit = vi.fn();
const confirmAndSubmit = vi.fn();

vi.mock('../tax-review-agent.js', () => ({
  startReview: (...a: any[]) => startReview(...a),
  answerReviewMessage: (...a: any[]) => answerReviewMessage(...a),
  hasConfirmedFreshReview: (...a: any[]) => hasConfirmedFreshReview(...a),
  getActiveReviewForTenant: (...a: any[]) => getActiveReviewForTenant(...a),
  applyFieldEdit: (...a: any[]) => applyFieldEdit(...a),
  confirmAndSubmit: (...a: any[]) => confirmAndSubmit(...a),
}));

beforeEach(() => vi.clearAllMocks());

describe('tax review HTTP routes', () => {
  it('GET /tax-filing/review/active returns active:false when there is no in-progress review', async () => {
    getActiveReviewForTenant.mockResolvedValue(null);
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/review/active').set('x-tenant-id', 't1');
    expect(res.body.data.active).toBe(false);
  });

  it('GET /tax-filing/review/active returns the taxYear when a review is in progress', async () => {
    getActiveReviewForTenant.mockResolvedValue({ taxYear: 2025 });
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/review/active').set('x-tenant-id', 't1');
    expect(res.body.data).toEqual({ active: true, taxYear: 2025 });
  });

  it('POST /tax-filing/:year/review/start returns startReview\'s message', async () => {
    startReview.mockResolvedValue({ message: 'Here is your summary...' });
    const { app } = await import('../server.js');
    const res = await request(app).post('/api/v1/agentbook-tax/tax-filing/2025/review/start').set('x-tenant-id', 't1');
    expect(res.body.data.message).toBe('Here is your summary...');
  });

  it('POST /tax-filing/:year/review/message passes the body text through to answerReviewMessage', async () => {
    answerReviewMessage.mockResolvedValue({ message: 'Updated.' });
    const { app } = await import('../server.js');
    const res = await request(app)
      .post('/api/v1/agentbook-tax/tax-filing/2025/review/message')
      .set('x-tenant-id', 't1')
      .send({ text: 'change income to 80000' });
    expect(answerReviewMessage).toHaveBeenCalledWith('t1', 2025, 'change income to 80000', expect.anything());
    expect(res.body.data.message).toBe('Updated.');
  });

  it('GET /tax-filing/:year/review/status returns confirmedAndFresh', async () => {
    hasConfirmedFreshReview.mockResolvedValue(true);
    const { app } = await import('../server.js');
    const res = await request(app).get('/api/v1/agentbook-tax/tax-filing/2025/review/status').set('x-tenant-id', 't1');
    expect(res.body.data.confirmedAndFresh).toBe(true);
  });

  it('POST /tax-filing/:year/review/edit-field calls applyFieldEdit directly with the exact field named in the body — no text classification', async () => {
    applyFieldEdit.mockResolvedValue({ message: 'Updated to $80,000.', computedTotals: { taxableIncomeCents: 8000000 } });
    const { app } = await import('../server.js');
    const res = await request(app)
      .post('/api/v1/agentbook-tax/tax-filing/2025/review/edit-field')
      .set('x-tenant-id', 't1')
      .send({ formCode: 'T1', fieldId: 'total_income_15000', valueCents: 8000000 });
    expect(applyFieldEdit).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(res.body.data.message).toContain('$80,000');
  });

  it('POST /tax-filing/:year/review/confirm calls confirmAndSubmit directly, no body required', async () => {
    confirmAndSubmit.mockResolvedValue({ message: 'Filed!', filed: false });
    const { app } = await import('../server.js');
    const res = await request(app).post('/api/v1/agentbook-tax/tax-filing/2025/review/confirm').set('x-tenant-id', 't1');
    expect(confirmAndSubmit).toHaveBeenCalledWith('t1', 2025);
    expect(res.body.data.message).toBe('Filed!');
  });
});
```

(**Note to implementer:** the exact tenant-resolution header/middleware (`x-tenant-id` above is a placeholder for whatever this plugin's existing routes actually use — check the real middleware, e.g. by reading how the existing `/tax-filing/:year/submit` route resolves `tenantId` today, and use the identical mechanism, not a new one.)

- [ ] **Step 2: Run tests to verify they fail.** Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-review-routes.test.ts` — Expected: FAIL (routes don't exist).

- [ ] **Step 3: Implement the routes**, mirroring the exact structure/middleware of the existing `/tax-filing/:year/submit` route in `server.ts`:

```typescript
import { startReview, answerReviewMessage, hasConfirmedFreshReview, getActiveReviewForTenant, applyFieldEdit, confirmAndSubmit } from './tax-review-agent.js';
// callGemini here is this plugin's own way of reaching the LLM — check
// whether this package already has a callGemini-equivalent (search for
// existing Gemini usage in plugins/agentbook-tax/backend/src, e.g. in
// receipt-OCR or elsewhere); if one exists, reuse it. If none exists in
// this package today, this task must add a minimal one, copying the
// existing callGemini implementation from
// plugins/agentbook-core/backend/src/server.ts verbatim (it's a
// dependency-free fetch() wrapper against the Gemini HTTP API — see the
// exact code already quoted in this plan's investigation phase) rather
// than attempting a shared cross-package import.

app.get('/api/v1/agentbook-tax/tax-filing/review/active', async (req, res) => {
  const tenantId = /* same tenant-resolution this file's other routes use */;
  const active = await getActiveReviewForTenant(tenantId);
  res.json({ success: true, data: active ? { active: true, taxYear: active.taxYear } : { active: false } });
});

app.post('/api/v1/agentbook-tax/tax-filing/:year/review/start', async (req, res) => {
  const tenantId = /* ... */;
  const taxYear = Number(req.params.year);
  try {
    const result = await startReview(tenantId, taxYear, callGemini);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/v1/agentbook-tax/tax-filing/:year/review/message', async (req, res) => {
  const tenantId = /* ... */;
  const taxYear = Number(req.params.year);
  const text = String(req.body?.text || '');
  try {
    const result = await answerReviewMessage(tenantId, taxYear, text, callGemini);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/v1/agentbook-tax/tax-filing/:year/review/status', async (req, res) => {
  const tenantId = /* ... */;
  const taxYear = Number(req.params.year);
  const confirmedAndFresh = await hasConfirmedFreshReview(tenantId, taxYear);
  res.json({ success: true, data: { confirmedAndFresh } });
});

// Structured routes for the web review tab (Task 15) — no text
// classification, since the UI already knows exactly which field/action
// it means. Added on plan review, per Global Constraint 14.
app.post('/api/v1/agentbook-tax/tax-filing/:year/review/edit-field', async (req, res) => {
  const tenantId = /* ... */;
  const taxYear = Number(req.params.year);
  const { formCode, fieldId, valueCents } = req.body || {};
  if (typeof formCode !== 'string' || typeof fieldId !== 'string' || !Number.isInteger(valueCents)) {
    return res.status(400).json({ success: false, error: 'formCode, fieldId, and an integer valueCents are required' });
  }
  try {
    const result = await applyFieldEdit(tenantId, taxYear, formCode, fieldId, valueCents);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/v1/agentbook-tax/tax-filing/:year/review/confirm', async (req, res) => {
  const tenantId = /* ... */;
  const taxYear = Number(req.params.year);
  try {
    const result = await confirmAndSubmit(tenantId, taxYear);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, error: err instanceof Error ? err.message : String(err) });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass.** Run: `cd plugins/agentbook-tax/backend && npx vitest run src/__tests__/tax-review-routes.test.ts` — Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-tax/backend/src/server.ts plugins/agentbook-tax/backend/src/__tests__/tax-review-routes.test.ts
git commit -m "feat(tax): HTTP endpoints for the review agent"
```

---

### Task 14: Locale files — French and the first-ever Chinese registration

**Files:**
- Modify: `packages/agentbook-i18n/src/locales/en/tax.json` (add keys)
- Modify: `packages/agentbook-i18n/src/locales/fr/tax.json` (add the same keys, French)
- Create: `packages/agentbook-i18n/src/locales/zh/tax.json` (new locale directory + file — `zh` has never been registered before)
- Create: `packages/agentbook-i18n/src/locales/zh/common.json` (only the handful of `common.*` keys the new web tab actually uses: `save`, `cancel`, `confirm` — not a full retranslation of `common.json`)
- Modify: `packages/agentbook-i18n/src/loader.ts` (register `zh`)
- Test: `packages/agentbook-i18n/src/__tests__/zh-registration.test.ts` (new)

**Interfaces:**
- Consumes: `loadLocale`, `t`, `resolveLocale` (already exist, Task 6's investigation confirmed their real signatures).
- Produces: `t('tax.tax_review_*', ...)` resolves correctly for `en`, `fr`, and — for the first time in this codebase — `zh`, for the specific keys this feature adds. `resolveLocale` recognizes `'zh'` as a registered locale for the first time.

**Why this is scoped narrowly (read before writing code):** `packages/agentbook-tax/frontend`'s existing pages (`Quarterly.tsx`, `Reports.tsx`, `CashFlow.tsx`, `TaxDashboard.tsx`, etc.) render hardcoded English JSX today — none of them call `t()` yet, despite the runtime existing and being tested. This task does not retrofit them; that's a separate, much larger effort, and taking it on here would be scope creep well beyond "the new agent supports i18n." This task registers `zh` for the first time ever in `@agentbook/i18n` — but only with the keys this one new tab needs. A `zh` tenant visiting any *other* existing tax page still sees English today (unchanged from before this task — not a regression, since that's already true for every locale on those pages, `fr` included). `loadLocale`'s merge-by-spread semantics (`{...locales.get(locale), ...data}`, confirmed in Task 6's investigation) make this safe regardless of whether some other in-flight effort elsewhere in this codebase also registers `zh` with its own namespaces before or after this lands — the two sets of keys simply accumulate; neither can clobber the other's namespace.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/agentbook-i18n/src/__tests__/zh-registration.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { t, setLocale, resolveLocale } from '../core.js';
import { loadAllLocales } from '../loader.js';

beforeAll(() => { loadAllLocales(); });

describe('zh locale — registered for the first time by this feature', () => {
  it('resolveLocale now recognizes zh as a real registered locale', () => {
    expect(resolveLocale({ tenantLocale: 'zh-CN' })).toBe('zh-CN');
  });

  it('t() resolves the new tax-review keys in zh', () => {
    setLocale('zh');
    expect(t('tax.tax_review_title')).not.toBe('tax.tax_review_title'); // not falling through to the raw key
    expect(t('common.save')).not.toBe('common.save');
  });

  it('t() still falls back to English for a zh key this feature did NOT add — the honest scope boundary, not a broken fallback', () => {
    setLocale('zh');
    // pnl_title is a real, pre-existing tax.json key this task deliberately
    // did not translate — must fall back to the English string, not the
    // raw key (proves the existing fallback-to-English chain still works
    // for the 99% of tax.json this task didn't touch).
    setLocale('en');
    const englishPnl = t('tax.pnl_title');
    setLocale('zh');
    expect(t('tax.pnl_title')).toBe(englishPnl);
  });

  it('existing en and fr locales are byte-identical for every key this task did not touch', () => {
    setLocale('fr');
    expect(t('common.cancel')).toBe('Annuler'); // unchanged from before this task
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd packages/agentbook-i18n && npx vitest run src/__tests__/zh-registration.test.ts` — Expected: FAIL (`zh` isn't registered; `resolveLocale({tenantLocale:'zh-CN'})` returns `'en'`).

- [ ] **Step 3: Add the new keys to `en/tax.json` and `fr/tax.json`**

Add these six keys to both `packages/agentbook-i18n/src/locales/en/tax.json` and `packages/agentbook-i18n/src/locales/fr/tax.json` (alongside the existing keys — do not remove or reorder anything already there):

English (`en/tax.json` additions):
```json
{
  "tax_review_title": "Filing Review",
  "tax_review_summary_label": "Summary",
  "tax_review_ask_placeholder": "Ask a question about any number...",
  "tax_review_ask_button": "Ask",
  "tax_review_submit_button": "Submit filing",
  "tax_review_edit_saved": "Saved"
}
```

French (`fr/tax.json` additions — Québec French, matching this codebase's existing "French (Canadian)" convention per `loader.ts`'s own comment, and its established tax-specific vocabulary, e.g. TPS/TVQ elsewhere in this same file):
```json
{
  "tax_review_title": "Revision de la declaration",
  "tax_review_summary_label": "Sommaire",
  "tax_review_ask_placeholder": "Posez une question sur un montant...",
  "tax_review_ask_button": "Demander",
  "tax_review_submit_button": "Soumettre la declaration",
  "tax_review_edit_saved": "Enregistre"
}
```

- [ ] **Step 4: Create `zh/tax.json` and `zh/common.json`**

```json
// packages/agentbook-i18n/src/locales/zh/tax.json (new file — only this
// feature's keys; the other ~18 pre-existing tax.json keys are
// deliberately NOT translated here, per this task's scope note above)
{
  "tax_review_title": "报税审核",
  "tax_review_summary_label": "摘要",
  "tax_review_ask_placeholder": "请输入关于任意数字的问题...",
  "tax_review_ask_button": "提问",
  "tax_review_submit_button": "提交报税",
  "tax_review_edit_saved": "已保存"
}
```

```json
// packages/agentbook-i18n/src/locales/zh/common.json (new file — only the
// 3 keys this feature's UI actually needs, not a full common.json translation)
{
  "save": "保存",
  "cancel": "取消",
  "confirm": "确认"
}
```

- [ ] **Step 5: Register `zh` in the loader**

In `packages/agentbook-i18n/src/loader.ts`, add the new imports and a new `loadLocale('zh', ...)` call, leaving the existing `en`/`fr` registrations completely untouched:

```typescript
import { loadLocale } from './core.js';

// English
import enCommon from './locales/en/common.json' assert { type: 'json' };
import enExpense from './locales/en/expense.json' assert { type: 'json' };
import enInvoice from './locales/en/invoice.json' assert { type: 'json' };
import enTax from './locales/en/tax.json' assert { type: 'json' };
import enProactive from './locales/en/proactive.json' assert { type: 'json' };
import enCalendar from './locales/en/calendar.json' assert { type: 'json' };

// French
import frCommon from './locales/fr/common.json' assert { type: 'json' };
import frExpense from './locales/fr/expense.json' assert { type: 'json' };
import frInvoice from './locales/fr/invoice.json' assert { type: 'json' };
import frTax from './locales/fr/tax.json' assert { type: 'json' };
import frProactive from './locales/fr/proactive.json' assert { type: 'json' };
import frCalendar from './locales/fr/calendar.json' assert { type: 'json' };

// Chinese — first registration ever in this package (Tax Review Agent
// feature). Scoped to only the namespaces this feature actually
// translated (tax, common) — see this file's owning task for why the
// other namespaces are deliberately not here yet.
import zhTax from './locales/zh/tax.json' assert { type: 'json' };
import zhCommon from './locales/zh/common.json' assert { type: 'json' };

export function loadAllLocales(): void {
  // English
  loadLocale('en', { common: enCommon, expense: enExpense, invoice: enInvoice, tax: enTax, proactive: enProactive, calendar: enCalendar });

  // French (Canadian)
  loadLocale('fr', { common: frCommon, expense: frExpense, invoice: frInvoice, tax: frTax, proactive: frProactive, calendar: frCalendar });

  // Chinese (partial — tax + common only, see above)
  loadLocale('zh', { common: zhCommon, tax: zhTax });
}
```

- [ ] **Step 6: Run test to verify it passes.** Run: `cd packages/agentbook-i18n && npx vitest run src/__tests__/zh-registration.test.ts` — Expected: PASS, all 4 tests.

- [ ] **Step 7: Run the full package test suite to confirm zero regression to existing en/fr behavior, then commit**

Run: `cd packages/agentbook-i18n && npx vitest run`
Expected: PASS — `core.test.ts` and `formatters.test.ts` (pre-existing) are completely unaffected; this task only adds new keys and a new locale, touching no existing key's value.

```bash
git add packages/agentbook-i18n/src/locales/en/tax.json packages/agentbook-i18n/src/locales/fr/tax.json packages/agentbook-i18n/src/locales/zh/ packages/agentbook-i18n/src/loader.ts packages/agentbook-i18n/src/__tests__/zh-registration.test.ts
git commit -m "feat(i18n): tax-review keys in en/fr, first-ever zh locale registration"
```

---

### Task 15: Web review tab — `TaxFilingReviewTab.tsx`

**Files:**
- Create: `plugins/agentbook-tax/frontend/src/pages/TaxFilingReviewTab.tsx`
- Modify: `plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx` (add a 4th tab)
- Test: `plugins/agentbook-tax/frontend/src/pages/__tests__/TaxFilingReviewTab.test.tsx` (new — mirror whichever test setup this plugin frontend's existing page tests already use, e.g. check for an existing `FastTrackTab.test.tsx` or similar and match its render/mock-fetch conventions exactly)

**Interfaces:**
- Consumes: Task 13's HTTP endpoints directly (`GET .../review/active`, `POST .../review/start`, `POST .../review/message`, `GET .../review/status`, `POST .../review/edit-field`, `POST .../review/confirm`) — plain `fetch` calls, the same pattern `TaxPackage.tsx`'s own `TaxPackageContent` already uses against `API = '/api/v1/agentbook-tax'`. `t`, `formatMoney` from `@agentbook/i18n` (Task 14's new keys; `formatMoney` already used by `TaxDashboard.tsx`).
- Produces: a `'review'` tab inside `TaxPackagePage`'s existing tab bar (`plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx:55-91`, real code quoted in this plan's investigation phase).

This is the first page in this plugin to actually call `t()` — every sibling tab (`TaxPackageContent`, `PastFilingsPage`, `FastTrackTab`) stays hardcoded English, unchanged by this task (Task 14's scope note explains why retrofitting them is explicitly out of scope here).

- [ ] **Step 1: Write the failing test**

```tsx
// plugins/agentbook-tax/frontend/src/pages/__tests__/TaxFilingReviewTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TaxFilingReviewTab } from '../TaxFilingReviewTab';
import { loadAllLocales } from '@agentbook/i18n';

beforeEach(() => {
  loadAllLocales();
  global.fetch = vi.fn();
});

function mockFetchSequence(responses: any[]) {
  let call = 0;
  (global.fetch as any).mockImplementation(() =>
    Promise.resolve({ json: () => Promise.resolve(responses[Math.min(call++, responses.length - 1)]) }),
  );
}

describe('TaxFilingReviewTab', () => {
  it('loads the review summary and renders the critical fields with their current values', async () => {
    mockFetchSequence([
      { success: true, data: {
        message: 'Your taxable income is $73,000...',
        criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }],
        computedTotals: { taxableIncomeCents: 7300000, taxPayableCents: 1150000 },
      } },
    ]);
    render(<TaxFilingReviewTab taxYear={2025} />);
    await waitFor(() => expect(screen.getByText(/taxable income/i)).toBeInTheDocument());
    expect(screen.getByDisplayValue('73000')).toBeInTheDocument(); // dollars, not cents, in the input
  });

  it('editing a field calls POST .../review/edit-field with the exact formCode/fieldId — no free-text round trip', async () => {
    mockFetchSequence([
      { success: true, data: { message: 'summary', criticalFields: [{ formCode: 'T1', fieldId: 'taxable_income_26000', label: 'Taxable income', currentValue: 7300000 }], computedTotals: {} } },
      { success: true, data: { message: 'Updated to $80,000.', computedTotals: { taxableIncomeCents: 8000000 } } },
    ]);
    render(<TaxFilingReviewTab taxYear={2025} />);
    await waitFor(() => screen.getByDisplayValue('73000'));
    fireEvent.change(screen.getByDisplayValue('73000'), { target: { value: '80000' } });
    fireEvent.click(screen.getByText(/save/i));
    await waitFor(() => {
      const editCall = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('edit-field'));
      expect(editCall).toBeDefined();
      const body = JSON.parse(editCall[1].body);
      expect(body).toEqual({ formCode: 'T1', fieldId: 'taxable_income_26000', valueCents: 8000000 });
    });
  });

  it('clicking Submit calls POST .../review/confirm with no body', async () => {
    mockFetchSequence([
      { success: true, data: { message: 'summary', criticalFields: [], computedTotals: {} } },
      { success: true, data: { message: 'Filed!', filed: false } },
    ]);
    render(<TaxFilingReviewTab taxYear={2025} />);
    await waitFor(() => screen.getByText(/submit filing/i));
    fireEvent.click(screen.getByText(/submit filing/i));
    await waitFor(() => {
      const confirmCall = (global.fetch as any).mock.calls.find((c: any[]) => String(c[0]).includes('/confirm'));
      expect(confirmCall).toBeDefined();
    });
  });

  it('renders French labels when the locale is set to fr', async () => {
    const { setLocale } = await import('@agentbook/i18n');
    setLocale('fr');
    mockFetchSequence([{ success: true, data: { message: 's', criticalFields: [], computedTotals: {} } }]);
    render(<TaxFilingReviewTab taxYear={2025} />);
    await waitFor(() => expect(screen.getByText('Revision de la declaration')).toBeInTheDocument());
    setLocale('en');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd plugins/agentbook-tax/frontend && npx vitest run src/pages/__tests__/TaxFilingReviewTab.test.tsx` — Expected: FAIL (component doesn't exist).

- [ ] **Step 3: Implement `TaxFilingReviewTab.tsx`**

```tsx
// plugins/agentbook-tax/frontend/src/pages/TaxFilingReviewTab.tsx
import React, { useEffect, useState, useCallback } from 'react';
import { t, formatMoney } from '@agentbook/i18n';
import { TaxDisclaimer } from '../components/TaxDisclaimer';

const API = '/api/v1/agentbook-tax';

interface CriticalField {
  formCode: string;
  fieldId: string;
  label: string;
  currentValue: number | string | boolean | null;
}
interface ComputedTotals {
  totalIncomeCents?: number;
  taxableIncomeCents?: number;
  taxPayableCents?: number;
}

export const TaxFilingReviewTab: React.FC<{ taxYear: number }> = ({ taxYear }) => {
  const [message, setMessage] = useState('');
  const [fields, setFields] = useState<CriticalField[]>([]);
  const [totals, setTotals] = useState<ComputedTotals>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const loadReview = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/start`, { method: 'POST' });
    const json = await res.json();
    if (json.success) {
      setMessage(json.data.message);
      setFields(json.data.criticalFields || []);
      setTotals(json.data.computedTotals || {});
    }
    setLoading(false);
  }, [taxYear]);

  useEffect(() => { loadReview(); }, [loadReview]);

  const saveField = async (field: CriticalField) => {
    const raw = edits[field.fieldId];
    if (raw === undefined) return;
    const valueCents = Math.round(Number(raw) * 100);
    if (!Number.isFinite(valueCents)) return;
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/edit-field`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ formCode: field.formCode, fieldId: field.fieldId, valueCents }),
    });
    const json = await res.json();
    if (json.success) {
      setTotals(json.data.computedTotals || totals);
      setMessage(json.data.message);
    }
  };

  const askQuestion = async () => {
    if (!question.trim()) return;
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: question }),
    });
    const json = await res.json();
    if (json.success) setAnswer(json.data.message);
    setQuestion('');
  };

  const submit = async () => {
    setSubmitting(true);
    const res = await fetch(`${API}/tax-filing/${taxYear}/review/confirm`, { method: 'POST' });
    const json = await res.json();
    if (json.success) setMessage(json.data.message);
    setSubmitting(false);
  };

  if (loading) return <div className="p-4 sm:p-6">{t('common.loading')}</div>;

  return (
    <div className="px-4 py-5 sm:p-6 max-w-2xl mx-auto">
      <TaxDisclaimer />
      <h2 className="text-lg font-semibold mt-4 mb-2">{t('tax.tax_review_title')}</h2>

      <div className="bg-card border border-border rounded-xl p-4 mb-4">
        <div className="text-sm font-medium text-muted-foreground mb-1">{t('tax.tax_review_summary_label')}</div>
        <p className="text-sm">{message}</p>
      </div>

      <div className="space-y-3 mb-4">
        {fields.map((field) => (
          <div key={`${field.formCode}:${field.fieldId}`} className="flex items-center gap-2">
            <label className="flex-1 text-sm">{field.label}</label>
            <input
              type="number"
              className="w-32 border border-border rounded px-2 py-1 text-sm"
              value={edits[field.fieldId] ?? (typeof field.currentValue === 'number' ? String(field.currentValue / 100) : '')}
              onChange={(e) => setEdits((prev) => ({ ...prev, [field.fieldId]: e.target.value }))}
            />
            <button onClick={() => saveField(field)} className="text-sm text-primary">{t('common.save')}</button>
          </div>
        ))}
      </div>

      {totals.taxPayableCents != null && (
        <div className="text-sm text-muted-foreground mb-4">{formatMoney(totals.taxPayableCents, 'USD')}</div>
      )}

      <div className="flex gap-2 mb-4">
        <input
          className="flex-1 border border-border rounded px-2 py-1 text-sm"
          placeholder={t('tax.tax_review_ask_placeholder')}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <button onClick={askQuestion} className="text-sm text-primary">{t('tax.tax_review_ask_button')}</button>
      </div>
      {answer && <p className="text-sm mb-4">{answer}</p>}

      <button
        onClick={submit}
        disabled={submitting}
        className="w-full bg-primary text-primary-foreground rounded-lg py-2 text-sm font-medium disabled:opacity-50"
      >
        {t('tax.tax_review_submit_button')}
      </button>
    </div>
  );
};
```

**Note on currency in `formatMoney(totals.taxPayableCents, 'USD')` above:** this is a placeholder needing the tenant's real jurisdiction-derived currency, not a hardcoded `'USD'` — the implementer must plumb the tenant's actual currency (available via whatever hook `TaxDashboard.tsx` already uses, per its own `import { useTenantCurrency } from '../hooks/useTenantCurrency';`, confirmed to exist in this plugin) rather than ship this literal. Flagged explicitly rather than left as a silent wrong-currency bug — reuse `useTenantCurrency()`, don't invent a second way to know the tenant's currency.

- [ ] **Step 4: Wire the new tab into `TaxPackage.tsx`**

In `plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx`, add the import and extend the existing tab bar (real current code quoted in full in this plan's investigation phase, lines 12-94) — minimal diff, no other tab's behavior changes:

```tsx
import { TaxFilingReviewTab } from './TaxFilingReviewTab';
```

Change the tab union type and the tab-bar array:
```tsx
const [tab, setTab] = useState<'package' | 'past' | 'fast-track' | 'review'>(() => {
  if (typeof window === 'undefined') return 'package';
  const requested = new URLSearchParams(window.location.search).get('tab');
  return requested === 'past' || requested === 'fast-track' || requested === 'review' ? requested : 'package';
});
```
```tsx
{(['package', 'past', 'fast-track', 'review'] as const).map((t) => (
  <button
    key={t}
    onClick={() => setTab(t)}
    className={[
      'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
      tab === t ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:text-foreground',
    ].join(' ')}
  >
    {t === 'package' ? 'Year-end Package' : t === 'past' ? 'Prior-year returns' : t === 'fast-track' ? 'Tax Fast-Track' : t('tax.tax_review_title')}
  </button>
))}
```
(Note the last label uses the new `t()`-based string while the other three stay their existing hardcoded English — consistent with this task's stated scope: this tab is i18n-aware, its siblings are unchanged.)

```tsx
{tab === 'package' ? <TaxPackageContent /> : tab === 'past' ? <PastFilingsPage /> : tab === 'fast-track' ? <FastTrackTab /> : <TaxFilingReviewTab taxYear={new Date().getUTCFullYear() - 1} />}
```

- [ ] **Step 5: Run tests to verify they pass.** Run: `cd plugins/agentbook-tax/frontend && npx vitest run src/pages/__tests__/TaxFilingReviewTab.test.tsx` — Expected: PASS, all 4 tests.

- [ ] **Step 6: Run the full frontend test suite to confirm zero regression to the other three tabs, then commit**

Run: `cd plugins/agentbook-tax/frontend && npx vitest run`

```bash
git add plugins/agentbook-tax/frontend/src/pages/TaxFilingReviewTab.tsx plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx plugins/agentbook-tax/frontend/src/pages/__tests__/TaxFilingReviewTab.test.tsx
git commit -m "feat(tax): web review tab — TaxFilingReviewTab, i18n-aware (en/fr/zh)"
```

---

### Task 16: `server.ts` (agentbook-core) — `ctx` wiring + the submit gate

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts` (add `ctx.checkActiveTaxReview`/`ctx.answerTaxReview` implementations and wire them into the `ctx` object passed to `handleAgentMessage`; modify the existing `tax-filing-submit` INTERNAL handler at lines 4646-4672)
- Test: `plugins/agentbook-core/backend/src/__tests__/tax-filing-submit-review-gate.test.ts`

**Interfaces:**
- Produces: two new properties on whatever type `AgentContext`/`ctx` is (find its definition — likely in `agent-brain.ts` or a shared types file, alongside `callGemini`/`classifyOnly`/`classifyAndExecuteV1`/`executeClassification`):
  ```typescript
  checkActiveTaxReview: (tenantId: string) => Promise<{ active: boolean; taxYear?: number }>;
  answerTaxReview: (tenantId: string, taxYear: number, text: string) => Promise<{ message: string }>;
  ```
- Consumes: Task 13's three new HTTP endpoints, via the identical `fetch(taxBase + ...)`/`brainHeaders(tenantId)` pattern the existing `tax-filing-submit` handler already uses.

- [ ] **Step 1: Write the failing test**

```typescript
// plugins/agentbook-core/backend/src/__tests__/tax-filing-submit-review-gate.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally — this test verifies the gate check happens BEFORE
// the real submit call, source-order matters (see Step 3's wiring test).
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

beforeEach(() => vi.clearAllMocks());

describe('tax-filing-submit gate — calls review/status before the real submit endpoint', () => {
  it('when the review is NOT confirmed-and-fresh, calls review/start instead of the real submit endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { confirmedAndFresh: false } }) }) // status check
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { message: 'Here is your summary...' } }) }); // review/start

    // Import whatever function/module exposes the tax-filing-submit
    // handler logic in an independently-testable way — if it's not
    // currently extracted into its own exported function, this task must
    // extract it first (a pure refactor, same behavior, now testable
    // in isolation) before adding the new gate logic inside it.
    const { handleTaxFilingSubmit } = await import('../server.js');
    const result = await handleTaxFilingSubmit({ tenantId: 't1', extractedParams: { taxYear: 2025 } } as any);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('/review/status');
    expect(urls[1]).toContain('/review/start');
    expect(urls.some((u) => u.includes('/submit') && !u.includes('review'))).toBe(false);
    expect(result.responseData.message).toContain('Here is your summary');
  });

  it('when the review IS confirmed-and-fresh, calls the real submit endpoint as before', async () => {
    fetchMock
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { confirmedAndFresh: true } }) })
      .mockResolvedValueOnce({ json: async () => ({ success: true, data: { message: 'Filed!' } }) });

    const { handleTaxFilingSubmit } = await import('../server.js');
    const result = await handleTaxFilingSubmit({ tenantId: 't1', extractedParams: { taxYear: 2025 } } as any);

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls[1]).toContain('/submit');
    expect(urls[1]).not.toContain('review');
    expect(result.responseData.message).toContain('Filed!');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-filing-submit-review-gate.test.ts` — Expected: FAIL (`handleTaxFilingSubmit` isn't an exported, independently-callable function yet, and the gate doesn't exist).

- [ ] **Step 3: Extract the handler (pure refactor) and add the gate**

First, extract the existing INTERNAL handler block (lines 4646-4672, quoted in full in this plan's investigation phase) into its own exported function with identical behavior — this is a pure refactor with no behavior change, done first so the gate logic added next is unit-testable in isolation:

```typescript
export async function handleTaxFilingSubmit(params: {
  tenantId: string; extractedParams: any; text?: string; channel?: string; confidence?: number; startTime?: number;
}): Promise<any> {
  const { tenantId, extractedParams } = params;
  const startTime = params.startTime ?? Date.now();
  const taxBase = baseUrls['/api/v1/agentbook-tax'] || 'http://localhost:4053';
  const IH = brainHeaders(tenantId);
  const taxYear = extractedParams.taxYear || 2025;

  // Gate: don't call the real submit endpoint until a confirmed, fresh
  // review exists for this exact filing snapshot. Primary confirm→submit
  // handoff happens inside answerReviewMessage() (Task 12) directly; this
  // is the defensive fallback for any path that reaches this handler
  // without having gone through a review conversation first.
  const statusRes = await fetch(`${taxBase}/api/v1/agentbook-tax/tax-filing/${taxYear}/review/status`, { headers: IH });
  const statusData = await statusRes.json() as any;
  if (!statusData?.data?.confirmedAndFresh) {
    const startRes = await fetch(`${taxBase}/api/v1/agentbook-tax/tax-filing/${taxYear}/review/start`, { method: 'POST', headers: IH });
    const startData = await startRes.json() as any;
    const message = startData?.data?.message || 'Please review your filing before submitting.';
    return { selectedSkill: { name: 'tax-filing-submit' }, extractedParams, confidence: params.confidence, skillUsed: 'tax-review-agent', skillResponse: startData,
      responseData: { message, actions: [], chartData: null, skillUsed: 'tax-review-agent', confidence: params.confidence, latencyMs: Date.now() - startTime } };
  }

  try {
    const res = await fetch(`${taxBase}/api/v1/agentbook-tax/tax-filing/${taxYear}/submit`, { method: 'POST', headers: IH });
    const data = await res.json() as any;
    let message: string;
    if (data.success) {
      message = `✅ **${data.data.message}**`;
    } else {
      message = `❌ **Filing Failed**\n\n${data.error}`;
      if (data.data?.validation?.errors?.length > 0) {
        message += '\n\n**Fix these errors first:**\n';
        data.data.validation.errors.forEach((e: any) => { message += `- ${e.message}\n`; });
      }
    }
    await db.abConversation.create({ data: { tenantId, question: params.text || '[submit]', answer: message, queryType: 'agent', channel: params.channel, skillUsed: 'tax-filing-submit' } });
    return { selectedSkill: { name: 'tax-filing-submit' }, extractedParams, confidence: params.confidence, skillUsed: 'tax-filing-submit', skillResponse: data,
      responseData: { message, actions: [], chartData: null, skillUsed: 'tax-filing-submit', confidence: params.confidence, latencyMs: Date.now() - startTime } };
  } catch (err) {
    console.error('Tax submit error:', err);
    return { selectedSkill: { name: 'tax-filing-submit' }, extractedParams, confidence: params.confidence, skillUsed: 'tax-filing-submit', skillResponse: null,
      responseData: { message: "Filing submission failed. Please try again.", actions: [], chartData: null, skillUsed: 'tax-filing-submit', confidence: 0, latencyMs: Date.now() - startTime } };
  }
}
```

Then replace the original inline `if (selectedSkill.name === 'tax-filing-submit') { ... }` block (lines 4646-4672) with a single call to the new function, preserving the exact same surrounding control flow:

```typescript
    if (selectedSkill.name === 'tax-filing-submit') {
      return handleTaxFilingSubmit({ tenantId, extractedParams, text, channel, confidence, startTime });
    }
```

Next, add the two new `ctx`-injected functions. Find the object literal where `ctx`/`AgentContext` is constructed and passed into `handleAgentMessage` (search for where `callGemini`, `classifyOnly`, `classifyAndExecuteV1`, `executeClassification` are all assembled into one object — that's the exact spot) and add two more properties there:

```typescript
checkActiveTaxReview: async (tenantId: string) => {
  const taxBase = baseUrls['/api/v1/agentbook-tax'] || 'http://localhost:4053';
  const res = await fetch(`${taxBase}/api/v1/agentbook-tax/tax-filing/review/active`, { headers: brainHeaders(tenantId) });
  const data = await res.json() as any;
  return data?.data || { active: false };
},
answerTaxReview: async (tenantId: string, taxYear: number, text: string) => {
  const taxBase = baseUrls['/api/v1/agentbook-tax'] || 'http://localhost:4053';
  const res = await fetch(`${taxBase}/api/v1/agentbook-tax/tax-filing/${taxYear}/review/message`, {
    method: 'POST', headers: { ...brainHeaders(tenantId), 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
  });
  const data = await res.json() as any;
  return { message: data?.data?.message || 'Sorry, something went wrong reviewing your filing.' };
},
```

Also update the `AgentContext` type definition (wherever it's declared — likely a type/interface near `CallGeminiFn` or in `agent-brain.ts` itself) to add these two properties, matching `CallGeminiFn`'s style of a named exported function type if one exists for the others, or inline if the others are inline too.

- [ ] **Step 4: Run tests to verify they pass.** Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-filing-submit-review-gate.test.ts` — Expected: PASS, both tests.

- [ ] **Step 5: Add the wiring regression test** (mirrors `consultation-review-wiring.test.ts`'s source-grep style — guards against a future refactor silently removing the gate while other tests stay green):

```typescript
// plugins/agentbook-core/backend/src/__tests__/tax-filing-submit-gate-wiring.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('tax-filing-submit gate wiring', () => {
  it('handleTaxFilingSubmit checks review/status before ever calling the real submit endpoint, in source order', () => {
    const src = readFileSync(new URL('../server.ts', import.meta.url), 'utf-8');
    const fnStart = src.indexOf('export async function handleTaxFilingSubmit');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart, fnStart + 3000);
    const statusIdx = fnBody.indexOf('/review/status');
    const submitIdx = fnBody.indexOf('/tax-filing/${taxYear}/submit');
    expect(statusIdx).toBeGreaterThan(-1);
    expect(submitIdx).toBeGreaterThan(statusIdx);
  });
});
```

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-filing-submit-gate-wiring.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full plugin test suite to confirm zero regression, then commit**

Run: `cd plugins/agentbook-core/backend && npx vitest run`

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/tax-filing-submit-review-gate.test.ts plugins/agentbook-core/backend/src/__tests__/tax-filing-submit-gate-wiring.test.ts
git commit -m "feat(core): submit-review gate + ctx.checkActiveTaxReview/answerTaxReview"
```

---

### Task 17: `agent-brain.ts` — early interception for in-progress reviews

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts` (add one new, independent `if` block inside `handleAgentMessageCore`, immediately after the existing Step 1 session-recovery block and before intent classification)
- Test: `plugins/agentbook-core/backend/src/__tests__/agent-brain-tax-review-interception.test.ts`

**Interfaces:**
- Consumes: `ctx.checkActiveTaxReview`, `ctx.answerTaxReview` (Task 16).
- Produces: a message sent while a tax review is in progress never reaches `ctx.classifyOnly`/`ctx.classifyAndExecuteV1` — it's routed straight to `ctx.answerTaxReview` and the function returns immediately.

This is a new, independent block — **the existing `activeSession`/`pendingConfirmation` code (Step 1, quoted in full in this plan's investigation phase) is not modified at all.** If a tenant somehow has both an active plan session AND an active tax review simultaneously, the review check runs first (more specific, more time-sensitive context wins) — see Step 3.

- [ ] **Step 1: Write the failing test**

```typescript
// plugins/agentbook-core/backend/src/__tests__/agent-brain-tax-review-interception.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleAgentMessage } from '../agent-brain.js';

function makeCtx(overrides: Partial<any> = {}) {
  return {
    callGemini: vi.fn(),
    classifyOnly: vi.fn(),
    classifyAndExecuteV1: vi.fn(),
    executeClassification: vi.fn(),
    checkActiveTaxReview: vi.fn().mockResolvedValue({ active: false }),
    answerTaxReview: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('agent-brain — tax review early interception', () => {
  it('when a review is active, routes the message to ctx.answerTaxReview and never calls classification', async () => {
    const ctx = makeCtx({
      checkActiveTaxReview: vi.fn().mockResolvedValue({ active: true, taxYear: 2025 }),
      answerTaxReview: vi.fn().mockResolvedValue({ message: 'Updated to $80,000.' }),
    });

    const result = await handleAgentMessage(
      { text: 'change income to 80000', tenantId: 't1', channel: 'web' } as any,
      ctx as any,
    );

    expect(ctx.answerTaxReview).toHaveBeenCalledWith('t1', 2025, 'change income to 80000');
    expect(ctx.classifyOnly).not.toHaveBeenCalled();
    expect(ctx.classifyAndExecuteV1).not.toHaveBeenCalled();
    expect(result.message).toContain('$80,000');
  });

  it('when no review is active, classification runs exactly as before (no behavior change for every other message)', async () => {
    const ctx = makeCtx();
    ctx.classifyAndExecuteV1.mockResolvedValue({
      selectedSkill: { name: 'query-expenses' }, extractedParams: {}, confidence: 0.9,
      responseData: { message: 'Here are your expenses.', actions: [], chartData: null, skillUsed: 'query-expenses', confidence: 0.9, latencyMs: 10 },
    });

    const result = await handleAgentMessage({ text: 'show my expenses', tenantId: 't1', channel: 'web' } as any, ctx as any);

    expect(ctx.checkActiveTaxReview).toHaveBeenCalledWith('t1');
    expect(ctx.classifyAndExecuteV1).toHaveBeenCalled();
    expect(result.message).toContain('expenses');
  });
});
```

- [ ] **Step 2: Run test to verify it fails.** Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/agent-brain-tax-review-interception.test.ts` — Expected: FAIL (no interception exists yet).

- [ ] **Step 3: Implement the interception**

In `plugins/agentbook-core/backend/src/agent-brain.ts`, inside `handleAgentMessageCore`, immediately after the closing of the existing `if (activeSession) { ... }` block (Step 1, quoted in full in this plan's investigation phase — i.e. right where intent classification would otherwise begin), add:

```typescript
  // ── Step 1.5: Active tax-filing-review interception ──────────────────
  // Independent of the activeSession block above — deliberately not
  // folded into it, since tax review is domain-specific state owned by a
  // different plugin (plugin_agentbook_tax), reached only via ctx, never
  // via a direct cross-plugin DB query (Global Constraint 8). Checked
  // before an activeSession's own classification would run, since a
  // pending tax-review answer is more time-sensitive than a general plan
  // session if both happen to exist for the same tenant at once.
  const activeReview = await ctx.checkActiveTaxReview(tenantId);
  if (activeReview.active && activeReview.taxYear) {
    const { message } = await ctx.answerTaxReview(tenantId, activeReview.taxYear, text);
    return buildResponse({
      message,
      skillUsed: 'tax-review-agent',
      confidence: 1,
      latencyMs: Date.now() - startTime,
    });
  }
```

- [ ] **Step 4: Run test to verify it passes.** Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/agent-brain-tax-review-interception.test.ts` — Expected: PASS, both tests.

- [ ] **Step 5: Run the full plugin test suite to confirm zero regression to the existing session/classification pipeline, then commit**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: PASS — every existing `agent-brain.ts` test (session recovery, confirm/cancel/skip/undo, classification, `brainAccountantFallback`, etc.) is completely unaffected, since `ctx.checkActiveTaxReview` returns `{ active: false }` for every test that doesn't explicitly mock it otherwise, and the new block returns early only in that one new case.

```bash
git add plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/__tests__/agent-brain-tax-review-interception.test.ts
git commit -m "feat(core): early interception routes in-progress tax reviews before classification"
```

---

### Task 18: End-to-end integration test — the full conversation, CA path

**Files:**
- Test: `plugins/agentbook-core/backend/src/__tests__/tax-review-agent-e2e.test.ts` (new)

**Interfaces:** none new — this task proves Tasks 1-15 work together as one mechanism, for at least the one jurisdiction (CA) with the deepest existing real data. US/AU get the identical shape once their form templates (Tasks 3-4) and packs (Tasks 8-9) exist — this one test's structure is the template for adding US/AU variants later if desired, but is not itself required to cover all three.

- [ ] **Step 1: Write the integration test**, mocking only the two true external boundaries (`callGemini` and the HTTP layer between `agent-brain.ts` and the tax plugin — or, if this repo's existing integration tests for cross-plugin flows run against real in-process Express apps via `supertest` rather than mocking `fetch`, follow that established convention instead; check how any existing test exercises a full agent-brain-to-plugin round trip, if one exists, and mirror it):

```typescript
// plugins/agentbook-core/backend/src/__tests__/tax-review-agent-e2e.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('Tax Review Agent — full conversation, CA path', () => {
  it('submit attempt -> gated into review -> summary shown -> field edit -> recomputed -> confirm -> real submitFiling outcome', async () => {
    // 1. Seed a real CA AbTaxFiling row (via populateFiling or a direct
    //    create) with a filing snapshot: T1.total_income_15000 = 7,300,000
    //    cents ($73,000), T1.taxable_income_26000 = same, T2125 populated.
    // 2. Call the tax-filing-submit path (via handleTaxFilingSubmit or
    //    the full classifyAndExecuteV1 pipeline, whichever this repo's
    //    existing skill-level integration tests already exercise) with a
    //    mocked callGemini returning a grounded {"summaryText": "..."}
    //    containing the real $73,000/$11,455-shaped figures.
    // 3. Assert the response is the review summary, NOT a submit outcome,
    //    and that submitFiling was never called yet.
    // 4. Send a follow-up message "change total income to 80000" through
    //    the SAME interception path (ctx.checkActiveTaxReview returning
    //    active:true) and assert updateFilingField was called with the
    //    real T1/total_income_15000/8000000 arguments, and the response
    //    reflects $80,000.
    // 5. Send "looks good, submit it" and assert: submitFiling was called
    //    exactly once, with the tenantId/taxYear from step 1, and the
    //    final response contains submitFiling's real outcome message
    //    (the honest "exported, not filed" text from buildFilingOutcome,
    //    since no certified partner exists in this test's DB fixture).
  });
});
```

Fill in the concrete mocking/fixture mechanics using whichever pattern the nearest existing cross-module integration test in this plugin already establishes (e.g. how `agent-brain.ts`'s own test suite currently seeds an `AbTenantConfig`/mocks `ctx`) — the five numbered assertions above are the complete, non-negotiable behavioral spec this test must prove; the exact mock/fixture plumbing to get there should match this codebase's existing convention rather than inventing a new one.

- [ ] **Step 2: Run the test.** Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-review-agent-e2e.test.ts` — Expected: PASS. If it fails, the failure must be diagnosed against Tasks 1-15's actual committed code (all of which exist by this point) — do not weaken this test's five assertions to make it pass; fix the underlying wiring instead.

- [ ] **Step 3: Commit**

```bash
git add plugins/agentbook-core/backend/src/__tests__/tax-review-agent-e2e.test.ts
git commit -m "test: end-to-end Tax Review Agent conversation (CA path)"
```

---

### Task 19: Final whole-branch review

Per `superpowers:subagent-driven-development`, dispatch a final code-reviewer on the most capable available model against the full branch diff (`git diff main...HEAD` or this repo's equivalent merge-base range), with this plan's Global Constraints block as the reviewer's attention lens. Specifically confirm:

- No CA behavior changed anywhere (formulas, validation rules' meaning, `seedCanadianForms`'s own call sites) — every CA test passes byte-for-byte as before.
- `consultation-review.ts` is untouched (Global Constraint 4).
- `agent-brain.ts`'s existing `activeSession`/`pendingConfirmation`/`resolveSessionAction` code is untouched (Task 17's block is additive only).
- The gate in `handleTaxFilingSubmit` (Task 16) genuinely precedes the real submit call in every code path, not just the happy path tested in Task 16 Step 5's wiring test.
- The new i18n keys (Task 14) and the web review tab (Task 15) don't regress any existing tax-plugin page — `en`/`fr` behavior for every pre-existing key is byte-identical, and the other three `TaxPackagePage` tabs are unmodified apart from the new 4th tab entry.
- No fabricated tax figures anywhere — every dollar amount either comes from a real bracket calculator (`usTaxBrackets`/`caTaxBrackets`/`auTaxBrackets`) or is explicitly user-entered/ledger-derived data; the only genuinely-asserted-without-a-cited-source figures are the two flagged, dated, "verify yearly" constants (US standard mileage rate, US standard deduction) per Global Constraint 9 — confirm no others crept in.
- Run every affected package/plugin's full test suite one more time from a clean state: `packages/agentbook-jurisdictions`, `plugins/agentbook-tax/backend`, `plugins/agentbook-core/backend`.

If the reviewer finds issues, dispatch one fix subagent with the complete findings list (not one per finding), then re-review. Once clean, follow `superpowers:finishing-a-development-branch` to decide how this branch gets merged (this plan does not decide that in advance — it is a human call at that point, per that skill's own process).

