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
  region: string;
  interval: 'month' | 'year';
  sortOrder: number;
}

// CA-4: CAD rows at nominal price parity with USD (same rationale already
// documented below for ADDON_PRICES — no reliable evidence of a specific
// regional discount, so CAD launches at the same nominal cents figure as
// USD, correctable later from real data with zero code changes).
export const CORE_PLANS: CorePlanPrice[] = [
  { code: 'free', name: 'Free', priceCents: 0, currency: 'usd', region: 'us', interval: 'month', sortOrder: 0 },
  { code: 'free', name: 'Free', priceCents: 0, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 0 },
  { code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', region: 'us', interval: 'month', sortOrder: 1 },
  { code: 'pro', name: 'Pro', priceCents: 1900, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 1 },
  // 20% off 12x the monthly price ($228), rounded to a whole dollar —
  // $190/12 would have implied a different (wrong) monthly price; this is
  // the actual math behind the "save 20%" marketing claim.
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 18200, currency: 'usd', region: 'us', interval: 'year', sortOrder: 2 },
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 18200, currency: 'cad', region: 'ca', interval: 'year', sortOrder: 2 },
  { code: 'business', name: 'Business', priceCents: 4900, currency: 'usd', region: 'us', interval: 'month', sortOrder: 3 },
  { code: 'business', name: 'Business', priceCents: 4900, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 3 },
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
