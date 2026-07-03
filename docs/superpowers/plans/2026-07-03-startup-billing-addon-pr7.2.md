# Startup Tax Benefits — PR 7.2 (Billing Add-On Primitive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first add-on-style billing primitive in AgentBook — `BillAddOn`/`BillAddOnPrice`/`BillAddOnSubscription`, a `hasAddOn()`/`resolveAddOnPrice()` helper pair, and admin + user API routes wired to real Stripe objects (via mocked-Stripe tests, no live Stripe calls in this session) — so the `startup_tax_benefits` add-on ($99/yr founding-member, $249/yr standard, $499/yr scaled) can be purchased independently of the base `BillPlan` tier a tenant is on.

**Architecture:** Additive-only extension of the existing `plugin_agentbook_billing` schema, following the exact pattern already proven by `BillPlan`/`BillSubscription` (admin creates a Stripe Product+Price then a DB catalog row; a user calls the existing `/me/subscription/intent` endpoint to get a Stripe customer, then a new `/me/addons/[code]/subscribe` endpoint creates a *second*, independent Stripe Subscription scoped to the add-on; the existing webhook handler gets one new conditional branch — keyed on `subscription.metadata.addOnCode` — that syncs `BillAddOnSubscription` without changing any existing `BillPlan` webhook behavior). Pricing is data, not code: `BillAddOnPrice` rows carry `tier`/`region`/`currency`/`priceCents`/`maxSlots`/`availableUntil`, so the founding-member cap and price points can be tuned by an admin without a redeploy.

**Tech Stack:** TypeScript, Next.js route handlers (`apps/web-next`), Prisma (PostgreSQL, `plugin_agentbook_billing` schema), Stripe SDK (mocked in tests via `vi.mock`), Vitest.

## Global Constraints

- Source of truth for the pricing decision: this session's deep-research pass (Pilot.com's 20%-contingency reality, Fondo $1,450-1,950/yr, Zeni $2,499-3,899/yr, Canada SR&ED 10-30% contingency, Carta's free/graduated-tier precedent) plus the explicit user instruction to make pricing "ridiculously low but attractive" and configurable.
- **No live Stripe objects are created by running this plan.** No `STRIPE_SECRET_KEY` is configured in this local worktree — every test in this plan mocks `@/lib/billing/stripe`'s `getStripe()`. Creating real Stripe products/prices/subscriptions against a live or even test Stripe account is explicitly out of scope for this session; that only happens later when an admin calls the new endpoint in a real environment.
- Additive only: zero changes to `BillPlan`, `BillSubscription`, `BillUsageCounter`, `BillEvent`, `BillReferralCode`, `BillReferral`, or any existing route's behavior for events/requests that don't reference the new add-on.
- Money in integer cents, matching every other model in the codebase.
- This branch (`feat/startup-billing-addon`) is cut from `origin/main`, not from the still-open PR #199 (`feat/startup-tax-benefits`) — per the design's own PR-plan philosophy ("no PR depends on a future PR to be safe to deploy"), and because `BillAddOn` is a billing-schema primitive, not something owned by the `agentbook-startup` plugin directory. All seed data for the `startup_tax_benefits` catalog therefore lives in the seed script itself, not inside `plugins/agentbook-startup/` (that directory doesn't exist on this branch).
- Local verification only — the local docker Postgres (`postgresql://postgres:postgres@localhost:5432/naap`) is shared across worktrees. Every schema-touching step in this plan re-verifies that the *other* worktree's `plugin_agentbook_startup` tables (from the still-unmerged PR #199) are untouched, since `prisma db push` runs against the same physical database.

## Pricing catalog seeded by this plan

| Tier | priceCents (all 3 currencies, same nominal number) | maxSlots | Purpose |
|---|---|---|---|
| `founding_member` | 9900 ($99) | 250 | Land-grab/bootstrap hook, locked in per-subscriber forever once purchased (Stripe subscriptions keep their original Price on renewal) |
| `standard` | 24900 ($249) | null (unlimited) | Default price once founding-member slots are exhausted |
| `scaled` | 49900 ($499) | null (unlimited) | Catalog entry for a future post-Series-A tier; not auto-assigned by `resolveAddOnPrice` in this PR — reserved for a later admin-driven upgrade flow |

Seeded 3× for `region`/`currency` pairs: `us`/`usd`, `ca`/`cad`, `uk`/`gbp` (9 `BillAddOnPrice` rows total). No PPP-style regional discount is applied — the research explicitly found no reliable evidence for a specific discount percentage, so launching at price parity and adjusting later from real data is the honest choice.

---

## Task 1: Prisma schema — BillAddOn, BillAddOnPrice, BillAddOnSubscription

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (append 3 models to the existing `plugin_agentbook_billing` section — no new schema namespace needed, `plugin_agentbook_billing` is already in the datasource's `schemas` array)

**Interfaces:**
- Produces: 3 Prisma models consumed by every later task via `@naap/database`'s generated client: `db.billAddOn`, `db.billAddOnPrice`, `db.billAddOnSubscription`.

- [ ] **Step 1: Append the models**

Find the end of the `// AGENTBOOK BILLING PLUGIN` section in `packages/database/prisma/schema.prisma` (after the `BillReferral` model, before the next `// ===...` section header) and insert:

```prisma
// First add-on-style purchase primitive (independent of BillPlan tiers).
// See startup.html §8.7 and docs/superpowers/plans/2026-07-03-startup-billing-addon-pr7.2.md.
// One row per add-on product — v1 has exactly one: "startup_tax_benefits".
model BillAddOn {
  id        String   @id @default(uuid())
  code      String   @unique
  name      String
  interval  String   @default("year")
  isActive  Boolean  @default(true)
  createdAt DateTime @default(now())

  prices        BillAddOnPrice[]
  subscriptions BillAddOnSubscription[]

  @@schema("plugin_agentbook_billing")
}

// Configurable pricing — one row per (addOn, region, tier). Nothing about
// price points, the founding-member slot cap, or its cutoff date is
// hardcoded in application code; all of it is admin-editable data.
model BillAddOnPrice {
  id             String    @id @default(uuid())
  addOnId        String
  region         String    // "us" | "ca" | "uk"
  currency       String    // "usd" | "cad" | "gbp"
  tier           String    // "founding_member" | "standard" | "scaled"
  priceCents     Int
  stripePriceId  String?
  maxSlots       Int?      // null = unlimited
  availableUntil DateTime? // null = no time limit
  isActive       Boolean   @default(true)
  createdAt      DateTime  @default(now())

  addOn         BillAddOn                @relation(fields: [addOnId], references: [id])
  subscriptions BillAddOnSubscription[]

  @@unique([addOnId, region, tier])
  @@schema("plugin_agentbook_billing")
}

// One active row per (account, add-on). priceId records which tier the
// account locked in — a founding-member subscriber keeps that Stripe
// Price (and its $99 renewal amount) even after the 250-slot cap fills.
model BillAddOnSubscription {
  id                   String    @id @default(uuid())
  accountId            String
  addOnId              String
  priceId              String
  status               String    // active | canceled
  stripeCustomerId     String?
  stripeSubscriptionId String?
  startedAt            DateTime  @default(now())
  canceledAt           DateTime?

  addOn BillAddOn      @relation(fields: [addOnId], references: [id])
  price BillAddOnPrice @relation(fields: [priceId], references: [id])

  @@unique([accountId, addOnId])
  @@schema("plugin_agentbook_billing")
}
```

- [ ] **Step 2: Validate and generate**

```bash
cd packages/database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" npx prisma validate
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" npx prisma generate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀` then `Generated Prisma Client`.

- [ ] **Step 3: Push to the local docker Postgres**

From the repo root:
```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx --no prisma db push --skip-generate --schema packages/database/prisma/schema.prisma
```
Expected: "Your database is now in sync with your Prisma schema." — no data-loss prompt (purely additive).

- [ ] **Step 4: Verify the 3 new tables exist AND PR #199's tables are untouched**

```bash
docker exec naap-db psql -U postgres -d naap -c "\dt plugin_agentbook_billing.\"BillAddOn\""
docker exec naap-db psql -U postgres -d naap -c "\dt plugin_agentbook_billing.\"BillAddOnPrice\""
docker exec naap-db psql -U postgres -d naap -c "\dt plugin_agentbook_billing.\"BillAddOnSubscription\""
docker exec naap-db psql -U postgres -d naap -c "\dt plugin_agentbook_startup.*"
```
Expected: first 3 commands each show one table. The 4th must still show the same 7 `StartupBenefit*` tables from PR #199 — if that command errors ("schema does not exist") or shows fewer than 7 tables, STOP: this `db push` incorrectly touched the other worktree's schema and must be investigated before continuing.

- [ ] **Step 5: Commit**

```bash
git add packages/database/prisma/schema.prisma
git commit -m "feat(billing): add BillAddOn/BillAddOnPrice/BillAddOnSubscription models"
```

---

## Task 2: `hasAddOn()` and `resolveAddOnPrice()` helpers

**Files:**
- Create: `packages/billing/src/addons.ts`
- Modify: `packages/billing/src/index.ts` (export the new functions)
- Test: `packages/billing/__tests__/addons.test.ts`

**Interfaces:**
- Consumes: `db.billAddOn`, `db.billAddOnPrice`, `db.billAddOnSubscription` (Task 1); `resolveAccountId` from `./account-resolver.js` (existing).
- Produces:
  - `hasAddOn(tenantId: string, code: string): Promise<boolean>` — used by `agentbook-startup`'s write routes starting in PR 7.4 (not built in this PR).
  - `resolveAddOnPrice(code: string, region: string): Promise<{ id: string; tier: string; priceCents: number; currency: string; stripePriceId: string | null } | null>` — used by Task 5's subscribe endpoint.

- [ ] **Step 1: Write the failing tests**

Create `packages/billing/__tests__/addons.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const addOnFindUnique = vi.fn();
const addOnSubFindUnique = vi.fn();
const priceFindMany = vi.fn();
const addOnSubCount = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billAddOn: { findUnique: (...a: unknown[]) => addOnFindUnique(...a) },
    billAddOnSubscription: {
      findUnique: (...a: unknown[]) => addOnSubFindUnique(...a),
      count: (...a: unknown[]) => addOnSubCount(...a),
    },
    billAddOnPrice: { findMany: (...a: unknown[]) => priceFindMany(...a) },
  },
}));

import { hasAddOn, resolveAddOnPrice } from '../src/addons.js';

const addOn = { id: 'addon-1', code: 'startup_tax_benefits', isActive: true };

beforeEach(() => {
  addOnFindUnique.mockReset();
  addOnSubFindUnique.mockReset();
  addOnSubCount.mockReset();
  priceFindMany.mockReset();
});

describe('hasAddOn', () => {
  it('returns false when the add-on code does not exist', async () => {
    addOnFindUnique.mockResolvedValue(null);
    expect(await hasAddOn('tenant-1', 'nonexistent')).toBe(false);
  });

  it('returns false when the account has no BillAddOnSubscription row', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    addOnSubFindUnique.mockResolvedValue(null);
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(false);
  });

  it('returns false when the subscription status is canceled', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    addOnSubFindUnique.mockResolvedValue({ status: 'canceled' });
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(false);
  });

  it('returns true when the subscription status is active', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    addOnSubFindUnique.mockResolvedValue({ status: 'active' });
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(true);
  });

  it('fails closed (returns false) on a database error', async () => {
    addOnFindUnique.mockRejectedValue(new Error('connection lost'));
    expect(await hasAddOn('tenant-1', 'startup_tax_benefits')).toBe(false);
  });
});

describe('resolveAddOnPrice', () => {
  const founding = { id: 'price-founding', tier: 'founding_member', priceCents: 9900, currency: 'usd', stripePriceId: null, maxSlots: 250, availableUntil: null };
  const standard = { id: 'price-standard', tier: 'standard', priceCents: 24900, currency: 'usd', stripePriceId: null, maxSlots: null, availableUntil: null };

  it('returns the founding_member price when slots remain', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    priceFindMany.mockResolvedValue([founding, standard]);
    addOnSubCount.mockResolvedValue(10); // 10 of 250 taken
    const price = await resolveAddOnPrice('startup_tax_benefits', 'us');
    expect(price?.tier).toBe('founding_member');
    expect(price?.priceCents).toBe(9900);
  });

  it('falls back to standard once maxSlots is reached', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    priceFindMany.mockResolvedValue([founding, standard]);
    addOnSubCount.mockResolvedValue(250); // cap reached
    const price = await resolveAddOnPrice('startup_tax_benefits', 'us');
    expect(price?.tier).toBe('standard');
    expect(price?.priceCents).toBe(24900);
  });

  it('falls back to standard once availableUntil has passed', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    const expiredFounding = { ...founding, availableUntil: new Date('2020-01-01') };
    priceFindMany.mockResolvedValue([expiredFounding, standard]);
    addOnSubCount.mockResolvedValue(0);
    const price = await resolveAddOnPrice('startup_tax_benefits', 'us');
    expect(price?.tier).toBe('standard');
  });

  it('returns null when the add-on has no price row for the region', async () => {
    addOnFindUnique.mockResolvedValue(addOn);
    priceFindMany.mockResolvedValue([]);
    const price = await resolveAddOnPrice('startup_tax_benefits', 'de');
    expect(price).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/billing && npx vitest run __tests__/addons.test.ts`
Expected: FAIL — `Cannot find module '../src/addons.js'`.

- [ ] **Step 3: Implement `packages/billing/src/addons.ts`**

```ts
import { prisma } from '@naap/database';
import { resolveAccountId } from './account-resolver.js';

export interface ResolvedAddOnPrice {
  id: string;
  tier: string;
  priceCents: number;
  currency: string;
  stripePriceId: string | null;
}

/**
 * Fail-closed entitlement check (mirrors checkQuota's G-022 property):
 * any error resolving the add-on or its subscription denies access
 * rather than granting it.
 */
export async function hasAddOn(tenantId: string, code: string): Promise<boolean> {
  try {
    const accountId = await resolveAccountId(tenantId);
    const addOn = await prisma.billAddOn.findUnique({ where: { code } });
    if (!addOn || !addOn.isActive) return false;
    const sub = await prisma.billAddOnSubscription.findUnique({
      where: { accountId_addOnId: { accountId, addOnId: addOn.id } },
    });
    return sub?.status === 'active';
  } catch (err) {
    console.error('[billing] hasAddOn failed, denying (fail-closed):', err);
    return false;
  }
}

/**
 * Pick which price tier a NEW subscriber should be offered for a given
 * region: founding_member while slots/time remain, else standard.
 * "scaled" is never auto-assigned — it's for a future admin-driven
 * upgrade flow once an account outgrows the bootstrap tiers.
 */
export async function resolveAddOnPrice(code: string, region: string): Promise<ResolvedAddOnPrice | null> {
  const addOn = await prisma.billAddOn.findUnique({ where: { code } });
  if (!addOn || !addOn.isActive) return null;

  const prices = await prisma.billAddOnPrice.findMany({
    where: { addOnId: addOn.id, region, isActive: true },
  });
  const founding = prices.find((p) => p.tier === 'founding_member');
  const standard = prices.find((p) => p.tier === 'standard');

  if (founding) {
    const now = new Date();
    const withinTime = !founding.availableUntil || now < founding.availableUntil;
    let withinSlots = true;
    if (founding.maxSlots !== null) {
      const taken = await prisma.billAddOnSubscription.count({ where: { priceId: founding.id } });
      withinSlots = taken < founding.maxSlots;
    }
    if (withinTime && withinSlots) {
      return { id: founding.id, tier: founding.tier, priceCents: founding.priceCents, currency: founding.currency, stripePriceId: founding.stripePriceId };
    }
  }

  if (standard) {
    return { id: standard.id, tier: standard.tier, priceCents: standard.priceCents, currency: standard.currency, stripePriceId: standard.stripePriceId };
  }

  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/billing && npx vitest run __tests__/addons.test.ts`
Expected: all 9 tests PASS.

- [ ] **Step 5: Export from the package barrel**

In `packages/billing/src/index.ts`, add after the `checkQuota` export line:
```ts
export { hasAddOn, resolveAddOnPrice, type ResolvedAddOnPrice } from './addons.js';
```

- [ ] **Step 6: Run the full billing package suite to confirm no regressions**

Run: `cd packages/billing && npx vitest run`
Expected: all existing suites plus the new `addons.test.ts` pass.

- [ ] **Step 7: Commit**

```bash
git add packages/billing/src/addons.ts packages/billing/src/index.ts packages/billing/__tests__/addons.test.ts
git commit -m "feat(billing): add hasAddOn() and resolveAddOnPrice() helpers"
```

---

## Task 3: Seed the `startup_tax_benefits` add-on catalog

**Files:**
- Create: `bin/seed-startup-benefit-addon.ts`

**Interfaces:**
- Consumes: `db.billAddOn`, `db.billAddOnPrice` (Task 1).
- Produces: 1 `BillAddOn` row (`code: "startup_tax_benefits"`) and 9 `BillAddOnPrice` rows (3 tiers × 3 regions) that Task 2's `resolveAddOnPrice('startup_tax_benefits', 'us'|'ca'|'uk')` and Task 5's subscribe endpoint depend on existing.

- [ ] **Step 1: Write the seed script**

Create `bin/seed-startup-benefit-addon.ts`:
```ts
import { prisma as db } from '@naap/database';

const ADDON_CODE = 'startup_tax_benefits';

const REGIONS: { region: string; currency: string }[] = [
  { region: 'us', currency: 'usd' },
  { region: 'ca', currency: 'cad' },
  { region: 'uk', currency: 'gbp' },
];

// Same nominal number across currencies — the pricing research found no
// reliable evidence for a specific regional discount, so this launches at
// parity and can be corrected later from real conversion data via
// BillAddOnPrice rows, with zero code changes.
const TIERS: { tier: string; priceCents: number; maxSlots: number | null }[] = [
  { tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
  { tier: 'standard', priceCents: 24900, maxSlots: null },
  { tier: 'scaled', priceCents: 49900, maxSlots: null },
];

async function main() {
  const addOn = await db.billAddOn.upsert({
    where: { code: ADDON_CODE },
    update: { name: 'Startup Tax Benefits', interval: 'year', isActive: true },
    create: { code: ADDON_CODE, name: 'Startup Tax Benefits', interval: 'year', isActive: true },
  });

  let created = 0;
  let updated = 0;

  for (const { region, currency } of REGIONS) {
    for (const { tier, priceCents, maxSlots } of TIERS) {
      const existing = await db.billAddOnPrice.findUnique({
        where: { addOnId_region_tier: { addOnId: addOn.id, region, tier } },
      });
      const data = { addOnId: addOn.id, region, currency, tier, priceCents, maxSlots, isActive: true };
      if (existing) {
        await db.billAddOnPrice.update({ where: { id: existing.id }, data });
        updated++;
      } else {
        await db.billAddOnPrice.create({ data });
        created++;
      }
    }
  }

  console.log(JSON.stringify({ addOnId: addOn.id, created, updated, total: REGIONS.length * TIERS.length }));
  await db.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run the seed script**

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap" \
npx tsx bin/seed-startup-benefit-addon.ts
```
Expected: `{"addOnId":"...","created":9,"updated":0,"total":9}`.

- [ ] **Step 3: Run it again to verify idempotency**

Same command again. Expected: `{"addOnId":"...","created":0,"updated":9,"total":9}`.

- [ ] **Step 4: Spot-check in Postgres**

```bash
docker exec naap-db psql -U postgres -d naap -c "SELECT region, tier, \"priceCents\", \"maxSlots\" FROM plugin_agentbook_billing.\"BillAddOnPrice\" ORDER BY region, tier;"
```
Expected: 9 rows — `founding_member`/9900/250, `scaled`/49900/(null), `standard`/24900/(null) for each of `ca`/`uk`/`us`.

- [ ] **Step 5: Commit**

```bash
git add bin/seed-startup-benefit-addon.ts
git commit -m "feat(billing): seed startup_tax_benefits add-on catalog"
```

---

## Task 4: Admin endpoint — create the add-on + Stripe product/prices

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-billing/addons/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-admin-routes.test.ts`

**Interfaces:**
- Consumes: `requireAdmin`/`HttpError` from `@/lib/billing/admin-auth` (existing, unchanged); `getStripe` from `@/lib/billing/stripe` (existing, unchanged); `db.billAddOn`/`db.billAddOnPrice` (Task 1).
- Produces: `GET /api/v1/agentbook-billing/addons` (public list of active add-ons+prices) and `POST /api/v1/agentbook-billing/addons/:code/prices` (admin-only: attach a live Stripe Price to an existing `BillAddOnPrice` row — mirrors `plans/[id]/route.ts`'s "attach IDs out-of-band" pattern rather than `plans/route.ts`'s "create everything at once", since this PR's catalog rows already exist from Task 3's seed and just need Stripe IDs attached later once an admin is ready to go live).

- [ ] **Step 1: Write the failing test**

Create `apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-admin-routes.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const validateSession = vi.fn();
const productsCreate = vi.fn();
const pricesCreate = vi.fn();
const addOnFindMany = vi.fn();
const priceFindUnique = vi.fn();
const priceUpdate = vi.fn();

vi.mock('@/lib/api/auth', () => ({ validateSession: (...a: unknown[]) => validateSession(...a) }));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    products: { create: (...a: unknown[]) => productsCreate(...a) },
    prices: { create: (...a: unknown[]) => pricesCreate(...a) },
  }),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    billAddOn: { findMany: (...a: unknown[]) => addOnFindMany(...a) },
    billAddOnPrice: {
      findUnique: (...a: unknown[]) => priceFindUnique(...a),
      update: (...a: unknown[]) => priceUpdate(...a),
    },
  },
}));

import { GET as listAddOns } from '@/app/api/v1/agentbook-billing/addons/route';
import { POST as createStripePrice } from '@/app/api/v1/agentbook-billing/addons/[code]/prices/route';

const adminUser = { id: 'admin-1', email: 'admin@a3p.io' };

beforeEach(() => {
  validateSession.mockReset(); productsCreate.mockReset(); pricesCreate.mockReset();
  addOnFindMany.mockReset(); priceFindUnique.mockReset(); priceUpdate.mockReset();
  process.env.ADMIN_EMAILS = 'admin@a3p.io';
});

function adminReq(body?: unknown): NextRequest {
  const r = new NextRequest('http://x/p', { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
  r.cookies.set('naap_auth_token', 'tok');
  return r;
}

describe('GET /addons', () => {
  it('returns active add-ons with their prices', async () => {
    addOnFindMany.mockResolvedValue([{ id: 'a1', code: 'startup_tax_benefits', name: 'Startup Tax Benefits', prices: [{ region: 'us', tier: 'standard', priceCents: 24900 }] }]);
    const r = await listAddOns(new NextRequest('http://x/addons'));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.addOns[0].code).toBe('startup_tax_benefits');
  });
});

describe('POST /addons/:code/prices/:priceId (attach Stripe price)', () => {
  it('creates a Stripe product+price and attaches the IDs, admin only', async () => {
    validateSession.mockResolvedValue(adminUser);
    priceFindUnique.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 24900, currency: 'usd', addOn: { code: 'startup_tax_benefits', name: 'Startup Tax Benefits', interval: 'year' } });
    productsCreate.mockResolvedValue({ id: 'prod_addon' });
    pricesCreate.mockResolvedValue({ id: 'price_addon_std' });
    priceUpdate.mockResolvedValue({ id: 'price-1', stripePriceId: 'price_addon_std' });
    const r = await createStripePrice(adminReq(), { params: Promise.resolve({ code: 'startup_tax_benefits', priceId: 'price-1' }) } as never);
    expect(r.status).toBe(200);
    expect(pricesCreate).toHaveBeenCalledWith(expect.objectContaining({ unit_amount: 24900, currency: 'usd' }));
  });

  it('rejects non-admin with 403', async () => {
    validateSession.mockResolvedValue({ id: 'u', email: 'maya@agentbook.test' });
    const r = await createStripePrice(adminReq(), { params: Promise.resolve({ code: 'startup_tax_benefits', priceId: 'price-1' }) } as never);
    expect(r.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing/addon-admin-routes.test.ts`
Expected: FAIL — route modules don't exist yet.

- [ ] **Step 3: Implement `apps/web-next/src/app/api/v1/agentbook-billing/addons/route.ts`**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';

export const runtime = 'nodejs';

export async function GET(_request: NextRequest): Promise<NextResponse> {
  const addOns = await prisma.billAddOn.findMany({
    where: { isActive: true },
    include: { prices: { where: { isActive: true } } },
  });
  return NextResponse.json({ addOns });
}
```

Note the test file also references `apps/web-next/src/app/api/v1/agentbook-billing/addons/[code]/prices/route.ts` — the plan intentionally scopes that endpoint's URL as `/addons/:code/prices/:priceId` conceptually, but Next.js route params require the dynamic segments to be actual path segments. Correct the route to `apps/web-next/src/app/api/v1/agentbook-billing/addons/[code]/prices/[priceId]/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

export const runtime = 'nodejs';

const Body = z.object({}).optional();

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string; priceId: string }> },
): Promise<NextResponse> {
  try {
    await requireAdmin(request);
  } catch (err) {
    const e = err as HttpError;
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  Body.parse(await request.json().catch(() => undefined));
  const { priceId } = await params;

  const price = await prisma.billAddOnPrice.findUnique({
    where: { id: priceId },
    include: { addOn: true },
  });
  if (!price) return NextResponse.json({ error: 'price not found' }, { status: 404 });

  const stripe = getStripe();
  try {
    const product = await stripe.products.create({
      name: `${price.addOn.name} (${price.tier})`,
      metadata: { addOnCode: price.addOn.code, tier: price.tier, region: price.region },
    });
    const stripePrice = await stripe.prices.create({
      product: product.id,
      unit_amount: price.priceCents,
      currency: price.currency,
      recurring: { interval: price.addOn.interval as 'year' | 'month' },
    });
    const updated = await prisma.billAddOnPrice.update({
      where: { id: priceId },
      data: { stripePriceId: stripePrice.id },
    });
    return NextResponse.json({ price: updated });
  } catch (err) {
    console.error('[billing] addon Stripe price create failed:', err);
    return NextResponse.json({ error: 'create failed' }, { status: 500 });
  }
}
```

Update the test file's import accordingly: `POST as createStripePrice from '@/app/api/v1/agentbook-billing/addons/[code]/prices/[priceId]/route'`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing/addon-admin-routes.test.ts`
Expected: all 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/addons apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-admin-routes.test.ts
git commit -m "feat(billing): admin endpoints to list add-ons and attach Stripe prices"
```

---

## Task 5: User endpoints — subscribe and cancel

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/route.ts` (GET status for the current tenant)
- Create: `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/[code]/subscribe/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/[code]/cancel/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-user-routes.test.ts`

**Interfaces:**
- Consumes: `safeResolveAgentbookTenant` from `@/lib/agentbook-tenant` (existing, unchanged); `hasAddOn`/`resolveAddOnPrice` (Task 2); `getStripe` (existing); reuses the *existing* `/me/subscription/intent` endpoint for Stripe customer creation — this task does not create a new customer-creation endpoint.
- Produces: the 3 routes above, which Task 6's webhook sync depends on for the `metadata.addOnCode` contract used when creating the Stripe subscription.

- [ ] **Step 1: Write the failing tests**

Create `apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-user-routes.test.ts`:
```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const hasAddOnMock = vi.fn();
const resolveAddOnPriceMock = vi.fn();
const billSubFindUnique = vi.fn();
const addOnSubFindUnique = vi.fn();
const addOnSubUpsert = vi.fn();
const addOnSubUpdate = vi.fn();
const subCreate = vi.fn();
const subUpdate = vi.fn();
const invalidateAccountMock = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/billing', () => ({
  hasAddOn: (...a: unknown[]) => hasAddOnMock(...a),
  resolveAddOnPrice: (...a: unknown[]) => resolveAddOnPriceMock(...a),
  invalidateAccount: (...a: unknown[]) => invalidateAccountMock(...a),
}));
vi.mock('@/lib/billing/stripe', () => ({
  getStripe: () => ({
    subscriptions: {
      create: (...a: unknown[]) => subCreate(...a),
      update: (...a: unknown[]) => subUpdate(...a),
    },
  }),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: { findUnique: (...a: unknown[]) => billSubFindUnique(...a) },
    billAddOnSubscription: {
      findUnique: (...a: unknown[]) => addOnSubFindUnique(...a),
      upsert: (...a: unknown[]) => addOnSubUpsert(...a),
      update: (...a: unknown[]) => addOnSubUpdate(...a),
    },
  },
}));

import { GET as getStatus } from '@/app/api/v1/agentbook-billing/me/addons/route';
import { POST as subscribe } from '@/app/api/v1/agentbook-billing/me/addons/[code]/subscribe/route';
import { POST as cancel } from '@/app/api/v1/agentbook-billing/me/addons/[code]/cancel/route';

const tenant = { tenantId: 'tenant-1' };

beforeEach(() => {
  resolveTenant.mockReset(); hasAddOnMock.mockReset(); resolveAddOnPriceMock.mockReset();
  billSubFindUnique.mockReset(); addOnSubFindUnique.mockReset(); addOnSubUpsert.mockReset();
  addOnSubUpdate.mockReset(); subCreate.mockReset(); subUpdate.mockReset(); invalidateAccountMock.mockReset();
  resolveTenant.mockResolvedValue(tenant);
});

function req(body?: unknown): NextRequest {
  return new NextRequest('http://x/p', { method: 'POST', body: body !== undefined ? JSON.stringify(body) : undefined });
}
function params(code: string) { return { params: Promise.resolve({ code }) }; }

describe('GET /me/addons', () => {
  it('reports active=false and a resolved price when not subscribed', async () => {
    hasAddOnMock.mockResolvedValue(false);
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'founding_member', priceCents: 9900, currency: 'usd' });
    const r = await getStatus(new NextRequest('http://x/me/addons?code=startup_tax_benefits&region=us'));
    const j = await r.json();
    expect(j.active).toBe(false);
    expect(j.price.tier).toBe('founding_member');
  });
});

describe('POST /me/addons/:code/subscribe', () => {
  it('requires an existing Stripe customer (call /intent first)', async () => {
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 24900, currency: 'usd', stripePriceId: 'price_x' });
    billSubFindUnique.mockResolvedValue(null);
    const r = await subscribe(req({ region: 'us', paymentMethodId: 'pm_1' }), params('startup_tax_benefits') as never);
    expect(r.status).toBe(400);
  });

  it('creates a Stripe subscription with addOnCode metadata and upserts BillAddOnSubscription', async () => {
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'founding_member', priceCents: 9900, currency: 'usd', stripePriceId: 'price_founding' });
    billSubFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    subCreate.mockResolvedValue({ id: 'sub_addon_1', status: 'active' });
    addOnSubUpsert.mockResolvedValue({ id: 'row-1' });
    const r = await subscribe(req({ region: 'us', paymentMethodId: 'pm_1' }), params('startup_tax_benefits') as never);
    expect(r.status).toBe(200);
    expect(subCreate).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'cus_1',
      items: [{ price: 'price_founding' }],
      metadata: expect.objectContaining({ tenantId: 'tenant-1', addOnCode: 'startup_tax_benefits' }),
    }));
    expect(addOnSubUpsert).toHaveBeenCalled();
    expect(invalidateAccountMock).toHaveBeenCalledWith('tenant-1');
  });

  it('rejects a price with no Stripe price ID attached yet', async () => {
    resolveAddOnPriceMock.mockResolvedValue({ id: 'price-1', tier: 'standard', priceCents: 24900, currency: 'usd', stripePriceId: null });
    billSubFindUnique.mockResolvedValue({ stripeCustomerId: 'cus_1' });
    const r = await subscribe(req({ region: 'us', paymentMethodId: 'pm_1' }), params('startup_tax_benefits') as never);
    expect(r.status).toBe(400);
  });
});

describe('POST /me/addons/:code/cancel', () => {
  it('cancels at period end and updates the local row', async () => {
    addOnSubFindUnique.mockResolvedValue({ stripeSubscriptionId: 'sub_addon_1', status: 'active' });
    const r = await cancel(req(), params('startup_tax_benefits') as never);
    expect(r.status).toBe(200);
    expect(subUpdate).toHaveBeenCalledWith('sub_addon_1', { cancel_at_period_end: true });
  });

  it('404s when there is no active subscription', async () => {
    addOnSubFindUnique.mockResolvedValue(null);
    const r = await cancel(req(), params('startup_tax_benefits') as never);
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing/addon-user-routes.test.ts`
Expected: FAIL — route modules don't exist.

- [ ] **Step 3: Implement the status route**

Create `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { hasAddOn, resolveAddOnPrice } from '@naap/billing';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const url = new URL(request.url);
  const code = url.searchParams.get('code') ?? 'startup_tax_benefits';
  const region = url.searchParams.get('region') ?? 'us';

  const active = await hasAddOn(tenantId, code);
  const price = await resolveAddOnPrice(code, region);
  return NextResponse.json({ active, price });
}
```

- [ ] **Step 4: Implement the subscribe route**

Create `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/[code]/subscribe/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@naap/database';
import { resolveAddOnPrice, invalidateAccount } from '@naap/billing';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

const Body = z.object({
  region: z.enum(['us', 'ca', 'uk']),
  paymentMethodId: z.string(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const { code } = await params;

  const parsed = Body.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  const { region, paymentMethodId } = parsed.data;

  const price = await resolveAddOnPrice(code, region);
  if (!price?.stripePriceId) {
    return NextResponse.json({ error: 'add-on has no Stripe price configured for this region yet' }, { status: 400 });
  }

  const billSub = await prisma.billSubscription.findUnique({ where: { accountId: tenantId } });
  const customerId = billSub?.stripeCustomerId;
  if (!customerId) {
    return NextResponse.json({ error: 'no customer; call /me/subscription/intent first' }, { status: 400 });
  }

  try {
    const stripeSub = await getStripe().subscriptions.create({
      customer: customerId,
      items: [{ price: price.stripePriceId }],
      default_payment_method: paymentMethodId,
      metadata: { tenantId, addOnCode: code, priceId: price.id, source: 'agentbook-billing-addon' },
    });
    const addOn = await prisma.billAddOn.findUnique({ where: { code } });
    await prisma.billAddOnSubscription.upsert({
      where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn!.id } },
      create: {
        accountId: tenantId, addOnId: addOn!.id, priceId: price.id,
        status: stripeSub.status, stripeCustomerId: customerId, stripeSubscriptionId: stripeSub.id,
      },
      update: {
        priceId: price.id, status: stripeSub.status, stripeSubscriptionId: stripeSub.id, canceledAt: null,
      },
    });
    invalidateAccount(tenantId);
    return NextResponse.json({ ok: true, subscriptionId: stripeSub.id, tier: price.tier });
  } catch (err) {
    console.error('[billing] addon subscribe failed:', err);
    return NextResponse.json({ error: 'subscribe failed' }, { status: 502 });
  }
}
```

- [ ] **Step 5: Implement the cancel route**

Create `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/[code]/cancel/route.ts`:
```ts
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@naap/database';
import { getStripe } from '@/lib/billing/stripe';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;
  const { code } = await params;

  const addOn = await prisma.billAddOn.findUnique({ where: { code } });
  if (!addOn) return NextResponse.json({ error: 'unknown add-on' }, { status: 404 });

  const sub = await prisma.billAddOnSubscription.findUnique({
    where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn.id } },
  });
  if (!sub?.stripeSubscriptionId) {
    return NextResponse.json({ error: 'no active subscription' }, { status: 404 });
  }
  await getStripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing/addon-user-routes.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-billing/me/addons apps/web-next/src/__tests__/api/v1/agentbook-billing/addon-user-routes.test.ts
git commit -m "feat(billing): user subscribe/cancel/status endpoints for add-ons"
```

---

## Task 6: Webhook sync — extend the existing handler without changing its BillPlan behavior

**Files:**
- Modify: `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts:9-46` (the `customer.subscription.created`/`updated` case) and its `customer.subscription.deleted` case
- Test: `apps/web-next/src/__tests__/api/v1/agentbook/stripe-webhook.test.ts` (add new cases; do not remove or alter existing ones)

**Interfaces:**
- Consumes: `db.billAddOnPrice`, `db.billAddOnSubscription` (Task 1); the `metadata.addOnCode` contract established by Task 5's subscribe route.
- Produces: `applyEvent()` now branches on `sub.metadata?.addOnCode` at the top of both subscription cases — if present, it updates `BillAddOnSubscription` and returns early; if absent, execution falls through to the existing, unmodified `BillPlan` logic.

- [ ] **Step 1: Write the new failing test cases**

In `apps/web-next/src/__tests__/api/v1/agentbook/stripe-webhook.test.ts`, add to the mock blocks (extend, don't replace):
```ts
const billAddOnPriceFindUnique = vi.fn();
const billAddOnFindUnique = vi.fn();
const billAddOnSubUpsert = vi.fn();
const billAddOnSubUpdate = vi.fn();
```
Add these to the existing `vi.mock('@naap/database', ...)` factory's `prisma` object (alongside the existing `billEvent`/`billSubscription`/`billPlan` keys):
```ts
billAddOnPrice: { findUnique: (...a: unknown[]) => billAddOnPriceFindUnique(...a) },
billAddOn: { findUnique: (...a: unknown[]) => billAddOnFindUnique(...a) },
billAddOnSubscription: {
  upsert: (...a: unknown[]) => billAddOnSubUpsert(...a),
  update: (...a: unknown[]) => billAddOnSubUpdate(...a),
},
```
Add resets for the 4 new mocks inside the existing `beforeEach`. Then add new test cases (find the `describe` block that posts `customer.subscription.created`/`updated`/`deleted` events and add siblings):
```ts
it('syncs a BillAddOnSubscription when the event has addOnCode metadata, without touching BillPlan', async () => {
  constructEvent.mockReturnValue({
    id: 'evt_addon_1',
    type: 'customer.subscription.updated',
    data: { object: {
      id: 'sub_addon_1', status: 'active', customer: 'cus_1',
      metadata: { tenantId: 'tenant-1', addOnCode: 'startup_tax_benefits', priceId: 'price-1' },
      items: { data: [{ price: { id: 'price_addon_std' } }] },
      current_period_start: 1700000000, current_period_end: 1702592000,
      cancel_at_period_end: false,
    } },
  });
  billEventCreate.mockResolvedValue({});
  billAddOnPriceFindUnique.mockResolvedValue({ id: 'price-1', addOnId: 'addon-1' });
  billAddOnSubUpsert.mockResolvedValue({});
  const r = await POST(req('{}', 'sig'));
  expect(r.status).toBe(200);
  expect(billAddOnSubUpsert).toHaveBeenCalledWith(expect.objectContaining({
    where: { accountId_addOnId: { accountId: 'tenant-1', addOnId: 'addon-1' } },
  }));
  expect(billPlanFindFirst).not.toHaveBeenCalled();
  expect(billSubscriptionUpsert).not.toHaveBeenCalled();
});

it('marks a BillAddOnSubscription canceled on subscription.deleted with addOnCode metadata', async () => {
  constructEvent.mockReturnValue({
    id: 'evt_addon_2',
    type: 'customer.subscription.deleted',
    data: { object: {
      id: 'sub_addon_1', customer: 'cus_1',
      metadata: { tenantId: 'tenant-1', addOnCode: 'startup_tax_benefits' },
    } },
  });
  billEventCreate.mockResolvedValue({});
  billAddOnFindUnique.mockResolvedValue({ id: 'addon-1' });
  billAddOnSubUpdate.mockResolvedValue({});
  const r = await POST(req('{}', 'sig'));
  expect(r.status).toBe(200);
  expect(billAddOnSubUpdate).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ status: 'canceled' }),
  }));
  expect(billSubscriptionUpdate).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify the new cases fail**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/stripe-webhook.test.ts`
Expected: the 2 new tests FAIL (handler doesn't branch on `addOnCode` yet); all pre-existing tests still PASS (confirms the test file edit itself didn't break anything before touching the handler).

- [ ] **Step 3: Extend the handler**

In `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts`, inside the `case 'customer.subscription.created': case 'customer.subscription.updated':` block, immediately after `const tenantId = ...` is resolved and the `if (!tenantId)` guard, insert the add-on branch before the existing `BillPlan` lookup:

```ts
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) {
        console.warn('[stripe-webhook] subscription missing tenantId metadata, skipping');
        return;
      }

      const addOnCode = sub.metadata?.addOnCode as string | undefined;
      if (addOnCode) {
        const priceIdMeta = sub.metadata?.priceId as string | undefined;
        const price = priceIdMeta
          ? await prisma.billAddOnPrice.findUnique({ where: { id: priceIdMeta } })
          : null;
        if (!price) {
          console.error('[stripe-webhook] add-on price not found for priceId', priceIdMeta);
          return;
        }
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
        await prisma.billAddOnSubscription.upsert({
          where: { accountId_addOnId: { accountId: tenantId, addOnId: price.addOnId } },
          create: {
            accountId: tenantId, addOnId: price.addOnId, priceId: price.id,
            status: sub.status, stripeCustomerId: customerId, stripeSubscriptionId: sub.id,
          },
          update: {
            priceId: price.id, status: sub.status, stripeSubscriptionId: sub.id, canceledAt: null,
          },
        });
        return;
      }

      const priceId = sub.items.data[0]?.price.id;
      const plan = priceId
        ? await prisma.billPlan.findFirst({ where: { stripePriceId: priceId } })
        : null;
      // ... existing BillPlan logic continues unchanged below this line
```

Then in the `case 'customer.subscription.deleted':` block, apply the same early-branch pattern:
```ts
    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const tenantId = (sub.metadata?.tenantId as string | undefined) ?? null;
      if (!tenantId) return;

      const addOnCode = sub.metadata?.addOnCode as string | undefined;
      if (addOnCode) {
        const addOn = await prisma.billAddOn.findUnique({ where: { code: addOnCode } });
        if (!addOn) return;
        await prisma.billAddOnSubscription.update({
          where: { accountId_addOnId: { accountId: tenantId, addOnId: addOn.id } },
          data: { status: 'canceled', canceledAt: new Date() },
        });
        return;
      }

      // ... existing BillPlan logic continues unchanged below this line
```

Do not otherwise reformat or reorder the surrounding, pre-existing `BillPlan` code in either case — the diff for this step should show only additions immediately after each case's `tenantId` guard.

- [ ] **Step 4: Run tests to verify everything passes**

Run: `cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook/stripe-webhook.test.ts`
Expected: all tests PASS — the 2 new add-on tests, plus every pre-existing `BillPlan`-path test unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts apps/web-next/src/__tests__/api/v1/agentbook/stripe-webhook.test.ts
git commit -m "feat(billing): sync BillAddOnSubscription from Stripe webhook events"
```

---

## Task 7: Full verification pass

**Files:** none created/modified — verification only.

- [ ] **Step 1: Run every touched test suite**

```bash
cd packages/billing && npx vitest run
cd ../../apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-billing src/__tests__/api/v1/agentbook/stripe-webhook.test.ts
```
Expected: all pass.

- [ ] **Step 2: Confirm PR #199's schema is still intact** (shared local DB)

```bash
docker exec naap-db psql -U postgres -d naap -c "\dt plugin_agentbook_startup.*"
```
Expected: same 7 `StartupBenefit*` tables as before Task 1.

- [ ] **Step 3: Review the diff against origin/main**

```bash
git diff origin/main --stat
```
Expected: only files from Tasks 1-6 — `packages/database/prisma/schema.prisma`, `packages/billing/src/{addons.ts,index.ts}`, `packages/billing/__tests__/addons.test.ts`, `bin/seed-startup-benefit-addon.ts`, `apps/web-next/src/app/api/v1/agentbook-billing/addons/**`, `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/**`, `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/handlers.ts`, and the 2 new/1 modified test files. Nothing under any other plugin or any other billing file (`plans.ts`, `quotas.ts`, `plans/route.ts`, etc.).

This task has no commit step — pure verification of Tasks 1-6's commits.
