# Launch-gap PR-4a: Pricing Source of Truth + Real Annual Billing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every price in this product is currently a separately hardcoded literal (marketing page strings, seed-script constants) with no shared source of truth — the root cause of a real, confirmed bug: Pro is `priceCents: 1900` ($19/mo) in `agentbook/seed-billing-plans.ts`, but the marketing page says "$20 a month" in three places. Fix that, establish one source of truth so it can't recur, and — per an explicit product decision made while scoping this PR — ship the "Pro Annual" option the marketing page already advertises but which doesn't actually exist as a purchasable product today, including the self-service subscribe flow needed to buy it.

**Architecture:** A new small workspace package (`packages/agentbook-pricing`, mirroring the existing `packages/agentbook-i18n`/`packages/agentbook-jurisdictions` pattern — importable via the `@agentbook/pricing` tsconfig path from both `bin/*.ts` scripts and `apps/web-next`) holds every price as data. The core-plan seed script, the four add-on seed scripts, and the marketing page all import from it instead of duplicating numbers. A new `BillPlan` row + a real Stripe Price make "Pro Annual" a real, purchasable product for the first time. A new Stripe Elements subscribe flow in Settings → Billing lets a user actually buy any core plan — today there is no such flow anywhere (the existing Billing tab is read-only, its "use the upgrade prompt in the app" text refers to a prompt that does not exist in the codebase).

**Tech Stack:** TypeScript workspace package, Prisma (`BillPlan`), Stripe Node SDK (already used) + `@stripe/stripe-js`/`@stripe/react-stripe-js` (new dependency — added in this plan, not yet present anywhere in the repo), Next.js, Vitest.

## Global Constraints

- **Real annual pricing decision (already made, not this plan's to reconsider):** Pro Annual = **$182/yr** (20% off $19×12=$228, rounded to a whole dollar), keeping the existing "save 20%" marketing framing accurate rather than changing the framing to match an arbitrary price. Pro Monthly stays $19/mo (confirmed authoritative from `BillPlan`/Stripe). $182/12 = $15.1667 → displayed as **$15.17/mo**.
- **Business plan decision (already made):** Business ($49/mo) gets a real 4th card on the marketing pricing section, using the shared pricing module — not left as a private/invite-only offering.
- **Self-service subscribe decision (already made):** this PR also builds the missing click-to-subscribe flow (Stripe Elements card collection → `SetupIntent` confirm → `POST /me/subscription`) in Settings → Billing, not just the pricing-data fix. This is new functionality, not a refactor, and is scoped to core plans (Free/Pro/Pro Annual/Business) only — add-on subscribe/cancel UI is Launch-gap PR-4b's job (task #134), not this PR's.
- **Real production billing/Stripe write required:** creating the live Stripe Price for Pro Annual and the corresponding `BillPlan` row happens against production (Stripe live mode + the production database) as part of this plan's Task 3 — this is a one-off script run directly by the controller (never delegated to a subagent, per this session's standing practice for anything touching live secrets/money), with the created resource IDs reported back verbatim for the record.
- **No existing prices change.** All four add-on prices (`tax_fast_track`/`student_success`/`personal_insights`/`startup_tax_benefits`) and their existing Stripe Price IDs are untouched — only *where* those numbers live moves (into the shared module), never the numbers or their Stripe objects.
- **MDX docs are out of scope.** `for-students.mdx`/`tax-fast-track.mdx` already state the correct $49/$65/$59 add-on figures and need no changes; wiring MDX content to the shared module is a separate, larger effort (would need a custom MDX component) not warranted by a currently-accurate doc.
- **`features`/`quotas` JSON blobs on `BillPlan` are business logic, not pricing** — they stay defined inline in `agentbook/seed-billing-plans.ts`, never move into the shared pricing module. Only `priceCents`/`currency`/`interval` move.
- All new/changed core-plan and add-on `priceCents` values must round-trip through `Math.round()` where computed (never leave a fractional-cent value in a `priceCents: number` field).

---

### Task 1: Create the `@agentbook/pricing` shared constants package

**Files:**
- Create: `packages/agentbook-pricing/package.json`
- Create: `packages/agentbook-pricing/tsconfig.json`
- Create: `packages/agentbook-pricing/src/index.ts`
- Create: `packages/agentbook-pricing/src/__tests__/index.test.ts`
- Modify: `tsconfig.base.json` (add the `@agentbook/pricing` path mapping)

**Interfaces:**
- Produces: `CorePlanPrice` (`{ code, name, priceCents, currency, interval, sortOrder }`), `CORE_PLANS: CorePlanPrice[]`, `AddOnTierPrice` (`{ region, currency, tier, priceCents, maxSlots }`), `ADDON_PRICES: Record<string, AddOnTierPrice[]>`. Every later task in this plan imports from here.

- [ ] **Step 1: Create the package manifest**

Create `packages/agentbook-pricing/package.json`:

```json
{
  "name": "@agentbook/pricing",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "scripts": { "build": "tsc", "test": "vitest run" },
  "devDependencies": { "@types/node": "^20.19.35", "typescript": "~5.9.3", "vitest": "^2.0.0" }
}
```

Create `packages/agentbook-pricing/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: Add the tsconfig path mapping**

In `tsconfig.base.json`, find:

```
      "@agentbook/i18n": ["packages/agentbook-i18n/src/index.ts"],
      "@agentbook/i18n/*": ["packages/agentbook-i18n/src/*"],
```

Add immediately after it:

```
      "@agentbook/pricing": ["packages/agentbook-pricing/src/index.ts"],
      "@agentbook/pricing/*": ["packages/agentbook-pricing/src/*"],
```

- [ ] **Step 3: Write the failing test**

Create `packages/agentbook-pricing/src/__tests__/index.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { CORE_PLANS, ADDON_PRICES } from '../index.js';

describe('CORE_PLANS', () => {
  it('has exactly 4 plans: free, pro, pro_yearly, business', () => {
    expect(CORE_PLANS.map((p) => p.code)).toEqual(['free', 'pro', 'pro_yearly', 'business']);
  });

  it('free is $0, pro is $19/mo, pro_yearly is $182/yr, business is $49/mo', () => {
    expect(CORE_PLANS.find((p) => p.code === 'free')!.priceCents).toBe(0);
    expect(CORE_PLANS.find((p) => p.code === 'pro')!.priceCents).toBe(1900);
    expect(CORE_PLANS.find((p) => p.code === 'pro_yearly')!.priceCents).toBe(18200);
    expect(CORE_PLANS.find((p) => p.code === 'business')!.priceCents).toBe(4900);
  });

  it('pro_yearly is a 20% discount off 12x the monthly price, rounded to a whole dollar', () => {
    const pro = CORE_PLANS.find((p) => p.code === 'pro')!;
    const proYearly = CORE_PLANS.find((p) => p.code === 'pro_yearly')!;
    const fullYearNoDiscount = pro.priceCents * 12;
    const expected = Math.round(fullYearNoDiscount * 0.8 / 100) * 100; // round to whole dollar
    expect(proYearly.priceCents).toBe(expected);
  });

  it('pro and pro_yearly both use interval-appropriate values', () => {
    expect(CORE_PLANS.find((p) => p.code === 'pro')!.interval).toBe('month');
    expect(CORE_PLANS.find((p) => p.code === 'pro_yearly')!.interval).toBe('year');
  });
});

describe('ADDON_PRICES', () => {
  it('has all 4 known add-ons', () => {
    expect(Object.keys(ADDON_PRICES).sort()).toEqual(
      ['personal_insights', 'startup_tax_benefits', 'student_success', 'tax_fast_track'].sort(),
    );
  });

  it('single-tier add-ons (tax_fast_track/student_success/personal_insights) each have exactly us/ca/au standard-tier rows at $49/$65/$59', () => {
    for (const code of ['tax_fast_track', 'student_success', 'personal_insights']) {
      const rows = ADDON_PRICES[code];
      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.tier === 'standard')).toBe(true);
      expect(rows.find((r) => r.region === 'us')).toMatchObject({ currency: 'usd', priceCents: 4900 });
      expect(rows.find((r) => r.region === 'ca')).toMatchObject({ currency: 'cad', priceCents: 6500 });
      expect(rows.find((r) => r.region === 'au')).toMatchObject({ currency: 'aud', priceCents: 5900 });
    }
  });

  it('startup_tax_benefits has 3 tiers x 4 regions (us/ca/uk at nominal parity, au independently uplifted)', () => {
    const rows = ADDON_PRICES.startup_tax_benefits;
    expect(rows).toHaveLength(12);
    for (const region of ['us', 'ca', 'uk']) {
      expect(rows.find((r) => r.region === region && r.tier === 'founding_member')).toMatchObject({ priceCents: 9900 });
      expect(rows.find((r) => r.region === region && r.tier === 'standard')).toMatchObject({ priceCents: 24900 });
      expect(rows.find((r) => r.region === region && r.tier === 'scaled')).toMatchObject({ priceCents: 49900 });
    }
    expect(rows.find((r) => r.region === 'au' && r.tier === 'founding_member')).toMatchObject({ currency: 'aud', priceCents: 12900 });
    expect(rows.find((r) => r.region === 'au' && r.tier === 'standard')).toMatchObject({ currency: 'aud', priceCents: 29900 });
    expect(rows.find((r) => r.region === 'au' && r.tier === 'scaled')).toMatchObject({ currency: 'aud', priceCents: 59900 });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/agentbook-pricing && npx vitest run src/__tests__/index.test.ts`
Expected: FAIL — `../index.js` doesn't exist yet.

- [ ] **Step 5: Write the module**

Create `packages/agentbook-pricing/src/index.ts`:

```ts
/**
 * Single source of truth for every price this product charges. Marketing
 * copy (apps/web-next/src/app/page.tsx), the core-plan seed script
 * (agentbook/seed-billing-plans.ts), and the four add-on seed scripts all
 * import from here instead of duplicating numbers — the root cause of a
 * real, confirmed bug this module closes: Pro was $19/mo in the database
 * but "$20 a month" on the marketing page, with nothing to catch the drift.
 */

export interface CorePlanPrice {
  code: 'free' | 'pro' | 'pro_yearly' | 'business';
  name: string;
  priceCents: number;
  currency: string;
  interval: 'month' | 'year';
  sortOrder: number;
}

export const CORE_PLANS: CorePlanPrice[] = [
  { code: 'free', name: 'Free', priceCents: 0, currency: 'usd', interval: 'month', sortOrder: 0 },
  { code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', interval: 'month', sortOrder: 1 },
  // 20% off 12x the monthly price ($228), rounded to a whole dollar —
  // $190/12 would have implied a different (wrong) monthly price; this is
  // the actual math behind the "save 20%" marketing claim.
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 18200, currency: 'usd', interval: 'year', sortOrder: 2 },
  { code: 'business', name: 'Business', priceCents: 4900, currency: 'usd', interval: 'month', sortOrder: 3 },
];

export interface AddOnTierPrice {
  region: string;
  currency: string;
  tier: string;
  priceCents: number;
  maxSlots: number | null;
}

/**
 * AU/CA pricing-derivation convention, established in
 * bin/seed-startup-benefit-addon.ts and reused by every add-on since:
 * - us/ca/uk: same nominal number across currencies — no reliable evidence
 *   was found for a specific regional discount, so these launch at
 *   currency-label parity (e.g. $49 USD and $49 CAD, not a converted CAD
 *   figure), correctable later from real data with zero code changes.
 * - au: independently researched rather than nominal parity — comped
 *   against AU R&D tax consultants (10-25% contingency or $5K-$25K+ flat
 *   fee per claim) and AU SaaS pricing norms: a modest ~1.2x uplift over
 *   the USD figure, not a full ~1.5x spot-rate conversion, since AU buyers
 *   benchmark against round nominal ladder points more than FX precision.
 */
export const ADDON_PRICES: Record<string, AddOnTierPrice[]> = {
  tax_fast_track: [
    { region: 'us', currency: 'usd', tier: 'standard', priceCents: 4900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'standard', priceCents: 6500, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'standard', priceCents: 5900, maxSlots: null },
  ],
  student_success: [
    { region: 'us', currency: 'usd', tier: 'standard', priceCents: 4900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'standard', priceCents: 6500, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'standard', priceCents: 5900, maxSlots: null },
  ],
  personal_insights: [
    { region: 'us', currency: 'usd', tier: 'standard', priceCents: 4900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'standard', priceCents: 6500, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'standard', priceCents: 5900, maxSlots: null },
  ],
  startup_tax_benefits: [
    { region: 'us', currency: 'usd', tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
    { region: 'us', currency: 'usd', tier: 'standard', priceCents: 24900, maxSlots: null },
    { region: 'us', currency: 'usd', tier: 'scaled', priceCents: 49900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
    { region: 'ca', currency: 'cad', tier: 'standard', priceCents: 24900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'scaled', priceCents: 49900, maxSlots: null },
    { region: 'uk', currency: 'gbp', tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
    { region: 'uk', currency: 'gbp', tier: 'standard', priceCents: 24900, maxSlots: null },
    { region: 'uk', currency: 'gbp', tier: 'scaled', priceCents: 49900, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'founding_member', priceCents: 12900, maxSlots: 250 },
    { region: 'au', currency: 'aud', tier: 'standard', priceCents: 29900, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'scaled', priceCents: 59900, maxSlots: null },
  ],
};

/** Formats cents as a whole-dollar display string, e.g. 1900 -> "$19". No cents shown (matches this product's existing convention for core-plan prices — see BillingTab's `fmt()`). */
export function formatWholeDollars(cents: number): string {
  return `$${(cents / 100).toFixed(0)}`;
}

/** Formats cents with 2 decimal places, e.g. 18200 -> "$182.00", 1517 -> "$15.17". Used for the Pro Annual monthly-equivalent figure, which isn't a whole dollar. */
export function formatDollarsAndCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/agentbook-pricing && npx vitest run src/__tests__/index.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/agentbook-pricing tsconfig.base.json
git commit -m "feat(pricing): create @agentbook/pricing shared source-of-truth package"
```

---

### Task 2: Wire `agentbook/seed-billing-plans.ts` to the shared module + add `pro_yearly`

**Files:**
- Modify: `agentbook/seed-billing-plans.ts`

**Interfaces:**
- Consumes: `CORE_PLANS` from `@agentbook/pricing` (Task 1).

- [ ] **Step 1: Replace the hardcoded price fields with shared-module lookups**

Find the full current file:

```ts
/**
 * Seeds default billing plans (Free, Pro, Business) into the database.
 * Safe to re-run — uses upsert.
 *
 * Usage: npx tsx agentbook/seed-billing-plans.ts
 */
import { prisma } from '@naap/database';

const PLANS = [
  {
    code: 'free',
    name: 'Free',
    description: 'Get started — no commitment.',
    priceCents: 0,
    currency: 'usd',
    interval: 'month' as const,
    features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
    quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
    sortOrder: 0,
  },
  {
    code: 'pro',
    name: 'Pro',
    description: 'Telegram bot, tax exports, generous quotas for active solo users.',
    priceCents: 1900,
    currency: 'usd',
    interval: 'month' as const,
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
    sortOrder: 1,
  },
  {
    code: 'business',
    name: 'Business',
    description: 'Unlimited everything. Team seats included.',
    priceCents: 4900,
    currency: 'usd',
    interval: 'month' as const,
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true },
    quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 },
    sortOrder: 2,
  },
];

async function main() {
  console.log('Seeding billing plans...\n');
  for (const p of PLANS) {
    await prisma.billPlan.upsert({
      where: { code: p.code },
      create: { ...p, isActive: true },
      update: { ...p, isActive: true },
    });
    const price = p.priceCents === 0 ? 'Free' : `$${(p.priceCents / 100).toFixed(0)}/mo`;
    console.log(`  ✓ ${p.name} (${price})`);
  }
  console.log('\nDone.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

Replace with:

```ts
/**
 * Seeds default billing plans (Free, Pro, Pro Annual, Business) into the
 * database. Safe to re-run — uses upsert. Price/currency/interval come
 * from @agentbook/pricing (the shared source of truth); only
 * name/description/features/quotas — business logic, not pricing — stay
 * defined here.
 *
 * Usage: npx tsx agentbook/seed-billing-plans.ts
 */
import { prisma } from '@naap/database';
import { CORE_PLANS } from '@agentbook/pricing';

const PLAN_DETAILS: Record<string, {
  description: string;
  features: Record<string, boolean>;
  quotas: Record<string, number>;
}> = {
  free: {
    description: 'Get started — no commitment.',
    features: { telegram_bot: false, tax_package_generation: false, multi_user_teams: false },
    quotas: { expenses_created: 50, ocr_scans: 10, ai_messages: 100, invoices_sent: 5, bank_connections: 0 },
  },
  pro: {
    description: 'Telegram bot, tax exports, generous quotas for active solo users.',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
  pro_yearly: {
    description: 'Everything in Pro, billed annually — save 20% vs. monthly.',
    // Same tier as Pro monthly — annual is a billing-interval choice, not a
    // different feature/quota tier.
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
    quotas: { expenses_created: 1000, ocr_scans: 200, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
  },
  business: {
    description: 'Unlimited everything. Team seats included.',
    features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: true },
    quotas: { expenses_created: 10000, ocr_scans: -1, ai_messages: -1, invoices_sent: -1, bank_connections: -1 },
  },
};

async function main() {
  console.log('Seeding billing plans...\n');
  for (const plan of CORE_PLANS) {
    const details = PLAN_DETAILS[plan.code];
    const data = {
      code: plan.code,
      name: plan.name,
      description: details.description,
      priceCents: plan.priceCents,
      currency: plan.currency,
      interval: plan.interval,
      features: details.features,
      quotas: details.quotas,
      sortOrder: plan.sortOrder,
    };
    await prisma.billPlan.upsert({
      where: { code: plan.code },
      create: { ...data, isActive: true },
      update: { ...data, isActive: true },
    });
    const price = plan.priceCents === 0 ? 'Free' : `$${(plan.priceCents / 100).toFixed(2)}/${plan.interval === 'year' ? 'yr' : 'mo'}`;
    console.log(`  ✓ ${plan.name} (${price})`);
  }
  console.log('\nDone.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
```

Note: this script does NOT set `stripeProductId`/`stripePriceId` — those are populated separately (already true for `free`/`pro`/`business` in production; Task 3 populates them for the new `pro_yearly` row). The `upsert`'s `update` clause here does not touch those two fields, so re-running this script is safe and won't clear already-set Stripe IDs. The console log's price-formatting line changed from `.toFixed(0)` to `.toFixed(2)}/${interval==='year'?'yr':'mo'}` only to correctly display `pro_yearly`'s `$182.00/yr` (previously all-monthly, whole-dollar display); this is a console-log cosmetic change only, not a data change.

- [ ] **Step 2: Manual verification (no automated test — this is a data-seeding script, covered by Task 7's live-DB consistency check instead)**

Run against an isolated/local test DB (never the shared local DB per this session's established practice — use an isolated verify DB): `DATABASE_URL=<isolated-verify-db> npx tsx agentbook/seed-billing-plans.ts` and confirm the console output shows all 4 plans including `Pro Annual ($182.00/yr)`.

- [ ] **Step 3: Commit**

```bash
git add agentbook/seed-billing-plans.ts
git commit -m "fix(billing): seed-billing-plans.ts reads prices from @agentbook/pricing, adds pro_yearly"
```

---

### Task 3: Real Stripe Price + `BillPlan` row for Pro Annual (production write)

**Files:**
- Create: `bin/create-pro-yearly-plan.ts` (one-off script, run once by the controller against production — not part of the regular seed-script rotation, left in the repo afterward as a record of how the row was created, matching this session's established pattern for one-off Stripe-object-creation scripts)

**Interfaces:**
- Consumes: `CORE_PLANS` from `@agentbook/pricing` (Task 1), `getStripe()` from `@/lib/billing/stripe` (existing, unmodified).

- [ ] **Step 1: Write the script**

Create `bin/create-pro-yearly-plan.ts`:

```ts
/**
 * One-off script: creates the real Stripe Price + BillPlan row for
 * "Pro Annual" ($182/yr), which did not exist as a purchasable product
 * before this script ran (the marketing page advertised it, but there was
 * no BillPlan row, no Stripe Price, and no code anywhere that read the
 * `?plan=pro-yearly` query param the marketing CTA links to).
 *
 * Reuses the EXISTING Stripe Product behind the monthly 'pro' BillPlan —
 * annual is a second Price on the same Product, the idiomatic Stripe
 * modeling for "same plan, different billing interval" (not a new Product).
 *
 * Usage (run once against production):
 *   DATABASE_URL=<prod> STRIPE_SECRET_KEY=<prod live key> npx tsx bin/create-pro-yearly-plan.ts
 *
 * Idempotent: re-running finds the already-created BillPlan row by code
 * and skips creating a duplicate Stripe Price if stripePriceId is already
 * set.
 */
import { prisma } from '@naap/database';
import Stripe from 'stripe';
import { CORE_PLANS } from '@agentbook/pricing';

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY must be set');
  const stripe = new Stripe(key, { apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion });

  const proYearly = CORE_PLANS.find((p) => p.code === 'pro_yearly');
  if (!proYearly) throw new Error('pro_yearly not found in @agentbook/pricing CORE_PLANS');

  const existing = await prisma.billPlan.findUnique({ where: { code: 'pro_yearly' } });
  if (existing?.stripePriceId) {
    console.log(JSON.stringify({ skipped: true, reason: 'already has a stripePriceId', billPlanId: existing.id, stripePriceId: existing.stripePriceId }));
    await prisma.$disconnect();
    return;
  }

  const monthlyPro = await prisma.billPlan.findUnique({ where: { code: 'pro' } });
  if (!monthlyPro?.stripeProductId) {
    throw new Error('the monthly "pro" BillPlan has no stripeProductId — cannot attach an annual Price to it');
  }

  const price = await stripe.prices.create({
    product: monthlyPro.stripeProductId,
    unit_amount: proYearly.priceCents,
    currency: proYearly.currency,
    recurring: { interval: 'year' },
    nickname: 'Pro Annual',
  });

  const billPlan = await prisma.billPlan.upsert({
    where: { code: 'pro_yearly' },
    create: {
      code: 'pro_yearly',
      name: proYearly.name,
      description: 'Everything in Pro, billed annually — save 20% vs. monthly.',
      priceCents: proYearly.priceCents,
      currency: proYearly.currency,
      interval: proYearly.interval,
      stripeProductId: monthlyPro.stripeProductId,
      stripePriceId: price.id,
      features: monthlyPro.features as object,
      quotas: monthlyPro.quotas as object,
      sortOrder: proYearly.sortOrder,
      isActive: true,
    },
    update: {
      stripeProductId: monthlyPro.stripeProductId,
      stripePriceId: price.id,
    },
  });

  console.log(JSON.stringify({ created: true, billPlanId: billPlan.id, stripeProductId: monthlyPro.stripeProductId, stripePriceId: price.id }));
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run against production (controller-executed, not delegated — real Stripe live-mode write)**

Run with production `DATABASE_URL` and the production `STRIPE_SECRET_KEY` (live-mode `sk_live_*`/`rk_live_*`). Capture and report the exact printed `stripeProductId`/`stripePriceId`/`billPlanId` verbatim as part of this task's completion record.

- [ ] **Step 3: Commit**

```bash
git add bin/create-pro-yearly-plan.ts
git commit -m "feat(billing): script to create the real Pro Annual Stripe Price + BillPlan row"
```

---

### Task 4: Wire the four add-on seed scripts to `@agentbook/pricing`

**Files:**
- Modify: `bin/seed-tax-fast-track-addon.ts`
- Modify: `bin/seed-student-success-addon.ts`
- Modify: `bin/seed-personal-insights-addon.ts`
- Modify: `bin/seed-startup-benefit-addon.ts`

**Interfaces:**
- Consumes: `ADDON_PRICES` from `@agentbook/pricing` (Task 1).

- [ ] **Step 1: `bin/seed-tax-fast-track-addon.ts`**

Find:

```ts
const ADDON_CODE = 'tax_fast_track';

const PRICES: { region: string; currency: string; priceCents: number }[] = [
  { region: 'us', currency: 'usd', priceCents: 4900 },
  { region: 'ca', currency: 'cad', priceCents: 6500 },
  { region: 'au', currency: 'aud', priceCents: 5900 },
];
```

Replace with:

```ts
import { ADDON_PRICES } from '@agentbook/pricing';

const ADDON_CODE = 'tax_fast_track';

const PRICES = ADDON_PRICES[ADDON_CODE].map(({ region, currency, priceCents }) => ({ region, currency, priceCents }));
```

(Move this new `import` to the top of the file, alongside the existing `import { prisma as db } from '@naap/database';` line — do not leave it mid-file.)

- [ ] **Step 2: `bin/seed-student-success-addon.ts`**

Find:

```ts
const ADDON_CODE = 'student_success';
const ACTIVATE = process.env.ACTIVATE === '1';

// $49 USD / $65 CAD / $59 AUD, single tier. Nominal-parity elsewhere can be
// added as more BillAddOnPrice rows later with zero code changes.
const PRICES: { region: string; currency: string; priceCents: number }[] = [
  { region: 'us', currency: 'usd', priceCents: 4900 },
  { region: 'ca', currency: 'cad', priceCents: 6500 },
  { region: 'au', currency: 'aud', priceCents: 5900 },
];
```

Replace with:

```ts
import { ADDON_PRICES } from '@agentbook/pricing';

const ADDON_CODE = 'student_success';
const ACTIVATE = process.env.ACTIVATE === '1';

const PRICES = ADDON_PRICES[ADDON_CODE].map(({ region, currency, priceCents }) => ({ region, currency, priceCents }));
```

(Move the new `import` to the top of the file, alongside `import { prisma as db } from '@naap/database';`.)

- [ ] **Step 3: `bin/seed-personal-insights-addon.ts`**

Find:

```ts
const ADDON_CODE = 'personal_insights';
const ACTIVATE = process.env.ACTIVATE === '1';

// $49 USD / $65 CAD / $59 AUD, single tier — matches the student_success precedent.
const PRICES: { region: string; currency: string; priceCents: number }[] = [
  { region: 'us', currency: 'usd', priceCents: 4900 },
  { region: 'ca', currency: 'cad', priceCents: 6500 },
  { region: 'au', currency: 'aud', priceCents: 5900 },
];
```

Replace with:

```ts
import { ADDON_PRICES } from '@agentbook/pricing';

const ADDON_CODE = 'personal_insights';
const ACTIVATE = process.env.ACTIVATE === '1';

const PRICES = ADDON_PRICES[ADDON_CODE].map(({ region, currency, priceCents }) => ({ region, currency, priceCents }));
```

(Move the new `import` to the top of the file, alongside `import { prisma as db } from '@naap/database';`.)

- [ ] **Step 4: `bin/seed-startup-benefit-addon.ts`**

Find:

```ts
const ADDON_CODE = 'startup_tax_benefits';

interface Tier { tier: string; priceCents: number; maxSlots: number | null }

// Same nominal number across currencies — the pricing research found no
// reliable evidence for a specific regional discount, so this launches at
// parity and can be corrected later from real conversion data via
// BillAddOnPrice rows, with zero code changes.
const DEFAULT_TIERS: Tier[] = [
  { tier: 'founding_member', priceCents: 9900, maxSlots: 250 },
  { tier: 'standard', priceCents: 24900, maxSlots: null },
  { tier: 'scaled', priceCents: 49900, maxSlots: null },
];

const REGIONS: { region: string; currency: string; tiers: Tier[] }[] = [
  { region: 'us', currency: 'usd', tiers: DEFAULT_TIERS },
  { region: 'ca', currency: 'cad', tiers: DEFAULT_TIERS },
  { region: 'uk', currency: 'gbp', tiers: DEFAULT_TIERS },
  {
    region: 'au',
    currency: 'aud',
    // Unlike the other regions, AUD pricing was independently researched
    // rather than using flat nominal parity — comped against AU R&D tax
    // consultants (10-25% contingency or $5K-$25K+ flat fee per claim) and
    // AU SaaS pricing norms (a modest ~1.2x uplift over the USD figure,
    // not a full ~1.5x spot-rate conversion, since AU buyers benchmark
    // against round nominal ladder points more than FX precision).
    tiers: [
      { tier: 'founding_member', priceCents: 12900, maxSlots: 250 },
      { tier: 'standard', priceCents: 29900, maxSlots: null },
      { tier: 'scaled', priceCents: 59900, maxSlots: null },
    ],
  },
];
```

Replace with:

```ts
import { ADDON_PRICES } from '@agentbook/pricing';

const ADDON_CODE = 'startup_tax_benefits';

interface Tier { tier: string; priceCents: number; maxSlots: number | null }

const REGIONS: { region: string; currency: string; tiers: Tier[] }[] = ['us', 'ca', 'uk', 'au'].map((region) => ({
  region,
  currency: ADDON_PRICES[ADDON_CODE].find((r) => r.region === region)!.currency,
  tiers: ADDON_PRICES[ADDON_CODE]
    .filter((r) => r.region === region)
    .map(({ tier, priceCents, maxSlots }) => ({ tier, priceCents, maxSlots })),
}));
```

(Move the new `import` to the top of the file, alongside `import { prisma as db } from '@naap/database';`. The rest of the file — the `main()` function that upserts `BillAddOn`/`BillAddOnPrice` rows via `REGIONS` — is unchanged; `REGIONS`'s shape is identical to before, just computed from the shared module instead of typed inline.)

- [ ] **Step 5: Manual verification (no new automated test for these 4 files — Task 7's live-DB consistency check covers this)**

For each of the 4 files, run against an isolated/local test DB and confirm the console output prices match what the ORIGINAL hardcoded values were (e.g. `DATABASE_URL=<isolated-verify-db> npx tsx bin/seed-tax-fast-track-addon.ts` should still print `total: 3` with $49/$65/$59 as before — this is a pure refactor, the seeded data must be byte-identical to before this change).

- [ ] **Step 6: Commit**

```bash
git add bin/seed-tax-fast-track-addon.ts bin/seed-student-success-addon.ts bin/seed-personal-insights-addon.ts bin/seed-startup-benefit-addon.ts
git commit -m "refactor(billing): four add-on seed scripts read prices from @agentbook/pricing"
```

---

### Task 5: Fix marketing page pricing — $19 not $20, real $182/yr, add Business card

**Files:**
- Modify: `apps/web-next/src/app/page.tsx`

**Interfaces:**
- Consumes: `CORE_PLANS`, `formatWholeDollars`, `formatDollarsAndCents` from `@agentbook/pricing` (Task 1).

- [ ] **Step 1: Add the import**

Find:

```ts
import type { Metadata } from 'next';
import Link from 'next/link';
import { Fraunces, Newsreader, JetBrains_Mono } from 'next/font/google';
import { Wordmark } from '@/components/brand/Wordmark';
import { InstallAppButton } from '@/components/pwa/InstallAppButton';
```

Replace with:

```ts
import type { Metadata } from 'next';
import Link from 'next/link';
import { Fraunces, Newsreader, JetBrains_Mono } from 'next/font/google';
import { Wordmark } from '@/components/brand/Wordmark';
import { InstallAppButton } from '@/components/pwa/InstallAppButton';
import { CORE_PLANS, formatWholeDollars, formatDollarsAndCents } from '@agentbook/pricing';
```

- [ ] **Step 2: Add plan lookups as the first lines of `LandingPage()`**

Find (the page's default-exported component, at the top of its body — line 60 in the current file):

```tsx
export default function LandingPage() {
  return (
```

Replace with:

```tsx
export default function LandingPage() {
  const proMonthly = CORE_PLANS.find((p) => p.code === 'pro')!;
  const proYearly = CORE_PLANS.find((p) => p.code === 'pro_yearly')!;
  const business = CORE_PLANS.find((p) => p.code === 'business')!;
  const proMonthlyPrice = formatWholeDollars(proMonthly.priceCents);
  const proYearlyPrice = formatWholeDollars(proYearly.priceCents);
  const proYearlyMonthlyEquivalent = formatDollarsAndCents(Math.round(proYearly.priceCents / 12));
  const businessPrice = formatWholeDollars(business.priceCents);
  return (
```

- [ ] **Step 3: Fix the intro copy (line 478)**

Find:

```tsx
            <p className="text-[16.5px] leading-[1.6] text-[var(--ink-soft)] max-w-[44ch]">
              No card to start. After the trial, $20 a month or $190 a year — whichever you
              like. Cancel any time, in plain English. We won't make it hard.
            </p>
```

Replace with:

```tsx
            <p className="text-[16.5px] leading-[1.6] text-[var(--ink-soft)] max-w-[44ch]">
              No card to start. After the trial, {proMonthlyPrice} a month or {proYearlyPrice} a year — whichever you
              like. Cancel any time, in plain English. We won't make it hard.
            </p>
```

- [ ] **Step 4: Fix the Pro Annual card (lines 531-539) and widen the grid to 4 columns**

Find:

```tsx
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
```

Replace with:

```tsx
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
```

Find:

```tsx
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                $190
              </span>
              <span className="num text-[12px] text-[var(--paper)] opacity-70 tracking-[0.14em] uppercase">/yr</span>
            </div>
            <p className="mt-3 text-[14px] opacity-80">
              $15.83/mo, paid up front. Same as Monthly otherwise.
            </p>
```

Replace with:

```tsx
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                {proYearlyPrice}
              </span>
              <span className="num text-[12px] text-[var(--paper)] opacity-70 tracking-[0.14em] uppercase">/yr</span>
            </div>
            <p className="mt-3 text-[14px] opacity-80">
              {proYearlyMonthlyEquivalent}/mo, paid up front. Same as Monthly otherwise.
            </p>
```

- [ ] **Step 5: Fix the Pro Monthly card (lines 567-571)**

Find:

```tsx
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                $20
              </span>
              <span className="num text-[12px] text-[var(--muted)] tracking-[0.14em] uppercase">/mo</span>
            </div>
```

Replace with:

```tsx
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                {proMonthlyPrice}
              </span>
              <span className="num text-[12px] text-[var(--muted)] tracking-[0.14em] uppercase">/mo</span>
            </div>
```

- [ ] **Step 6: Add the Business card, immediately after the Pro Monthly card and before the closing `</div>` of the pricing grid**

Find:

```tsx
            <Link href="/register?plan=pro" className="btn btn-ghost mt-8 w-full justify-center">
              Start 90-day trial
            </Link>
          </div>
        </div>

        <p className="mt-10 text-center text-[13px] num text-[var(--muted)] tracking-[0.12em] uppercase">
```

Replace with:

```tsx
            <Link href="/register?plan=pro" className="btn btn-ghost mt-8 w-full justify-center">
              Start 90-day trial
            </Link>
          </div>

          {/* Business */}
          <div className="ab-card p-8" style={{ borderRadius: '2px' }}>
            <div className="flex items-center justify-between">
              <h3 className="text-[28px]" style={{ fontWeight: 500 }}>
                Business
              </h3>
              <span className="pill pill-paper">teams</span>
            </div>
            <div className="mt-5 flex items-baseline gap-2">
              <span className="display num text-[64px] leading-none" style={{ fontWeight: 500 }}>
                {businessPrice}
              </span>
              <span className="num text-[12px] text-[var(--muted)] tracking-[0.14em] uppercase">/mo</span>
            </div>
            <p className="mt-3 text-[14px] text-[var(--ink-soft)]">
              Unlimited everything. Team seats included.
            </p>
            <Hairline className="my-6" />
            <ul className="space-y-2.5 text-[14px] text-[var(--ink-soft)]">
              <li>· Everything in Pro</li>
              <li>· Multi-user teams</li>
              <li>· No usage caps</li>
              <li>· 90-day free trial</li>
            </ul>
            <Link href="/register?plan=business" className="btn btn-ghost mt-8 w-full justify-center">
              Start 90-day trial
            </Link>
          </div>
        </div>

        <p className="mt-10 text-center text-[13px] num text-[var(--muted)] tracking-[0.12em] uppercase">
```

- [ ] **Step 7: Fix the final CTA (line 709)**

Find:

```tsx
          Ninety days of Pro, no card, no hooks. After that, $20 a month or $190 a year. Or
          stay on Free. You decide — every time.
```

Replace with:

```tsx
          Ninety days of Pro, no card, no hooks. After that, {proMonthlyPrice} a month or {proYearlyPrice} a year. Or
          stay on Free. You decide — every time.
```

(This line is inside a `<p>` in the final CTA section, not inside the component's `return`'s outermost scope shown above — `proMonthlyPrice`/`proYearlyPrice` are already in scope from Step 2 since they're declared once at the top of the same component function that renders this entire page.)

- [ ] **Step 8: Manual verification**

Run the dev server, load `/`, confirm: intro copy says "$19 a month or $182 a year," Pro Annual card shows "$182 /yr" and "$15.17/mo, paid up front," Pro Monthly card shows "$19 /mo," a 4th Business card appears at "$49 /mo," final CTA says "$19 a month or $182 a year." Confirm the pricing grid still lays out cleanly at `lg` (4 columns) and collapses to 2 columns at `md` per the widened grid class.

- [ ] **Step 9: Commit**

```bash
git add apps/web-next/src/app/page.tsx
git commit -m "fix(marketing): $19 not $20, real \$182/yr annual price, add Business card"
```

---

### Task 6: Self-service subscribe flow (Stripe Elements) in Settings → Billing

**Files:**
- Modify: `apps/web-next/package.json` (root) or `apps/web-next/package.json` directly — add `@stripe/stripe-js` and `@stripe/react-stripe-js` as dependencies of `apps/web-next`
- Create: `apps/web-next/src/components/settings/SubscribeModal.tsx`
- Modify: `apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx` (`BillingTab()`)

**Interfaces:**
- Consumes: the existing, unmodified `POST /api/v1/agentbook-billing/me/subscription/intent` (returns `{ clientSecret, customerId }`) and `POST /api/v1/agentbook-billing/me/subscription` (body `{ planId, paymentMethodId }`) routes — both already fully generic over any `BillPlan`, no backend changes needed. Also reads `window.STRIPE_PUBLISHABLE_KEY`, already injected globally by `apps/web-next/src/app/layout.tsx` but never consumed anywhere until now.

- [ ] **Step 1: Add the Stripe Elements dependencies**

In `apps/web-next/package.json`, find the `"dependencies"` block and add (keeping alphabetical order if the file is already sorted; otherwise add adjacent to the existing `"stripe"` entry):

```json
    "@stripe/react-stripe-js": "^6.8.0",
    "@stripe/stripe-js": "^9.10.0",
```

Run `npm install` at the repo root afterward so the lockfile picks up the new dependencies.

- [ ] **Step 2: Create the subscribe modal component**

Create `apps/web-next/src/components/settings/SubscribeModal.tsx`:

```tsx
'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { loadStripe, type Stripe } from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useStripe,
  useElements,
} from '@stripe/react-stripe-js';
import { Loader2, X } from 'lucide-react';

interface Plan {
  id: string;
  code: string;
  name: string;
  priceCents: number;
  interval: string;
}

interface Props {
  plan: Plan;
  onClose: () => void;
  onSubscribed: () => void;
}

let stripePromise: Promise<Stripe | null> | null = null;
function getStripePromise(): Promise<Stripe | null> {
  if (!stripePromise) {
    const pk = (typeof window !== 'undefined' ? (window as unknown as { STRIPE_PUBLISHABLE_KEY?: string }).STRIPE_PUBLISHABLE_KEY : '') || '';
    stripePromise = loadStripe(pk);
  }
  return stripePromise;
}

function fmtPrice(cents: number, interval: string): string {
  const dollars = (cents / 100).toFixed(cents % 100 === 0 ? 0 : 2);
  return `$${dollars}/${interval === 'year' ? 'yr' : 'mo'}`;
}

function SubscribeForm({ plan, onClose, onSubscribed }: Props): React.ReactElement {
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setSubmitting(true);
    setError(null);

    const { error: confirmError, setupIntent } = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
    });

    if (confirmError || !setupIntent?.payment_method) {
      setError(confirmError?.message || 'Could not confirm your card. Please try again.');
      setSubmitting(false);
      return;
    }

    try {
      const paymentMethodId =
        typeof setupIntent.payment_method === 'string'
          ? setupIntent.payment_method
          : setupIntent.payment_method.id;
      const res = await fetch('/api/v1/agentbook-billing/me/subscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: plan.id, paymentMethodId }),
      });
      const json = await res.json();
      if (!res.ok || json.error) {
        setError(json.error || 'Subscription failed. Please try again.');
        setSubmitting(false);
        return;
      }
      onSubscribed();
    } catch {
      setError('Subscription failed. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <PaymentElement />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2 justify-end">
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!stripe || submitting}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Subscribe to {plan.name} — {fmtPrice(plan.priceCents, plan.interval)}
        </button>
      </div>
    </form>
  );
}

export function SubscribeModal({ plan, onClose, onSubscribed }: Props): React.ReactElement {
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/agentbook-billing/me/subscription/intent', { method: 'POST' })
      .then((r) => r.json())
      .then((j) => {
        if (j.clientSecret) setClientSecret(j.clientSecret);
        else setError('Could not start checkout. Please try again.');
      })
      .catch(() => setError('Could not start checkout. Please try again.'));
  }, []);

  const options = useMemo(() => (clientSecret ? { clientSecret } : undefined), [clientSecret]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-foreground">
            Subscribe to {plan.name}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="text-sm text-destructive mb-3">{error}</p>}
        {!clientSecret && !error ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : clientSecret ? (
          <Elements stripe={getStripePromise()} options={options}>
            <SubscribeForm plan={plan} onClose={onClose} onSubscribed={onSubscribed} />
          </Elements>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire the modal into `BillingTab()`**

Find:

```tsx
interface BillingPlan { id: string; code: string; name: string; description?: string | null; priceCents: number; interval: string }

function BillingTab(): React.ReactElement {
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [current, setCurrent] = useState<{ code?: string; name?: string; status?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/v1/agentbook-billing/plans').then((r) => r.json()).catch(() => null),
      fetch('/api/v1/agentbook-billing/me/subscription').then((r) => r.json()).catch(() => null),
    ]).then(([p, c]) => {
      if (p?.plans) setPlans(p.plans);
      if (c) setCurrent({ code: c.code ?? c.planCode ?? c.plan?.code, name: c.name ?? c.plan?.name, status: c.status });
    }).finally(() => setLoading(false));
  }, []);

  const fmt = (cents: number) => cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}`;

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading billing…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Your plan</h3>
        <p className="text-sm text-muted-foreground">
          {current?.name || current?.code
            ? <>Currently on <span className="font-medium text-foreground capitalize">{current.name || current.code}</span>{current.status ? ` · ${current.status}` : ''}.</>
            : 'You are on the Free plan.'}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {plans.map((p) => {
          const isCurrent = current?.code === p.code;
          return (
            <div key={p.id} className={`rounded-xl border p-4 ${isCurrent ? 'border-primary' : 'border-border'} bg-card`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-semibold text-foreground">{p.name}</p>
                {isCurrent && <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">Current</span>}
              </div>
              <p className="text-2xl font-bold text-foreground">{fmt(p.priceCents)}<span className="text-xs font-normal text-muted-foreground">{p.priceCents > 0 ? `/${p.interval}` : ''}</span></p>
              {p.description && <p className="text-xs text-muted-foreground mt-1.5">{p.description}</p>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">To change or cancel your plan, contact support or use the upgrade prompt in the app. Managed securely via Stripe.</p>
    </div>
  );
}
```

Replace with:

```tsx
interface BillingPlan { id: string; code: string; name: string; description?: string | null; priceCents: number; interval: string }

function BillingTab(): React.ReactElement {
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [current, setCurrent] = useState<{ code?: string; name?: string; status?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [subscribeTarget, setSubscribeTarget] = useState<BillingPlan | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      fetch('/api/v1/agentbook-billing/plans').then((r) => r.json()).catch(() => null),
      fetch('/api/v1/agentbook-billing/me/subscription').then((r) => r.json()).catch(() => null),
    ]).then(([p, c]) => {
      if (p?.plans) setPlans(p.plans);
      if (c) setCurrent({ code: c.code ?? c.planCode ?? c.plan?.code, name: c.name ?? c.plan?.name, status: c.status });
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmt = (cents: number) => cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}`;

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading billing…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Your plan</h3>
        <p className="text-sm text-muted-foreground">
          {current?.name || current?.code
            ? <>Currently on <span className="font-medium text-foreground capitalize">{current.name || current.code}</span>{current.status ? ` · ${current.status}` : ''}.</>
            : 'You are on the Free plan.'}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {plans.map((p) => {
          const isCurrent = current?.code === p.code;
          return (
            <div key={p.id} className={`rounded-xl border p-4 ${isCurrent ? 'border-primary' : 'border-border'} bg-card`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-semibold text-foreground">{p.name}</p>
                {isCurrent && <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">Current</span>}
              </div>
              <p className="text-2xl font-bold text-foreground">{fmt(p.priceCents)}<span className="text-xs font-normal text-muted-foreground">{p.priceCents > 0 ? `/${p.interval}` : ''}</span></p>
              {p.description && <p className="text-xs text-muted-foreground mt-1.5">{p.description}</p>}
              {!isCurrent && p.priceCents > 0 && (
                <button
                  onClick={() => setSubscribeTarget(p)}
                  className="mt-3 w-full rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  Subscribe
                </button>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">To cancel your plan, contact support. Managed securely via Stripe.</p>
      {subscribeTarget && (
        <SubscribeModal
          plan={subscribeTarget}
          onClose={() => setSubscribeTarget(null)}
          onSubscribed={() => { setSubscribeTarget(null); load(); }}
        />
      )}
    </div>
  );
}
```

Add the import for `SubscribeModal` near the top of `AgentBookSettingsPanel.tsx`, alongside its existing local component imports (find the file's existing `import` block and add):

```ts
import { SubscribeModal } from './SubscribeModal';
```

- [ ] **Step 4: Manual verification**

Run the dev server, log in as a test tenant currently on Free, open Settings → Billing, confirm 4 plan cards render (Free/Pro/Pro Annual/Business) with a "Subscribe" button on every non-current, non-free plan. Click Subscribe on Pro, confirm the modal opens, the Stripe Elements card form renders (using the sandbox/test publishable key), and — using Stripe's test card `4242 4242 4242 4242`, any future expiry, any CVC — confirm submitting completes without error and the tab refreshes to show "Currently on Pro."

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/package.json package-lock.json apps/web-next/src/components/settings/SubscribeModal.tsx apps/web-next/src/components/settings/AgentBookSettingsPanel.tsx
git commit -m "feat(billing): self-service Stripe Elements subscribe flow for core plans"
```

---

### Task 7: Live-DB pricing-consistency check

**Files:**
- Create: `bin/verify-pricing-consistency.ts`

**Interfaces:**
- Consumes: `CORE_PLANS`, `ADDON_PRICES` from `@agentbook/pricing` (Task 1).

- [ ] **Step 1: Write the script**

Create `bin/verify-pricing-consistency.ts`:

```ts
/**
 * Reads live BillPlan/BillAddOnPrice rows and asserts they match
 * @agentbook/pricing — turns "someone notices a mismatch by reading the
 * site" into an automated, runnable check. Not part of the standard CI
 * unit-test run (this repo's CI jobs don't have a live DB — see the
 * chronic oauth-consent/localhost:5432 issue); run manually after any
 * seed-script change, or wire into a scheduled job later.
 *
 * Usage: DATABASE_URL=<env to check> npx tsx bin/verify-pricing-consistency.ts
 * Exit code 0 = consistent, 1 = drift found (prints every mismatch).
 */
import { prisma } from '@naap/database';
import { CORE_PLANS, ADDON_PRICES } from '@agentbook/pricing';

async function main() {
  const mismatches: string[] = [];

  for (const plan of CORE_PLANS) {
    const row = await prisma.billPlan.findUnique({ where: { code: plan.code } });
    if (!row) {
      mismatches.push(`BillPlan '${plan.code}': no row found in the database`);
      continue;
    }
    if (row.priceCents !== plan.priceCents) {
      mismatches.push(`BillPlan '${plan.code}': DB priceCents=${row.priceCents}, expected ${plan.priceCents}`);
    }
    if (row.currency !== plan.currency) {
      mismatches.push(`BillPlan '${plan.code}': DB currency=${row.currency}, expected ${plan.currency}`);
    }
    if (row.interval !== plan.interval) {
      mismatches.push(`BillPlan '${plan.code}': DB interval=${row.interval}, expected ${plan.interval}`);
    }
  }

  for (const [addOnCode, expectedRows] of Object.entries(ADDON_PRICES)) {
    const addOn = await prisma.billAddOn.findUnique({ where: { code: addOnCode } });
    if (!addOn) {
      mismatches.push(`BillAddOn '${addOnCode}': no row found in the database`);
      continue;
    }
    for (const expected of expectedRows) {
      const row = await prisma.billAddOnPrice.findUnique({
        where: { addOnId_region_tier: { addOnId: addOn.id, region: expected.region, tier: expected.tier } },
      });
      if (!row) {
        mismatches.push(`BillAddOnPrice '${addOnCode}'/${expected.region}/${expected.tier}: no row found`);
        continue;
      }
      if (row.priceCents !== expected.priceCents) {
        mismatches.push(`BillAddOnPrice '${addOnCode}'/${expected.region}/${expected.tier}: DB priceCents=${row.priceCents}, expected ${expected.priceCents}`);
      }
      if (row.currency !== expected.currency) {
        mismatches.push(`BillAddOnPrice '${addOnCode}'/${expected.region}/${expected.tier}: DB currency=${row.currency}, expected ${expected.currency}`);
      }
    }
  }

  if (mismatches.length > 0) {
    console.error(`Found ${mismatches.length} pricing mismatch(es):`);
    for (const m of mismatches) console.error(`  ✗ ${m}`);
    await prisma.$disconnect();
    process.exit(1);
  }

  console.log(`✓ All ${CORE_PLANS.length} core plans and ${Object.values(ADDON_PRICES).flat().length} add-on prices match @agentbook/pricing.`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Run against production (read-only — safe to run any time)**

Run: `DATABASE_URL=<prod> npx tsx bin/verify-pricing-consistency.ts`
Expected (after Tasks 2-4 have been seeded/re-run against production): `✓ All 4 core plans and 21 add-on prices match @agentbook/pricing.`

- [ ] **Step 3: Commit**

```bash
git add bin/verify-pricing-consistency.ts
git commit -m "test(billing): live-DB script to verify BillPlan/BillAddOnPrice match @agentbook/pricing"
```

---

## Verification

- Task 1's unit tests: 7/7 passing, CI-runnable without a live DB.
- Full test suite: `cd apps/web-next && npx vitest run` and `cd packages/agentbook-pricing && npx vitest run` — no regressions beyond the same 8 pre-existing/unrelated failures already established this session.
- Manual: marketing page shows correct $19/$182/$49 figures and a working 4th Business card (Task 5); Settings → Billing shows all 4 plans and a working Stripe-Elements subscribe flow using a test card (Task 6).
- Live-DB check: `bin/verify-pricing-consistency.ts` passes against the re-seeded database (Task 7).
- Deploy: commit → PR → CI → merge → **production DB re-seed is required for this PR** (`agentbook/seed-billing-plans.ts` + the 4 add-on scripts must be re-run against production so the existing rows pick up any drift, though none is expected since Tasks 2/4 are pure refactors of already-matching values) → run `bin/create-pro-yearly-plan.ts` once against production (Task 3, the one genuinely new write) → build + deploy the Next.js app → run `bin/verify-pricing-consistency.ts` against production as the final gate.
