# AgentBook Billing Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the AgentBook billing plugin per the approved spec (`docs/superpowers/specs/2026-05-12-agentbook-billing-plugin-design.md`): admin defines subscription plans, users subscribe via Stripe Payment Element, other agentbook plugins gate features and meter usage via a shared `@naap/billing` library — all deployable to Vercel as Next.js route handlers.

**Architecture:** Eight phased PRs, each independently mergeable and tested. Phase 1 ships the schema. Phase 2 ships the library (consumable without UI). Phase 3 ships the Stripe wrapper + webhook (verifiable via webhook replay). Phases 4-5 ship admin surface. Phases 6-7 ship user surface. Phase 8 wires entitlement enforcement into the other agentbook plugins and runs the full E2E suite. Each phase keeps the product shippable (no half-built UI, no broken routes).

**Tech Stack:** TypeScript 5, Prisma (Postgres / Neon), Next.js 15 App Router on Vercel Fluid Compute, Stripe Node SDK + Stripe.js Payment Element, vitest, Playwright, Tailwind, React 19.

---

## Pre-flight (one-time setup, before Phase 1)

Run these once. If they're already done, skip.

- [ ] **Verify clean main**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull origin main && git status
```

Expected: working tree clean, on main, up to date with origin.

- [ ] **Confirm spec is committed**

```bash
ls docs/superpowers/specs/2026-05-12-agentbook-billing-plugin-design.md
git log --oneline -3 docs/superpowers/specs/2026-05-12-agentbook-billing-plugin-design.md
```

Expected: file exists; most recent commit is `docs: AgentBook billing plugin — design spec`.

- [ ] **Install Stripe Node SDK at repo root**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
npm install stripe@^17.0.0 --workspace=apps/web-next
```

Expected: `apps/web-next/package.json` gains `"stripe": "^17.0.0"` and `node_modules` updates.

- [ ] **Install Stripe.js for the frontend Payment Element**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
npm install @stripe/stripe-js@^4.0.0 @stripe/react-stripe-js@^3.0.0 --workspace=apps/web-next
```

Expected: both packages added.

- [ ] **Add three Vercel env vars in the dashboard (Development + Preview + Production scopes)**

```
STRIPE_SECRET_KEY=sk_test_...      (Production: sk_live_...)
STRIPE_WEBHOOK_SECRET=whsec_...    (one per environment endpoint)
STRIPE_PUBLISHABLE_KEY=pk_test_... (Production: pk_live_...)
ADMIN_EMAILS=admin@a3p.io          (comma-separated allowlist)
CRON_SECRET=<32-char random hex>   (used by cron route auth)
```

Test by pulling locally:

```bash
cd apps/web-next && vercel env pull .env.local
grep "STRIPE_" .env.local
```

Expected: three Stripe vars present in `.env.local`.

---

## Phase 1 — Database schema (PR 1)

**Goal:** Add the four billing models to the central Prisma schema and migrate. No code consumes them yet, but the migration runs cleanly and `npx prisma generate` succeeds.

**Branch:** `feat/billing-phase-1-schema`

**Files:**
- Modify: `packages/database/prisma/schema.prisma`
- Create: `packages/database/__tests__/billing-schema.test.ts`

### Task 1.1: Branch + schema models

- [ ] **Step 1: Create branch from clean main**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull origin main
git checkout -b feat/billing-phase-1-schema
```

Expected: on branch `feat/billing-phase-1-schema`.

- [ ] **Step 2: Add the new schema namespace to the datasource**

Locate line 27 in `packages/database/prisma/schema.prisma`:

```
schemas   = ["public", "plugin_community", "plugin_service_gateway", "plugin_agentbook_core", "plugin_agentbook_expense", "plugin_agentbook_invoice", "plugin_agentbook_tax"]
```

Change it to:

```
schemas   = ["public", "plugin_community", "plugin_service_gateway", "plugin_agentbook_core", "plugin_agentbook_expense", "plugin_agentbook_invoice", "plugin_agentbook_tax", "plugin_agentbook_billing"]
```

- [ ] **Step 3: Append the four models to `schema.prisma`**

At the end of `packages/database/prisma/schema.prisma`, append:

```prisma
// ─── AgentBook Billing Plugin ──────────────────────────────────────
// One plan per subscription tier. Soft-archived plans (isActive=false)
// cannot be subscribed to anew; existing subscriptions keep working.
model BillPlan {
  id              String   @id @default(uuid())
  code            String   @unique
  name            String
  description     String?
  priceCents      Int
  currency        String   @default("usd")
  interval        String   @default("month")
  stripeProductId String?
  stripePriceId   String?
  features        Json     // {telegram_bot: bool, tax_package_generation: bool, multi_user_teams: bool}
  quotas          Json     // {expenses_created: int, ocr_scans: int, ai_messages: int, invoices_sent: int, bank_connections: int} (-1 = unlimited)
  isActive        Boolean  @default(true)
  sortOrder       Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  subscriptions   BillSubscription[]

  @@schema("plugin_agentbook_billing")
}

// One row per billing account. v1: accountId always equals a tenantId.
// The rename sets up team billing (accountId = teamId) without a
// future schema migration; see resolveAccountId in @naap/billing.
model BillSubscription {
  id                   String    @id @default(uuid())
  accountId            String    @unique
  planId               String
  status               String    // 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete'
  stripeCustomerId     String?
  stripeSubscriptionId String?
  currentPeriodStart   DateTime?
  currentPeriodEnd     DateTime?
  cancelAtPeriodEnd    Boolean   @default(false)
  canceledAt           DateTime?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  plan                 BillPlan  @relation(fields: [planId], references: [id])

  @@index([status])
  @@schema("plugin_agentbook_billing")
}

// Per-(account, dimension, period) usage counter. Old period rows
// pruned weekly after 90 days.
model BillUsageCounter {
  id          String   @id @default(uuid())
  accountId   String
  dimension   String
  periodStart DateTime
  count       Int      @default(0)
  updatedAt   DateTime @updatedAt

  @@unique([accountId, dimension, periodStart])
  @@index([accountId])
  @@schema("plugin_agentbook_billing")
}

// Append-only Stripe webhook log. stripeEventId @unique gives free
// idempotency on Stripe's at-least-once delivery.
model BillEvent {
  id             String    @id @default(uuid())
  accountId      String?
  stripeEventId  String    @unique
  eventType      String
  payload        Json
  processedAt    DateTime?
  createdAt      DateTime  @default(now())

  @@index([eventType, createdAt])
  @@schema("plugin_agentbook_billing")
}
```

- [ ] **Step 4: Format Prisma schema**

```bash
cd packages/database
npx prisma format
```

Expected: no errors; file reformatted in place.

- [ ] **Step 5: Generate the Prisma client**

```bash
cd packages/database
npx prisma generate
```

Expected: `✔ Generated Prisma Client (v...)` with no errors. New types appear in `src/generated/client/`.

- [ ] **Step 6: Apply the schema to local DB**

```bash
cd packages/database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx prisma db push --skip-generate
```

Expected: `🚀 Your database is now in sync with your Prisma schema.` Four new tables created under `plugin_agentbook_billing` schema.

- [ ] **Step 7: Commit**

```bash
git add packages/database/prisma/schema.prisma packages/database/src/generated/
git commit -m "feat(billing): add BillPlan, BillSubscription, BillUsageCounter, BillEvent models

Introduces the plugin_agentbook_billing schema namespace and four
Prisma models per the billing plugin design spec. No consumer code
yet; future phases (library, routes, webhook) read and write these.

accountId (not tenantId) is used as the billing-account FK column to
allow future team billing without a schema migration."
```

### Task 1.2: Smoke test the new models

- [ ] **Step 1: Create the schema smoke test**

Create `packages/database/__tests__/billing-schema.test.ts`:

```ts
import { describe, expect, it, afterAll, beforeAll } from 'vitest';
import { PrismaClient } from '../src/generated/client/index.js';

const prisma = new PrismaClient();

describe('billing schema smoke', () => {
  const testAccountId = `test-${Date.now()}`;
  let planId: string;

  beforeAll(async () => {
    const plan = await prisma.billPlan.create({
      data: {
        code: `test-plan-${Date.now()}`,
        name: 'Test',
        priceCents: 0,
        features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
        quotas: { expenses_created: 10, ocr_scans: 1, ai_messages: 10, invoices_sent: 1, bank_connections: 0 },
      },
    });
    planId = plan.id;
  });

  afterAll(async () => {
    await prisma.billEvent.deleteMany({ where: { accountId: testAccountId } });
    await prisma.billUsageCounter.deleteMany({ where: { accountId: testAccountId } });
    await prisma.billSubscription.deleteMany({ where: { accountId: testAccountId } });
    await prisma.billPlan.delete({ where: { id: planId } });
    await prisma.$disconnect();
  });

  it('creates a subscription pointing at a plan', async () => {
    const sub = await prisma.billSubscription.create({
      data: { accountId: testAccountId, planId, status: 'active' },
    });
    expect(sub.accountId).toBe(testAccountId);
    expect(sub.cancelAtPeriodEnd).toBe(false);
  });

  it('enforces unique accountId on BillSubscription', async () => {
    await expect(
      prisma.billSubscription.create({
        data: { accountId: testAccountId, planId, status: 'active' },
      }),
    ).rejects.toThrow();
  });

  it('upserts BillUsageCounter on (accountId, dimension, periodStart)', async () => {
    const periodStart = new Date('2026-05-01');
    await prisma.billUsageCounter.upsert({
      where: { accountId_dimension_periodStart: { accountId: testAccountId, dimension: 'ocr_scans', periodStart } },
      create: { accountId: testAccountId, dimension: 'ocr_scans', periodStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    await prisma.billUsageCounter.upsert({
      where: { accountId_dimension_periodStart: { accountId: testAccountId, dimension: 'ocr_scans', periodStart } },
      create: { accountId: testAccountId, dimension: 'ocr_scans', periodStart, count: 1 },
      update: { count: { increment: 1 } },
    });
    const row = await prisma.billUsageCounter.findUnique({
      where: { accountId_dimension_periodStart: { accountId: testAccountId, dimension: 'ocr_scans', periodStart } },
    });
    expect(row?.count).toBe(2);
  });

  it('enforces unique stripeEventId on BillEvent', async () => {
    const eid = `evt_test_${Date.now()}`;
    await prisma.billEvent.create({
      data: { accountId: testAccountId, stripeEventId: eid, eventType: 'customer.subscription.updated', payload: {} },
    });
    await expect(
      prisma.billEvent.create({
        data: { accountId: testAccountId, stripeEventId: eid, eventType: 'customer.subscription.updated', payload: {} },
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the smoke test**

```bash
cd packages/database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx vitest run __tests__/billing-schema.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 3: Commit the test**

```bash
git add packages/database/__tests__/billing-schema.test.ts
git commit -m "test(billing): smoke test the four new Prisma models

Covers happy-path create + the three uniqueness constraints
(BillSubscription.accountId, BillEvent.stripeEventId, and the
BillUsageCounter composite unique). Guards against future schema
edits silently dropping constraints."
```

### Task 1.3: Push + PR + merge

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/billing-phase-1-schema
```

Expected: branch pushed; gh prints PR-creation hint.

- [ ] **Step 2: Open the PR (target qianghan/a3p:main)**

```bash
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-1-schema \
  --title "feat(billing): phase 1 — Prisma schema" \
  --body "Adds BillPlan, BillSubscription, BillUsageCounter, BillEvent under the new plugin_agentbook_billing schema. No consumer code yet; future phases (library, routes, webhook) build on this.

Test plan:
- [x] \`prisma generate\` succeeds
- [x] \`prisma db push\` applies cleanly on local Neon
- [x] 4 vitest smoke tests pass (uniqueness, upsert, FK)"
```

Expected: PR URL printed (e.g., `https://github.com/qianghan/a3p/pull/40`).

- [ ] **Step 3: Wait for CI, then merge**

```bash
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
```

Expected: all checks pass. Then:

```bash
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

Expected: PR shows MERGED; local main is fast-forwarded.

---

## Phase 2 — Shared `@naap/billing` library (PR 2)

**Goal:** Ship a usable `@naap/billing` workspace package with full vitest unit tests. No callers yet — Phase 8 wires consumers. The library can be imported and tested end-to-end against a local DB.

**Branch:** `feat/billing-phase-2-library`

**Files (all new):**
- `packages/billing/package.json`
- `packages/billing/tsconfig.json`
- `packages/billing/src/index.ts` — public re-exports
- `packages/billing/src/types.ts` — `FeatureFlag`, `UsageDimension`, `SubscriptionStatus`
- `packages/billing/src/account-resolver.ts` — `resolveAccountId`
- `packages/billing/src/cache.ts` — in-process 24h TTL cache
- `packages/billing/src/plans.ts` — `getCurrentPlan`
- `packages/billing/src/features.ts` — `canUseFeature`
- `packages/billing/src/quotas.ts` — `checkQuota`, `incrementUsage`, `getUsage`
- `packages/billing/__tests__/{cache,features,quotas,plans,account-resolver}.test.ts`

### Task 2.1: Package scaffolding

- [ ] **Step 1: Branch + package skeleton**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull
git checkout -b feat/billing-phase-2-library
mkdir -p packages/billing/src packages/billing/__tests__
```

- [ ] **Step 2: Create `packages/billing/package.json`**

```json
{
  "name": "@naap/billing",
  "version": "1.0.0",
  "description": "AgentBook billing — entitlement checks, quotas, plan resolution",
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "import": "./src/index.ts"
    }
  },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@naap/database": "*"
  },
  "devDependencies": {
    "vitest": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

- [ ] **Step 3: Create `packages/billing/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src/**/*", "__tests__/**/*"]
}
```

- [ ] **Step 4: Run the workspace bootstrap so npm links the new package**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
npm install
```

Expected: `@naap/billing` symlinked into top-level `node_modules`; no errors.

- [ ] **Step 5: Commit the skeleton**

```bash
git add packages/billing/package.json packages/billing/tsconfig.json package-lock.json
git commit -m "feat(billing): scaffold @naap/billing workspace package"
```

### Task 2.2: Types + account resolver (TDD)

- [ ] **Step 1: Write the failing test for `resolveAccountId`**

Create `packages/billing/__tests__/account-resolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveAccountId } from '../src/account-resolver.js';

describe('resolveAccountId', () => {
  it('returns the tenantId unchanged (v1 — one tenant per account)', async () => {
    const tenantId = 'tenant-abc';
    expect(await resolveAccountId(tenantId)).toBe(tenantId);
  });

  it('returns the same value on repeated calls', async () => {
    const tenantId = 'tenant-xyz';
    expect(await resolveAccountId(tenantId)).toBe(tenantId);
    expect(await resolveAccountId(tenantId)).toBe(tenantId);
  });
});
```

- [ ] **Step 2: Create `packages/billing/src/types.ts`**

```ts
export type FeatureFlag =
  | 'telegram_bot'
  | 'tax_package_generation'
  | 'multi_user_teams';

export type UsageDimension =
  | 'expenses_created'
  | 'ocr_scans'
  | 'ai_messages'
  | 'invoices_sent'
  | 'bank_connections';

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete';

export interface PlanFeatures {
  telegram_bot: boolean;
  tax_package_generation: boolean;
  multi_user_teams: boolean;
}

export interface PlanQuotas {
  expenses_created: number;
  ocr_scans: number;
  ai_messages: number;
  invoices_sent: number;
  bank_connections: number;
}
```

- [ ] **Step 3: Create `packages/billing/src/account-resolver.ts`**

```ts
/**
 * Resolve a tenantId to the billing accountId that owns its subscription.
 *
 * v1: every AgentBook user owns their own account, so accountId === tenantId.
 *
 * When team billing ships, this function will check a BillSeat table first:
 *   const seat = await db.billSeat.findFirst({ where: { tenantId } });
 *   return seat?.accountId ?? tenantId;
 *
 * Every public library function calls this so consumer plugins never see
 * the user-vs-team distinction.
 */
export async function resolveAccountId(tenantId: string): Promise<string> {
  return tenantId;
}
```

- [ ] **Step 4: Run the test**

```bash
cd packages/billing && npx vitest run __tests__/account-resolver.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/billing/src/types.ts packages/billing/src/account-resolver.ts packages/billing/__tests__/account-resolver.test.ts
git commit -m "feat(billing): resolveAccountId + shared types

v1 returns tenantId verbatim; comment documents the BillSeat lookup
swap that ships with team billing. Every public library function
goes through this indirection so consumers never see the distinction."
```

### Task 2.3: In-process cache (TDD)

- [ ] **Step 1: Write the failing cache tests**

Create `packages/billing/__tests__/cache.test.ts`:

```ts
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import { PlanCache, type CachedPlan } from '../src/cache.js';

const sample: CachedPlan = {
  planId: 'p1',
  code: 'pro',
  status: 'active',
  features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
  quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  currentPeriodStart: new Date('2026-05-01'),
  currentPeriodEnd: new Date('2026-06-01'),
  cancelAtPeriodEnd: false,
  cachedAt: Date.now(),
};

describe('PlanCache', () => {
  let cache: PlanCache;
  beforeEach(() => {
    cache = new PlanCache(60_000); // 1 min TTL for tests
  });

  it('returns null on miss', () => {
    expect(cache.get('account-1')).toBeNull();
  });

  it('returns the stored entry on hit', () => {
    cache.set('account-1', sample);
    expect(cache.get('account-1')).toEqual(sample);
  });

  it('returns null after TTL expiry', () => {
    vi.useFakeTimers();
    cache.set('account-1', sample);
    vi.advanceTimersByTime(60_001);
    expect(cache.get('account-1')).toBeNull();
    vi.useRealTimers();
  });

  it('invalidate() removes the entry', () => {
    cache.set('account-1', sample);
    cache.invalidate('account-1');
    expect(cache.get('account-1')).toBeNull();
  });

  it('clear() empties the cache', () => {
    cache.set('a', sample);
    cache.set('b', sample);
    cache.clear();
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBeNull();
  });
});
```

- [ ] **Step 2: Create `packages/billing/src/cache.ts`**

```ts
import type { PlanFeatures, PlanQuotas, SubscriptionStatus } from './types.js';

export interface CachedPlan {
  planId: string;
  code: string;
  status: SubscriptionStatus;
  features: PlanFeatures;
  quotas: PlanQuotas;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  cachedAt: number;
}

export class PlanCache {
  private store = new Map<string, CachedPlan>();
  constructor(private readonly ttlMs: number = 24 * 60 * 60 * 1000) {}

  get(accountId: string): CachedPlan | null {
    const entry = this.store.get(accountId);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > this.ttlMs) {
      this.store.delete(accountId);
      return null;
    }
    return entry;
  }

  set(accountId: string, entry: CachedPlan): void {
    this.store.set(accountId, entry);
  }

  invalidate(accountId: string): void {
    this.store.delete(accountId);
  }

  clear(): void {
    this.store.clear();
  }
}

// Singleton used across the process. Different Vercel Function instances
// have separate caches — staleness window is bounded by TTL + the
// webhook-driven invalidate() round-trip.
export const planCache = new PlanCache();
```

- [ ] **Step 3: Run the cache tests**

```bash
cd packages/billing && npx vitest run __tests__/cache.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/billing/src/cache.ts packages/billing/__tests__/cache.test.ts
git commit -m "feat(billing): in-process 24h plan cache

PlanCache stores resolved (plan + status + features + quotas) per
accountId. TTL bound keeps memory steady; invalidate() is called
from the Stripe webhook handler when a subscription changes."
```

### Task 2.4: `getCurrentPlan` (TDD)

- [ ] **Step 1: Write the failing plans test**

Create `packages/billing/__tests__/plans.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const findFirst = vi.fn();
const findMany = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: { findUnique: (...a: unknown[]) => findUnique(...a) },
    billPlan: { findFirst: (...a: unknown[]) => findFirst(...a) },
    billUsageCounter: { findMany: (...a: unknown[]) => findMany(...a) },
  },
}));

import { getCurrentPlan, _resetCacheForTests } from '../src/plans.js';

const freePlan = {
  id: 'plan-free', code: 'free', name: 'Free', priceCents: 0,
  features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
  quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
};

const proPlan = {
  id: 'plan-pro', code: 'pro', name: 'Pro', priceCents: 1900,
  features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
  quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
};

beforeEach(() => {
  findUnique.mockReset();
  findFirst.mockReset();
  findMany.mockReset();
  _resetCacheForTests();
});

describe('getCurrentPlan', () => {
  it('returns the Free fallback when no subscription exists', async () => {
    findUnique.mockResolvedValue(null);
    findFirst.mockResolvedValue(freePlan);
    findMany.mockResolvedValue([]);
    const r = await getCurrentPlan('account-1');
    expect(r.plan.code).toBe('free');
    expect(r.status).toBe('active');
    expect(r.usage.ocr_scans.used).toBe(0);
  });

  it('returns the Pro plan when subscription is active', async () => {
    findUnique.mockResolvedValue({
      planId: 'plan-pro', status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      cancelAtPeriodEnd: false, plan: proPlan,
    });
    findMany.mockResolvedValue([{ dimension: 'ocr_scans', count: 47 }]);
    const r = await getCurrentPlan('account-1');
    expect(r.plan.code).toBe('pro');
    expect(r.usage.ocr_scans.used).toBe(47);
    expect(r.usage.ocr_scans.limit).toBe(200);
  });

  it('hits cache on second call', async () => {
    findUnique.mockResolvedValue({
      planId: 'plan-pro', status: 'active', currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 30 * 86400_000),
      cancelAtPeriodEnd: false, plan: proPlan,
    });
    findMany.mockResolvedValue([]);
    await getCurrentPlan('account-1');
    await getCurrentPlan('account-1');
    expect(findUnique).toHaveBeenCalledTimes(1);
  });

  it('fails open on DB error — returns synthetic Free plan, logs warning', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await getCurrentPlan('account-1');
    expect(r.plan.code).toBe('free');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Create `packages/billing/src/plans.ts`**

```ts
import { prisma } from '@naap/database';
import { planCache, type CachedPlan } from './cache.js';
import { resolveAccountId } from './account-resolver.js';
import type { PlanFeatures, PlanQuotas, SubscriptionStatus, UsageDimension } from './types.js';

const ALL_DIMS: UsageDimension[] = [
  'expenses_created', 'ocr_scans', 'ai_messages', 'invoices_sent', 'bank_connections',
];

const SYNTHETIC_FREE: CachedPlan = {
  planId: 'synthetic-free',
  code: 'free',
  status: 'active',
  features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
  quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
  currentPeriodStart: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  cachedAt: 0,
};

export interface CurrentPlan {
  plan: { id: string; code: string; name: string; priceCents: number; features: PlanFeatures; quotas: PlanQuotas };
  status: SubscriptionStatus;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  usage: Record<UsageDimension, { used: number; limit: number }>;
}

export function _resetCacheForTests(): void {
  planCache.clear();
}

async function loadCachedPlan(accountId: string): Promise<CachedPlan> {
  const hit = planCache.get(accountId);
  if (hit) return hit;
  try {
    const sub = await prisma.billSubscription.findUnique({
      where: { accountId },
      include: { plan: true },
    });
    if (!sub) {
      const free = await prisma.billPlan.findFirst({ where: { code: 'free', isActive: true } });
      const entry: CachedPlan = free
        ? {
            planId: free.id,
            code: free.code,
            status: 'active',
            features: free.features as unknown as PlanFeatures,
            quotas: free.quotas as unknown as PlanQuotas,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
            cachedAt: Date.now(),
          }
        : { ...SYNTHETIC_FREE, cachedAt: Date.now() };
      planCache.set(accountId, entry);
      return entry;
    }
    const entry: CachedPlan = {
      planId: sub.plan.id,
      code: sub.plan.code,
      status: sub.status as SubscriptionStatus,
      features: sub.plan.features as unknown as PlanFeatures,
      quotas: sub.plan.quotas as unknown as PlanQuotas,
      currentPeriodStart: sub.currentPeriodStart,
      currentPeriodEnd: sub.currentPeriodEnd,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      cachedAt: Date.now(),
    };
    planCache.set(accountId, entry);
    return entry;
  } catch (err) {
    console.warn('[billing] loadCachedPlan failed, falling back to free:', err);
    return { ...SYNTHETIC_FREE, cachedAt: Date.now() };
  }
}

async function loadUsage(accountId: string, periodStart: Date | null): Promise<Record<UsageDimension, number>> {
  const usage: Record<UsageDimension, number> = {
    expenses_created: 0, ocr_scans: 0, ai_messages: 0, invoices_sent: 0, bank_connections: 0,
  };
  if (!periodStart) return usage;
  try {
    const rows = await prisma.billUsageCounter.findMany({
      where: { accountId, periodStart },
    });
    for (const r of rows) {
      if ((ALL_DIMS as string[]).includes(r.dimension)) {
        usage[r.dimension as UsageDimension] = r.count;
      }
    }
  } catch (err) {
    console.warn('[billing] loadUsage failed (returning zeros):', err);
  }
  return usage;
}

export async function getCurrentPlan(tenantId: string): Promise<CurrentPlan> {
  const accountId = await resolveAccountId(tenantId);
  const cached = await loadCachedPlan(accountId);
  const counts = await loadUsage(accountId, cached.currentPeriodStart);

  const usage: CurrentPlan['usage'] = {
    expenses_created: { used: counts.expenses_created, limit: cached.quotas.expenses_created },
    ocr_scans: { used: counts.ocr_scans, limit: cached.quotas.ocr_scans },
    ai_messages: { used: counts.ai_messages, limit: cached.quotas.ai_messages },
    invoices_sent: { used: counts.invoices_sent, limit: cached.quotas.invoices_sent },
    bank_connections: { used: counts.bank_connections, limit: cached.quotas.bank_connections },
  };

  return {
    plan: { id: cached.planId, code: cached.code, name: cached.code, priceCents: 0, features: cached.features, quotas: cached.quotas },
    status: cached.status,
    periodEnd: cached.currentPeriodEnd,
    cancelAtPeriodEnd: cached.cancelAtPeriodEnd,
    usage,
  };
}
```

- [ ] **Step 3: Run the plans tests**

```bash
cd packages/billing && npx vitest run __tests__/plans.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/billing/src/plans.ts packages/billing/__tests__/plans.test.ts
git commit -m "feat(billing): getCurrentPlan with cache + DB fail-open

Reads BillSubscription + plan, merges with BillUsageCounter rows
for the current period. Cache miss does one Prisma query; cache hit
skips it. DB error returns a synthetic Free plan so the bot keeps
working through transient infra blips."
```

### Task 2.5: `canUseFeature` (TDD)

- [ ] **Step 1: Write the failing features test**

Create `packages/billing/__tests__/features.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: { findUnique: (...a: unknown[]) => findUnique(...a) },
    billPlan: { findFirst: vi.fn().mockResolvedValue(null) },
    billUsageCounter: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { canUseFeature } from '../src/features.js';
import { _resetCacheForTests } from '../src/plans.js';

beforeEach(() => {
  findUnique.mockReset();
  _resetCacheForTests();
});

describe('canUseFeature', () => {
  it('returns true when feature flag is true', async () => {
    findUnique.mockResolvedValue({
      planId: 'p', status: 'active', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      plan: { id: 'p', code: 'pro', features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false }, quotas: {expenses_created:0,ocr_scans:0,ai_messages:0,invoices_sent:0,bank_connections:0} },
    });
    expect(await canUseFeature('t1', 'telegram_bot')).toBe(true);
    expect(await canUseFeature('t1', 'multi_user_teams')).toBe(false);
  });

  it('past_due is treated as still allowed (Stripe handles 7-day dunning)', async () => {
    findUnique.mockResolvedValue({
      planId: 'p', status: 'past_due', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      plan: { id: 'p', code: 'pro', features: { telegram_bot: true, tax_package_generation: false, multi_user_teams: false }, quotas: {expenses_created:0,ocr_scans:0,ai_messages:0,invoices_sent:0,bank_connections:0} },
    });
    expect(await canUseFeature('t1', 'telegram_bot')).toBe(true);
  });

  it('canceled status falls back to Free plan features', async () => {
    findUnique.mockResolvedValue({
      planId: 'p', status: 'canceled', currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      plan: { id: 'p', code: 'pro', features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false }, quotas: {expenses_created:0,ocr_scans:0,ai_messages:0,invoices_sent:0,bank_connections:0} },
    });
    expect(await canUseFeature('t1', 'telegram_bot')).toBe(false);
  });

  it('fails open on DB error', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await canUseFeature('t1', 'telegram_bot')).toBe(true);
    warn.mockRestore();
  });
});
```

- [ ] **Step 2: Create `packages/billing/src/features.ts`**

```ts
import type { FeatureFlag } from './types.js';
import { getCurrentPlan } from './plans.js';

/**
 * Hot-path entitlement check. < 1ms on cache hit.
 *
 * Status handling:
 *   • active / trialing — grant if feature flag is true
 *   • past_due — still granted (Stripe runs a 7-day dunning grace
 *     during which we keep features lit so the user can retry payment)
 *   • canceled / incomplete — degrade to Free features (telegram_bot,
 *     tax_package_generation, multi_user_teams all false by design)
 *
 * Fails open on errors: returns true. Better to grant access than to
 * brick the Telegram bot for everyone on a transient DB blip.
 */
export async function canUseFeature(tenantId: string, feature: FeatureFlag): Promise<boolean> {
  try {
    const cur = await getCurrentPlan(tenantId);
    if (cur.status === 'canceled' || cur.status === 'incomplete') return false;
    return cur.plan.features[feature] === true;
  } catch (err) {
    console.warn('[billing] canUseFeature failed open:', err);
    return true;
  }
}
```

- [ ] **Step 3: Run the features tests**

```bash
cd packages/billing && npx vitest run __tests__/features.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/billing/src/features.ts packages/billing/__tests__/features.test.ts
git commit -m "feat(billing): canUseFeature with status grace + fail-open

past_due grants access (Stripe's 7-day dunning grace); canceled
degrades to no premium features. DB errors fail open so transient
infra problems never wall off the bot."
```

### Task 2.6: `checkQuota`, `incrementUsage`, `getUsage` (TDD)

- [ ] **Step 1: Write the failing quotas test**

Create `packages/billing/__tests__/quotas.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const findMany = vi.fn();
const upsert = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: { findUnique: (...a: unknown[]) => findUnique(...a) },
    billPlan: { findFirst: vi.fn().mockResolvedValue(null) },
    billUsageCounter: {
      findMany: (...a: unknown[]) => findMany(...a),
      upsert: (...a: unknown[]) => upsert(...a),
    },
  },
}));

import { checkQuota, incrementUsage, getUsage } from '../src/quotas.js';
import { _resetCacheForTests } from '../src/plans.js';

const proSub = {
  planId: 'p', status: 'active',
  currentPeriodStart: new Date('2026-05-01'),
  currentPeriodEnd: new Date('2026-06-01'),
  cancelAtPeriodEnd: false,
  plan: {
    id: 'p', code: 'pro',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 10, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
};

beforeEach(() => {
  findUnique.mockReset(); findMany.mockReset(); upsert.mockReset();
  _resetCacheForTests();
});

describe('checkQuota', () => {
  it('allowed when used < limit', async () => {
    findUnique.mockResolvedValue(proSub);
    findMany.mockResolvedValue([{ dimension: 'ocr_scans', count: 3 }]);
    const q = await checkQuota('t1', 'ocr_scans');
    expect(q).toEqual({ allowed: true, used: 3, limit: 10, remaining: 7 });
  });

  it('blocked when used >= limit', async () => {
    findUnique.mockResolvedValue(proSub);
    findMany.mockResolvedValue([{ dimension: 'ocr_scans', count: 10 }]);
    const q = await checkQuota('t1', 'ocr_scans');
    expect(q.allowed).toBe(false);
    expect(q.remaining).toBe(0);
  });

  it('unlimited when limit === -1', async () => {
    findUnique.mockResolvedValue({ ...proSub, plan: { ...proSub.plan, quotas: { ...proSub.plan.quotas, ocr_scans: -1 } } });
    findMany.mockResolvedValue([{ dimension: 'ocr_scans', count: 9999 }]);
    const q = await checkQuota('t1', 'ocr_scans');
    expect(q.allowed).toBe(true);
    expect(q.limit).toBe(-1);
    expect(q.remaining).toBe(Number.POSITIVE_INFINITY);
  });

  it('fails open on DB error', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const q = await checkQuota('t1', 'ocr_scans');
    expect(q.allowed).toBe(true);
    warn.mockRestore();
  });
});

describe('incrementUsage', () => {
  it('upserts and increments by n', async () => {
    findUnique.mockResolvedValue(proSub);
    findMany.mockResolvedValue([]);
    upsert.mockResolvedValue({});
    await incrementUsage('t1', 'ocr_scans', 3);
    expect(upsert).toHaveBeenCalledTimes(1);
    const call = upsert.mock.calls[0][0];
    expect(call.update.count.increment).toBe(3);
    expect(call.create.count).toBe(3);
  });

  it('swallows errors silently', async () => {
    findUnique.mockResolvedValue(proSub);
    findMany.mockResolvedValue([]);
    upsert.mockRejectedValue(new Error('db down'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(incrementUsage('t1', 'ocr_scans')).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('no-ops when subscription has no currentPeriodStart (Free + never used)', async () => {
    findUnique.mockResolvedValue({ ...proSub, currentPeriodStart: null });
    findMany.mockResolvedValue([]);
    upsert.mockResolvedValue({});
    await incrementUsage('t1', 'ocr_scans');
    expect(upsert).toHaveBeenCalledTimes(1); // uses periodStart=startOfMonth fallback
  });
});

describe('getUsage', () => {
  it('returns used count for a dimension', async () => {
    findUnique.mockResolvedValue(proSub);
    findMany.mockResolvedValue([{ dimension: 'ocr_scans', count: 5 }]);
    expect(await getUsage('t1', 'ocr_scans')).toBe(5);
  });
});
```

- [ ] **Step 2: Create `packages/billing/src/quotas.ts`**

```ts
import { prisma } from '@naap/database';
import { resolveAccountId } from './account-resolver.js';
import { getCurrentPlan } from './plans.js';
import type { UsageDimension } from './types.js';

export interface QuotaCheck {
  allowed: boolean;
  used: number;
  limit: number;     // -1 = unlimited
  remaining: number; // Infinity when unlimited
}

function periodStartOf(d: Date | null): Date {
  if (d) return d;
  // Free tier with no current period: bucket by calendar month start UTC
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function checkQuota(tenantId: string, dim: UsageDimension): Promise<QuotaCheck> {
  try {
    const cur = await getCurrentPlan(tenantId);
    const limit = cur.plan.quotas[dim];
    const used = cur.usage[dim].used;
    if (limit === -1) {
      return { allowed: true, used, limit: -1, remaining: Number.POSITIVE_INFINITY };
    }
    return { allowed: used < limit, used, limit, remaining: Math.max(0, limit - used) };
  } catch (err) {
    console.warn('[billing] checkQuota failed open:', err);
    return { allowed: true, used: 0, limit: -1, remaining: Number.POSITIVE_INFINITY };
  }
}

export async function incrementUsage(tenantId: string, dim: UsageDimension, n: number = 1): Promise<void> {
  try {
    const accountId = await resolveAccountId(tenantId);
    const cur = await getCurrentPlan(tenantId);
    const periodStart = periodStartOf(cur.periodEnd ? new Date(cur.periodEnd.getTime() - 30 * 86400_000) : null);
    await prisma.billUsageCounter.upsert({
      where: { accountId_dimension_periodStart: { accountId, dimension: dim, periodStart } },
      create: { accountId, dimension: dim, periodStart, count: n },
      update: { count: { increment: n } },
    });
  } catch (err) {
    console.warn('[billing] incrementUsage swallowed error:', err);
  }
}

export async function getUsage(tenantId: string, dim: UsageDimension): Promise<number> {
  try {
    const cur = await getCurrentPlan(tenantId);
    return cur.usage[dim].used;
  } catch (err) {
    console.warn('[billing] getUsage failed:', err);
    return 0;
  }
}
```

- [ ] **Step 3: Run + commit**

```bash
cd packages/billing && npx vitest run __tests__/quotas.test.ts
```

Expected: 8 tests pass. Then:

```bash
git add packages/billing/src/quotas.ts packages/billing/__tests__/quotas.test.ts
git commit -m "feat(billing): checkQuota + incrementUsage + getUsage

checkQuota: -1 = unlimited (Infinity remaining); allowed when used<limit.
incrementUsage: best-effort upsert; swallows errors (Stripe is billing
source of truth, not these counters).
getUsage: simple read of the current period's count for a dimension."
```

### Task 2.7: Public index + invalidate hook

- [ ] **Step 1: Create `packages/billing/src/index.ts`**

```ts
export type {
  FeatureFlag,
  UsageDimension,
  SubscriptionStatus,
  PlanFeatures,
  PlanQuotas,
} from './types.js';

export { resolveAccountId } from './account-resolver.js';
export { planCache, type CachedPlan } from './cache.js';
export { getCurrentPlan, type CurrentPlan } from './plans.js';
export { canUseFeature } from './features.js';
export { checkQuota, incrementUsage, getUsage, type QuotaCheck } from './quotas.js';

/**
 * Webhook hook — call this from the Stripe webhook handler whenever
 * a subscription is created/updated/deleted so the next entitlement
 * check refreshes from the DB rather than returning a stale cache value.
 */
export function invalidateAccount(accountId: string): void {
  // Imported above; planCache is the singleton instance.
  // Local re-import to keep this function purely a re-export hook:
  //   import { planCache } from '@naap/billing'; planCache.invalidate(id);
  // Provided here for callers that want a one-line API.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { planCache } = require('./cache.js') as typeof import('./cache.js');
  planCache.invalidate(accountId);
}
```

- [ ] **Step 2: Run all library tests together**

```bash
cd packages/billing && npx vitest run
```

Expected: ~23 tests across 5 files, all pass.

- [ ] **Step 3: Commit + push branch**

```bash
git add packages/billing/src/index.ts
git commit -m "feat(billing): public API surface — @naap/billing index"
git push -u origin feat/billing-phase-2-library
```

### Task 2.8: PR + merge

- [ ] **Step 1: Open PR**

```bash
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-2-library \
  --title "feat(billing): phase 2 — @naap/billing library" \
  --body "Ships the shared library that other agentbook plugins (and the Telegram webhook) will import for entitlement checks and metering.

Public API:
- canUseFeature(tenantId, feature) — < 1ms cache-hit, fails open
- checkQuota(tenantId, dim) — used/limit/remaining; -1 = unlimited
- incrementUsage(tenantId, dim, n?) — best-effort upsert
- getCurrentPlan(tenantId) — plan + status + usage for /billing page
- invalidateAccount(accountId) — webhook hook to refresh cache
- resolveAccountId(tenantId) — future-proofs for team billing

Behavior:
- 24h in-process cache; webhook-driven invalidation
- Fail-open on hot-path reads (canUseFeature, checkQuota)
- Errors swallowed on incrementUsage (best-effort by design)
- Free fallback when no subscription row exists

Test plan:
- [x] 23 vitest unit tests pass
- [x] No production callers yet (wired in Phase 8)"
```

- [ ] **Step 2: Wait for CI + merge**

```bash
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

---

## Phase 3 — Stripe wrapper + webhook handler (PR 3)

**Goal:** Add a thin Stripe SDK wrapper and the webhook receiver. The webhook is wired but unreachable in production yet (no plans exist in Stripe). Idempotency, signature verification, and event handling are fully tested.

**Branch:** `feat/billing-phase-3-stripe-webhook`

**Files:**
- Create: `apps/web-next/src/lib/billing/stripe.ts` — SDK wrapper, env-aware
- Create: `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/route.ts` — webhook handler
- Create: `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts` — per-event-type appliers (separated for testability)
- Create: `apps/web-next/__tests__/api/v1/agentbook/stripe-webhook.test.ts`

### Task 3.1: Stripe wrapper

- [ ] **Step 1: Branch**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull
git checkout -b feat/billing-phase-3-stripe-webhook
mkdir -p apps/web-next/src/lib/billing
mkdir -p apps/web-next/src/app/api/v1/agentbook/stripe-webhook
```

- [ ] **Step 2: Create `apps/web-next/src/lib/billing/stripe.ts`**

```ts
import 'server-only';
import Stripe from 'stripe';

/**
 * Single Stripe SDK instance per Vercel Function. Reads the key once
 * at module load. Test mode (sk_test_*) outside production; live mode
 * (sk_live_*) only when VERCEL_ENV === 'production'.
 *
 * Tests use mockStripe() from this module to swap the export.
 */
let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('[billing] STRIPE_SECRET_KEY not set');
  const isProd = process.env.VERCEL_ENV === 'production';
  if (isProd && !key.startsWith('sk_live_')) {
    throw new Error('[billing] production env must use sk_live_* key');
  }
  if (!isProd && !key.startsWith('sk_test_')) {
    console.warn('[billing] non-production env should use sk_test_* key');
  }
  _stripe = new Stripe(key, { apiVersion: '2024-11-20.acacia' });
  return _stripe;
}

export function _resetStripeForTests(): void {
  _stripe = null;
}

export function _setStripeForTests(s: Stripe): void {
  _stripe = s;
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-next/src/lib/billing/stripe.ts
git commit -m "feat(billing): Stripe SDK wrapper with env guardrails

Single Stripe instance per Function, env-aware key validation
(prod requires sk_live_*, non-prod requires sk_test_*). Test
helpers _resetStripeForTests / _setStripeForTests allow mocking
the SDK without monkey-patching the import."
```

### Task 3.2: Webhook handler skeleton + signature verification

- [ ] **Step 1: Write the failing webhook test**

Create `apps/web-next/__tests__/api/v1/agentbook/stripe-webhook.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const constructEvent = vi.fn();
const billEventCreate = vi.fn();
const billSubscriptionUpsert = vi.fn();
const billSubscriptionUpdate = vi.fn();
const billPlanFindFirst = vi.fn();
const planCacheInvalidate = vi.fn();

vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    webhooks: { constructEvent: (...a: unknown[]) => constructEvent(...a) },
  }),
}));

vi.mock('@naap/database', () => ({
  prisma: {
    billEvent: { create: (...a: unknown[]) => billEventCreate(...a) },
    billSubscription: {
      upsert: (...a: unknown[]) => billSubscriptionUpsert(...a),
      update: (...a: unknown[]) => billSubscriptionUpdate(...a),
    },
    billPlan: { findFirst: (...a: unknown[]) => billPlanFindFirst(...a) },
  },
}));

vi.mock('@naap/billing', () => ({
  invalidateAccount: (id: string) => planCacheInvalidate(id),
}));

import { POST } from '@/app/api/v1/agentbook/stripe-webhook/route';

beforeEach(() => {
  constructEvent.mockReset();
  billEventCreate.mockReset();
  billSubscriptionUpsert.mockReset();
  billSubscriptionUpdate.mockReset();
  billPlanFindFirst.mockReset();
  planCacheInvalidate.mockReset();
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

afterEach(() => { delete process.env.STRIPE_WEBHOOK_SECRET; });

function req(body: string, sig: string | null): NextRequest {
  const headers = new Headers();
  if (sig) headers.set('stripe-signature', sig);
  return new NextRequest('http://x/api/v1/agentbook/stripe-webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('Stripe webhook', () => {
  it('returns 400 when signature header is missing', async () => {
    const r = await POST(req('{}', null));
    expect(r.status).toBe(400);
  });

  it('returns 400 when signature is invalid', async () => {
    constructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(400);
  });

  it('returns 200 + idempotent on duplicate event', async () => {
    constructEvent.mockReturnValue({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });
    billEventCreate.mockRejectedValue(Object.assign(new Error('Unique'), { code: 'P2002' }));
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billSubscriptionUpsert).not.toHaveBeenCalled();
  });

  it('applies customer.subscription.updated → upsert', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_2',
      type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_x',
        customer: 'cus_x',
        status: 'active',
        items: { data: [{ price: { id: 'price_pro' } }] },
        current_period_start: 1700000000,
        current_period_end: 1702592000,
        cancel_at_period_end: false,
        metadata: { tenantId: 't1' },
      } },
    });
    billEventCreate.mockResolvedValue({});
    billPlanFindFirst.mockResolvedValue({ id: 'plan-pro' });
    billSubscriptionUpsert.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billSubscriptionUpsert).toHaveBeenCalledTimes(1);
    expect(planCacheInvalidate).toHaveBeenCalledWith('t1');
  });

  it('applies customer.subscription.deleted → status canceled', async () => {
    constructEvent.mockReturnValue({
      id: 'evt_3',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_x', customer: 'cus_x', metadata: { tenantId: 't1' } } },
    });
    billEventCreate.mockResolvedValue({});
    billSubscriptionUpdate.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billSubscriptionUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'canceled' }),
    }));
  });

  it('ignores unknown event types but still records BillEvent', async () => {
    constructEvent.mockReturnValue({ id: 'evt_4', type: 'random.thing', data: { object: {} } });
    billEventCreate.mockResolvedValue({});
    const r = await POST(req('{}', 'sig'));
    expect(r.status).toBe(200);
    expect(billSubscriptionUpsert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Create `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts`**

```ts
import 'server-only';
import { prisma } from '@naap/database';
import { invalidateAccount } from '@naap/billing';
import type Stripe from 'stripe';

export async function applyEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) {
        console.warn('[stripe-webhook] subscription missing tenantId metadata, skipping');
        return;
      }
      const priceId = sub.items.data[0]?.price.id;
      const plan = priceId ? await prisma.billPlan.findFirst({ where: { stripePriceId: priceId } }) : null;
      if (!plan) {
        console.error('[stripe-webhook] plan not found for stripePriceId', priceId);
        return;
      }
      await prisma.billSubscription.upsert({
        where: { accountId: tenantId },
        create: {
          accountId: tenantId,
          planId: plan.id,
          status: sub.status,
          stripeCustomerId: typeof sub.customer === 'string' ? sub.customer : sub.customer.id,
          stripeSubscriptionId: sub.id,
          currentPeriodStart: new Date(sub.current_period_start * 1000),
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        },
        update: {
          planId: plan.id,
          status: sub.status,
          stripeSubscriptionId: sub.id,
          currentPeriodStart: new Date(sub.current_period_start * 1000),
          currentPeriodEnd: new Date(sub.current_period_end * 1000),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        },
      });
      invalidateAccount(tenantId);
      break;
    }
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) return;
      await prisma.billSubscription.update({
        where: { accountId: tenantId },
        data: { status: 'canceled', canceledAt: new Date() },
      });
      invalidateAccount(tenantId);
      break;
    }
    case 'invoice.paid':
    case 'invoice.payment_failed':
      // No DB writes here; the matching customer.subscription.updated
      // event flips status. We log for observability.
      console.log('[stripe-webhook]', event.type, 'recorded');
      break;
    default:
      // Unknown event type — still recorded in BillEvent for replay.
      break;
  }
}
```

- [ ] **Step 3: Create `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/billing/stripe';
import { prisma } from '@naap/database';
import { applyEvent } from './handlers';

// Stripe webhooks must run on Node runtime (raw body + signature verify)
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const sig = request.headers.get('stripe-signature');
  if (!sig) return NextResponse.json({ error: 'missing signature' }, { status: 400 });

  const rawBody = await request.text();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return NextResponse.json({ error: 'webhook secret not configured' }, { status: 500 });

  let event;
  try {
    event = getStripe().webhooks.constructEvent(rawBody, sig, secret);
  } catch (err) {
    console.warn('[stripe-webhook] signature verification failed:', err);
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  // Idempotency: try to insert BillEvent. If P2002 (unique violation),
  // we've already processed this event — short-circuit success.
  try {
    await prisma.billEvent.create({
      data: {
        accountId: (event.data.object as { metadata?: { tenantId?: string } })?.metadata?.tenantId ?? null,
        stripeEventId: event.id,
        eventType: event.type,
        payload: JSON.parse(JSON.stringify(event)),
      },
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'P2002') {
      return NextResponse.json({ received: true, idempotent: true });
    }
    console.error('[stripe-webhook] BillEvent create failed:', err);
    return NextResponse.json({ error: 'persist failed' }, { status: 500 });
  }

  try {
    await applyEvent(event);
    await prisma.billEvent.update({
      where: { stripeEventId: event.id },
      data: { processedAt: new Date() },
    });
  } catch (err) {
    console.error('[stripe-webhook] applyEvent failed:', err);
    // Return 500 so Stripe retries. BillEvent row stays without processedAt.
    return NextResponse.json({ error: 'handler failed' }, { status: 500 });
  }

  return NextResponse.json({ received: true });
}
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p/apps/web-next
npx vitest run __tests__/api/v1/agentbook/stripe-webhook.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/stripe-webhook/ apps/web-next/__tests__/api/v1/agentbook/stripe-webhook.test.ts
git commit -m "feat(billing): Stripe webhook handler with signature + idempotency

- Verifies stripe-signature against STRIPE_WEBHOOK_SECRET (400 on
  mismatch or missing)
- Inserts BillEvent before applying; P2002 unique-violation returns
  200 immediately so Stripe retries are no-ops
- applyEvent handles subscription.created/updated/deleted; unknown
  events are still persisted for replay
- invalidateAccount called after any state change so the next hot-
  path check refreshes from DB

Tests cover: missing sig, bad sig, idempotency, three event types."
```

### Task 3.3: PR + merge

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/billing-phase-3-stripe-webhook
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-3-stripe-webhook \
  --title "feat(billing): phase 3 — Stripe wrapper + webhook" \
  --body "Adds the env-aware Stripe SDK wrapper and the webhook receiver. No customers/subscriptions exist yet, so the webhook has no real traffic — but full unit coverage proves the signature/idempotency/dispatch logic.

Test plan:
- [x] 6 vitest tests pass (signature, idempotency, 3 event types, unknown event)
- [ ] After merge: register the webhook in Stripe Dashboard pointing at https://<your-domain>/api/v1/agentbook/stripe-webhook (one endpoint per environment); save STRIPE_WEBHOOK_SECRET per env"
```

- [ ] **Step 2: Wait + merge**

```bash
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

- [ ] **Step 3: Manual Stripe Dashboard step (after merge, before Phase 6)**

Register webhook endpoints in Stripe Dashboard → Developers → Webhooks. Add one per environment (Production, Preview). Listen for events: `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy each `whsec_*` and store as `STRIPE_WEBHOOK_SECRET` in the matching Vercel environment scope.

---

## Phase 4 — Admin backend routes (PR 4)

**Goal:** Ship admin-only routes for plan templates, plan CRUD. No UI yet (Phase 5). Routes are reachable but gated by `ADMIN_EMAILS` allowlist.

**Branch:** `feat/billing-phase-4-admin-routes`

**Files (all new):**
- `apps/web-next/src/lib/billing/admin-auth.ts` — admin allowlist check
- `apps/web-next/src/lib/billing/templates.ts` — Free/Pro/Business seed templates
- `apps/web-next/src/app/api/v1/agentbook-billing/templates/route.ts`
- `apps/web-next/src/app/api/v1/agentbook-billing/plans/route.ts` (GET, POST)
- `apps/web-next/src/app/api/v1/agentbook-billing/plans/[id]/route.ts` (PATCH, DELETE)
- `apps/web-next/__tests__/api/v1/agentbook-billing/admin-routes.test.ts`

### Task 4.1: Admin auth helper

- [ ] **Step 1: Branch + write helper test**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull
git checkout -b feat/billing-phase-4-admin-routes
```

Create `apps/web-next/__tests__/lib/billing/admin-auth.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('server-only', () => ({}));

vi.mock('@/lib/api/auth', () => ({
  validateSession: vi.fn(),
}));

import { validateSession } from '@/lib/api/auth';
import { requireAdmin } from '@/lib/billing/admin-auth';
import { NextRequest } from 'next/server';

const mockSession = validateSession as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockSession.mockReset();
  process.env.ADMIN_EMAILS = 'admin@a3p.io,ops@a3p.io';
});

function req(token?: string): NextRequest {
  const r = new NextRequest('http://x/admin');
  if (token) r.cookies.set('naap_auth_token', token);
  return r;
}

describe('requireAdmin', () => {
  it('returns user when email is in ADMIN_EMAILS', async () => {
    mockSession.mockResolvedValue({ id: 'u1', email: 'admin@a3p.io' });
    const u = await requireAdmin(req('tok'));
    expect(u.email).toBe('admin@a3p.io');
  });

  it('throws 403 when email not in allowlist', async () => {
    mockSession.mockResolvedValue({ id: 'u1', email: 'maya@agentbook.test' });
    await expect(requireAdmin(req('tok'))).rejects.toMatchObject({ status: 403 });
  });

  it('throws 401 when no session token', async () => {
    await expect(requireAdmin(req())).rejects.toMatchObject({ status: 401 });
  });
});
```

- [ ] **Step 2: Create `apps/web-next/src/lib/billing/admin-auth.ts`**

```ts
import 'server-only';
import type { NextRequest } from 'next/server';
import { validateSession } from '@/lib/api/auth';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface AdminUser { id: string; email: string; }

export async function requireAdmin(request: NextRequest): Promise<AdminUser> {
  const token = request.cookies.get('naap_auth_token')?.value;
  if (!token) throw new HttpError(401, 'not authenticated');
  const user = await validateSession(token);
  if (!user?.email) throw new HttpError(401, 'invalid session');
  const allowlist = (process.env.ADMIN_EMAILS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowlist.includes(user.email)) throw new HttpError(403, 'admin only');
  return { id: user.id, email: user.email };
}
```

- [ ] **Step 3: Run + commit**

```bash
cd apps/web-next && npx vitest run __tests__/lib/billing/admin-auth.test.ts
```

Expected: 3 pass.

```bash
git add apps/web-next/src/lib/billing/admin-auth.ts apps/web-next/__tests__/lib/billing/admin-auth.test.ts
git commit -m "feat(billing): requireAdmin helper — ADMIN_EMAILS allowlist

Throws HttpError(401) with no session, HttpError(403) when the
session email is not in ADMIN_EMAILS. Used by all admin routes."
```

### Task 4.2: Plan templates

- [ ] **Step 1: Create `apps/web-next/src/lib/billing/templates.ts`**

```ts
import 'server-only';
import type { PlanFeatures, PlanQuotas } from '@naap/billing';

export interface PlanTemplate {
  code: string;
  name: string;
  description: string;
  priceCents: number;
  currency: string;
  interval: 'month' | 'year';
  features: PlanFeatures;
  quotas: PlanQuotas;
}

export const SEED_TEMPLATES: PlanTemplate[] = [
  {
    code: 'free',
    name: 'Free',
    description: 'For getting started — try AgentBook with no commitment.',
    priceCents: 0,
    currency: 'usd',
    interval: 'month',
    features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
    quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Telegram bot, tax exports, generous quotas for active solo users.',
    priceCents: 1900,
    currency: 'usd',
    interval: 'month',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Unlimited everything. Team seats coming soon.',
    priceCents: 4900,
    currency: 'usd',
    interval: 'month',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true },
    quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 },
  },
];
```

- [ ] **Step 2: Create `apps/web-next/src/app/api/v1/agentbook-billing/templates/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { SEED_TEMPLATES } from '@/lib/billing/templates';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(request);
  } catch (err) {
    const e = err as HttpError;
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return NextResponse.json({ templates: SEED_TEMPLATES });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/web-next/src/lib/billing/templates.ts apps/web-next/src/app/api/v1/agentbook-billing/templates/route.ts
git commit -m "feat(billing): admin GET /templates — Free / Pro / Business seeds

Three seed templates matching the spec's pricing table. Admin
clones one, tweaks the price/quotas, then POSTs to /plans."
```

### Task 4.3: Create plan (Stripe Product + Price + DB row, all-or-nothing)

- [ ] **Step 1: Write the failing test**

Create `apps/web-next/__tests__/api/v1/agentbook-billing/admin-routes.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const validateSession = vi.fn();
const productsCreate = vi.fn();
const productsUpdate = vi.fn();
const pricesCreate = vi.fn();
const planCreate = vi.fn();
const planUpdate = vi.fn();
const planFindMany = vi.fn();
const planFindUnique = vi.fn();

vi.mock('@/lib/api/auth', () => ({ validateSession: (...a: unknown[]) => validateSession(...a) }));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    products: { create: (...a: unknown[]) => productsCreate(...a), update: (...a: unknown[]) => productsUpdate(...a) },
    prices: { create: (...a: unknown[]) => pricesCreate(...a) },
  }),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    billPlan: {
      create: (...a: unknown[]) => planCreate(...a),
      update: (...a: unknown[]) => planUpdate(...a),
      findMany: (...a: unknown[]) => planFindMany(...a),
      findUnique: (...a: unknown[]) => planFindUnique(...a),
    },
  },
}));

import { POST as createPlan, GET as listPlans } from '@/app/api/v1/agentbook-billing/plans/route';
import { PATCH as editPlan, DELETE as archivePlan } from '@/app/api/v1/agentbook-billing/plans/[id]/route';

const adminUser = { id: 'admin-1', email: 'admin@a3p.io' };

beforeEach(() => {
  validateSession.mockReset(); productsCreate.mockReset(); productsUpdate.mockReset();
  pricesCreate.mockReset(); planCreate.mockReset(); planUpdate.mockReset();
  planFindMany.mockReset(); planFindUnique.mockReset();
  process.env.ADMIN_EMAILS = 'admin@a3p.io';
});

function adminReq(body?: unknown): NextRequest {
  const r = new NextRequest('http://x/p', { method: 'POST', body: body ? JSON.stringify(body) : undefined });
  r.cookies.set('naap_auth_token', 'tok');
  return r;
}

describe('POST /plans', () => {
  it('creates Stripe Product + Price + DB row', async () => {
    validateSession.mockResolvedValue(adminUser);
    productsCreate.mockResolvedValue({ id: 'prod_x' });
    pricesCreate.mockResolvedValue({ id: 'price_y' });
    planCreate.mockResolvedValue({ id: 'plan-1', code: 'pro', stripeProductId: 'prod_x', stripePriceId: 'price_y' });

    const body = {
      code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', interval: 'month',
      features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
      quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
    };
    const r = await createPlan(adminReq(body));
    expect(r.status).toBe(201);
    expect(productsCreate).toHaveBeenCalledTimes(1);
    expect(pricesCreate).toHaveBeenCalledTimes(1);
    expect(planCreate).toHaveBeenCalledTimes(1);
  });

  it('rolls back Stripe Product when DB write fails', async () => {
    validateSession.mockResolvedValue(adminUser);
    productsCreate.mockResolvedValue({ id: 'prod_x' });
    pricesCreate.mockResolvedValue({ id: 'price_y' });
    planCreate.mockRejectedValue(new Error('db'));
    productsUpdate.mockResolvedValue({});

    const r = await createPlan(adminReq({
      code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', interval: 'month',
      features: { telegram_bot: true, tax_package_generation: false, multi_user_teams: false },
      quotas: { expenses_created: 0, ocr_scans: 0, ai_messages: 0, invoices_sent: 0, bank_connections: 0 },
    }));
    expect(r.status).toBe(500);
    expect(productsUpdate).toHaveBeenCalledWith('prod_x', { active: false });
  });

  it('returns 403 for non-admin', async () => {
    validateSession.mockResolvedValue({ id: 'u', email: 'maya@agentbook.test' });
    const r = await createPlan(adminReq({}));
    expect(r.status).toBe(403);
  });
});

describe('GET /plans', () => {
  it('returns active plans only by default', async () => {
    planFindMany.mockResolvedValue([{ id: 'p1', code: 'free', isActive: true }]);
    const r = await listPlans(new NextRequest('http://x/p'));
    expect(r.status).toBe(200);
    expect(planFindMany.mock.calls[0][0].where.isActive).toBe(true);
  });
});

describe('PATCH /plans/:id', () => {
  it('updates display fields only — never price', async () => {
    validateSession.mockResolvedValue(adminUser);
    planUpdate.mockResolvedValue({ id: 'p1' });
    const r = await editPlan(adminReq({ name: 'Pro 2', description: 'new', priceCents: 9999 }), { params: Promise.resolve({ id: 'p1' }) });
    expect(r.status).toBe(200);
    const data = planUpdate.mock.calls[0][0].data;
    expect(data.name).toBe('Pro 2');
    expect(data).not.toHaveProperty('priceCents');
  });
});

describe('DELETE /plans/:id', () => {
  it('soft-archives (isActive=false) + archives Stripe Product', async () => {
    validateSession.mockResolvedValue(adminUser);
    planFindUnique.mockResolvedValue({ id: 'p1', stripeProductId: 'prod_x' });
    productsUpdate.mockResolvedValue({});
    planUpdate.mockResolvedValue({});
    const r = await archivePlan(adminReq(), { params: Promise.resolve({ id: 'p1' }) });
    expect(r.status).toBe(200);
    expect(productsUpdate).toHaveBeenCalledWith('prod_x', { active: false });
    expect(planUpdate.mock.calls[0][0].data.isActive).toBe(false);
  });
});
```

- [ ] **Step 2: Create `apps/web-next/src/app/api/v1/agentbook-billing/plans/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

export const runtime = 'nodejs';

const PlanBody = z.object({
  code: z.string().regex(/^[a-z0-9_-]+$/),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  priceCents: z.number().int().min(0),
  currency: z.string().length(3),
  interval: z.enum(['month', 'year']),
  features: z.object({
    telegram_bot: z.boolean(),
    tax_package_generation: z.boolean(),
    multi_user_teams: z.boolean(),
  }),
  quotas: z.object({
    expenses_created: z.number().int(),
    ocr_scans: z.number().int(),
    ai_messages: z.number().int(),
    invoices_sent: z.number().int(),
    bank_connections: z.number().int(),
  }),
  sortOrder: z.number().int().optional(),
});

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const plans = await prisma.billPlan.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { priceCents: 'asc' }],
  });
  return NextResponse.json({ plans });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(request);
  } catch (err) {
    const e = err as HttpError;
    return NextResponse.json({ error: e.message }, { status: e.status });
  }

  const parsed = PlanBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid body', details: parsed.error.flatten() }, { status: 400 });
  }
  const body = parsed.data;

  const stripe = getStripe();
  let productId: string | null = null;
  try {
    const product = await stripe.products.create({ name: body.name, metadata: { code: body.code } });
    productId = product.id;
    const price = await stripe.prices.create({
      product: productId,
      unit_amount: body.priceCents,
      currency: body.currency,
      recurring: { interval: body.interval },
    });
    const plan = await prisma.billPlan.create({
      data: {
        code: body.code,
        name: body.name,
        description: body.description,
        priceCents: body.priceCents,
        currency: body.currency,
        interval: body.interval,
        features: body.features,
        quotas: body.quotas,
        sortOrder: body.sortOrder ?? 0,
        stripeProductId: productId,
        stripePriceId: price.id,
      },
    });
    return NextResponse.json({ plan }, { status: 201 });
  } catch (err) {
    console.error('[billing] plan create failed:', err);
    if (productId) {
      try {
        await stripe.products.update(productId, { active: false });
      } catch (rollbackErr) {
        console.error('[billing] rollback also failed:', rollbackErr);
      }
    }
    return NextResponse.json({ error: 'create failed' }, { status: 500 });
  }
}
```

- [ ] **Step 3: Create `apps/web-next/src/app/api/v1/agentbook-billing/plans/[id]/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

export const runtime = 'nodejs';

const PatchBody = z.object({
  name: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  features: z.object({
    telegram_bot: z.boolean(),
    tax_package_generation: z.boolean(),
    multi_user_teams: z.boolean(),
  }).optional(),
  quotas: z.object({
    expenses_created: z.number().int(),
    ocr_scans: z.number().int(),
    ai_messages: z.number().int(),
    invoices_sent: z.number().int(),
    bank_connections: z.number().int(),
  }).optional(),
  sortOrder: z.number().int().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try { await requireAdmin(request); } catch (err) {
    const e = err as HttpError; return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const { id } = await params;
  const parsed = PatchBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const plan = await prisma.billPlan.update({ where: { id }, data: parsed.data });
  return NextResponse.json({ plan });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try { await requireAdmin(request); } catch (err) {
    const e = err as HttpError; return NextResponse.json({ error: e.message }, { status: e.status });
  }
  const { id } = await params;
  const plan = await prisma.billPlan.findUnique({ where: { id } });
  if (!plan) return NextResponse.json({ error: 'not found' }, { status: 404 });
  if (plan.stripeProductId) {
    try {
      await getStripe().products.update(plan.stripeProductId, { active: false });
    } catch (err) {
      console.warn('[billing] stripe archive failed (continuing):', err);
    }
  }
  await prisma.billPlan.update({ where: { id }, data: { isActive: false } });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 4: Run + commit**

```bash
cd apps/web-next && npx vitest run __tests__/api/v1/agentbook-billing/admin-routes.test.ts
```

Expected: ~7 pass.

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/ apps/web-next/__tests__/api/v1/agentbook-billing/
git commit -m "feat(billing): admin plan CRUD routes

- GET /plans   : public list (active only)
- POST /plans  : admin; Stripe Product+Price+DB row, rolls back
                 product on DB failure
- PATCH /plans/:id : admin; updates display fields + features +
                     quotas; price is immutable (archive + new)
- DELETE /plans/:id: admin; soft-archive + Stripe product inactive"
```

### Task 4.4: PR + merge

- [ ] **Step 1: Push, PR, merge**

```bash
git push -u origin feat/billing-phase-4-admin-routes
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-4-admin-routes \
  --title "feat(billing): phase 4 — admin backend routes" \
  --body "Admin can now manage plans via HTTP (UI ships in phase 5).

Routes:
- GET  /api/v1/agentbook-billing/templates   (admin) → 3 seed templates
- GET  /api/v1/agentbook-billing/plans       (public) → active plans
- POST /api/v1/agentbook-billing/plans       (admin) → Stripe + DB
- PATCH /api/v1/agentbook-billing/plans/:id  (admin)
- DELETE /api/v1/agentbook-billing/plans/:id (admin) → soft-archive

Test plan: 10 vitest tests pass; admin allowlist via ADMIN_EMAILS env."
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

---

## Phase 5 — Admin frontend (PR 5)

**Goal:** Mount the admin UI at `/admin/billing`. Plan list, template picker modal, plan editor. Backend already exists (Phase 4); this is pure frontend wired to those routes.

**Branch:** `feat/billing-phase-5-admin-frontend`

**Files (all new in `plugins/agentbook-billing/`):**
- `plugins/agentbook-billing/plugin.json`
- `plugins/agentbook-billing/frontend/package.json`
- `plugins/agentbook-billing/frontend/vite.config.ts`
- `plugins/agentbook-billing/frontend/tsconfig.json`
- `plugins/agentbook-billing/frontend/index.html`
- `plugins/agentbook-billing/frontend/src/main.tsx` — UMD entry
- `plugins/agentbook-billing/frontend/src/mount.tsx` — `mount(container, ctx)`
- `plugins/agentbook-billing/frontend/src/App.tsx` — route switch
- `plugins/agentbook-billing/frontend/src/admin/AdminApp.tsx`
- `plugins/agentbook-billing/frontend/src/admin/PlanList.tsx`
- `plugins/agentbook-billing/frontend/src/admin/TemplatePickerModal.tsx`
- `plugins/agentbook-billing/frontend/src/admin/PlanEditorModal.tsx`
- `plugins/agentbook-billing/frontend/src/lib/api.ts`
- `plugins/agentbook-billing/frontend/src/__tests__/*` — Vitest + React Testing Library

### Task 5.1: Plugin scaffolding

- [ ] **Step 1: Branch + plugin.json**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull
git checkout -b feat/billing-phase-5-admin-frontend
mkdir -p plugins/agentbook-billing/frontend/src/{admin,user,lib,__tests__}
```

Create `plugins/agentbook-billing/plugin.json`:

```json
{
  "$schema": "https://plugins.naap.io/schema/plugin.json",
  "name": "agentbook-billing",
  "displayName": "AgentBook Billing",
  "version": "1.0.0",
  "description": "Subscription plans, payments, and entitlement gating for AgentBook.",
  "isCore": true,
  "author": { "name": "A3P Team", "email": "team@a3p.io" },
  "license": "MIT",
  "keywords": ["billing", "stripe", "subscriptions"],
  "category": "platform",
  "shell": { "minVersion": "0.1.0", "maxVersion": "2.x" },
  "frontend": {
    "entry": "./frontend/dist/production/agentbook-billing.js",
    "devPort": 3054,
    "routes": ["/admin/billing", "/admin/billing/*", "/billing", "/billing/*"],
    "navigation": {
      "label": "Billing",
      "icon": "CreditCard",
      "order": 50,
      "group": "settings"
    }
  }
}
```

(No `backend` block — routes live in `apps/web-next` per the Vercel-native pattern documented in the spec.)

- [ ] **Step 2: Create `plugins/agentbook-billing/frontend/package.json`**

```json
{
  "name": "@agentbook-billing/frontend",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build && npm run build:prod",
    "build:prod": "vite build --mode production --outDir dist/production",
    "test": "vitest run"
  },
  "dependencies": {
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "@stripe/stripe-js": "^4.0.0",
    "@stripe/react-stripe-js": "^3.0.0"
  },
  "devDependencies": {
    "@testing-library/react": "^16.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^5.0.0",
    "happy-dom": "^15.0.0",
    "typescript": "^5.5.0",
    "vite": "^7.0.0",
    "vitest": "^4.0.0"
  }
}
```

- [ ] **Step 3: Create `vite.config.ts` and `tsconfig.json`**

`plugins/agentbook-billing/frontend/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/main.tsx'),
      name: 'AgentbookBilling',
      formats: ['umd'],
      fileName: () => 'agentbook-billing.js',
    },
    rollupOptions: {
      external: ['react', 'react-dom'],
      output: { globals: { react: 'React', 'react-dom': 'ReactDOM' } },
    },
  },
  test: { environment: 'happy-dom', globals: true },
});
```

`plugins/agentbook-billing/frontend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": { "@/*": ["src/*"] }
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Install deps + commit scaffolding**

```bash
cd plugins/agentbook-billing/frontend && npm install
```

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git add plugins/agentbook-billing/plugin.json plugins/agentbook-billing/frontend/package.json plugins/agentbook-billing/frontend/vite.config.ts plugins/agentbook-billing/frontend/tsconfig.json plugins/agentbook-billing/frontend/package-lock.json
git commit -m "feat(billing): scaffold plugin manifest + frontend build setup

No backend block — backend routes live in apps/web-next per the
Vercel-native pattern. plugin.json declares routes for /admin/billing
and /billing. Vite builds a UMD bundle that the shell loads from
public/cdn/plugins/agentbook-billing/."
```

### Task 5.2: API client + mount

- [ ] **Step 1: Create `plugins/agentbook-billing/frontend/src/lib/api.ts`**

```ts
export interface Plan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  interval: 'month' | 'year';
  features: { telegram_bot: boolean; tax_package_generation: boolean; multi_user_teams: boolean };
  quotas: { expenses_created: number; ocr_scans: number; ai_messages: number; invoices_sent: number; bank_connections: number };
  isActive: boolean;
  sortOrder: number;
}

export interface PlanTemplate extends Omit<Plan, 'id' | 'isActive' | 'sortOrder'> {}

async function json<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const billingApi = {
  listPlans: async (): Promise<Plan[]> =>
    (await json<{ plans: Plan[] }>(await fetch('/api/v1/agentbook-billing/plans'))).plans,
  listTemplates: async (): Promise<PlanTemplate[]> =>
    (await json<{ templates: PlanTemplate[] }>(await fetch('/api/v1/agentbook-billing/templates'))).templates,
  createPlan: async (body: PlanTemplate & { code: string }): Promise<Plan> =>
    (await json<{ plan: Plan }>(await fetch('/api/v1/agentbook-billing/plans', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }))).plan,
  patchPlan: async (id: string, patch: Partial<Plan>): Promise<Plan> =>
    (await json<{ plan: Plan }>(await fetch(`/api/v1/agentbook-billing/plans/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    }))).plan,
  archivePlan: async (id: string): Promise<void> => {
    await json(await fetch(`/api/v1/agentbook-billing/plans/${id}`, { method: 'DELETE' }));
  },
};
```

- [ ] **Step 2: Create `plugins/agentbook-billing/frontend/src/main.tsx` and `mount.tsx`**

`main.tsx`:

```ts
import { mount } from './mount';
export { mount };
```

`mount.tsx`:

```tsx
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';

interface ShellContext {
  route: string;
  user?: { id: string; email: string };
}

const roots = new WeakMap<Element, Root>();

export function mount(container: HTMLElement, ctx: ShellContext): () => void {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(<App route={ctx.route} user={ctx.user} />);
  return () => { root?.unmount(); roots.delete(container); };
}
```

`App.tsx`:

```tsx
import { lazy, Suspense } from 'react';

const AdminApp = lazy(() => import('./admin/AdminApp').then(m => ({ default: m.AdminApp })));
const UserApp = lazy(() => import('./user/UserApp').then(m => ({ default: m.UserApp })));

export function App({ route }: { route: string; user?: { id: string; email: string } }): JSX.Element {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading…</div>}>
      {route.startsWith('/admin/billing') ? <AdminApp /> : <UserApp />}
    </Suspense>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add plugins/agentbook-billing/frontend/src/main.tsx plugins/agentbook-billing/frontend/src/mount.tsx plugins/agentbook-billing/frontend/src/App.tsx plugins/agentbook-billing/frontend/src/lib/api.ts
git commit -m "feat(billing): UMD mount entry + route switch + API client

App switches between AdminApp (/admin/billing) and UserApp (/billing).
billingApi wraps the four backend routes for plans + templates."
```

### Task 5.3: Admin pages — PlanList + TemplatePickerModal + PlanEditorModal

- [ ] **Step 1: Write tests for PlanList**

Create `plugins/agentbook-billing/frontend/src/__tests__/PlanList.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { PlanList } from '../admin/PlanList';

const mockListPlans = vi.fn();
const mockArchivePlan = vi.fn();
vi.mock('../lib/api', () => ({
  billingApi: {
    listPlans: () => mockListPlans(),
    archivePlan: (id: string) => mockArchivePlan(id),
  },
}));

beforeEach(() => { mockListPlans.mockReset(); mockArchivePlan.mockReset(); });

describe('PlanList', () => {
  it('renders plans', async () => {
    mockListPlans.mockResolvedValue([
      { id: 'p1', code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', interval: 'month',
        description: '', features: {telegram_bot:true,tax_package_generation:true,multi_user_teams:false},
        quotas: {expenses_created:1000,ocr_scans:200,ai_messages:5000,invoices_sent:200,bank_connections:3},
        isActive: true, sortOrder: 0 },
    ]);
    render(<PlanList onEdit={() => {}} onAdd={() => {}} />);
    await waitFor(() => expect(screen.getByText('Pro')).toBeInTheDocument());
    expect(screen.getByText('$19.00 / month')).toBeInTheDocument();
  });

  it('archives a plan on Archive click', async () => {
    mockListPlans.mockResolvedValue([
      { id: 'p1', code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', interval: 'month',
        description: '', features: {telegram_bot:true,tax_package_generation:true,multi_user_teams:false},
        quotas: {expenses_created:1000,ocr_scans:200,ai_messages:5000,invoices_sent:200,bank_connections:3},
        isActive: true, sortOrder: 0 },
    ]);
    mockArchivePlan.mockResolvedValue(undefined);
    window.confirm = () => true;
    render(<PlanList onEdit={() => {}} onAdd={() => {}} />);
    await waitFor(() => screen.getByText('Pro'));
    fireEvent.click(screen.getByRole('button', { name: /archive/i }));
    await waitFor(() => expect(mockArchivePlan).toHaveBeenCalledWith('p1'));
  });
});
```

- [ ] **Step 2: Create `admin/PlanList.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { billingApi, type Plan } from '../lib/api';

function fmtPrice(cents: number, currency: string, interval: string): string {
  return `${new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100)} / ${interval}`;
}

interface Props { onEdit: (p: Plan) => void; onAdd: () => void; }

export function PlanList({ onEdit, onAdd }: Props): JSX.Element {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = (): void => {
    billingApi.listPlans().then(setPlans).catch(e => setErr(String(e)));
  };
  useEffect(load, []);

  const archive = async (p: Plan): Promise<void> => {
    if (!window.confirm(`Archive plan "${p.name}"? Existing subscriptions keep working.`)) return;
    await billingApi.archivePlan(p.id);
    load();
  };

  if (err) return <div className="p-6 text-red-600">{err}</div>;
  if (!plans) return <div className="p-6 text-gray-500">Loading…</div>;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-semibold">Subscription plans</h2>
        <button onClick={onAdd} className="rounded bg-blue-600 px-4 py-2 text-white">+ New plan from template</button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-gray-500">
          <tr><th>Code</th><th>Name</th><th>Price</th><th>Telegram</th><th>Tax pkg</th><th></th></tr>
        </thead>
        <tbody>
          {plans.map(p => (
            <tr key={p.id} className="border-t">
              <td className="py-2"><code>{p.code}</code></td>
              <td>{p.name}</td>
              <td>{fmtPrice(p.priceCents, p.currency, p.interval)}</td>
              <td>{p.features.telegram_bot ? '✓' : '—'}</td>
              <td>{p.features.tax_package_generation ? '✓' : '—'}</td>
              <td className="text-right">
                <button onClick={() => onEdit(p)} className="mr-2 text-blue-600">Edit</button>
                <button onClick={() => archive(p)} className="text-red-600">Archive</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 3: Create `admin/TemplatePickerModal.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { billingApi, type PlanTemplate } from '../lib/api';

interface Props { onClose: () => void; onPicked: (t: PlanTemplate) => void; }

export function TemplatePickerModal({ onClose, onPicked }: Props): JSX.Element {
  const [tpls, setTpls] = useState<PlanTemplate[] | null>(null);
  useEffect(() => { billingApi.listTemplates().then(setTpls); }, []);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[600px] rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Start from a template</h3>
          <button onClick={onClose} aria-label="close" className="text-gray-500">×</button>
        </div>
        {!tpls ? <div>Loading…</div> : (
          <div className="grid grid-cols-3 gap-3">
            {tpls.map(t => (
              <button key={t.code} onClick={() => onPicked(t)}
                className="rounded border p-4 text-left hover:bg-gray-50">
                <div className="font-medium">{t.name}</div>
                <div className="text-sm text-gray-500">${(t.priceCents / 100).toFixed(0)} / {t.interval}</div>
                <div className="mt-2 text-xs text-gray-400">{t.description}</div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create `admin/PlanEditorModal.tsx`**

```tsx
import { useState } from 'react';
import { billingApi, type PlanTemplate, type Plan } from '../lib/api';

type Mode = { kind: 'create'; template: PlanTemplate } | { kind: 'edit'; plan: Plan };

export function PlanEditorModal({ mode, onClose, onSaved }: { mode: Mode; onClose: () => void; onSaved: () => void }): JSX.Element {
  const seed = mode.kind === 'create' ? mode.template : mode.plan;
  const [form, setForm] = useState({
    code: 'code' in seed ? seed.code : '',
    name: seed.name,
    description: seed.description ?? '',
    priceCents: seed.priceCents,
    currency: seed.currency,
    interval: seed.interval,
    features: { ...seed.features },
    quotas: { ...seed.quotas },
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true); setErr(null);
    try {
      if (mode.kind === 'create') {
        await billingApi.createPlan(form);
      } else {
        await billingApi.patchPlan(mode.plan.id, {
          name: form.name, description: form.description, features: form.features, quotas: form.quotas,
        });
      }
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[640px] rounded-lg bg-white p-6 max-h-[90vh] overflow-y-auto">
        <h3 className="mb-4 text-lg font-semibold">{mode.kind === 'create' ? `Create plan from ${mode.template.name}` : `Edit ${mode.plan.name}`}</h3>
        {err && <div className="mb-3 rounded bg-red-50 p-2 text-sm text-red-700">{err}</div>}

        <label className="mb-3 block text-sm">
          <span className="text-gray-600">Name</span>
          <input className="mt-1 w-full rounded border px-2 py-1" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
        </label>

        {mode.kind === 'create' && (
          <label className="mb-3 block text-sm">
            <span className="text-gray-600">Code (URL-safe, unique)</span>
            <input className="mt-1 w-full rounded border px-2 py-1 font-mono text-xs" value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} />
          </label>
        )}

        <label className="mb-3 block text-sm">
          <span className="text-gray-600">Price (cents) — only at create</span>
          <input type="number" disabled={mode.kind !== 'create'} className="mt-1 w-full rounded border px-2 py-1 disabled:bg-gray-100" value={form.priceCents} onChange={e => setForm({ ...form, priceCents: Number(e.target.value) })} />
        </label>

        <fieldset className="mb-3 rounded border p-3">
          <legend className="px-1 text-sm text-gray-600">Features</legend>
          {(['telegram_bot', 'tax_package_generation', 'multi_user_teams'] as const).map(k => (
            <label key={k} className="mr-4 inline-flex items-center text-sm">
              <input type="checkbox" className="mr-1" checked={form.features[k]} onChange={e => setForm({ ...form, features: { ...form.features, [k]: e.target.checked } })} />
              {k}
            </label>
          ))}
        </fieldset>

        <fieldset className="mb-3 rounded border p-3">
          <legend className="px-1 text-sm text-gray-600">Quotas (-1 = unlimited)</legend>
          {(['expenses_created', 'ocr_scans', 'ai_messages', 'invoices_sent', 'bank_connections'] as const).map(k => (
            <label key={k} className="mb-2 block text-sm">
              <span className="inline-block w-40 text-gray-600">{k}</span>
              <input type="number" className="rounded border px-2 py-1" value={form.quotas[k]} onChange={e => setForm({ ...form, quotas: { ...form.quotas, [k]: Number(e.target.value) } })} />
            </label>
          ))}
        </fieldset>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded border px-4 py-2">Cancel</button>
          <button disabled={saving} onClick={save} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Create `admin/AdminApp.tsx`**

```tsx
import { useState } from 'react';
import { PlanList } from './PlanList';
import { TemplatePickerModal } from './TemplatePickerModal';
import { PlanEditorModal } from './PlanEditorModal';
import type { Plan, PlanTemplate } from '../lib/api';

type Modal = null | { kind: 'picker' } | { kind: 'edit'; plan: Plan } | { kind: 'create'; template: PlanTemplate };

export function AdminApp(): JSX.Element {
  const [modal, setModal] = useState<Modal>(null);
  const [refresh, setRefresh] = useState(0);

  return (
    <div>
      <PlanList
        key={refresh}
        onAdd={() => setModal({ kind: 'picker' })}
        onEdit={(plan) => setModal({ kind: 'edit', plan })}
      />
      {modal?.kind === 'picker' && (
        <TemplatePickerModal onClose={() => setModal(null)} onPicked={(t) => setModal({ kind: 'create', template: t })} />
      )}
      {modal?.kind === 'create' && (
        <PlanEditorModal mode={{ kind: 'create', template: modal.template }} onClose={() => setModal(null)} onSaved={() => { setModal(null); setRefresh(r => r + 1); }} />
      )}
      {modal?.kind === 'edit' && (
        <PlanEditorModal mode={{ kind: 'edit', plan: modal.plan }} onClose={() => setModal(null)} onSaved={() => { setModal(null); setRefresh(r => r + 1); }} />
      )}
    </div>
  );
}
```

Also create stub `user/UserApp.tsx` so `App.tsx` import doesn't break:

```tsx
export function UserApp(): JSX.Element {
  return <div className="p-6 text-sm text-gray-500">Billing UI coming in phase 7.</div>;
}
```

- [ ] **Step 6: Run tests + build**

```bash
cd plugins/agentbook-billing/frontend
npx vitest run
npm run build
```

Expected: PlanList tests pass; build emits `dist/production/agentbook-billing.js`.

- [ ] **Step 7: Copy bundle to public CDN folder**

```bash
mkdir -p /Users/qianghan/Documents/mycodespace/a3p/apps/web-next/public/cdn/plugins/agentbook-billing/1.0.0
cp dist/production/agentbook-billing.js /Users/qianghan/Documents/mycodespace/a3p/apps/web-next/public/cdn/plugins/agentbook-billing/agentbook-billing.js
cp dist/production/agentbook-billing.js /Users/qianghan/Documents/mycodespace/a3p/apps/web-next/public/cdn/plugins/agentbook-billing/1.0.0/agentbook-billing.js
```

- [ ] **Step 8: Commit**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git add plugins/agentbook-billing/frontend/src apps/web-next/public/cdn/plugins/agentbook-billing/
git commit -m "feat(billing): admin frontend — plan list + template picker + editor

PlanList shows active plans with edit/archive buttons. New-plan
flow: click '+ New plan from template' → pick template → editor
modal pre-filled with seed values → save creates Stripe Product
+ Price + DB row. Edit modal disallows price changes (immutable
on existing plans per Stripe's price semantics)."
```

### Task 5.4: PR + merge

- [ ] **Step 1: Push, PR, merge**

```bash
git push -u origin feat/billing-phase-5-admin-frontend
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-5-admin-frontend \
  --title "feat(billing): phase 5 — admin frontend" \
  --body "Mounts /admin/billing with plan list, template picker, plan editor. Backend already in place (phase 4).

Smoke plan:
- [ ] Login as admin@a3p.io → navigate to /admin/billing
- [ ] Click '+ New plan from template' → pick Pro → save → confirm
      Stripe Dashboard shows new Product + Price
- [ ] Edit a plan → change name → save → reload → name persists
- [ ] Archive a plan → it disappears from list (isActive=false)"
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

---

## Phase 6 — User backend routes (PR 6)

**Goal:** User-facing subscribe/cancel/reactivate routes. No UI yet (Phase 7).

**Branch:** `feat/billing-phase-6-user-routes`

**Files (all new under `apps/web-next/src/app/api/v1/agentbook-billing/me/`):**
- `subscription/route.ts` — GET (current state), POST (subscribe with payment method)
- `subscription/intent/route.ts` — POST (create SetupIntent for Payment Element)
- `subscription/cancel/route.ts` — POST (set cancel_at_period_end)
- `subscription/reactivate/route.ts` — POST (clear cancel_at_period_end)
- `apps/web-next/__tests__/api/v1/agentbook-billing/user-routes.test.ts`

### Task 6.1: GET /me/subscription (current state)

- [ ] **Step 1: Branch + test**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull
git checkout -b feat/billing-phase-6-user-routes
mkdir -p apps/web-next/src/app/api/v1/agentbook-billing/me/subscription/{intent,cancel,reactivate}
```

Create `apps/web-next/__tests__/api/v1/agentbook-billing/user-routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const getCurrentPlan = vi.fn();
const customersCreate = vi.fn();
const setupIntentsCreate = vi.fn();
const subscriptionsCreate = vi.fn();
const subscriptionsUpdate = vi.fn();
const billSubFindUnique = vi.fn();
const billSubUpsert = vi.fn();
const billSubUpdate = vi.fn();
const planFindUnique = vi.fn();
const resolveTenant = vi.fn().mockResolvedValue('t1');

vi.mock('@/lib/agentbook-tenant', () => ({ resolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a) }));
vi.mock('@naap/billing', () => ({ getCurrentPlan: (...a: unknown[]) => getCurrentPlan(...a), invalidateAccount: vi.fn() }));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    customers: { create: (...a: unknown[]) => customersCreate(...a) },
    setupIntents: { create: (...a: unknown[]) => setupIntentsCreate(...a) },
    subscriptions: { create: (...a: unknown[]) => subscriptionsCreate(...a), update: (...a: unknown[]) => subscriptionsUpdate(...a) },
  }),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: {
      findUnique: (...a: unknown[]) => billSubFindUnique(...a),
      upsert: (...a: unknown[]) => billSubUpsert(...a),
      update: (...a: unknown[]) => billSubUpdate(...a),
    },
    billPlan: { findUnique: (...a: unknown[]) => planFindUnique(...a) },
  },
}));

import { GET as getMine, POST as subscribe } from '@/app/api/v1/agentbook-billing/me/subscription/route';
import { POST as createIntent } from '@/app/api/v1/agentbook-billing/me/subscription/intent/route';
import { POST as cancel } from '@/app/api/v1/agentbook-billing/me/subscription/cancel/route';
import { POST as reactivate } from '@/app/api/v1/agentbook-billing/me/subscription/reactivate/route';

beforeEach(() => {
  getCurrentPlan.mockReset(); customersCreate.mockReset(); setupIntentsCreate.mockReset();
  subscriptionsCreate.mockReset(); subscriptionsUpdate.mockReset();
  billSubFindUnique.mockReset(); billSubUpsert.mockReset(); billSubUpdate.mockReset();
  planFindUnique.mockReset();
});

function req(body?: unknown): NextRequest {
  return new NextRequest('http://x/me', { method: 'POST', body: body ? JSON.stringify(body) : undefined });
}

describe('GET /me/subscription', () => {
  it('returns the current plan summary', async () => {
    getCurrentPlan.mockResolvedValue({
      plan: { id: 'p1', code: 'free', name: 'Free', priceCents: 0, features: {telegram_bot:false,tax_package_generation:false,multi_user_teams:false}, quotas: {expenses_created:50,ocr_scans:10,ai_messages:100,invoices_sent:5,bank_connections:0} },
      status: 'active', periodEnd: null, cancelAtPeriodEnd: false,
      usage: { expenses_created:{used:0,limit:50}, ocr_scans:{used:0,limit:10}, ai_messages:{used:0,limit:100}, invoices_sent:{used:0,limit:5}, bank_connections:{used:0,limit:0} },
    });
    const r = await getMine(new NextRequest('http://x/me'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.plan.code).toBe('free');
  });
});

describe('POST /me/subscription/intent', () => {
  it('creates Stripe Customer + SetupIntent', async () => {
    billSubFindUnique.mockResolvedValue(null);
    customersCreate.mockResolvedValue({ id: 'cus_x' });
    setupIntentsCreate.mockResolvedValue({ id: 'seti_x', client_secret: 'seti_x_secret_y' });
    billSubUpsert.mockResolvedValue({});
    const r = await createIntent(req());
    const j = await r.json();
    expect(r.status).toBe(200);
    expect(j.clientSecret).toBe('seti_x_secret_y');
  });

  it('reuses existing customer', async () => {
    billSubFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_existing' });
    setupIntentsCreate.mockResolvedValue({ id: 's', client_secret: 'sec' });
    const r = await createIntent(req());
    expect(r.status).toBe(200);
    expect(customersCreate).not.toHaveBeenCalled();
  });
});

describe('POST /me/subscription', () => {
  it('creates the subscription', async () => {
    billSubFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_x' });
    planFindUnique.mockResolvedValue({ id: 'plan-pro', stripePriceId: 'price_y' });
    subscriptionsCreate.mockResolvedValue({
      id: 'sub_x', status: 'active',
      current_period_start: 1700000000, current_period_end: 1702592000,
      cancel_at_period_end: false,
    });
    billSubUpsert.mockResolvedValue({});
    const r = await subscribe(req({ planId: 'plan-pro', paymentMethodId: 'pm_x' }));
    expect(r.status).toBe(200);
    expect(subscriptionsCreate).toHaveBeenCalled();
  });
});

describe('POST /me/subscription/cancel', () => {
  it('sets cancel_at_period_end', async () => {
    billSubFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_x' });
    subscriptionsUpdate.mockResolvedValue({});
    billSubUpdate.mockResolvedValue({});
    const r = await cancel(req());
    expect(r.status).toBe(200);
    expect(subscriptionsUpdate).toHaveBeenCalledWith('sub_x', { cancel_at_period_end: true });
  });
});

describe('POST /me/subscription/reactivate', () => {
  it('clears cancel_at_period_end', async () => {
    billSubFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_x' });
    subscriptionsUpdate.mockResolvedValue({});
    billSubUpdate.mockResolvedValue({});
    const r = await reactivate(req());
    expect(r.status).toBe(200);
    expect(subscriptionsUpdate).toHaveBeenCalledWith('sub_x', { cancel_at_period_end: false });
  });
});
```

- [ ] **Step 2: Create `me/subscription/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { getCurrentPlan, invalidateAccount } from '@naap/billing';
import { getStripe } from '@/lib/billing/stripe';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const tenantId = await resolveAgentbookTenant(request);
  const cur = await getCurrentPlan(tenantId);
  return NextResponse.json(cur);
}

const Body = z.object({
  planId: z.string(),
  paymentMethodId: z.string(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const tenantId = await resolveAgentbookTenant(request);
  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const { planId, paymentMethodId } = parsed.data;

  const plan = await prisma.billPlan.findUnique({ where: { id: planId } });
  if (!plan?.stripePriceId) return NextResponse.json({ error: 'plan has no Stripe price' }, { status: 400 });

  const sub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  const customerId = sub?.stripeCustomerId;
  if (!customerId) return NextResponse.json({ error: 'no customer; call /intent first' }, { status: 400 });

  try {
    const stripeSub = await getStripe().subscriptions.create({
      customer: customerId,
      items: [{ price: plan.stripePriceId }],
      default_payment_method: paymentMethodId,
      metadata: { tenantId },
    });
    await prisma.billSubscription.upsert({
      where: { accountId: tenantId },
      create: {
        accountId: tenantId, planId, status: stripeSub.status,
        stripeCustomerId: customerId, stripeSubscriptionId: stripeSub.id,
        currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
        currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      },
      update: {
        planId, status: stripeSub.status, stripeSubscriptionId: stripeSub.id,
        currentPeriodStart: new Date(stripeSub.current_period_start * 1000),
        currentPeriodEnd: new Date(stripeSub.current_period_end * 1000),
        cancelAtPeriodEnd: stripeSub.cancel_at_period_end,
      },
    });
    invalidateAccount(tenantId);
    return NextResponse.json({ ok: true, subscriptionId: stripeSub.id });
  } catch (err) {
    console.error('[billing] subscribe failed:', err);
    return NextResponse.json({ error: 'subscribe failed' }, { status: 502 });
  }
}
```

- [ ] **Step 3: Create `me/subscription/intent/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const tenantId = await resolveAgentbookTenant(request);
  const stripe = getStripe();
  const existing = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  let customerId = existing?.stripeCustomerId ?? null;
  if (!customerId) {
    const cust = await stripe.customers.create({ metadata: { tenantId } });
    customerId = cust.id;
    await prisma.billSubscription.upsert({
      where: { accountId: tenantId },
      create: {
        accountId: tenantId,
        planId: (await prisma.billPlan.findFirst({ where: { code: 'free' } }))?.id ?? '',
        status: 'active',
        stripeCustomerId: customerId,
      },
      update: { stripeCustomerId: customerId },
    });
  }
  const seti = await stripe.setupIntents.create({ customer: customerId, payment_method_types: ['card'] });
  return NextResponse.json({ clientSecret: seti.client_secret, customerId });
}
```

- [ ] **Step 4: Create `me/subscription/cancel/route.ts` + `reactivate/route.ts`**

`cancel/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { invalidateAccount } from '@naap/billing';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const tenantId = await resolveAgentbookTenant(request);
  const sub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  if (!sub?.stripeSubscriptionId) return NextResponse.json({ error: 'no active subscription' }, { status: 404 });
  await getStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
  await prisma.billSubscription.update({ where: { accountId: tenantId }, data: { cancelAtPeriodEnd: true } });
  invalidateAccount(tenantId);
  return NextResponse.json({ ok: true });
}
```

`reactivate/route.ts` (same shape, flips the boolean):

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { invalidateAccount } from '@naap/billing';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const tenantId = await resolveAgentbookTenant(request);
  const sub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  if (!sub?.stripeSubscriptionId) return NextResponse.json({ error: 'no subscription' }, { status: 404 });
  await getStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
  await prisma.billSubscription.update({ where: { accountId: tenantId }, data: { cancelAtPeriodEnd: false, canceledAt: null } });
  invalidateAccount(tenantId);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 5: Run + commit**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p/apps/web-next
npx vitest run __tests__/api/v1/agentbook-billing/user-routes.test.ts
```

Expected: 6 pass.

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/me/ apps/web-next/__tests__/api/v1/agentbook-billing/user-routes.test.ts
git commit -m "feat(billing): user routes — subscribe, cancel, reactivate

- GET    /me/subscription              → current plan + usage
- POST   /me/subscription/intent       → SetupIntent for Payment Element
- POST   /me/subscription              → create Stripe Subscription
- POST   /me/subscription/cancel       → cancel_at_period_end=true
- POST   /me/subscription/reactivate   → cancel_at_period_end=false

Each mutation invalidates the @naap/billing cache so the next
entitlement check refreshes from DB."
```

### Task 6.2: PR + merge

- [ ] **Step 1: Push, PR, merge**

```bash
git push -u origin feat/billing-phase-6-user-routes
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-6-user-routes \
  --title "feat(billing): phase 6 — user backend routes" \
  --body "Subscribe / cancel / reactivate / view routes for AgentBook users. UI ships in phase 7.

Test plan: 6 vitest tests pass; full flow exercised in phase 8 E2E."
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

---

## Phase 7 — User frontend with Stripe Payment Element (PR 7)

**Goal:** `/billing` page showing current plan, usage bars, upgrade button, Payment Element modal, cancel/reactivate controls.

**Branch:** `feat/billing-phase-7-user-frontend`

**Files (under `plugins/agentbook-billing/frontend/src/user/`):**
- `UserApp.tsx` — main page
- `CurrentPlanCard.tsx` — current plan + status + cancel/reactivate
- `UsageBars.tsx` — visualises used/limit per dimension
- `PlanGrid.tsx` — available plans + Subscribe buttons
- `SubscribeModal.tsx` — Stripe Elements + Payment Element
- `__tests__/user-app.test.tsx`

### Task 7.1: User pages without payment

- [ ] **Step 1: Branch**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull
git checkout -b feat/billing-phase-7-user-frontend
```

- [ ] **Step 2: Add user-facing API methods to `lib/api.ts`**

Append to `plugins/agentbook-billing/frontend/src/lib/api.ts`:

```ts
export interface CurrentPlanView {
  plan: Plan;
  status: 'active' | 'trialing' | 'past_due' | 'canceled' | 'incomplete';
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  usage: Record<string, { used: number; limit: number }>;
}

export const meApi = {
  current: async (): Promise<CurrentPlanView> =>
    json<CurrentPlanView>(await fetch('/api/v1/agentbook-billing/me/subscription')),
  intent: async (): Promise<{ clientSecret: string; customerId: string }> =>
    json(await fetch('/api/v1/agentbook-billing/me/subscription/intent', { method: 'POST' })),
  subscribe: async (planId: string, paymentMethodId: string): Promise<void> => {
    await json(await fetch('/api/v1/agentbook-billing/me/subscription', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ planId, paymentMethodId }),
    }));
  },
  cancel: async (): Promise<void> => { await json(await fetch('/api/v1/agentbook-billing/me/subscription/cancel', { method: 'POST' })); },
  reactivate: async (): Promise<void> => { await json(await fetch('/api/v1/agentbook-billing/me/subscription/reactivate', { method: 'POST' })); },
};
```

- [ ] **Step 3: Create `user/UsageBars.tsx`**

```tsx
const LABELS: Record<string, string> = {
  expenses_created: 'Expenses created',
  ocr_scans: 'Receipt scans',
  ai_messages: 'AI messages',
  invoices_sent: 'Invoices sent',
  bank_connections: 'Bank connections',
};

export function UsageBars({ usage }: { usage: Record<string, { used: number; limit: number }> }): JSX.Element {
  return (
    <div className="space-y-2">
      {Object.entries(usage).map(([dim, { used, limit }]) => {
        const isUnlimited = limit === -1;
        const pct = isUnlimited ? 0 : Math.min(100, Math.round((used / Math.max(1, limit)) * 100));
        return (
          <div key={dim}>
            <div className="flex justify-between text-xs text-gray-600">
              <span>{LABELS[dim] ?? dim}</span>
              <span>{used} {isUnlimited ? '' : `/ ${limit}`}</span>
            </div>
            {!isUnlimited && (
              <div className="h-2 w-full rounded bg-gray-100">
                <div className={`h-2 rounded ${pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-400' : 'bg-blue-500'}`} style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Create `user/CurrentPlanCard.tsx`**

```tsx
import { meApi, type CurrentPlanView } from '../lib/api';

export function CurrentPlanCard({ view, onRefresh }: { view: CurrentPlanView; onRefresh: () => void }): JSX.Element {
  const cancel = async (): Promise<void> => {
    if (!window.confirm('Cancel at the end of the current period?')) return;
    await meApi.cancel(); onRefresh();
  };
  const reactivate = async (): Promise<void> => { await meApi.reactivate(); onRefresh(); };

  return (
    <div className="rounded-lg border bg-white p-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase text-gray-500">Current plan</div>
          <div className="text-2xl font-semibold">{view.plan.name}</div>
        </div>
        <div className="text-right text-sm">
          <div>${(view.plan.priceCents / 100).toFixed(2)} / {view.plan.interval}</div>
          <div className="text-gray-500">{view.status}</div>
          {view.periodEnd && <div className="text-gray-500">Renews {new Date(view.periodEnd).toLocaleDateString()}</div>}
        </div>
      </div>
      {view.cancelAtPeriodEnd && (
        <div className="mt-3 flex items-center justify-between rounded bg-amber-50 p-3 text-sm">
          <span>Cancels at the end of the current period.</span>
          <button onClick={reactivate} className="text-blue-600">Reactivate</button>
        </div>
      )}
      {!view.cancelAtPeriodEnd && view.plan.code !== 'free' && view.status === 'active' && (
        <div className="mt-3 text-right">
          <button onClick={cancel} className="text-sm text-red-600">Cancel subscription</button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Create `user/PlanGrid.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { billingApi, type Plan } from '../lib/api';

export function PlanGrid({ currentPlanCode, onSubscribe }: { currentPlanCode: string; onSubscribe: (p: Plan) => void }): JSX.Element {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  useEffect(() => { billingApi.listPlans().then(setPlans); }, []);
  if (!plans) return <div className="text-gray-500">Loading plans…</div>;
  return (
    <div className="grid grid-cols-3 gap-4">
      {plans.map(p => (
        <div key={p.id} className="rounded-lg border bg-white p-5">
          <div className="text-lg font-semibold">{p.name}</div>
          <div className="text-sm text-gray-500">${(p.priceCents / 100).toFixed(0)} / {p.interval}</div>
          <p className="mt-2 text-sm text-gray-600">{p.description}</p>
          <ul className="mt-3 space-y-1 text-xs text-gray-700">
            <li>Telegram bot: {p.features.telegram_bot ? '✓' : '—'}</li>
            <li>Tax packages: {p.features.tax_package_generation ? '✓' : '—'}</li>
            <li>OCR scans: {p.quotas.ocr_scans === -1 ? '∞' : p.quotas.ocr_scans}/mo</li>
          </ul>
          <button
            disabled={p.code === currentPlanCode}
            onClick={() => onSubscribe(p)}
            className="mt-4 w-full rounded bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-40">
            {p.code === currentPlanCode ? 'Current plan' : p.priceCents === 0 ? 'Downgrade' : 'Upgrade'}
          </button>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 6: Commit (without payment element yet)**

```bash
git add plugins/agentbook-billing/frontend/src/lib/api.ts plugins/agentbook-billing/frontend/src/user/
git commit -m "feat(billing): user views — current plan, usage bars, plan grid

CurrentPlanCard shows status + cancel/reactivate. UsageBars render
red when ≥ 90% of quota. PlanGrid disables the current plan's
button and labels others Upgrade / Downgrade. No payment flow yet."
```

### Task 7.2: Stripe Payment Element subscribe flow

- [ ] **Step 1: Create `user/SubscribeModal.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { meApi, type Plan } from '../lib/api';

declare global { interface Window { STRIPE_PUBLISHABLE_KEY?: string; } }

let _stripePromise: Promise<Stripe | null> | null = null;
function stripePromise(): Promise<Stripe | null> {
  if (!_stripePromise) {
    const key = window.STRIPE_PUBLISHABLE_KEY ?? '';
    _stripePromise = loadStripe(key);
  }
  return _stripePromise;
}

function PayForm({ plan, clientSecret, onDone }: { plan: Plan; clientSecret: string; onDone: () => void }): JSX.Element {
  const stripe = useStripe();
  const elements = useElements();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true); setErr(null);
    const { error, setupIntent } = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    });
    if (error) { setErr(error.message ?? 'Payment failed'); setBusy(false); return; }
    const pmId = typeof setupIntent?.payment_method === 'string' ? setupIntent.payment_method : setupIntent?.payment_method?.id;
    if (!pmId) { setErr('No payment method'); setBusy(false); return; }
    try {
      await meApi.subscribe(plan.id, pmId);
      onDone();
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <PaymentElement />
      {err && <div className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{err}</div>}
      <button type="submit" disabled={!stripe || busy} className="mt-4 w-full rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
        {busy ? 'Processing…' : `Subscribe to ${plan.name}`}
      </button>
    </form>
  );
}

export function SubscribeModal({ plan, onClose, onDone }: { plan: Plan; onClose: () => void; onDone: () => void }): JSX.Element {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { meApi.intent().then(r => setClientSecret(r.clientSecret)).catch(e => setErr(String(e))); }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[480px] rounded-lg bg-white p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Upgrade to {plan.name}</h3>
          <button onClick={onClose} aria-label="close" className="text-gray-500">×</button>
        </div>
        {err && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{err}</div>}
        {!clientSecret ? (
          <div className="text-sm text-gray-500">Preparing checkout…</div>
        ) : (
          <Elements stripe={stripePromise()} options={{ clientSecret, appearance: { theme: 'stripe' } }}>
            <PayForm plan={plan} clientSecret={clientSecret} onDone={onDone} />
          </Elements>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire `user/UserApp.tsx`**

Replace the stub from Phase 5 with:

```tsx
import { useEffect, useState } from 'react';
import { CurrentPlanCard } from './CurrentPlanCard';
import { UsageBars } from './UsageBars';
import { PlanGrid } from './PlanGrid';
import { SubscribeModal } from './SubscribeModal';
import { meApi, type CurrentPlanView, type Plan } from '../lib/api';

export function UserApp(): JSX.Element {
  const [view, setView] = useState<CurrentPlanView | null>(null);
  const [picking, setPicking] = useState<Plan | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    meApi.current().then(setView).catch(console.error);
  }, [refresh]);

  if (!view) return <div className="p-6 text-gray-500">Loading…</div>;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <CurrentPlanCard view={view} onRefresh={() => setRefresh(r => r + 1)} />
      <div className="rounded-lg border bg-white p-6">
        <h3 className="mb-3 text-sm font-medium text-gray-600">Usage this period</h3>
        <UsageBars usage={view.usage} />
      </div>
      <h3 className="text-lg font-semibold">Plans</h3>
      <PlanGrid currentPlanCode={view.plan.code} onSubscribe={setPicking} />
      {picking && <SubscribeModal plan={picking} onClose={() => setPicking(null)} onDone={() => { setPicking(null); setRefresh(r => r + 1); }} />}
    </div>
  );
}
```

- [ ] **Step 3: Expose `STRIPE_PUBLISHABLE_KEY` to the frontend**

Modify `apps/web-next/src/app/layout.tsx` (or the existing root layout) to add a script tag that injects the publishable key:

```tsx
<script
  dangerouslySetInnerHTML={{
    __html: `window.STRIPE_PUBLISHABLE_KEY = ${JSON.stringify(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '')};`,
  }}
/>
```

(also add the env var to Vercel as `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...`).

- [ ] **Step 4: Build + copy bundle**

```bash
cd plugins/agentbook-billing/frontend && npm run build
cp dist/production/agentbook-billing.js /Users/qianghan/Documents/mycodespace/a3p/apps/web-next/public/cdn/plugins/agentbook-billing/agentbook-billing.js
cp dist/production/agentbook-billing.js /Users/qianghan/Documents/mycodespace/a3p/apps/web-next/public/cdn/plugins/agentbook-billing/1.0.0/agentbook-billing.js
```

- [ ] **Step 5: Commit + PR + merge**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git add plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx plugins/agentbook-billing/frontend/src/user/UserApp.tsx apps/web-next/src/app/layout.tsx apps/web-next/public/cdn/plugins/agentbook-billing/
git commit -m "feat(billing): user /billing page with Stripe Payment Element

UserApp pulls current state + usage. PlanGrid surfaces upgrade
options. SubscribeModal: meApi.intent() → render Payment Element
with returned client_secret → user enters card → stripe.confirmSetup
(handles 3DS) → meApi.subscribe(planId, paymentMethodId) → reload.

NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY injected via root layout for
the frontend to consume."

git push -u origin feat/billing-phase-7-user-frontend
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-7-user-frontend \
  --title "feat(billing): phase 7 — user frontend with Payment Element" \
  --body "Smoke plan: login as Maya → /billing → click Upgrade → enter 4242 4242 4242 4242 → confirm → /billing reloads with Pro plan + new quotas."
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

---

## Phase 8 — Cron + entitlement integration + E2E (PR 8)

**Goal:** Final phase. Vercel Cron jobs wired. Library is called from the four agentbook plugins on the hot paths (Telegram bot, OCR, AI brain, invoice send). Playwright E2E covers the full subscribe-and-gate loop against Stripe test mode.

**Branch:** `feat/billing-phase-8-integration`

**Files (modify):**
- `vercel.json` — add 2 cron entries
- `apps/web-next/src/app/api/v1/agentbook-billing/cron/reset-quotas/route.ts` (new)
- `apps/web-next/src/app/api/v1/agentbook-billing/cron/cleanup-events/route.ts` (new)
- `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` — gate Telegram by `canUseFeature('telegram_bot')` and OCR by `checkQuota('ocr_scans')`
- `plugins/agentbook-core/backend/src/server.ts` — gate AI brain message ingress by `checkQuota('ai_messages')`
- `plugins/agentbook-expense/backend/src/routes/expenses.ts` — `incrementUsage(t, 'expenses_created')` on POST
- `plugins/agentbook-invoice/backend/src/routes/invoices.ts` — `incrementUsage(t, 'invoices_sent')` on send + `checkQuota('invoices_sent')`
- `plugins/agentbook-tax/backend/src/routes/...` — gate tax package endpoint by `canUseFeature('tax_package_generation')`
- `tests/e2e/billing.spec.ts` — Playwright

### Task 8.1: Cron jobs

- [ ] **Step 1: Branch + cron route — reset-quotas**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
git checkout main && git pull
git checkout -b feat/billing-phase-8-integration
mkdir -p apps/web-next/src/app/api/v1/agentbook-billing/cron/{reset-quotas,cleanup-events}
```

Create `apps/web-next/src/app/api/v1/agentbook-billing/cron/reset-quotas/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { invalidateAccount } from '@naap/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isAuthorized(request: NextRequest): boolean {
  const cron = request.headers.get('x-vercel-cron');
  const secret = request.nextUrl.searchParams.get('secret');
  return cron === '1' || secret === process.env.CRON_SECRET;
}

export async function POST(request: NextRequest): Promise<NextResponse> { return handle(request); }
export async function GET(request: NextRequest): Promise<NextResponse> { return handle(request); }

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!isAuthorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const stale = await prisma.billSubscription.findMany({
    where: { currentPeriodEnd: { lt: new Date() } },
    select: { accountId: true, stripeSubscriptionId: true, currentPeriodStart: true, currentPeriodEnd: true },
  });

  let updated = 0;
  for (const sub of stale) {
    try {
      if (sub.stripeSubscriptionId) {
        const fresh = await getStripe().subscriptions.retrieve(sub.stripeSubscriptionId);
        await prisma.billSubscription.update({
          where: { accountId: sub.accountId },
          data: {
            status: fresh.status,
            currentPeriodStart: new Date(fresh.current_period_start * 1000),
            currentPeriodEnd: new Date(fresh.current_period_end * 1000),
            cancelAtPeriodEnd: fresh.cancel_at_period_end,
          },
        });
      } else {
        // Free tier — roll forward one month from previous end
        const start = sub.currentPeriodEnd ?? new Date();
        const end = new Date(start);
        end.setUTCMonth(end.getUTCMonth() + 1);
        await prisma.billSubscription.update({
          where: { accountId: sub.accountId },
          data: { currentPeriodStart: start, currentPeriodEnd: end },
        });
      }
      invalidateAccount(sub.accountId);
      updated++;
    } catch (err) {
      console.error('[billing] reset-quotas failed for', sub.accountId, err);
    }
  }
  return NextResponse.json({ ok: true, updated });
}
```

- [ ] **Step 2: Create `cron/cleanup-events/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function authorized(r: NextRequest): boolean {
  return r.headers.get('x-vercel-cron') === '1' || r.nextUrl.searchParams.get('secret') === process.env.CRON_SECRET;
}

async function handle(request: NextRequest): Promise<NextResponse> {
  if (!authorized(request)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const cutoff = new Date(Date.now() - 90 * 86400_000);
  const result = await prisma.billEvent.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return NextResponse.json({ ok: true, deleted: result.count });
}

export const POST = handle;
export const GET = handle;
```

- [ ] **Step 3: Modify `vercel.json` to add the two crons**

In `vercel.json` line 124 region, add two entries before the closing `]`:

```json
    { "path": "/api/v1/agentbook-billing/cron/reset-quotas", "schedule": "0 0 * * *" },
    { "path": "/api/v1/agentbook-billing/cron/cleanup-events", "schedule": "0 3 * * 0" }
```

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/cron/ vercel.json
git commit -m "feat(billing): Vercel cron — reset-quotas (daily) + cleanup-events (weekly)

reset-quotas: rolls every BillSubscription with currentPeriodEnd<now
forward. Paid plans use Stripe as truth (subscriptions.retrieve);
free plans add one month. Invalidates plan cache on update.

cleanup-events: deletes BillEvent rows older than 90 days."
```

### Task 8.2: Telegram webhook entitlement gates

- [ ] **Step 1: Add gate at top of text handler in webhook**

In `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts`, after the existing tenant resolution and BEFORE invoking the agent brain (around the same area where the daily-briefing intercept lives), insert:

```ts
// PR 8: gate Telegram chat by canUseFeature
{
  const { canUseFeature } = await import('@naap/billing');
  if (!(await canUseFeature(tenantId, 'telegram_bot'))) {
    await ctx.reply(
      '🔒 The Telegram bot is a Pro feature. Upgrade your plan to chat with your AgentBook here:\nhttps://a3book.brainliber.com/billing',
    );
    return;
  }
}
```

And in the photo-handling section (where the OCR is invoked), wrap OCR with a quota check:

```ts
// PR 8: gate OCR by checkQuota
{
  const { checkQuota, incrementUsage } = await import('@naap/billing');
  const q = await checkQuota(tenantId, 'ocr_scans');
  if (!q.allowed) {
    await ctx.reply(
      `You've used all ${q.limit} receipt scans this month. Upgrade for more: https://a3book.brainliber.com/billing`,
    );
    return;
  }
  // ... existing OCR ...
  await incrementUsage(tenantId, 'ocr_scans', 1).catch(() => {});
  if (q.used + 1 >= q.limit * 0.8) {
    // Append soft warning to whatever the bot replies later
    // (the helper that builds the reply can call getUsage + format)
  }
}
```

(The exact insertion points depend on the current file structure — the implementer should grep for `await runAgentLoop` and `ocrReceipt` to find the right spots.)

- [ ] **Step 2: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts
git commit -m "feat(billing): gate Telegram bot + OCR via @naap/billing

Telegram chat now requires canUseFeature('telegram_bot'). OCR
scans are quota-checked via checkQuota('ocr_scans'); successful
scans increment the counter (best-effort). Soft 80%-warning is
prepared but not yet appended — defer to follow-up PR if needed."
```

### Task 8.3: Other plugin entitlement gates

- [ ] **Step 1: agentbook-core AI brain quota**

In `plugins/agentbook-core/backend/src/server.ts`, find the agent/message route handler and prepend a quota check:

```ts
import { checkQuota, incrementUsage } from '@naap/billing';

// inside POST /agent/message handler, near the top after tenant resolution:
const q = await checkQuota(req.tenantId, 'ai_messages');
if (!q.allowed) {
  return res.status(402).json({
    error: 'quota_exceeded',
    message: `You've used all ${q.limit} AI messages this period. Upgrade for more.`,
  });
}
// ... existing brain pipeline ...
await incrementUsage(req.tenantId, 'ai_messages', 1).catch(() => {});
```

- [ ] **Step 2: agentbook-expense — increment on POST /expenses**

In `plugins/agentbook-expense/backend/src/routes/expenses.ts`, after the `prisma.abExpense.create` call:

```ts
const { incrementUsage } = await import('@naap/billing');
await incrementUsage(req.tenantId, 'expenses_created', 1).catch(() => {});
```

- [ ] **Step 3: agentbook-invoice — gate + increment on send**

In `plugins/agentbook-invoice/backend/src/routes/invoices.ts`, in the POST /invoices/:id/send handler:

```ts
const { checkQuota, incrementUsage } = await import('@naap/billing');
const q = await checkQuota(req.tenantId, 'invoices_sent');
if (!q.allowed) return res.status(402).json({ error: 'quota_exceeded' });
// ... existing send logic ...
await incrementUsage(req.tenantId, 'invoices_sent', 1).catch(() => {});
```

- [ ] **Step 4: agentbook-tax — gate package generation**

In `plugins/agentbook-tax/backend/src/routes/...` (the tax-package endpoint), top of handler:

```ts
const { canUseFeature } = await import('@naap/billing');
if (!(await canUseFeature(req.tenantId, 'tax_package_generation'))) {
  return res.status(402).json({ error: 'feature_gated', message: 'Tax package generation requires Pro or above.' });
}
```

- [ ] **Step 5: Add `@naap/billing` to each plugin's `package.json` `dependencies`**

For each of `plugins/{agentbook-core,agentbook-expense,agentbook-invoice,agentbook-tax}/backend/package.json`, add:

```json
"@naap/billing": "*"
```

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts plugins/agentbook-expense/backend/src/routes/expenses.ts plugins/agentbook-invoice/backend/src/routes/invoices.ts plugins/agentbook-tax/backend/src/routes/ plugins/agentbook-*/backend/package.json
git commit -m "feat(billing): wire entitlement gates into the four agentbook plugins

- core   : checkQuota('ai_messages') → 402 when exceeded; increment
           after successful brain pipeline
- expense: incrementUsage('expenses_created') on create
- invoice: checkQuota+increment('invoices_sent') on send
- tax    : canUseFeature('tax_package_generation') gate on package
           generation

Each call is fail-open per @naap/billing's contract, so a billing
outage degrades to 'free for everyone' rather than breaking the
product."
```

### Task 8.4: E2E test against Stripe test mode

- [ ] **Step 1: Create `tests/e2e/billing.spec.ts`**

```ts
import { test, expect } from '@playwright/test';

const ADMIN = { email: 'admin@a3p.io', password: 'a3p-dev' };
const MAYA  = { email: 'maya@agentbook.test', password: 'agentbook123' };

test.describe('billing — admin flow', () => {
  test('admin can clone the Pro template and save a new plan', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', ADMIN.email);
    await page.fill('input[name="password"]', ADMIN.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|admin/);

    await page.goto('/admin/billing');
    await expect(page.getByRole('heading', { name: /subscription plans/i })).toBeVisible();
    await page.getByRole('button', { name: /new plan from template/i }).click();
    await page.getByText(/^Pro$/).click();
    // Editor opens pre-filled; just save
    await page.getByRole('button', { name: /^save$/i }).click();
    await expect(page.getByText('Pro').first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('billing — user subscribe + gate', () => {
  test('Maya can upgrade from Free to Pro with the test card', async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[name="email"]', MAYA.email);
    await page.fill('input[name="password"]', MAYA.password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard|agentbook/);

    await page.goto('/billing');
    await expect(page.getByText(/Current plan/i)).toBeVisible();

    await page.getByRole('button', { name: /upgrade/i }).first().click();
    await expect(page.getByText(/Upgrade to/i)).toBeVisible();

    const stripeFrame = page.frameLocator('iframe[name^="__privateStripeFrame"]').first();
    await stripeFrame.locator('[name="number"]').fill('4242 4242 4242 4242');
    await stripeFrame.locator('[name="expiry"]').fill('12 / 34');
    await stripeFrame.locator('[name="cvc"]').fill('123');
    await stripeFrame.locator('[name="postalCode"]').fill('12345');

    await page.getByRole('button', { name: /subscribe to/i }).click();
    await expect(page.getByText(/Pro/)).toBeVisible({ timeout: 30_000 });
  });
});
```

- [ ] **Step 2: Run locally (requires `stripe listen` running)**

```bash
cd /Users/qianghan/Documents/mycodespace/a3p
npx playwright test tests/e2e/billing.spec.ts --reporter=line
```

Expected: 2 tests pass (or report skipped if Stripe keys aren't configured locally).

- [ ] **Step 3: Commit + PR + merge**

```bash
git add tests/e2e/billing.spec.ts
git commit -m "test(billing): e2e — admin clones Pro template + Maya subscribes

Playwright drives the real /admin/billing + /billing pages end-to-end
against Stripe test mode. Card 4242 4242 4242 4242 confirms the
SetupIntent and the subsequent subscribe call flips Maya to Pro."

git push -u origin feat/billing-phase-8-integration
gh pr create -R qianghan/a3p --base main --head feat/billing-phase-8-integration \
  --title "feat(billing): phase 8 — cron + entitlement integration + e2e" \
  --body "Final phase. Vercel Cron resets quotas daily, cleans BillEvent weekly. The four agentbook plugins now consult @naap/billing on their hot paths (Telegram, OCR, AI brain, expenses, invoices, tax). Playwright e2e proves the full admin-cloned-plan → user-subscribed-with-real-Stripe flow.

After this merges, the billing plugin is feature complete per the design spec."
gh pr checks --watch -R qianghan/a3p $(gh pr view --json number -q .number -R qianghan/a3p)
gh pr merge -R qianghan/a3p --squash --delete-branch
git checkout main && git pull origin main
```

---

## Post-launch checklist (after Phase 8 merges)

- [ ] Verify Stripe Dashboard branding: logo + accent color applied (Stripe sends branded invoice emails to customers)
- [ ] Test invoice email delivery: subscribe Maya with a real address you control, verify email arrives and PDF renders with branding
- [ ] Configure `ADMIN_EMAILS=admin@a3p.io` on Production
- [ ] Confirm cron jobs are listed in Vercel Dashboard → Crons; each one was triggered at least once
- [ ] Open a Stripe Test Clock, advance one month, verify Stripe fires `customer.subscription.updated` and our webhook bumps `currentPeriodEnd` correctly
- [ ] Run nightly E2E suite once and confirm billing tests are picked up
- [ ] Update `agentbook/skills/architecture.md` to document the Vercel-native-no-Express pattern for future plugins


