# Reconnect 1099-NEC Contractor-Reporting Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `packages/agentbook-framework`'s real, schema-compatible `getContractorSummaries` function (1099-NEC for US / T4A for CA threshold tracking) reachable from a real API route and the existing Reports UI — today it has zero callers anywhere in the live app.

**Architecture:** Export the existing function from `@agentbook/framework`'s index barrel (it isn't exported today, which is likely why it was never wired up — everything else in that package is orchestration-engine machinery this task deliberately does NOT touch or resurrect). Add one new Next.js route that calls it directly with the real Prisma client, and one new report card to the existing generic Reports page, reusing its established `ReportData`/`transformReport` pattern rather than building bespoke UI. Verified against the current schema: every field the function references (`AbAccount.taxCategory`, `AbExpense.vendorId/isPersonal/categoryId`, `AbVendor.name`) still exists — this is a pure reconnection, not a rewrite.

**Tech Stack:** Next.js route handlers, Prisma, React, Vitest.

## Global Constraints

- Do NOT resurrect or wire up any other part of `agentbook-framework` (Orchestrator, ConstraintEngine, LLMGateway, multi-agent system, etc.) — those are a separate, much larger, unrelated initiative and out of scope. Only `getContractorSummaries`/`ContractorPaymentSummary` get exported and used.
- No rewrite of the contractor-summary logic itself — it's correct as-is against the current schema (confirmed by direct field-by-field comparison against `schema.prisma`).
- Reuse the existing Reports page's generic `ReportData`/`transformReport` pattern — no new bespoke report-rendering component.
- The function already handles both `us` (1099-NEC, $600 threshold) and `ca` (T4A, $500 threshold) correctly — wire both through, don't artificially restrict to US-only.

---

### Task 1: Export the function and add a real API route

**Files:**
- Modify: `packages/agentbook-framework/src/index.ts` (add the export)
- New: `apps/web-next/src/app/api/v1/agentbook-tax/reports/contractor-1099/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-tax/reports/contractor-1099-route.test.ts` (new — follow the mocking conventions already used by sibling route tests under `apps/web-next/src/__tests__/api/v1/agentbook-tax/`, if any exist; otherwise follow `apps/web-next/src/__tests__/api/v1/auth/register-route.test.ts`'s `vi.mock` style)

**Interfaces:**
- Produces: `GET /api/v1/agentbook-tax/reports/contractor-1099?year=` → `{ success: true, data: { year, jurisdiction, contractors: ContractorPaymentSummary[] } }`, consumed by Task 2's frontend change.

- [ ] **Step 1: Add the export** to `packages/agentbook-framework/src/index.ts`, alongside the existing exports:

```ts
export { getContractorSummaries, type ContractorPaymentSummary } from './skills/contractor-reporting/handler.js';
```

- [ ] **Step 2: Write failing tests** for the new route: (a) returns a list of contractor summaries for a US tenant with contract-labor expenses above/below/near the $600 threshold; (b) returns an empty list (not an error) for a tenant with no contract-labor expenses; (c) respects a `?year=` query param; (d) works for a `ca` tenant using the $500/T4A path (confirming the function's existing jurisdiction handling is exercised end-to-end through the new route, not just the function in isolation).

- [ ] **Step 2: Run tests, confirm they fail** (route doesn't exist yet).

- [ ] **Step 3: Implement the route**

```ts
/**
 * 1099-NEC (US) / T4A (CA) contractor-payment threshold report — reconnects
 * packages/agentbook-framework's getContractorSummaries, which had zero
 * callers anywhere in the live app until this route.
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { getContractorSummaries } from '@agentbook/framework';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    const jurisdiction = cfg?.jurisdiction || 'us';
    const year = parseInt(request.nextUrl.searchParams.get('year') || String(new Date().getFullYear()), 10);

    const contractors = await getContractorSummaries(tenantId, jurisdiction, year, db);
    return NextResponse.json({ success: true, data: { year, jurisdiction, contractors } });
  } catch (err) {
    console.error('[agentbook-tax/reports/contractor-1099] failed:', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
```

Verify (read the actual current file) that `getContractorSummaries`'s import path resolves correctly from `apps/web-next` — check how other files already import from `@agentbook/framework` if any do, or confirm the package's `main`/`exports` field supports this bare-specifier import the same way `@agentbook/jurisdictions` imports already work elsewhere in this route family.

- [ ] **Step 4: Run tests, confirm they pass.**

- [ ] **Step 5: Commit**

```bash
git add packages/agentbook-framework/src/index.ts apps/web-next/src/app/api/v1/agentbook-tax/reports/contractor-1099/route.ts apps/web-next/src/__tests__/api/v1/agentbook-tax/reports/contractor-1099-route.test.ts
git commit -m "feat(tax): reconnect getContractorSummaries via a real 1099-NEC/T4A report route"
```

---

### Task 2: Surface the report in the existing Reports UI

**Files:**
- Modify: `plugins/agentbook-tax/frontend/src/pages/Reports.tsx`

**Interfaces:**
- Consumes: the new route from Task 1.
- Produces: nothing consumed by a later task — this plan has 2 tasks.

- [ ] **Step 1: Read `Reports.tsx` in full** — confirm the exact current shape of the `REPORTS` array, `transformReport`, and the render logic before editing (the plan's snippets are a template; verify against reality).

- [ ] **Step 2: Add a new report card** to the `REPORTS` array:

```tsx
  {
    key: 'contractor-1099',
    title: '1099-NEC / T4A Contractors',
    description: 'Contractors paid over the reporting threshold this year',
    icon: <Users className="w-6 h-6" />, // add Users to the lucide-react import list at the top
    color: 'bg-rose-100 text-rose-600',
    endpoint: '/api/v1/agentbook-tax/reports/contractor-1099',
  },
```

- [ ] **Step 3: Add a `transformReport` case**, reusing the existing generic `rows`-only shape:

```tsx
    case 'contractor-1099':
      return {
        title: '1099-NEC / T4A Contractors',
        rows: (d.contractors ?? []).map((c: { contractorName: string; totalPaidCents: number; requiresReporting: boolean; nearThreshold: boolean; formId: string }) => ({
          label: `${c.contractorName}${c.requiresReporting ? ` — ${c.formId} required` : c.nearThreshold ? ' — approaching threshold' : ''}`,
          amount: c.totalPaidCents / 100,
        })),
      };
```

If `d.contractors` is empty, the existing generic render logic already handles an empty `rows` array gracefully (confirm this by reading the render logic — don't assume).

- [ ] **Step 4: Manual verification** — no test harness exists for this plugin frontend (confirmed in a prior PR on this same file family). Do a careful static read-through confirming the new card and transform case follow the exact same shape/conventions as the four existing ones, and that `requiresReporting`/`nearThreshold`/`formId` field names exactly match `ContractorPaymentSummary`'s real shape from Task 1.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-tax/frontend/src/pages/Reports.tsx
git commit -m "feat(tax): surface the 1099-NEC/T4A contractor report in the Reports page"
```

## Self-Review

- Spec coverage: closes the roadmap's PR US-5 entry — the orphaned logic is genuinely reachable now, via a real route and a real UI entry point, not just exported-but-still-uncalled.
- Placeholder scan: none.
- Scope check: explicitly does NOT touch any other part of `agentbook-framework` — this is the single most important boundary in this plan, since that package contains a much larger, unrelated, seemingly-abandoned orchestration-engine initiative that must not be resurrected as a side effect of this fix.
