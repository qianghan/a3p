/**
 * Pure comparison for agentbook/check-stripe-pricing-sync.ts.
 *
 * Three places hold a price, and they drift independently:
 *   1. CODE   @agentbook/pricing (CORE_PLANS / ADDON_PRICES)  what the pricing page SHOWS
 *   2. DB     BillPlan / BillAddOnPrice                        what the app thinks it sells
 *   3. STRIPE the Price object behind stripePriceId            what the customer is CHARGED
 *
 * Checkout charges item #3 (`items: [{ price: row.stripePriceId }]`). A Stripe Price's amount is immutable, and the
 * activate-*-pricing scripts skip any row that already has a stripePriceId, so changing #1 never reaches #3 by itself.
 */
export type Interval = 'month' | 'year';

export interface Money { cents: number; currency: string; interval: Interval }
export interface DbPrice extends Money { stripePriceId: string | null; isActive: boolean }
export interface StripePrice extends Money { active: boolean }

export interface SyncInput {
  label: string;
  want: Money;
  db: DbPrice | null;
  stripe: StripePrice | null;
}

export type SyncStatus =
  | 'OK' | 'NOT_IN_DB' | 'DB_DRIFT' | 'NO_STRIPE_PRICE' | 'STRIPE_MISSING' | 'STRIPE_INACTIVE' | 'STRIPE_DRIFT';

const same = (a: Money, b: Money) =>
  a.cents === b.cents && a.currency.toLowerCase() === b.currency.toLowerCase() && a.interval === b.interval;

/** Order matters: fix the earliest problem first (code -> DB -> Stripe attachment -> Stripe amount). */
export function classifyRow({ want, db, stripe }: SyncInput): SyncStatus {
  if (!db) return 'NOT_IN_DB';
  if (!same(want, db)) return 'DB_DRIFT';
  if (want.cents === 0) return 'OK'; // free: no Stripe object by design
  if (!db.stripePriceId) return 'NO_STRIPE_PRICE';
  if (!stripe) return 'STRIPE_MISSING';
  if (!stripe.active) return 'STRIPE_INACTIVE';
  if (!same(db, stripe)) return 'STRIPE_DRIFT';
  return 'OK';
}

export function remediation(s: SyncStatus): string {
  switch (s) {
    case 'OK': return '';
    case 'NOT_IN_DB': return 'Row exists in code but not in the database: run the seed (agentbook/seed-billing-plans.ts, or the add-on seed scripts).';
    case 'DB_DRIFT': return 'Database differs from the code: re-run the seed so the database matches @agentbook/pricing, then re-check.';
    case 'NO_STRIPE_PRICE': return 'Paid row has no Stripe Price (checkout will 400): run agentbook/activate-core-plan-pricing.ts or activate-addon-pricing.ts with the LIVE key.';
    case 'STRIPE_MISSING': return 'stripePriceId points at a Price Stripe cannot find (wrong account or deleted): null the id on the row and re-run the activate script.';
    case 'STRIPE_INACTIVE': return 'The attached Stripe Price is archived: customers cannot subscribe. Attach a new active Price.';
    case 'STRIPE_DRIFT': return 'Stripe charges a different amount than the database. A Price amount cannot be edited: create a NEW Price with the right amount, attach its id to the row, archive the old Price. Existing subscribers stay on the old Price until moved.';
  }
}

export function summarize(statuses: SyncStatus[]): { counts: Partial<Record<SyncStatus, number>>; clean: boolean } {
  const counts: Partial<Record<SyncStatus, number>> = {};
  for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
  // An empty run checked nothing, which is not the same as "in sync".
  return { counts, clean: statuses.length > 0 && statuses.every((s) => s === 'OK') };
}
