# Daily Overview Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing `/agentbook` home dashboard with a forward-looking, mobile-first daily overview (cashflow timeline, agent-summarized attention queue, this-month strip, mixed activity feed) plus a daily Telegram morning digest.

**Architecture:** New backend endpoints under agentbook-core Express plugin (overview aggregator, activity feed, agent-summary with in-memory LLM cache). Recurring-outflow detection is server-side from expense history. Frontend rewrites `Dashboard.tsx` (same file path keeps routing/UMD wiring unchanged) into composed subcomponents. Morning digest is a Next.js cron route that iterates tenants and sends via existing Telegram bot.

**Tech Stack:** TypeScript (ESM), Express via `@naap/plugin-server-sdk`, React (UMD-bundled), Tailwind tokens, Prisma + Postgres, Vitest + Playwright, Vercel Cron.

**Spec:** `docs/superpowers/specs/2026-05-02-daily-overview-dashboard-design.md`

---

## File map

### Backend (agentbook-core plugin)
- **Modify:** `plugins/agentbook-core/backend/src/server.ts` — export `callGemini`, register new dashboard routes.
- **Create:** `plugins/agentbook-core/backend/src/dashboard/overview.ts` — overview aggregator handler.
- **Create:** `plugins/agentbook-core/backend/src/dashboard/activity.ts` — activity feed handler.
- **Create:** `plugins/agentbook-core/backend/src/dashboard/agent-summary.ts` — LLM summary handler + in-memory cache.
- **Create:** `plugins/agentbook-core/backend/src/dashboard/recurring-detector.ts` — auto-detection from expense history.
- **Create:** `plugins/agentbook-core/backend/src/dashboard/__tests__/recurring-detector.test.ts`
- **Create:** `plugins/agentbook-core/backend/src/dashboard/__tests__/agent-summary.test.ts`
- **Create:** `plugins/agentbook-core/backend/src/dashboard/__tests__/overview.test.ts`

### Schema (one column on existing model)
- **Modify:** `packages/database/prisma/schema.prisma` — add `dailyDigestEnabled` column to `AbTenantConfig`.

### Frontend (agentbook-core plugin)
- **Modify:** `plugins/agentbook-core/frontend/src/pages/Dashboard.tsx` — replaces body with new layout, deletes old subcomponents.
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/ForwardView.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/CashflowTimeline.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/NextMomentsList.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/AttentionPanel.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/AttentionItem.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/ThisMonthStrip.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/ActivityFeed.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/QuickActionsBar.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/OnboardingHero.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/types.ts`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/hooks/useDashboardOverview.ts`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/hooks/useDashboardActivity.ts`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/CashflowTimeline.test.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/NextMomentsList.test.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/AttentionPanel.test.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/ThisMonthStrip.test.tsx`
- **Create:** `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/Dashboard.integration.test.tsx`

### Cron (Next.js shell)
- **Create:** `apps/web-next/src/app/api/v1/agentbook/cron/morning-digest/route.ts`
- **Modify:** `vercel.json` — add cron entry.

### E2E
- **Create:** `tests/e2e/dashboard.spec.ts`

---

## Task 0: Add `dailyDigestEnabled` column to `AbTenantConfig`

**Why:** the morning digest needs a per-tenant opt-out toggle. The spec calls this out as the only schema change. No new table.

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (around line 1430)

- [ ] **Step 1: Add column to the model**

In `packages/database/prisma/schema.prisma`, inside `model AbTenantConfig`, add the column right after `autoRemindDays`:

```prisma
autoRemindEnabled       Boolean  @default(false)
autoRemindDays          Int      @default(3)
dailyDigestEnabled      Boolean  @default(true)
```

- [ ] **Step 2: Push schema and regenerate client**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx --no prisma db push --schema=packages/database/prisma/schema.prisma
```

Expected: "Database is now in sync with the Prisma schema." Then regenerate:

```bash
npx --no prisma generate --schema=packages/database/prisma/schema.prisma
```

- [ ] **Step 3: Commit**

```bash
git add packages/database/prisma/schema.prisma
git commit -m "feat(db): add AbTenantConfig.dailyDigestEnabled flag"
```

---

## Task 1: Export `callGemini` from agentbook-core server.ts

**Why:** the new `agent-summary` endpoint reuses the existing Gemini wrapper. Today it's a private function; we just need to export it.

**Files:**
- Modify: `plugins/agentbook-core/backend/src/server.ts:853`

- [ ] **Step 1: Change the declaration to export**

Find line 853 (the `async function callGemini(...)` declaration) and prepend `export`:

```ts
export async function callGemini(systemPrompt: string, userMessage: string, maxTokens: number = 500): Promise<string | null> {
```

- [ ] **Step 2: Verify nothing else breaks**

```bash
cd plugins/agentbook-core/backend && npx tsc --noEmit 2>&1 | head -20
```

Expected: no new errors caused by this change. Pre-existing errors are tolerated.

- [ ] **Step 3: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts
git commit -m "refactor(agentbook-core): export callGemini for reuse"
```

---

## Task 2: Recurring-outflow detector

**Why:** server-side detection so the frontend just renders. Single high-confidence threshold (≥3 occurrences) per the spec.

**Files:**
- Create: `plugins/agentbook-core/backend/src/dashboard/recurring-detector.ts`
- Create: `plugins/agentbook-core/backend/src/dashboard/__tests__/recurring-detector.test.ts`

- [ ] **Step 1: Write the failing test**

Create `plugins/agentbook-core/backend/src/dashboard/__tests__/recurring-detector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { detectRecurringFromHistory, type ExpenseRow } from '../recurring-detector.js';

const exp = (id: string, vendor: string, amountCents: number, date: string): ExpenseRow => ({
  id, vendor, amountCents, date: new Date(date),
});

describe('detectRecurringFromHistory', () => {
  it('detects monthly recurring with 3+ occurrences at 25–35d cadence', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'AWS', 34000, '2026-02-01'),
      exp('2', 'AWS', 34500, '2026-03-02'),
      exp('3', 'AWS', 33700, '2026-04-01'),
    ];
    const today = new Date('2026-05-01');
    const result = detectRecurringFromHistory(rows, today);
    expect(result).toHaveLength(1);
    expect(result[0].vendor).toBe('AWS');
    expect(Math.round(result[0].amountCents / 100)).toBeCloseTo(341, 0); // ≈ avg
    // next expected ≈ 30 days after last occurrence
    expect(result[0].nextExpectedDate.startsWith('2026-05')).toBe(true);
  });

  it('does NOT detect when only 2 occurrences', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'AWS', 34000, '2026-03-01'),
      exp('2', 'AWS', 34500, '2026-04-01'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(0);
  });

  it('rejects clusters whose amounts vary > ±10%', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'Variable', 10000, '2026-02-01'),
      exp('2', 'Variable', 30000, '2026-03-01'),
      exp('3', 'Variable', 50000, '2026-04-01'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(0);
  });

  it('rejects clusters whose cadence is outside 25–35 days', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'Weekly', 10000, '2026-04-01'),
      exp('2', 'Weekly', 10000, '2026-04-08'),
      exp('3', 'Weekly', 10000, '2026-04-15'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(0);
  });

  it('groups by normalized vendor (case + whitespace insensitive)', () => {
    const rows: ExpenseRow[] = [
      exp('1', 'Netflix', 1599, '2026-02-15'),
      exp('2', 'NETFLIX ', 1599, '2026-03-15'),
      exp('3', 'netflix', 1599, '2026-04-15'),
    ];
    expect(detectRecurringFromHistory(rows, new Date('2026-05-01'))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd plugins/agentbook-core/backend && npx vitest run src/dashboard/__tests__/recurring-detector.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

Create `plugins/agentbook-core/backend/src/dashboard/recurring-detector.ts`:

```ts
/**
 * Auto-detect recurring monthly outflows from expense history.
 * Single high-confidence threshold: ≥3 occurrences in last 90 days at
 * 25–35 day cadence with amounts within ±10%. False positives are rare;
 * users get no UI to suppress them in V1.
 */

import { db } from '../db/client.js';

export interface ExpenseRow {
  id: string;
  vendor: string;
  amountCents: number;
  date: Date;
}

export interface RecurringOutflow {
  vendor: string;
  amountCents: number;       // average of cluster
  nextExpectedDate: string;  // ISO date (YYYY-MM-DD)
}

const MIN_OCCURRENCES = 3;
const MIN_CADENCE_DAYS = 25;
const MAX_CADENCE_DAYS = 35;
const AMOUNT_TOLERANCE = 0.10; // ±10%
const LOOKBACK_DAYS = 90;

function normalizeVendor(v: string): string {
  return v.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return Math.round(ms / (24 * 60 * 60 * 1000));
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export function detectRecurringFromHistory(
  rows: ExpenseRow[],
  today: Date
): RecurringOutflow[] {
  const byVendor = new Map<string, ExpenseRow[]>();
  for (const r of rows) {
    const key = normalizeVendor(r.vendor);
    if (!key) continue;
    if (!byVendor.has(key)) byVendor.set(key, []);
    byVendor.get(key)!.push(r);
  }

  const out: RecurringOutflow[] = [];

  for (const cluster of byVendor.values()) {
    if (cluster.length < MIN_OCCURRENCES) continue;

    cluster.sort((a, b) => a.date.getTime() - b.date.getTime());

    // Amounts within tolerance?
    const meanAmount = avg(cluster.map(c => c.amountCents));
    const tolerance = meanAmount * AMOUNT_TOLERANCE;
    if (cluster.some(c => Math.abs(c.amountCents - meanAmount) > tolerance)) continue;

    // Cadence within window?
    const gaps: number[] = [];
    for (let i = 1; i < cluster.length; i++) {
      gaps.push(daysBetween(cluster[i].date, cluster[i - 1].date));
    }
    if (gaps.some(g => g < MIN_CADENCE_DAYS || g > MAX_CADENCE_DAYS)) continue;

    const lastDate = cluster[cluster.length - 1].date;
    const avgCadence = Math.round(avg(gaps));
    const next = new Date(lastDate);
    next.setDate(next.getDate() + avgCadence);
    if (next < today) continue; // already past

    out.push({
      vendor: cluster[0].vendor,           // original casing of first occurrence
      amountCents: Math.round(meanAmount),
      nextExpectedDate: next.toISOString().slice(0, 10),
    });
  }

  return out.sort((a, b) => a.nextExpectedDate.localeCompare(b.nextExpectedDate));
}

export async function detectRecurringForTenant(
  tenantId: string,
  today: Date = new Date()
): Promise<RecurringOutflow[]> {
  const since = new Date(today);
  since.setDate(since.getDate() - LOOKBACK_DAYS);

  const expenses = await db.abExpense.findMany({
    where: {
      tenantId,
      isPersonal: false,
      date: { gte: since },
    },
    select: { id: true, description: true, amountCents: true, date: true, vendor: true },
  });

  const rows: ExpenseRow[] = expenses.map((e: any) => ({
    id: e.id,
    vendor: e.vendor || e.description || '',
    amountCents: e.amountCents,
    date: e.date,
  }));

  return detectRecurringFromHistory(rows, today);
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd plugins/agentbook-core/backend && npx vitest run src/dashboard/__tests__/recurring-detector.test.ts
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/backend/src/dashboard/recurring-detector.ts \
        plugins/agentbook-core/backend/src/dashboard/__tests__/recurring-detector.test.ts
git commit -m "feat(dashboard): recurring-outflow detector"
```

---

## Task 3: Overview aggregator endpoint

**Why:** one server-side fan-out so the mobile dashboard makes one round-trip instead of eight. Returns the full payload defined in spec §6. Partial failures degrade gracefully (a missing slice becomes `null`; the page renders the rest).

**Files:**
- Create: `plugins/agentbook-core/backend/src/dashboard/overview.ts`
- Create: `plugins/agentbook-core/backend/src/dashboard/__tests__/overview.test.ts`
- Modify: `plugins/agentbook-core/backend/src/server.ts` (register route)

- [ ] **Step 1: Write a happy-path test**

Create `plugins/agentbook-core/backend/src/dashboard/__tests__/overview.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rankAttention, buildNextMoments, deriveMoodLabel } from '../overview.js';

describe('rankAttention', () => {
  it('orders overdue invoices first, then tax-within-14d, then unbilled, then balance, then receipts', () => {
    const ranked = rankAttention({
      overdue: [{ id: 'i1', client: 'Acme', daysOverdue: 32, amountCents: 450000 }],
      taxQuarterly: { dueDate: '2026-05-14', amountCents: 320000, daysOut: 12 },
      unbilled: { hours: 12, amountCents: 240000 },
      booksOutOfBalance: true,
      missingReceiptsCount: 4,
    });

    expect(ranked[0].id).toBe('overdue:i1');
    expect(ranked[1].id).toBe('tax');
    expect(ranked[2].id).toBe('unbilled');
    expect(ranked[3].id).toBe('balance');
    expect(ranked[4].id).toBe('receipts');
    expect(ranked).toHaveLength(5);
  });

  it('omits tax callout when daysOut > 14', () => {
    const ranked = rankAttention({
      overdue: [],
      taxQuarterly: { dueDate: '2026-06-01', amountCents: 320000, daysOut: 30 },
      unbilled: null,
      booksOutOfBalance: false,
      missingReceiptsCount: 0,
    });
    expect(ranked).toHaveLength(0);
  });

  it('omits missingReceipts when count < 3', () => {
    const ranked = rankAttention({
      overdue: [],
      taxQuarterly: null,
      unbilled: null,
      booksOutOfBalance: false,
      missingReceiptsCount: 2,
    });
    expect(ranked).toHaveLength(0);
  });

  it('caps at 5 items even when more inputs exist', () => {
    const overdue = Array.from({ length: 10 }, (_, i) => ({
      id: `i${i}`, client: `Client${i}`, daysOverdue: 30 + i, amountCents: 100000,
    }));
    const ranked = rankAttention({
      overdue,
      taxQuarterly: { dueDate: '2026-05-14', amountCents: 320000, daysOut: 12 },
      unbilled: null,
      booksOutOfBalance: false,
      missingReceiptsCount: 0,
    });
    expect(ranked).toHaveLength(5);
    // overdue items occupy 4 slots; tax is the 5th
    expect(ranked.slice(0, 4).every(r => r.id.startsWith('overdue:'))).toBe(true);
    expect(ranked[4].id).toBe('tax');
  });
});

describe('buildNextMoments', () => {
  it('orders by daysOut asc; ties broken by absolute amount desc; cap 4', () => {
    const moments = buildNextMoments({
      upcomingInvoices: [
        { client: 'Acme', amountCents: 450000, daysOut: 7 },
        { client: 'Beta', amountCents: 280000, daysOut: 14 },
      ],
      tax: { amountCents: 320000, daysOut: 14 },
      recurring: [
        { vendor: 'Rent', amountCents: 180000, daysOut: 5 },
        { vendor: 'AWS', amountCents: 34000, daysOut: 12 },
      ],
    });

    expect(moments).toHaveLength(4);
    expect(moments[0].label).toMatch(/Rent/);   // 5d
    expect(moments[0].kind).toBe('rent');
    expect(moments[1].label).toMatch(/Acme/);   // 7d
    expect(moments[2].label).toMatch(/AWS/);    // 12d
    // tax and Beta both at 14d — tax has higher amount, comes first
    expect(moments[3].label).toMatch(/Tax/);
  });

  it('returns empty when no inputs', () => {
    expect(buildNextMoments({ upcomingInvoices: [], tax: null, recurring: [] })).toEqual([]);
  });
});

describe('deriveMoodLabel', () => {
  it('critical when any day in window is ≤ 0', () => {
    const days = Array.from({ length: 30 }, (_, i) => ({
      date: '2026-05-' + String(i + 1).padStart(2, '0'),
      cents: i === 15 ? -1000 : 100000,
    }));
    expect(deriveMoodLabel(days, 200000)).toBe('critical');
  });

  it('tight when min < 0.5 × monthly burn', () => {
    const days = Array.from({ length: 30 }, () => ({ date: '', cents: 50000 }));
    expect(deriveMoodLabel(days, 200000)).toBe('tight'); // 50k < 100k
  });

  it('healthy otherwise', () => {
    const days = Array.from({ length: 30 }, () => ({ date: '', cents: 500000 }));
    expect(deriveMoodLabel(days, 200000)).toBe('healthy');
  });
});
```

- [ ] **Step 2: Run test, verify it fails (module missing)**

```bash
cd plugins/agentbook-core/backend && npx vitest run src/dashboard/__tests__/overview.test.ts
```

Expected: FAIL — cannot import.

- [ ] **Step 3: Implement the aggregator**

Create `plugins/agentbook-core/backend/src/dashboard/overview.ts`:

```ts
/**
 * Dashboard /overview aggregator.
 *
 * Fans out to existing tax/invoice/expense endpoints, ranks the
 * attention queue, builds the "next moments" list, derives a mood label,
 * and returns one payload to the client.
 *
 * Partial failures: any leaf endpoint failure becomes `null` for its
 * slice — the page still renders the rest.
 */

import type { Request, Response } from 'express';
import { db } from '../db/client.js';
import { detectRecurringForTenant, type RecurringOutflow } from './recurring-detector.js';

// === Types =================================================================

export interface NextMoment {
  kind: 'income' | 'tax' | 'rent' | 'recurring';
  label: string;
  amountCents: number;
  daysOut: number;
  sourceId?: string;
}

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'warn' | 'info';
  title: string;
  subtitle?: string;
  amountCents?: number;
  action?: { label: string; href?: string; postEndpoint?: string };
}

export interface OverviewPayload {
  cashToday: number;
  projection: {
    days: { date: string; cents: number }[];
    moodLabel: 'healthy' | 'tight' | 'critical';
  } | null;
  nextMoments: NextMoment[];
  attention: AttentionItem[];
  recurringOutflows: RecurringOutflow[];
  monthMtd: { revenueCents: number; expenseCents: number; netCents: number } | null;
  monthPrev: { revenueCents: number; expenseCents: number; netCents: number } | null;
  isBrandNew: boolean;
}

// === Pure helpers (unit-tested) ============================================

interface AttentionInput {
  overdue: { id: string; client: string; daysOverdue: number; amountCents: number }[];
  taxQuarterly: { dueDate: string; amountCents: number; daysOut: number } | null;
  unbilled: { hours: number; amountCents: number } | null;
  booksOutOfBalance: boolean;
  missingReceiptsCount: number;
}

export function rankAttention(input: AttentionInput): AttentionItem[] {
  const items: AttentionItem[] = [];

  for (const ov of input.overdue) {
    items.push({
      id: `overdue:${ov.id}`,
      severity: 'critical',
      title: `${ov.client} · ${ov.daysOverdue} days overdue`,
      amountCents: ov.amountCents,
      action: { label: 'Send reminder', postEndpoint: `/api/v1/agentbook-invoice/invoices/${ov.id}/remind` },
    });
  }

  if (input.taxQuarterly && input.taxQuarterly.daysOut <= 14) {
    items.push({
      id: 'tax',
      severity: 'warn',
      title: `Tax payment due ${input.taxQuarterly.dueDate}`,
      amountCents: input.taxQuarterly.amountCents,
      action: { label: 'View', href: '/agentbook/tax' },
    });
  }

  if (input.unbilled && input.unbilled.hours > 0) {
    items.push({
      id: 'unbilled',
      severity: 'info',
      title: `${input.unbilled.hours.toFixed(1)} unbilled hours`,
      amountCents: input.unbilled.amountCents,
      action: { label: 'Invoice now', href: '/agentbook/invoices/new' },
    });
  }

  if (input.booksOutOfBalance) {
    items.push({
      id: 'balance',
      severity: 'critical',
      title: 'Books are out of balance',
      action: { label: 'Review', href: '/agentbook/ledger' },
    });
  }

  if (input.missingReceiptsCount >= 3) {
    items.push({
      id: 'receipts',
      severity: 'info',
      title: `${input.missingReceiptsCount} expenses missing receipts`,
      action: { label: 'Upload', href: '/agentbook/expenses' },
    });
  }

  return items.slice(0, 5);
}

interface NextMomentsInput {
  upcomingInvoices: { client: string; amountCents: number; daysOut: number; sourceId?: string }[];
  tax: { amountCents: number; daysOut: number } | null;
  recurring: { vendor: string; amountCents: number; daysOut: number }[];
}

export function buildNextMoments(input: NextMomentsInput): NextMoment[] {
  const moments: NextMoment[] = [];

  for (const inv of input.upcomingInvoices) {
    moments.push({
      kind: 'income',
      label: `💰 ${inv.client} $${(inv.amountCents / 100).toFixed(0)} in ${inv.daysOut}d`,
      amountCents: inv.amountCents,
      daysOut: inv.daysOut,
      sourceId: inv.sourceId,
    });
  }

  if (input.tax) {
    moments.push({
      kind: 'tax',
      label: `📋 Tax $${(input.tax.amountCents / 100).toFixed(0)} in ${input.tax.daysOut}d`,
      amountCents: input.tax.amountCents,
      daysOut: input.tax.daysOut,
    });
  }

  for (const r of input.recurring) {
    const isRent = /rent|lease/i.test(r.vendor);
    moments.push({
      kind: isRent ? 'rent' : 'recurring',
      label: `${isRent ? '🏠' : '🔁'} ${r.vendor} $${(r.amountCents / 100).toFixed(0)} in ${r.daysOut}d`,
      amountCents: r.amountCents,
      daysOut: r.daysOut,
    });
  }

  moments.sort((a, b) => {
    if (a.daysOut !== b.daysOut) return a.daysOut - b.daysOut;
    return Math.abs(b.amountCents) - Math.abs(a.amountCents);
  });

  return moments.slice(0, 4);
}

export function deriveMoodLabel(
  days: { cents: number }[],
  monthlyExpenseRunRateCents: number
): 'healthy' | 'tight' | 'critical' {
  if (days.length === 0) return 'healthy';
  const minCents = Math.min(...days.map(d => d.cents));
  if (minCents <= 0) return 'critical';
  if (monthlyExpenseRunRateCents > 0 && minCents < 0.5 * monthlyExpenseRunRateCents) return 'tight';
  return 'healthy';
}

// === Express handler =======================================================

const PORT_CORE = process.env.PORT || '4050';
const baseUrl = `http://localhost:${PORT_CORE}`; // for in-process forwarding fallback

interface FetchOpts {
  url: string;
  tenantId: string;
}

async function safeJson<T>({ url, tenantId }: FetchOpts): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: { 'x-tenant-id': tenantId } });
    if (!res.ok) return null;
    const json = await res.json();
    return (json?.data ?? json) as T;
  } catch (err) {
    console.error('[overview] leaf fetch failed', url, err);
    return null;
  }
}

const TAX_BASE = process.env.AGENTBOOK_TAX_URL || 'http://localhost:4053';
const INVOICE_BASE = process.env.AGENTBOOK_INVOICE_URL || 'http://localhost:4052';
const EXPENSE_BASE = process.env.AGENTBOOK_EXPENSE_URL || 'http://localhost:4051';
const CORE_BASE = process.env.AGENTBOOK_CORE_URL || baseUrl;

export async function handleDashboardOverview(req: Request, res: Response): Promise<void> {
  const tenantId: string = (req as any).tenantId;
  const today = new Date();

  const [
    trialBalance,
    projection,
    upcomingInvoices,
    overdueAging,
    quarterlyTax,
    unbilled,
    missingReceipts,
    pnlMtd,
    pnlPrev,
    expenseCount,
    invoiceCount,
  ] = await Promise.all([
    safeJson<{ totalDebits: number; totalCredits: number; balanced: boolean; accounts: { accountType: string; balance: number }[] }>(
      { url: `${CORE_BASE}/api/v1/agentbook-core/trial-balance`, tenantId }
    ),
    safeJson<{ days: { date: string; cents: number }[] }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/cashflow/projection`, tenantId }
    ),
    safeJson<{ id: string; client: { name: string }; total: number; dueDate: string }[]>(
      { url: `${INVOICE_BASE}/api/v1/agentbook-invoice/invoices?status=sent&dueWithinDays=30`, tenantId }
    ),
    safeJson<{ buckets: any; overdueInvoices: { id: string; client: string; daysOverdue: number; amountCents: number }[] }>(
      { url: `${INVOICE_BASE}/api/v1/agentbook-invoice/aging-report`, tenantId }
    ),
    safeJson<{ year: number; quarters: { quarter: number; dueDate: string; estimatedCents: number; paid: boolean }[] }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/tax/quarterly`, tenantId }
    ),
    safeJson<{ totalHours: number; totalCents: number }>(
      { url: `${INVOICE_BASE}/api/v1/agentbook-invoice/unbilled-summary`, tenantId }
    ),
    safeJson<{ count: number }>(
      { url: `${EXPENSE_BASE}/api/v1/agentbook-expense/expenses?missingReceipt=true&limit=1&countOnly=true`, tenantId }
    ),
    safeJson<{ revenueCents: number; expenseCents: number; netCents: number }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/reports/pnl?period=mtd`, tenantId }
    ),
    safeJson<{ revenueCents: number; expenseCents: number; netCents: number }>(
      { url: `${TAX_BASE}/api/v1/agentbook-tax/reports/pnl?period=last-month`, tenantId }
    ),
    db.abExpense.count({ where: { tenantId } }),
    db.abInvoice.count({ where: { tenantId } }),
  ]);

  // Cash today: sum of asset accounts
  const cashToday = trialBalance
    ? trialBalance.accounts.filter(a => a.accountType === 'asset').reduce((s, a) => s + (a.balance || 0), 0)
    : 0;

  // Recurring outflows
  const recurring = await detectRecurringForTenant(tenantId, today);
  const recurringWithDays = recurring.map(r => ({
    ...r,
    daysOut: Math.max(0, Math.round((new Date(r.nextExpectedDate).getTime() - today.getTime()) / 86400000)),
  }));

  // Next quarterly tax due
  const nextTax = quarterlyTax?.quarters.find(q => !q.paid && new Date(q.dueDate) >= today);
  const taxDaysOut = nextTax
    ? Math.round((new Date(nextTax.dueDate).getTime() - today.getTime()) / 86400000)
    : null;

  // Build next moments
  const nextMoments = buildNextMoments({
    upcomingInvoices: (upcomingInvoices || []).map((i: any) => ({
      client: i.client?.name || 'Client',
      amountCents: Math.round((i.total || 0) * 100),
      daysOut: Math.max(0, Math.round((new Date(i.dueDate).getTime() - today.getTime()) / 86400000)),
      sourceId: i.id,
    })),
    tax: nextTax && taxDaysOut !== null ? { amountCents: nextTax.estimatedCents, daysOut: taxDaysOut } : null,
    recurring: recurringWithDays.filter(r => r.daysOut <= 30).map(r => ({
      vendor: r.vendor, amountCents: r.amountCents, daysOut: r.daysOut,
    })),
  });

  // Build attention
  const attention = rankAttention({
    overdue: overdueAging?.overdueInvoices || [],
    taxQuarterly: nextTax && taxDaysOut !== null
      ? { dueDate: nextTax.dueDate.slice(0, 10), amountCents: nextTax.estimatedCents, daysOut: taxDaysOut }
      : null,
    unbilled: unbilled && unbilled.totalHours > 0
      ? { hours: unbilled.totalHours, amountCents: unbilled.totalCents }
      : null,
    booksOutOfBalance: trialBalance ? !trialBalance.balanced : false,
    missingReceiptsCount: missingReceipts?.count || 0,
  });

  // Mood label (uses MTD expense as a proxy for monthly burn)
  const monthlyBurn = pnlMtd?.expenseCents || 0;
  const moodLabel = projection ? deriveMoodLabel(projection.days, monthlyBurn) : 'healthy';

  const payload: OverviewPayload = {
    cashToday,
    projection: projection ? { days: projection.days, moodLabel } : null,
    nextMoments,
    attention,
    recurringOutflows: recurring,
    monthMtd: pnlMtd,
    monthPrev: pnlPrev,
    isBrandNew: expenseCount === 0 && invoiceCount === 0,
  };

  res.json({ success: true, data: payload });
}
```

- [ ] **Step 4: Register the route in server.ts**

In `plugins/agentbook-core/backend/src/server.ts`, near the existing `app.get('/api/v1/agentbook-core/trial-balance', ...)` block (around line 493), add:

```ts
import { handleDashboardOverview } from './dashboard/overview.js';
// ...
app.get('/api/v1/agentbook-core/dashboard/overview', handleDashboardOverview);
```

- [ ] **Step 5: Run tests**

```bash
cd plugins/agentbook-core/backend && npx vitest run src/dashboard/__tests__/overview.test.ts
```

Expected: 7 passing.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/dashboard/overview.ts \
        plugins/agentbook-core/backend/src/dashboard/__tests__/overview.test.ts \
        plugins/agentbook-core/backend/src/server.ts
git commit -m "feat(dashboard): GET /agentbook-core/dashboard/overview aggregator"
```

---

## Task 4: Activity feed endpoint

**Why:** unified recent-activity feed mixing invoice events, expenses, and payments — sorted by date, easier than 3 client-side fetches.

**Files:**
- Create: `plugins/agentbook-core/backend/src/dashboard/activity.ts`
- Modify: `plugins/agentbook-core/backend/src/server.ts` (register route)

- [ ] **Step 1: Implement the handler**

Create `plugins/agentbook-core/backend/src/dashboard/activity.ts`:

```ts
import type { Request, Response } from 'express';
import { db } from '../db/client.js';

export interface ActivityItem {
  id: string;
  kind: 'invoice_sent' | 'invoice_paid' | 'invoice_voided' | 'expense' | 'payment';
  label: string;
  amountCents: number;
  date: string;
  href?: string;
}

export async function handleDashboardActivity(req: Request, res: Response): Promise<void> {
  const tenantId: string = (req as any).tenantId;
  const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit || '10'), 10)));

  // Pull a window of ~3× limit per source, then merge & truncate.
  const perSource = limit * 3;
  const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // last 60 days

  const [expenses, invoices, payments] = await Promise.all([
    db.abExpense.findMany({
      where: { tenantId, isPersonal: false, date: { gte: since } },
      orderBy: { date: 'desc' },
      take: perSource,
      select: { id: true, description: true, amountCents: true, date: true },
    }),
    db.abInvoice.findMany({
      where: { tenantId, OR: [{ sentAt: { gte: since } }, { voidedAt: { gte: since } }] },
      orderBy: { updatedAt: 'desc' },
      take: perSource,
      select: { id: true, number: true, status: true, total: true, sentAt: true, voidedAt: true, client: { select: { name: true } } },
    }),
    db.abPayment.findMany({
      where: { tenantId, date: { gte: since } },
      orderBy: { date: 'desc' },
      take: perSource,
      select: { id: true, amountCents: true, date: true, invoice: { select: { number: true, client: { select: { name: true } } } } },
    }),
  ]);

  const items: ActivityItem[] = [];

  for (const e of expenses) {
    items.push({
      id: `exp:${e.id}`,
      kind: 'expense',
      label: `🧾 ${e.description || 'Expense'}`,
      amountCents: -e.amountCents,
      date: e.date.toISOString(),
      href: `/agentbook/expenses`,
    });
  }

  for (const inv of invoices) {
    if (inv.sentAt) {
      items.push({
        id: `inv-sent:${inv.id}`,
        kind: 'invoice_sent',
        label: `↗ Sent invoice ${inv.number} — ${inv.client?.name || ''}`.trim(),
        amountCents: Math.round((inv.total || 0) * 100),
        date: inv.sentAt.toISOString(),
        href: `/agentbook/invoices`,
      });
    }
    if (inv.voidedAt) {
      items.push({
        id: `inv-void:${inv.id}`,
        kind: 'invoice_voided',
        label: `✕ Voided invoice ${inv.number}`,
        amountCents: 0,
        date: inv.voidedAt.toISOString(),
        href: `/agentbook/invoices`,
      });
    }
  }

  for (const p of payments) {
    items.push({
      id: `pay:${p.id}`,
      kind: 'invoice_paid',
      label: `⬇ Paid by ${p.invoice?.client?.name || 'client'} (${p.invoice?.number || ''})`,
      amountCents: p.amountCents,
      date: p.date.toISOString(),
      href: `/agentbook/invoices`,
    });
  }

  items.sort((a, b) => b.date.localeCompare(a.date));
  res.json({ success: true, data: items.slice(0, limit) });
}
```

- [ ] **Step 2: Register the route**

In `plugins/agentbook-core/backend/src/server.ts`:

```ts
import { handleDashboardActivity } from './dashboard/activity.js';
// ...
app.get('/api/v1/agentbook-core/dashboard/activity', handleDashboardActivity);
```

- [ ] **Step 3: Smoke test (dev DB seeded)**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
PORT=4050 npx tsx plugins/agentbook-core/backend/src/server.ts &
sleep 2 && curl -s -H "x-tenant-id: maya" http://localhost:4050/api/v1/agentbook-core/dashboard/activity?limit=5 | head -c 500
kill %1
```

Expected: JSON with `{ success: true, data: [...] }` (≤5 items).

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-core/backend/src/dashboard/activity.ts \
        plugins/agentbook-core/backend/src/server.ts
git commit -m "feat(dashboard): GET /agentbook-core/dashboard/activity feed"
```

---

## Task 5: Agent summary endpoint with in-memory cache

**Why:** the LLM moat. Calls Gemini for a 1–2 sentence judgment line; caches 15 min per tenant in a process-local Map; falls back to a deterministic counts string if the LLM is slow or fails.

**Files:**
- Create: `plugins/agentbook-core/backend/src/dashboard/agent-summary.ts`
- Create: `plugins/agentbook-core/backend/src/dashboard/__tests__/agent-summary.test.ts`
- Modify: `plugins/agentbook-core/backend/src/server.ts` (register route)

- [ ] **Step 1: Write failing tests**

Create `plugins/agentbook-core/backend/src/dashboard/__tests__/agent-summary.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildDeterministicSummary, computeSummary, _resetCache } from '../agent-summary.js';

beforeEach(() => _resetCache());

describe('buildDeterministicSummary', () => {
  it('summarizes overdue + tax', () => {
    const s = buildDeterministicSummary({
      overdueCount: 3,
      overdueAmountCents: 840000,
      taxDaysOut: 12,
    });
    expect(s).toMatch(/3 invoices overdue/);
    expect(s).toMatch(/\$8,400/);
    expect(s).toMatch(/Tax payment in 12 days/);
  });

  it('All clear when nothing pending', () => {
    expect(buildDeterministicSummary({
      overdueCount: 0, overdueAmountCents: 0, taxDaysOut: null,
    })).toBe('All clear ☕');
  });
});

describe('computeSummary cache', () => {
  it('returns deterministic when callGemini returns null', async () => {
    const fakeGemini = vi.fn().mockResolvedValue(null);
    const out = await computeSummary('tenant-A', { overdueCount: 1, overdueAmountCents: 100000, taxDaysOut: null }, fakeGemini);
    expect(out.source).toBe('fallback');
    expect(out.summary).toMatch(/1 invoice overdue/);
  });

  it('returns LLM result when callGemini resolves', async () => {
    const fakeGemini = vi.fn().mockResolvedValue('Two big ones land next week — tight.');
    const out = await computeSummary('tenant-A', { overdueCount: 1, overdueAmountCents: 100000, taxDaysOut: null }, fakeGemini);
    expect(out.source).toBe('llm');
    expect(out.summary).toBe('Two big ones land next week — tight.');
  });

  it('caches LLM result for 15 min', async () => {
    const fakeGemini = vi.fn().mockResolvedValue('cached value');
    await computeSummary('tenant-B', { overdueCount: 0, overdueAmountCents: 0, taxDaysOut: null }, fakeGemini);
    await computeSummary('tenant-B', { overdueCount: 0, overdueAmountCents: 0, taxDaysOut: null }, fakeGemini);
    expect(fakeGemini).toHaveBeenCalledTimes(1);
  });

  it('falls back if LLM exceeds 3s', async () => {
    const slowGemini = () => new Promise<string | null>(resolve => setTimeout(() => resolve('too late'), 5000));
    const out = await computeSummary('tenant-C', { overdueCount: 0, overdueAmountCents: 0, taxDaysOut: null }, slowGemini);
    expect(out.source).toBe('fallback');
  }, 10_000);
});
```

- [ ] **Step 2: Run tests, confirm fail**

```bash
cd plugins/agentbook-core/backend && npx vitest run src/dashboard/__tests__/agent-summary.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `plugins/agentbook-core/backend/src/dashboard/agent-summary.ts`:

```ts
import type { Request, Response } from 'express';
import { callGemini } from '../server.js';

export interface SummaryFacts {
  overdueCount: number;
  overdueAmountCents: number;
  taxDaysOut: number | null;
}

export interface SummaryResult {
  summary: string;
  generatedAt: string;
  source: 'llm' | 'fallback';
}

const CACHE_TTL_MS = 15 * 60 * 1000;
const LLM_TIMEOUT_MS = 3000;

interface CacheEntry { value: SummaryResult; expiresAt: number; }
const cache = new Map<string, CacheEntry>();

export function _resetCache(): void { cache.clear(); }

function fmtUSD(cents: number): string {
  return '$' + Math.abs(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function buildDeterministicSummary(f: SummaryFacts): string {
  const parts: string[] = [];
  if (f.overdueCount > 0) {
    parts.push(`${f.overdueCount} invoice${f.overdueCount === 1 ? '' : 's'} overdue (${fmtUSD(f.overdueAmountCents)})`);
  }
  if (f.taxDaysOut !== null && f.taxDaysOut <= 14) {
    parts.push(`Tax payment in ${f.taxDaysOut} days`);
  }
  return parts.length === 0 ? 'All clear ☕' : parts.join('. ') + '.';
}

const SYSTEM_PROMPT = `You are a small-business accounting copilot. In ONE or TWO sentences, summarize the user's most pressing financial situation right now. Use plain language. Suggest the single highest-leverage action when appropriate. No emojis. No bullet points. Under 200 characters.`;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }).catch(() => { clearTimeout(timer); resolve(null); });
  });
}

export async function computeSummary(
  tenantId: string,
  facts: SummaryFacts,
  callLLM: (sys: string, user: string, max?: number) => Promise<string | null> = callGemini
): Promise<SummaryResult> {
  const cached = cache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const userMsg = `Facts: ${JSON.stringify(facts)}`;
  const llmRaw = await withTimeout(callLLM(SYSTEM_PROMPT, userMsg, 200), LLM_TIMEOUT_MS);
  const summary = (llmRaw && llmRaw.trim().length > 0) ? llmRaw.trim() : buildDeterministicSummary(facts);
  const source: 'llm' | 'fallback' = llmRaw ? 'llm' : 'fallback';

  const result: SummaryResult = { summary, generatedAt: new Date().toISOString(), source };
  cache.set(tenantId, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

export async function handleDashboardAgentSummary(req: Request, res: Response): Promise<void> {
  const tenantId: string = (req as any).tenantId;
  const facts: SummaryFacts = {
    overdueCount: parseInt(String(req.query.overdueCount || '0'), 10),
    overdueAmountCents: parseInt(String(req.query.overdueAmountCents || '0'), 10),
    taxDaysOut: req.query.taxDaysOut !== undefined ? parseInt(String(req.query.taxDaysOut), 10) : null,
  };

  const result = await computeSummary(tenantId, facts);
  res.json({ success: true, data: result });
}
```

- [ ] **Step 4: Register the route**

In `server.ts`:

```ts
import { handleDashboardAgentSummary } from './dashboard/agent-summary.js';
// ...
app.get('/api/v1/agentbook-core/dashboard/agent-summary', handleDashboardAgentSummary);
```

- [ ] **Step 5: Run tests**

```bash
cd plugins/agentbook-core/backend && npx vitest run src/dashboard/__tests__/agent-summary.test.ts
```

Expected: 5 passing.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/dashboard/agent-summary.ts \
        plugins/agentbook-core/backend/src/dashboard/__tests__/agent-summary.test.ts \
        plugins/agentbook-core/backend/src/server.ts
git commit -m "feat(dashboard): GET /agentbook-core/dashboard/agent-summary with in-memory cache"
```

---

## Task 6: Frontend types and overview hook

**Why:** typed boundary between server and components. Hook centralizes fetch + skeleton/error state.

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/types.ts`
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/hooks/useDashboardOverview.ts`

- [ ] **Step 1: Create the shared types file**

`plugins/agentbook-core/frontend/src/pages/dashboard/types.ts`:

```ts
export interface NextMoment {
  kind: 'income' | 'tax' | 'rent' | 'recurring';
  label: string;
  amountCents: number;
  daysOut: number;
  sourceId?: string;
}

export interface AttentionItem {
  id: string;
  severity: 'critical' | 'warn' | 'info';
  title: string;
  subtitle?: string;
  amountCents?: number;
  action?: { label: string; href?: string; postEndpoint?: string };
}

export interface RecurringOutflow {
  vendor: string;
  amountCents: number;
  nextExpectedDate: string;
}

export interface OverviewPayload {
  cashToday: number;
  projection: { days: { date: string; cents: number }[]; moodLabel: 'healthy' | 'tight' | 'critical' } | null;
  nextMoments: NextMoment[];
  attention: AttentionItem[];
  recurringOutflows: RecurringOutflow[];
  monthMtd: { revenueCents: number; expenseCents: number; netCents: number } | null;
  monthPrev: { revenueCents: number; expenseCents: number; netCents: number } | null;
  isBrandNew: boolean;
}

export interface ActivityItem {
  id: string;
  kind: 'invoice_sent' | 'invoice_paid' | 'invoice_voided' | 'expense' | 'payment';
  label: string;
  amountCents: number;
  date: string;
  href?: string;
}

export interface AgentSummary {
  summary: string;
  generatedAt: string;
  source: 'llm' | 'fallback';
}
```

- [ ] **Step 2: Create the overview hook**

`plugins/agentbook-core/frontend/src/pages/dashboard/hooks/useDashboardOverview.ts`:

```ts
import { useEffect, useState, useCallback } from 'react';
import type { OverviewPayload } from '../types';

interface State {
  data: OverviewPayload | null;
  error: Error | null;
  loading: boolean;
}

export function useDashboardOverview() {
  const [state, setState] = useState<State>({ data: null, error: null, loading: true });

  const fetchOverview = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const res = await fetch('/api/v1/agentbook-core/dashboard/overview');
      if (!res.ok) throw new Error(`overview ${res.status}`);
      const json = await res.json();
      if (!json?.success) throw new Error(json?.error || 'overview failed');
      setState({ data: json.data, error: null, loading: false });
    } catch (err) {
      setState({ data: null, error: err as Error, loading: false });
    }
  }, []);

  useEffect(() => { fetchOverview(); }, [fetchOverview]);

  return { ...state, refetch: fetchOverview };
}
```

- [ ] **Step 3: Create the activity hook**

`plugins/agentbook-core/frontend/src/pages/dashboard/hooks/useDashboardActivity.ts`:

```ts
import { useEffect, useState, useCallback } from 'react';
import type { ActivityItem } from '../types';

export function useDashboardActivity(initialLimit = 10) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(initialLimit);

  const fetchActivity = useCallback(async (l: number) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/v1/agentbook-core/dashboard/activity?limit=${l}`);
      if (!res.ok) throw new Error(`activity ${res.status}`);
      const json = await res.json();
      if (!json?.success) throw new Error(json?.error || 'activity failed');
      setItems(json.data);
      setError(null);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchActivity(limit); }, [fetchActivity, limit]);

  return { items, error, loading, loadMore: () => setLimit(l => l + 10) };
}
```

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/types.ts \
        plugins/agentbook-core/frontend/src/pages/dashboard/hooks
git commit -m "feat(dashboard): types + data fetching hooks"
```

---

## Task 7: CashflowTimeline component (with unit test)

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/CashflowTimeline.tsx`
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/CashflowTimeline.test.tsx`

- [ ] **Step 1: Failing test**

`__tests__/CashflowTimeline.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { CashflowTimeline } from '../CashflowTimeline';
import type { NextMoment } from '../types';

const baseDays = Array.from({ length: 30 }, (_, i) => ({
  date: '2026-05-' + String(i + 1).padStart(2, '0'),
  cents: 100000 + i * 1000,
}));

describe('CashflowTimeline', () => {
  it('renders one circle per marker', () => {
    const moments: NextMoment[] = [
      { kind: 'income', label: 'Acme', amountCents: 450000, daysOut: 7 },
      { kind: 'tax', label: 'Tax', amountCents: 320000, daysOut: 14 },
    ];
    const { container } = render(<CashflowTimeline days={baseDays} moments={moments} />);
    expect(container.querySelectorAll('[data-testid="timeline-marker"]').length).toBe(2);
  });

  it('clips markers with daysOut > 30', () => {
    const moments: NextMoment[] = [
      { kind: 'recurring', label: 'Far', amountCents: 100, daysOut: 45 },
    ];
    const { container } = render(<CashflowTimeline days={baseDays} moments={moments} />);
    expect(container.querySelectorAll('[data-testid="timeline-marker"]').length).toBe(0);
  });
});
```

- [ ] **Step 2: Implement**

`CashflowTimeline.tsx`:

```tsx
import React from 'react';
import type { NextMoment } from './types';

interface Props {
  days: { date: string; cents: number }[];
  moments: NextMoment[];
  width?: number;
  height?: number;
}

export const CashflowTimeline: React.FC<Props> = ({ days, moments, width = 320, height = 60 }) => {
  const visible = moments.filter(m => m.daysOut >= 0 && m.daysOut <= 30);
  const padX = 8;
  const innerW = width - padX * 2;
  const yMid = height / 2;

  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="30-day cashflow">
      <line x1={padX} x2={width - padX} y1={yMid} y2={yMid} stroke="currentColor" strokeOpacity={0.25} strokeWidth={2} />
      <circle cx={padX} cy={yMid} r={4} fill="currentColor" />
      <circle cx={width - padX} cy={yMid} r={4} fill="currentColor" />
      {visible.map((m, i) => {
        const x = padX + (m.daysOut / 30) * innerW;
        const isInflow = m.kind === 'income';
        const color = isInflow ? '#22c55e' : '#ef4444';
        return (
          <g key={i} data-testid="timeline-marker" aria-label={m.label}>
            <line x1={x} x2={x} y1={yMid - 12} y2={yMid + 12} stroke={color} strokeWidth={2} />
            <circle cx={x} cy={isInflow ? yMid - 12 : yMid + 12} r={5} fill={color} />
          </g>
        );
      })}
    </svg>
  );
};
```

- [ ] **Step 3: Run tests**

```bash
cd plugins/agentbook-core/frontend && npx vitest run src/pages/dashboard/__tests__/CashflowTimeline.test.tsx
```

Expected: 2 passing.

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/CashflowTimeline.tsx \
        plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/CashflowTimeline.test.tsx
git commit -m "feat(dashboard): CashflowTimeline SVG component"
```

---

## Task 8: NextMomentsList component

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/NextMomentsList.tsx`
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/NextMomentsList.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextMomentsList } from '../NextMomentsList';
import type { NextMoment } from '../types';

describe('NextMomentsList', () => {
  it('renders all items with their labels', () => {
    const moments: NextMoment[] = [
      { kind: 'rent', label: '🏠 Rent $1,800 in 5d', amountCents: 180000, daysOut: 5 },
      { kind: 'income', label: '💰 Acme $4,500 in 7d', amountCents: 450000, daysOut: 7 },
    ];
    render(<NextMomentsList moments={moments} />);
    expect(screen.getByText(/Rent/)).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });

  it('shows empty state when no moments', () => {
    render(<NextMomentsList moments={[]} />);
    expect(screen.getByText(/No upcoming/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Implement**

```tsx
import React from 'react';
import type { NextMoment } from './types';

interface Props { moments: NextMoment[]; }

export const NextMomentsList: React.FC<Props> = ({ moments }) => {
  if (moments.length === 0) {
    return <p className="text-sm text-muted-foreground">No upcoming receivables or bills.</p>;
  }
  return (
    <ul className="space-y-1.5">
      {moments.map((m, i) => (
        <li key={i} className="text-sm font-medium text-foreground">{m.label}</li>
      ))}
    </ul>
  );
};
```

- [ ] **Step 3: Run tests**

```bash
cd plugins/agentbook-core/frontend && npx vitest run src/pages/dashboard/__tests__/NextMomentsList.test.tsx
```

Expected: 2 passing.

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/NextMomentsList.tsx \
        plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/NextMomentsList.test.tsx
git commit -m "feat(dashboard): NextMomentsList"
```

---

## Task 9: ForwardView (composes timeline + moments + cash)

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/ForwardView.tsx`

- [ ] **Step 1: Implement**

```tsx
import React from 'react';
import { CashflowTimeline } from './CashflowTimeline';
import { NextMomentsList } from './NextMomentsList';
import type { NextMoment } from './types';

interface Props {
  cashTodayCents: number;
  projection: { days: { date: string; cents: number }[]; moodLabel: 'healthy' | 'tight' | 'critical' } | null;
  moments: NextMoment[];
}

const moodIcon = (label: 'healthy' | 'tight' | 'critical') =>
  label === 'healthy' ? '☀️' : label === 'tight' ? '⛅' : '⛈';

const moodText = (label: 'healthy' | 'tight' | 'critical') =>
  label === 'healthy' ? 'Healthy' : label === 'tight' ? 'Tight' : 'Critical';

const fmt = (cents: number) =>
  '$' + Math.round(cents / 100).toLocaleString('en-US');

export const ForwardView: React.FC<Props> = ({ cashTodayCents, projection, moments }) => {
  const projectedEnd = projection?.days[projection.days.length - 1]?.cents ?? cashTodayCents;
  const endDate = projection?.days[projection.days.length - 1]?.date;

  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-6">
      <div className="flex items-baseline justify-between gap-2 mb-3 flex-wrap">
        <h2 className="text-lg sm:text-xl font-bold text-foreground">
          {fmt(cashTodayCents)} today → {fmt(projectedEnd)} {endDate && new Date(endDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </h2>
        {projection && (
          <span className="text-sm text-muted-foreground hidden sm:inline">
            {moodIcon(projection.moodLabel)} {moodText(projection.moodLabel)}
          </span>
        )}
      </div>
      <div className="text-foreground mb-4">
        <CashflowTimeline days={projection?.days || []} moments={moments} />
        <div className="flex justify-between text-xs text-muted-foreground mt-1 px-2">
          <span>Today</span><span>+30d</span>
        </div>
      </div>
      <NextMomentsList moments={moments} />
    </section>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/ForwardView.tsx
git commit -m "feat(dashboard): ForwardView composes timeline + moments"
```

---

## Task 10: AttentionItem + AttentionPanel

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/AttentionItem.tsx`
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/AttentionPanel.tsx`
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/AttentionPanel.test.tsx`

- [ ] **Step 1: AttentionItem**

```tsx
import React, { useState } from 'react';
import type { AttentionItem as Item } from './types';

interface Props { item: Item; }

const fmt = (cents?: number) =>
  cents == null ? '' : '$' + Math.abs(Math.round(cents / 100)).toLocaleString('en-US');

const severityClass = (s: Item['severity']) =>
  s === 'critical' ? 'border-red-500/30 bg-red-500/5' :
  s === 'warn'     ? 'border-amber-500/30 bg-amber-500/5' :
                     'border-border bg-muted/30';

export const AttentionItem: React.FC<Props> = ({ item }) => {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const onClick = async () => {
    if (!item.action) return;
    if (item.action.href) {
      window.location.href = item.action.href;
      return;
    }
    if (item.action.postEndpoint) {
      setBusy(true);
      try {
        const res = await fetch(item.action.postEndpoint, { method: 'POST' });
        if (res.ok) setDone(true);
      } finally {
        setBusy(false);
      }
    }
  };

  return (
    <div className={`rounded-xl border p-3 flex items-center gap-3 ${severityClass(item.severity)}`}>
      <span className="text-base">⚠</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">{item.title}</p>
        {item.amountCents != null && <p className="text-xs text-muted-foreground">{fmt(item.amountCents)}</p>}
      </div>
      {item.action && !done && (
        <button onClick={onClick} disabled={busy} className="text-xs font-medium text-primary disabled:opacity-50 px-2 py-1 rounded-lg hover:bg-primary/10">
          {busy ? '…' : item.action.label}
        </button>
      )}
      {done && <span className="text-xs text-green-600">Sent ✓</span>}
    </div>
  );
};
```

- [ ] **Step 2: AttentionPanel + test**

`__tests__/AttentionPanel.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AttentionPanel } from '../AttentionPanel';

describe('AttentionPanel', () => {
  it('shows All clear when empty', () => {
    render(<AttentionPanel items={[]} summary={null} />);
    expect(screen.getByText(/All clear/)).toBeInTheDocument();
  });

  it('renders summary above items when present', () => {
    render(<AttentionPanel items={[
      { id: '1', severity: 'critical', title: 'Acme · 32 days overdue', amountCents: 450000 },
    ]} summary={{ summary: 'Test summary line', generatedAt: '', source: 'llm' }} />);
    expect(screen.getByText('Test summary line')).toBeInTheDocument();
    expect(screen.getByText(/Acme/)).toBeInTheDocument();
  });
});
```

`AttentionPanel.tsx`:

```tsx
import React from 'react';
import { AttentionItem } from './AttentionItem';
import type { AttentionItem as Item, AgentSummary } from './types';

interface Props { items: Item[]; summary: AgentSummary | null; }

export const AttentionPanel: React.FC<Props> = ({ items, summary }) => {
  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-6">
      <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Needs your attention</h2>
      {summary && (
        <p className="text-sm text-foreground mb-3 leading-relaxed">{summary.summary}</p>
      )}
      {items.length === 0 ? (
        <div className="rounded-xl border border-border bg-muted/20 p-4 text-center">
          <p className="text-sm text-muted-foreground">All clear ☕</p>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map(it => <AttentionItem key={it.id} item={it} />)}
        </div>
      )}
    </section>
  );
};
```

- [ ] **Step 3: Run tests**

```bash
cd plugins/agentbook-core/frontend && npx vitest run src/pages/dashboard/__tests__/AttentionPanel.test.tsx
```

Expected: 2 passing.

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/AttentionItem.tsx \
        plugins/agentbook-core/frontend/src/pages/dashboard/AttentionPanel.tsx \
        plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/AttentionPanel.test.tsx
git commit -m "feat(dashboard): AttentionPanel + AttentionItem"
```

---

## Task 11: ThisMonthStrip with delta math

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/ThisMonthStrip.tsx`
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/ThisMonthStrip.test.tsx`

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ThisMonthStrip, computeDelta } from '../ThisMonthStrip';

describe('computeDelta', () => {
  it('returns positive % when current > prior', () => {
    expect(computeDelta(11500, 10000)).toEqual({ pct: 15, sign: 'up' });
  });
  it('returns negative % when current < prior', () => {
    expect(computeDelta(9700, 10000)).toEqual({ pct: -3, sign: 'down' });
  });
  it('returns null when prior is 0 (avoids Infinity)', () => {
    expect(computeDelta(5000, 0)).toBe(null);
  });
});

describe('ThisMonthStrip', () => {
  it('renders all three numbers with deltas', () => {
    render(<ThisMonthStrip
      mtd={{ revenueCents: 1240000, expenseCents: 410000, netCents: 830000 }}
      prev={{ revenueCents: 1078260, expenseCents: 422680, netCents: 680320 }}
    />);
    expect(screen.getByText(/Rev/)).toBeInTheDocument();
    expect(screen.getByText(/Exp/)).toBeInTheDocument();
    expect(screen.getByText(/Net/)).toBeInTheDocument();
  });

  it('renders "—" instead of Infinity when prior is 0', () => {
    const { container } = render(<ThisMonthStrip
      mtd={{ revenueCents: 100000, expenseCents: 0, netCents: 100000 }}
      prev={{ revenueCents: 0, expenseCents: 0, netCents: 0 }}
    />);
    expect(container.textContent).not.toMatch(/Infinity/);
    expect(container.textContent).toMatch(/—/);
  });
});
```

- [ ] **Step 2: Implement**

```tsx
import React from 'react';

export function computeDelta(current: number, prior: number): { pct: number; sign: 'up' | 'down' } | null {
  if (prior === 0) return null;
  const pct = Math.round(((current - prior) / Math.abs(prior)) * 100);
  return { pct, sign: pct >= 0 ? 'up' : 'down' };
}

const fmt = (cents: number) => '$' + Math.round(cents / 100).toLocaleString('en-US');

const Cell: React.FC<{ label: string; cents: number; prior: number }> = ({ label, cents, prior }) => {
  const delta = computeDelta(cents, prior);
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-bold text-foreground">{fmt(cents)}</span>
      {delta ? (
        <span className={`text-xs ${delta.sign === 'up' ? 'text-green-600' : 'text-red-500'}`}>
          {delta.sign === 'up' ? '↑' : '↓'}{Math.abs(delta.pct)}%
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">—</span>
      )}
    </div>
  );
};

interface Props {
  mtd: { revenueCents: number; expenseCents: number; netCents: number } | null;
  prev: { revenueCents: number; expenseCents: number; netCents: number } | null;
}

export const ThisMonthStrip: React.FC<Props> = ({ mtd, prev }) => {
  if (!mtd) return null;
  const p = prev || { revenueCents: 0, expenseCents: 0, netCents: 0 };
  return (
    <section className="bg-card border border-border rounded-2xl p-4 flex items-center gap-4 flex-wrap">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">This month</span>
      <Cell label="Rev" cents={mtd.revenueCents} prior={p.revenueCents} />
      <Cell label="Exp" cents={mtd.expenseCents} prior={p.expenseCents} />
      <Cell label="Net" cents={mtd.netCents} prior={p.netCents} />
    </section>
  );
};
```

- [ ] **Step 3: Run tests**

```bash
cd plugins/agentbook-core/frontend && npx vitest run src/pages/dashboard/__tests__/ThisMonthStrip.test.tsx
```

Expected: 5 passing.

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/ThisMonthStrip.tsx \
        plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/ThisMonthStrip.test.tsx
git commit -m "feat(dashboard): ThisMonthStrip with delta math"
```

---

## Task 12: ActivityFeed component

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/ActivityFeed.tsx`

- [ ] **Step 1: Implement**

```tsx
import React from 'react';
import type { ActivityItem } from './types';

const fmtAmount = (cents: number) => {
  if (cents === 0) return '';
  const sign = cents > 0 ? '+' : '−';
  return `${sign}$${Math.abs(Math.round(cents / 100)).toLocaleString('en-US')}`;
};

const fmtRelative = (iso: string) => {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const hr = Math.floor(ms / 3_600_000);
  if (hr < 1) return 'just now';
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

interface Props {
  items: ActivityItem[];
  loading: boolean;
  onLoadMore: () => void;
}

export const ActivityFeed: React.FC<Props> = ({ items, loading, onLoadMore }) => {
  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-6">
      <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Recent activity</h2>
      {items.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">No recent activity.</p>
      )}
      <ul className="divide-y divide-border">
        {items.map(item => (
          <li key={item.id} className="py-2.5 flex items-center gap-3">
            <a href={item.href || '#'} className="flex-1 min-w-0 text-sm text-foreground truncate">{item.label}</a>
            <span className={`text-sm font-mono ${item.amountCents > 0 ? 'text-green-600' : item.amountCents < 0 ? 'text-foreground' : 'text-muted-foreground'}`}>{fmtAmount(item.amountCents)}</span>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtRelative(item.date)}</span>
          </li>
        ))}
      </ul>
      {items.length >= 10 && (
        <button onClick={onLoadMore} disabled={loading} className="w-full mt-3 text-sm text-primary hover:bg-primary/5 rounded-lg py-2">
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/ActivityFeed.tsx
git commit -m "feat(dashboard): ActivityFeed list with load-more"
```

---

## Task 13: QuickActionsBar with native camera capture

**Why:** the headline mobile UX upgrade. Snap opens the camera in one tap via `<input capture>`.

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/QuickActionsBar.tsx`

- [ ] **Step 1: Implement**

```tsx
import React, { useRef, useState } from 'react';
import { FilePlus2, Camera, MessageSquare } from 'lucide-react';

export const QuickActionsBar: React.FC = () => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      // Hand off to the expense receipt-capture endpoint; if it 404s the
      // user is routed to the upload page so they can try again.
      const res = await fetch('/api/v1/agentbook-expense/receipts/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        window.location.href = '/agentbook/expenses/new';
        return;
      }
      window.location.href = '/agentbook/expenses?recent=1';
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      {/* Mobile: sticky bottom bar. Desktop: hidden (header buttons handle it). */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-card/95 backdrop-blur border-t border-border flex items-stretch"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        aria-label="Quick actions"
      >
        <a href="/agentbook/invoices/new" className="flex-1 flex flex-col items-center justify-center py-3 active:scale-95 transition-transform">
          <FilePlus2 className="w-5 h-5" />
          <span className="text-[11px] mt-0.5">New invoice</span>
        </a>
        <button onClick={() => fileRef.current?.click()} disabled={uploading} className="flex-1 flex flex-col items-center justify-center py-3 active:scale-95 transition-transform disabled:opacity-50">
          <Camera className="w-5 h-5" />
          <span className="text-[11px] mt-0.5">{uploading ? 'Uploading…' : 'Snap'}</span>
        </button>
        <a href="/agentbook/agents" className="flex-1 flex flex-col items-center justify-center py-3 active:scale-95 transition-transform">
          <MessageSquare className="w-5 h-5" />
          <span className="text-[11px] mt-0.5">Ask</span>
        </a>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
      </nav>
      {/* Desktop header buttons: rendered inline by Dashboard.tsx header. */}
    </>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/QuickActionsBar.tsx
git commit -m "feat(dashboard): QuickActionsBar with native camera capture on mobile"
```

---

## Task 14: OnboardingHero for brand-new tenants

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/OnboardingHero.tsx`

- [ ] **Step 1: Implement**

```tsx
import React from 'react';
import { Banknote, FilePlus2, Camera } from 'lucide-react';

interface Step {
  icon: React.ReactNode;
  label: string;
  href: string;
  done: boolean;
}

interface Props {
  hasBank: boolean;
  hasInvoice: boolean;
  hasReceipt: boolean;
}

export const OnboardingHero: React.FC<Props> = ({ hasBank, hasInvoice, hasReceipt }) => {
  const steps: Step[] = [
    { icon: <Banknote className="w-5 h-5" />, label: 'Link bank account', href: '/agentbook/bank',     done: hasBank },
    { icon: <FilePlus2 className="w-5 h-5" />, label: 'Add first invoice',   href: '/agentbook/invoices/new', done: hasInvoice },
    { icon: <Camera className="w-5 h-5" />,   label: 'Snap a receipt',     href: '/agentbook/expenses/new', done: hasReceipt },
  ];

  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-6">
      <h2 className="text-lg font-bold text-foreground mb-1">Welcome to AgentBook</h2>
      <p className="text-sm text-muted-foreground mb-4">Three steps to bring your dashboard to life.</p>
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li key={i}>
            <a
              href={s.href}
              className={`flex items-center gap-3 rounded-xl border p-3 transition ${s.done ? 'border-green-500/30 bg-green-500/5' : 'border-border hover:bg-muted/30'}`}
            >
              <span className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">{s.icon}</span>
              <span className="flex-1 text-sm text-foreground">{i + 1}. {s.label}</span>
              {s.done && <span className="text-green-600 text-sm">✓</span>}
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
};
```

- [ ] **Step 2: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/OnboardingHero.tsx
git commit -m "feat(dashboard): OnboardingHero for brand-new tenants"
```

---

## Task 15: Dashboard.tsx — replace body, compose all sections

**Files:**
- Modify: `plugins/agentbook-core/frontend/src/pages/Dashboard.tsx` (full rewrite)

- [ ] **Step 1: Replace the file contents**

Open `plugins/agentbook-core/frontend/src/pages/Dashboard.tsx` and replace the entire file with:

```tsx
import React, { useEffect, useRef, useState } from 'react';
import { MoreHorizontal, FilePlus2, Camera, MessageSquare, RefreshCw } from 'lucide-react';
import { useDashboardOverview } from './dashboard/hooks/useDashboardOverview';
import { useDashboardActivity } from './dashboard/hooks/useDashboardActivity';
import { ForwardView } from './dashboard/ForwardView';
import { AttentionPanel } from './dashboard/AttentionPanel';
import { ThisMonthStrip } from './dashboard/ThisMonthStrip';
import { ActivityFeed } from './dashboard/ActivityFeed';
import { QuickActionsBar } from './dashboard/QuickActionsBar';
import { OnboardingHero } from './dashboard/OnboardingHero';
import type { AgentSummary } from './dashboard/types';

const Skeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div className={`animate-pulse rounded-2xl bg-muted/40 ${className}`} />
);

const DesktopHeaderActions: React.FC = () => (
  <div className="hidden lg:flex items-center gap-2">
    <a href="/agentbook/invoices/new" className="text-sm font-medium px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:opacity-90 flex items-center gap-1.5">
      <FilePlus2 className="w-4 h-4" /> New invoice
    </a>
    <a href="/agentbook/expenses/new" className="text-sm font-medium px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground flex items-center gap-1.5">
      <Camera className="w-4 h-4" /> Snap
    </a>
    <a href="/agentbook/agents" className="text-sm font-medium px-3 py-2 rounded-lg bg-muted hover:bg-muted/80 text-foreground flex items-center gap-1.5">
      <MessageSquare className="w-4 h-4" /> Ask
    </a>
  </div>
);

const Kebab: React.FC<{ onRefresh: () => void; showTelegramHint: boolean }> = ({ onRefresh, showTelegramHint }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} aria-label="More" className="p-2 rounded-lg hover:bg-muted">
        <MoreHorizontal className="w-5 h-5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-card border border-border rounded-xl shadow-lg p-2 z-50">
          <button onClick={() => { setOpen(false); onRefresh(); }} className="w-full text-left px-3 py-2 text-sm hover:bg-muted rounded-lg flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> Refresh
          </button>
          <a href="/agentbook/telegram" className="w-full block px-3 py-2 text-sm hover:bg-muted rounded-lg">
            Share to Telegram
          </a>
          {showTelegramHint && (
            <a href="/agentbook/telegram" className="block px-3 py-2 mt-1 text-xs text-primary bg-primary/5 rounded-lg">
              ☀️ Get a 7am summary — connect Telegram
            </a>
          )}
        </div>
      )}
    </div>
  );
};

export const DashboardPage: React.FC = () => {
  const { data, error, loading, refetch } = useDashboardOverview();
  const { items: activity, loading: actLoading, loadMore } = useDashboardActivity(10);
  const [summary, setSummary] = useState<AgentSummary | null>(null);

  // Pull-to-refresh (mobile)
  const startY = useRef<number | null>(null);
  const [pulling, setPulling] = useState(false);
  useEffect(() => {
    const onTouchStart = (e: TouchEvent) => {
      if (window.scrollY === 0) startY.current = e.touches[0].clientY;
    };
    const onTouchMove = (e: TouchEvent) => {
      if (startY.current == null) return;
      if (e.touches[0].clientY - startY.current > 80) setPulling(true);
    };
    const onTouchEnd = () => {
      if (pulling) refetch();
      startY.current = null;
      setPulling(false);
    };
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [pulling, refetch]);

  // Fetch agent summary once data is in
  useEffect(() => {
    if (!data) return;
    const overdueCount = data.attention.filter(a => a.id.startsWith('overdue:')).length;
    const overdueAmountCents = data.attention.filter(a => a.id.startsWith('overdue:')).reduce((s, a) => s + (a.amountCents || 0), 0);
    const taxItem = data.attention.find(a => a.id === 'tax');
    const taxDaysOut = taxItem ? data.nextMoments.find(m => m.kind === 'tax')?.daysOut ?? null : null;

    const params = new URLSearchParams({
      overdueCount: String(overdueCount),
      overdueAmountCents: String(overdueAmountCents),
      ...(taxDaysOut !== null ? { taxDaysOut: String(taxDaysOut) } : {}),
    });

    fetch(`/api/v1/agentbook-core/dashboard/agent-summary?${params}`)
      .then(r => r.json())
      .then(j => { if (j?.success) setSummary(j.data); })
      .catch(() => { /* fallback rendered by panel */ });
  }, [data]);

  const greeting = (() => {
    const h = new Date().getHours();
    if (h < 12) return 'Good morning';
    if (h < 18) return 'Good afternoon';
    return 'Good evening';
  })();

  if (error && !data) {
    return (
      <div className="px-4 py-6 max-w-7xl mx-auto">
        <header className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold">AgentBook</h1>
          <DesktopHeaderActions />
        </header>
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-center justify-between">
          <p className="text-sm text-red-700 dark:text-red-300">Couldn't reach AgentBook.</p>
          <button onClick={refetch} className="text-sm font-medium text-primary px-3 py-1.5 rounded-lg hover:bg-primary/10">Retry</button>
        </div>
        <QuickActionsBar />
      </div>
    );
  }

  // Brand-new tenant
  if (data?.isBrandNew) {
    return (
      <div className="px-4 py-6 max-w-7xl mx-auto pb-32 lg:pb-6">
        <header className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">{greeting}</h1>
          </div>
          <Kebab onRefresh={refetch} showTelegramHint={false} />
        </header>
        <OnboardingHero hasBank={false} hasInvoice={false} hasReceipt={false} />
        <QuickActionsBar />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 max-w-7xl mx-auto pb-32 lg:pb-6">
      {pulling && <div className="text-center text-sm text-muted-foreground mb-2">Refreshing…</div>}
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-foreground">{greeting}</h1>
        </div>
        <div className="flex items-center gap-2">
          <DesktopHeaderActions />
          {/* Hint always shown in V1; safe because tapping it routes to the
              telegram settings page where users can verify or disconnect. */}
          <Kebab onRefresh={refetch} showTelegramHint={true} />
        </div>
      </header>

      <div className="grid lg:grid-cols-3 gap-4 mb-4">
        <div className="lg:col-span-2">
          {loading || !data ? (
            <Skeleton className="h-48 sm:h-64" />
          ) : (
            <ForwardView cashTodayCents={data.cashToday} projection={data.projection} moments={data.nextMoments} />
          )}
        </div>
        <div>
          {loading || !data ? (
            <Skeleton className="h-48 sm:h-64" />
          ) : (
            <AttentionPanel items={data.attention} summary={summary} />
          )}
        </div>
      </div>

      {data && data.monthMtd && (
        <div className="mb-4">
          <ThisMonthStrip mtd={data.monthMtd} prev={data.monthPrev} />
        </div>
      )}

      <ActivityFeed items={activity} loading={actLoading} onLoadMore={loadMore} />

      <QuickActionsBar />
    </div>
  );
};
```

- [ ] **Step 2: Sanity-check that the build still resolves imports**

```bash
cd plugins/agentbook-core/frontend && npx vitest run --reporter=verbose 2>&1 | tail -30
```

Expected: tests we wrote pass; no new module-resolution errors.

- [ ] **Step 3: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/Dashboard.tsx
git commit -m "feat(dashboard): rewrite Dashboard.tsx — forward view, attention, this-month, activity"
```

---

## Task 16: Dashboard integration test

**Files:**
- Create: `plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/Dashboard.integration.test.tsx`

- [ ] **Step 1: Implement**

```tsx
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DashboardPage } from '../../Dashboard';

const happyOverview = {
  success: true,
  data: {
    cashToday: 1420000,
    projection: { days: Array.from({ length: 30 }, (_, i) => ({ date: '2026-05-' + String(i + 1).padStart(2, '0'), cents: 1500000 })), moodLabel: 'healthy' },
    nextMoments: [{ kind: 'income', label: '💰 Acme $4,500 in 7d', amountCents: 450000, daysOut: 7 }],
    attention: [{ id: 'overdue:i1', severity: 'critical', title: 'Acme · 32 days overdue', amountCents: 450000 }],
    recurringOutflows: [],
    monthMtd: { revenueCents: 1240000, expenseCents: 410000, netCents: 830000 },
    monthPrev: { revenueCents: 1078260, expenseCents: 422680, netCents: 680320 },
    isBrandNew: false,
  },
};
const happySummary = { success: true, data: { summary: 'One invoice overdue.', generatedAt: '', source: 'fallback' } };
const happyActivity = { success: true, data: [{ id: 'exp:1', kind: 'expense', label: '🧾 Uber', amountCents: -2800, date: new Date().toISOString() }] };

let fetchMock: any;

function installFetch(responses: Record<string, any | (() => any)>) {
  fetchMock = vi.fn().mockImplementation((url: string) => {
    for (const [pattern, body] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        const value = typeof body === 'function' ? body() : body;
        if (value === '500') return Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as any);
        return Promise.resolve({ ok: true, status: 200, json: async () => value } as any);
      }
    }
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as any);
  });
  globalThis.fetch = fetchMock;
}

describe('DashboardPage integration', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('happy path renders all sections', async () => {
    installFetch({
      '/dashboard/overview':       happyOverview,
      '/dashboard/agent-summary':  happySummary,
      '/dashboard/activity':       happyActivity,
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Acme/)).toBeInTheDocument());
    expect(screen.getByText(/This month/)).toBeInTheDocument();
    expect(screen.getByText(/Recent activity/)).toBeInTheDocument();
  });

  it('renders error banner when overview returns 500', async () => {
    installFetch({ '/dashboard/overview': '500' });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Couldn't reach AgentBook/)).toBeInTheDocument());
  });

  it('renders onboarding hero when brand new', async () => {
    installFetch({
      '/dashboard/overview': { ...happyOverview, data: { ...happyOverview.data, isBrandNew: true } },
      '/dashboard/agent-summary': happySummary,
      '/dashboard/activity': { success: true, data: [] },
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Welcome to AgentBook/)).toBeInTheDocument());
  });

  it('renders rest of page when projection slice is null (partial failure)', async () => {
    installFetch({
      '/dashboard/overview':       { ...happyOverview, data: { ...happyOverview.data, projection: null } },
      '/dashboard/agent-summary':  happySummary,
      '/dashboard/activity':       happyActivity,
    });
    render(<DashboardPage />);
    await waitFor(() => expect(screen.getByText(/Needs your attention/)).toBeInTheDocument());
    // ForwardView still mounts; it just renders an empty timeline + "No upcoming…" copy.
    expect(screen.getByText(/This month/)).toBeInTheDocument();
    expect(screen.getByText(/Recent activity/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd plugins/agentbook-core/frontend && npx vitest run src/pages/dashboard/__tests__/Dashboard.integration.test.tsx
```

Expected: 3 passing.

- [ ] **Step 3: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/dashboard/__tests__/Dashboard.integration.test.tsx
git commit -m "test(dashboard): integration tests — happy, 500 banner, onboarding"
```

---

## Task 17: Morning digest cron route

**Why:** Vercel Cron must hit a Next.js route. The cron runs hourly, and the handler iterates tenants, sends only when local hour is 7.

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook/cron/morning-digest/route.ts`

- [ ] **Step 1: Implement**

```ts
/**
 * Morning Digest Cron
 *
 * Vercel Cron schedule: hourly at minute 0 ("0 * * * *").
 * Iterates active tenants and sends a forward-looking summary at 7am
 * local time. Telegram if configured, else email via Resend, else no-op.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';

const CORE_BASE = process.env.AGENTBOOK_CORE_URL || 'http://localhost:4050';

interface OverviewData {
  cashToday: number;
  projection: { days: { date: string; cents: number }[] } | null;
  nextMoments: { label: string; daysOut: number }[];
  attention: { id: string; title: string; amountCents?: number }[];
}

async function fetchOverview(tenantId: string): Promise<OverviewData | null> {
  try {
    const r = await fetch(`${CORE_BASE}/api/v1/agentbook-core/dashboard/overview`, {
      headers: { 'x-tenant-id': tenantId },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data ?? null;
  } catch {
    return null;
  }
}

async function fetchSummary(tenantId: string, overdueCount: number, overdueAmt: number, taxDaysOut: number | null): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      overdueCount: String(overdueCount),
      overdueAmountCents: String(overdueAmt),
      ...(taxDaysOut !== null ? { taxDaysOut: String(taxDaysOut) } : {}),
    });
    const r = await fetch(`${CORE_BASE}/api/v1/agentbook-core/dashboard/agent-summary?${params}`, {
      headers: { 'x-tenant-id': tenantId },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data?.summary || null;
  } catch {
    return null;
  }
}

function fmt(cents: number): string {
  return '$' + Math.round(cents / 100).toLocaleString('en-US');
}

function composeMessage(name: string, overview: OverviewData, summary: string | null): string {
  const projectedEnd = overview.projection?.days.at(-1)?.cents ?? overview.cashToday;
  const endLabel = overview.projection?.days.at(-1)?.date
    ? new Date(overview.projection.days.at(-1)!.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
  return [
    `☀️ Good morning, ${name}. Cash ${fmt(overview.cashToday)} today, projected ${fmt(projectedEnd)} by ${endLabel}.`,
    summary ? `*Heads up:* ${summary}` : null,
    '/open to see the full dashboard.',
  ].filter(Boolean).join('\n');
}

async function sendTelegram(tenantId: string, message: string): Promise<boolean> {
  const bot = await db.abTelegramBot.findFirst({ where: { tenantId, enabled: true } });
  if (!bot) return false;
  const chats = Array.isArray(bot.chatIds) ? (bot.chatIds as string[]) : [];
  if (chats.length === 0) return false;
  for (const chatId of chats) {
    await fetch(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    }).catch(() => null);
  }
  return true;
}

async function sendEmail(userId: string, message: string): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) return false;
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.email) return false;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'AgentBook <noreply@agentbook.app>',
      to: user.email,
      subject: 'Your AgentBook morning summary',
      text: message,
    }),
  }).catch(() => null);
  return true;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = request.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tenants = await db.abTenantConfig.findMany({ where: { dailyDigestEnabled: true } });
  const now = new Date();
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const tenant of tenants) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tenant.timezone || 'America/New_York' });
      const localHour = parseInt(fmt.format(now), 10);
      if (localHour !== 7) { skipped++; continue; }

      const overview = await fetchOverview(tenant.userId);
      if (!overview) { errors++; continue; }

      const overdueItems = overview.attention.filter(a => a.id.startsWith('overdue:'));
      const overdueAmt = overdueItems.reduce((s, a) => s + (a.amountCents || 0), 0);
      const taxMoment = overview.nextMoments.find(m => m.label.startsWith('📋'));
      const taxDaysOut = taxMoment ? taxMoment.daysOut : null;

      const summary = await fetchSummary(tenant.userId, overdueItems.length, overdueAmt, taxDaysOut);
      const user = await db.user.findUnique({ where: { id: tenant.userId } });
      const name = user?.name || 'there';

      const message = composeMessage(name, overview, summary);
      const tgSent = await sendTelegram(tenant.userId, message);
      if (!tgSent) await sendEmail(tenant.userId, message);
      sent++;
    } catch (err) {
      console.error('[morning-digest] tenant error', tenant.userId, err);
      errors++;
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, errors, timestamp: new Date().toISOString() });
}
```

- [ ] **Step 2: Add cron entry to vercel.json**

In `vercel.json`, inside the `crons` array, add:

```json
{ "path": "/api/v1/agentbook/cron/morning-digest", "schedule": "0 * * * *" }
```

Place it after the existing `payment-reminders` entry.

- [ ] **Step 3: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/cron/morning-digest/route.ts vercel.json
git commit -m "feat(dashboard): morning digest cron with Telegram + email fallback"
```

---

## Task 18: E2E test (Playwright)

**Files:**
- Create: `tests/e2e/dashboard.spec.ts`

- [ ] **Step 1: Implement**

```ts
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000';

async function login(page: any, email: string, password: string) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook/);
}

test.describe('Dashboard — Maya happy path', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('forward view + attention + this-month + activity render; sticky bar visible', async ({ page }) => {
    await login(page, 'maya@agentbook.test', 'agentbook123');
    await page.goto(`${BASE}/agentbook`);

    // Forward view present (a $... → ~$... headline)
    await expect(page.locator('text=/\\$[\\d,]+\\s*(today)?/i').first()).toBeVisible({ timeout: 10_000 });

    // Attention panel header
    await expect(page.locator('text=/Needs your attention/i')).toBeVisible();

    // This-month strip
    await expect(page.locator('text=/This month/i')).toBeVisible();

    // Activity feed
    await expect(page.locator('text=/Recent activity/i')).toBeVisible();

    // Sticky bottom bar at mobile width
    await expect(page.locator('nav[aria-label="Quick actions"]')).toBeVisible();

    // New invoice button routes correctly
    await page.click('a:has-text("New invoice")');
    await page.waitForURL(/\/agentbook\/invoices\/new/);
  });
});

test.describe('Dashboard — empty tenant onboarding', () => {
  test('shows three-step onboarding when brand new', async ({ page }) => {
    // This test depends on a freshly-seeded test user with no expenses/invoices.
    // If the test environment doesn't seed one, mark this as skip rather than
    // leaving broken state behind.
    const fresh = process.env.E2E_FRESH_USER_EMAIL;
    const freshPw = process.env.E2E_FRESH_USER_PASSWORD;
    test.skip(!fresh || !freshPw, 'No fresh test user available — set E2E_FRESH_USER_EMAIL/PASSWORD');

    await login(page, fresh!, freshPw!);
    await page.goto(`${BASE}/agentbook`);
    await expect(page.locator('text=/Welcome to AgentBook/i')).toBeVisible();
    await expect(page.locator('text=/Link bank account/i')).toBeVisible();
    await expect(page.locator('text=/Add first invoice/i')).toBeVisible();
    await expect(page.locator('text=/Snap a receipt/i')).toBeVisible();
  });
});
```

- [ ] **Step 2: Run e2e against local dev (skip if no dev server up)**

```bash
cd tests/e2e && npx playwright test dashboard.spec.ts --project=chromium
```

Expected: Maya happy-path passes; empty-tenant skipped unless env set.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/dashboard.spec.ts
git commit -m "test(dashboard): Playwright e2e — Maya happy path + empty tenant"
```

---

## Task 19: Rebuild plugin frontend bundle and copy to CDN

**Why:** the agentbook-core plugin frontend is shipped as a UMD bundle from `dist/production/agentbook-core.js`, copied into `apps/web-next/public/cdn/plugins/agentbook-core/`. Production builds run this in `bin/vercel-build.sh`, but the change must be tested locally.

**Files:**
- (No code changes — build artifacts only.)

- [ ] **Step 1: Build the plugin**

```bash
cd plugins/agentbook-core/frontend && npm run build
```

Expected: emits `dist/production/agentbook-core.js`.

- [ ] **Step 2: Copy bundle into web-next CDN dir**

```bash
cp plugins/agentbook-core/frontend/dist/production/agentbook-core.js \
   apps/web-next/public/cdn/plugins/agentbook-core/agentbook-core.js
cp plugins/agentbook-core/frontend/dist/production/agentbook-core.js \
   apps/web-next/public/cdn/plugins/agentbook-core/1.0.0/agentbook-core.js
```

- [ ] **Step 3: Verify the bundle is non-empty and exports the plugin**

```bash
wc -c apps/web-next/public/cdn/plugins/agentbook-core/agentbook-core.js
grep -c 'NaapPluginAgentbookCore' apps/web-next/public/cdn/plugins/agentbook-core/agentbook-core.js
```

Expected: byte count > 50 KB; grep finds at least 1 occurrence.

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/public/cdn/plugins/agentbook-core/
git commit -m "chore(dashboard): rebuild agentbook-core UMD bundle"
```

---

## Task 20: Run the full test sweep + manual QA

**Files:** none modified — verification only.

- [ ] **Step 1: Vitest (frontend)**

```bash
cd plugins/agentbook-core/frontend && npx vitest run
```

Expected: all dashboard tests green.

- [ ] **Step 2: Vitest (backend)**

```bash
cd plugins/agentbook-core/backend && npx vitest run src/dashboard
```

Expected: all dashboard tests green.

- [ ] **Step 3: Manual QA (in dev)**

Start the stack per CLAUDE.md (postgres + 4 backends + web-next), log in as Maya. Verify in a browser:

- 375×812 viewport: header greeting, forward view, attention panel with summary, this-month strip, activity feed, sticky bottom bar with New Invoice / Snap / Ask, kebab menu opens with Refresh + Share to Telegram + connect-telegram hint.
- Tap Snap → camera prompt opens directly (not a routed page).
- Pull-to-refresh from the top fires a refetch (visible "Refreshing…" hint).
- 1280×800 viewport: header buttons render inline; two-column layout (forward 2/3, attention 1/3); sticky bar hidden.
- Light + dark theme look correct.
- Tab navigation reaches every interactive element.

- [ ] **Step 4: Final commit**

If any small adjustments came out of QA, commit them with a `chore(dashboard): QA fixes` message. Otherwise nothing to commit.

---

## Self-review checklist (run before opening PR)

- [ ] Spec §1–§16 each have a corresponding task above.
- [ ] No `TODO`, `TBD`, or "implement later" anywhere in this plan.
- [ ] Type names match: `AttentionItem` defined in Task 6 types is used identically by Tasks 10, 16, 17.
- [ ] All endpoints registered in `server.ts` are referenced by the same path in the frontend hooks.
- [ ] Mobile camera capture uses `capture="environment"` (Task 13).
- [ ] Onboarding hero is shown when `isBrandNew` (Tasks 14, 15).
- [ ] Cron entry is hourly (`0 * * * *`) and gates by local hour 7 (Task 17).
- [ ] No new Prisma tables added; only one column on `AbTenantConfig` (Task 0).
- [ ] No localStorage cache, no React error boundaries, no per-section retry — all simplified per the §10 spec edits.
