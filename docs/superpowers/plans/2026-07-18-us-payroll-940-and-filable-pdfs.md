# Form 940 Computation + Filable Payroll PDFs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close two related gaps in US payroll: Form 940 (FUTA) has zero computation anywhere in the codebase, and "downloading" any of W-2/941/940 currently opens raw JSON instead of a real document — closing both makes payroll's year-end/quarterly obligations something a user could plausibly hand to an accountant, matching the standard this codebase already set for invoices (`agentbook-invoice-pdf.ts`, "closes the long-open gap where /invoices/:id/pdf served HTML masquerading as a PDF").

**Architecture:** Two independent additions to the existing payroll module, no new architecture: (1) `payroll-deposits.ts` gets a `computeFutaDeposit` function, accrued into `AbPayrollTaxDeposit` (form `'940'`) via the exact same create-or-increment pattern the pay-run process route already uses for the SG deposit — FUTA is deliberately computed as a flat 0.6% of gross wages paid in each run (the standard 6.0% FUTA rate minus the standard 5.4% state-unemployment-tax credit most compliant small employers qualify for), **not** tracking the real per-employee $7,000 annual wage-base cap across pay runs, since that would require new YTD-wage-tracking infrastructure this codebase doesn't have — documented as an explicit simplification, consistent with this module's existing "reasonable planning approximation" scope (e.g. the AU engine's own OTE-proxy comment). (2) A new `payroll-forms-pdf.ts` (mirroring `agentbook-invoice-pdf.ts`'s established `@react-pdf/renderer` pattern exactly) renders real, correctly-labeled W-2/941/940 documents — not pixel-perfect IRS form facsimiles, but structured documents with the real IRS box numbers and computed figures, which is the same bar `agentbook-invoice-pdf.ts` itself set when it replaced "HTML masquerading as a PDF."

**Tech Stack:** `@react-pdf/renderer` (already a dependency), Next.js route handlers, Prisma, Vitest.

## Global Constraints

- No new abstraction layers — FUTA accrual reuses the exact pattern already established for the SG deposit in `pay-runs/[id]/process/route.ts`; PDF rendering reuses the exact pattern already established in `agentbook-invoice-pdf.ts` / `agentbook-tax-pdf.ts`.
- No new schema/migration in this PR — the 941/940 PDF routes recompute their line-item breakdown from existing `AbPayStub` records for the relevant period at render time, rather than adding new columns to `AbPayrollTaxDeposit` to store a breakdown that isn't there today.
- FUTA's wage-base simplification (flat 0.6% of gross, no per-employee annual cap tracking) must be documented in code, not silently under-implemented — a future PR can add real YTD tracking if evidence shows it's needed.
- CA/UK/AU payroll paths are completely untouched by this PR — Form 940/FUTA is US-only.
- PDFs are structured, labeled, and numerically correct — not attempts at exact IRS visual facsimiles (a much larger, disproportionate undertaking for this fix).

---

### Task 1: Compute and accrue Form 940 (FUTA)

**Files:**
- Modify: `apps/web-next/src/lib/payroll-deposits.ts`
- Modify: `apps/web-next/src/app/api/v1/agentbook-payroll/pay-runs/[id]/process/route.ts`
- Test: `apps/web-next/src/__tests__/lib/payroll-deposits.test.ts` (check if this file already exists — if so, extend it; if not, this is the first test for this module, establish real coverage)

**Interfaces:**
- Produces: `computeFutaDeposit(stubs: DepositStub[], date: Date): Deposit` — a new exported function with `form: '940'`, `periodLabel` as just the year (e.g. `"2026"`, distinct from `941`'s `"2026-Q2"` shape since FUTA is annual), and `dueDate` = January 31 of the following year.

- [ ] **Step 1: Read `payroll-deposits.ts` and the process route in full** to confirm current shapes before editing.

- [ ] **Step 2: Write failing tests** for `computeFutaDeposit`: (a) a US employer with $10,000 total gross wages this run gets `amountCents` = `600000 * 0.006` = `3600` cents ($36.00); (b) `periodLabel` is just the year (e.g. `"2026"`), not a quarter; (c) `dueDate` is January 31 of the year AFTER the run's period-end year; (d) calling it with a non-US context still returns a well-formed `Deposit` (the caller is responsible for only invoking this for US tenants — mirror how `computeSgDeposit` is only ever called for AU, per the process route's existing `if (split.sgCents > 0)` gating pattern).

- [ ] **Step 3: Run tests, confirm they fail** (function doesn't exist yet).

- [ ] **Step 4: Implement `computeFutaDeposit`**

```ts
/**
 * Form 940 (FUTA) — US only. Standard federal rate is 6.0% on the first
 * $7,000 of each employee's ANNUAL wages, reduced to a net 0.6% for
 * employers who pay state unemployment tax in full and on time (the normal
 * case for a compliant small employer, and the standard simplification used
 * by most payroll-planning tools). This computes 0.6% of THIS RUN's gross
 * wages, not a true per-employee $7,000 annual-wage-base cap tracked across
 * pay runs — that would need YTD-wage tracking this codebase doesn't have
 * yet. A planning approximation, consistent with this file's existing scope
 * (see e.g. the AU engine's own OTE-proxy comment) — not a certified
 * calculation for actual 940 filing.
 */
const FUTA_NET_RATE = 0.006;

export function computeFutaDeposit(stubs: { grossCents: number }[], date: Date): Deposit {
  const year = date.getFullYear();
  const grossCents = stubs.reduce((sum, s) => sum + s.grossCents, 0);
  const amountCents = Math.round(grossCents * FUTA_NET_RATE);
  return {
    form: '940',
    periodLabel: String(year),
    amountCents,
    dueDate: new Date(year + 1, 0, 31).toISOString().slice(0, 10),
  };
}
```

- [ ] **Step 5: Run tests, confirm they pass.**

- [ ] **Step 6: Wire the accrual into the process route**, mirroring the existing SG block's create-or-increment shape exactly:

```ts
      // Form 940 (FUTA) — US only, accrued annually (see computeFutaDeposit
      // for the wage-base simplification this uses).
      if (jurisdiction === 'us' && split.grossCents > 0) {
        const futaDep = computeFutaDeposit(run.stubs, run.periodEnd);
        const existingFuta = await tx.abPayrollTaxDeposit.findUnique({
          where: { tenantId_form_periodLabel: { tenantId, form: futaDep.form, periodLabel: futaDep.periodLabel } },
        });
        if (existingFuta) {
          await tx.abPayrollTaxDeposit.update({ where: { id: existingFuta.id }, data: { amountCents: existingFuta.amountCents + futaDep.amountCents } });
        } else {
          await tx.abPayrollTaxDeposit.create({
            data: { tenantId, form: futaDep.form, periodLabel: futaDep.periodLabel, amountCents: futaDep.amountCents, dueDate: new Date(futaDep.dueDate), status: 'pending' },
          });
        }
      }
```

Add `computeFutaDeposit` to the existing import line from `@/lib/payroll-deposits`. Place this block near the existing SG block (after it, since both are "additional, jurisdiction-specific deposit" blocks alongside the main quarterly one).

- [ ] **Step 7: Manual verification** — confirm `split.grossCents` and `run.periodEnd` are the correct values to pass (read `splitPayrollEntry` in `payroll-ledger.ts` if its shape isn't already clear from the surrounding code).

- [ ] **Step 8: Commit**

```bash
git add apps/web-next/src/lib/payroll-deposits.ts apps/web-next/src/app/api/v1/agentbook-payroll/pay-runs/\[id\]/process/route.ts apps/web-next/src/__tests__/lib/payroll-deposits.test.ts
git commit -m "feat(payroll): compute and accrue Form 940 (FUTA) for US employers"
```

---

### Task 2: Real PDF rendering for W-2, 941, and 940

**Files:**
- New: `apps/web-next/src/lib/payroll-forms-pdf.ts` (mirrors `agentbook-invoice-pdf.ts`'s structure: shared `StyleSheet`, one exported render function per document type)
- New: `apps/web-next/src/app/api/v1/agentbook-payroll/year-end/pdf/route.ts` (W-2/T4/P60/Payment-Summary PDF, one employee at a time — reuses `buildYearEndForm`)
- New: `apps/web-next/src/app/api/v1/agentbook-payroll/tax-deposits/[id]/pdf/route.ts` (941/940/BAS/etc. PDF for one deposit record)
- Modify: `apps/web-next/src/app/(dashboard)/payroll/page.tsx` (point the existing Download links at the new PDF routes instead of raw JSON)

**Interfaces:**
- Consumes: `YearEndForm` from `year-end-forms.ts` (unchanged), `AbPayrollTaxDeposit` rows, `AbPayStub` rows (re-queried per-period for the 941/940 line-item breakdown).
- Produces: nothing consumed by a later task — this plan has 2 tasks.

- [ ] **Step 1: Read `agentbook-invoice-pdf.ts` in full** to copy its established shape: `StyleSheet.create`, a `Document`/`Page` React tree, `renderToBuffer`, and its exported render-function signature style.

- [ ] **Step 2: Build `payroll-forms-pdf.ts`** with three exported functions:

```ts
export interface W2PdfData {
  employeeName: string;
  employerName: string;
  year: number;
  boxes: Record<string, number>; // from YearEndForm.boxes
  formType: string; // 'W-2' | 'T4' | 'P60' | 'Payment Summary'
}

export async function renderW2Pdf(data: W2PdfData): Promise<Buffer> { /* ... */ }

export interface PayrollDepositPdfData {
  form: string; // '941' | '940' | 'bas' | ...
  employerName: string;
  periodLabel: string;
  dueDate: string;
  amountCents: number;
  breakdown?: { incomeTaxWithheldCents: number; employeeFicaCents: number; employerFicaCents: number };
}

export async function render941Pdf(data: PayrollDepositPdfData): Promise<Buffer> { /* ... */ }
export async function render940Pdf(data: PayrollDepositPdfData): Promise<Buffer> { /* ... */ }
```

Layout each with real, correctly-labeled fields — for the W-2, use actual box numbers/labels (Box 1 Wages/tips/other comp, Box 2 Federal income tax withheld, Box 4 Social security tax withheld + Box 6 Medicare tax withheld split from the combined `ficaWithheldCents` at the standard 6.2%/1.45% proportion, Box 17 State income tax); for 941, real line labels (Line 2 Wages/tips/other comp, Line 3 Federal income tax withheld, Line 5a Taxable social security wages × 12.4%, Line 5c Taxable Medicare wages × 2.9%); for 940, real line labels (Line 3 Total payments to all employees, Line 7 Total taxable FUTA wages, Line 8 FUTA tax before adjustments at 0.6%). Keep the visual design simple (title, employer/employee header block, a table of labeled amounts, generated-by-AgentBook footer) — this is a structured, correct document, not an attempt at the official form's exact grid layout.

- [ ] **Step 3: Build the W-2 PDF route** (`year-end/pdf/route.ts`) — `GET ?year=&employeeId=`, reusing the exact tenant-resolution + stub-aggregation logic already in `year-end/route.ts` (read that file again and extract/duplicate its `byEmployee` grouping for the one requested employee), call `buildYearEndForm`, then `renderW2Pdf`, respond with `Content-Type: application/pdf` exactly like `invoices/[id]/pdf/route.ts` does.

- [ ] **Step 4: Build the deposit PDF route** (`tax-deposits/[id]/pdf/route.ts`) — `GET`, look up the `AbPayrollTaxDeposit` by `id` + `tenantId`, then re-derive the line-item breakdown for 941 by re-querying `abPayStub` (via `payRun.periodEnd` within the deposit's quarter — parse `periodLabel`'s `"YYYY-QN"` shape) and summing `federalTaxCents`/`ficaCents` across those stubs (mirror the employer-match approximation already in `computeDeposit`); for 940, the breakdown is simpler (just the flat 0.6% amount, no sub-line items needed). Call `render941Pdf`/`render940Pdf`/generic fallback based on `deposit.form`, respond with the PDF.

- [ ] **Step 5: Update `payroll/page.tsx`'s Download links** — the year-end forms list's `<a href={...year-end?year=...}>` becomes `<a href={${API}/year-end/pdf?year=${year}&employeeId=${employeeIdForThisForm}>` (the `forms` array from the JSON GET doesn't currently carry an `employeeId` — check whether `YearEndForm` needs one added, or whether matching by `employeeName` is sufficient for this UI; prefer adding `employeeId` to `YearEndForm` if it's cheap, since name-matching is fragile with duplicate names). The deposits tab's rows don't currently have a download link at all — add one next to "Mark paid" pointing at `${API}/tax-deposits/${d.id}/pdf`.

- [ ] **Step 6: Manual verification** — since there's no test harness for react-pdf rendering elsewhere in this codebase (confirm by checking whether `agentbook-invoice-pdf.ts` has a test file — if it doesn't, this project's established precedent is to verify PDF rendering manually/by reading, not unit-test the PDF byte output), run each new route locally if a dev server is reachable in this environment, or at minimum confirm the render functions compile and don't throw against representative sample data via a small ad hoc script, and say explicitly what you did.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/lib/payroll-forms-pdf.ts apps/web-next/src/app/api/v1/agentbook-payroll/year-end/pdf/route.ts apps/web-next/src/app/api/v1/agentbook-payroll/tax-deposits/\[id\]/pdf/route.ts "apps/web-next/src/app/(dashboard)/payroll/page.tsx"
git commit -m "feat(payroll): serve real PDFs for W-2/941/940 instead of raw JSON"
```

## Self-Review

- Spec coverage: Task 1 closes "Form 940 has zero computation anywhere"; Task 2 closes "no IRS-form-compliant PDF for either; Download opens raw JSON" — both halves of the roadmap's PR US-3 entry.
- Placeholder scan: Task 2's PDF layout is described at the "what fields, what labels" level rather than full JSX, since the exact styling should follow `agentbook-invoice-pdf.ts`'s established look — the implementer reads that file first per Step 1 and adapts its patterns, which is a legitimate delegation of visual-detail judgment, not a missing requirement.
- Scope check: deliberately NOT implementing real per-employee YTD wage-base tracking for FUTA — flagged as a disclosed simplification, not a silent gap.
