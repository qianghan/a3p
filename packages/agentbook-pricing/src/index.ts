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
//
// AU-5: AUD rows use the SAME ~1.2x uplift already researched and shipped
// for the AU add-ons below (not nominal parity like CAD) — this file
// already established that AU buyers benchmark against round nominal
// ladder points rather than FX precision, and that a modest uplift over
// the USD figure (not a full ~1.5x spot-rate conversion) is the right
// call. Business's $49 USD -> $59 AUD is the exact same price point
// already shipped for tax_fast_track/student_success/personal_insights,
// reused directly rather than re-derived. Pro ($19 -> $23) is the same
// ~1.2x uplift rounded to the nearest whole dollar (19 * 1.2 = 22.8 -> 23).
// Pro Annual ($221) is derived the same way every region's annual price
// is derived — 20% off 12x the AUD monthly price, not a re-scaling of the
// USD annual figure — so the "save 20%" relationship holds in every
// currency, not just USD/CAD.
export const CORE_PLANS: CorePlanPrice[] = [
  { code: 'free', name: 'Free', priceCents: 0, currency: 'usd', region: 'us', interval: 'month', sortOrder: 0 },
  { code: 'free', name: 'Free', priceCents: 0, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 0 },
  { code: 'free', name: 'Free', priceCents: 0, currency: 'aud', region: 'au', interval: 'month', sortOrder: 0 },
  { code: 'pro', name: 'Pro', priceCents: 1900, currency: 'usd', region: 'us', interval: 'month', sortOrder: 1 },
  { code: 'pro', name: 'Pro', priceCents: 1900, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 1 },
  { code: 'pro', name: 'Pro', priceCents: 2300, currency: 'aud', region: 'au', interval: 'month', sortOrder: 1 },
  // 20% off 12x the monthly price ($228), rounded to a whole dollar —
  // $190/12 would have implied a different (wrong) monthly price; this is
  // the actual math behind the "save 20%" marketing claim.
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 18200, currency: 'usd', region: 'us', interval: 'year', sortOrder: 2 },
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 18200, currency: 'cad', region: 'ca', interval: 'year', sortOrder: 2 },
  // 20% off 12x the AUD monthly price ($276), rounded to a whole dollar:
  // 2300 * 12 = 27600; 27600 * 0.8 = 22080 -> rounds to 22100 (221.00).
  { code: 'pro_yearly', name: 'Pro Annual', priceCents: 22100, currency: 'aud', region: 'au', interval: 'year', sortOrder: 2 },
  { code: 'business', name: 'Business', priceCents: 4900, currency: 'usd', region: 'us', interval: 'month', sortOrder: 3 },
  { code: 'business', name: 'Business', priceCents: 4900, currency: 'cad', region: 'ca', interval: 'month', sortOrder: 3 },
  { code: 'business', name: 'Business', priceCents: 5900, currency: 'aud', region: 'au', interval: 'month', sortOrder: 3 },
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
 *
 * Exception — the three single-tier add-ons (tax_fast_track, student_success,
 * personal_insights) were repriced 2026-07 off real value anchors, so they
 * use regionally-adjusted (not nominal-parity) figures on a round ladder:
 * ~1.35x USD for ca, ~1.5x USD for au. tax_fast_track is anchored against
 * accountant fees; student_success is kept student-accessible; and
 * personal_insights moved to a monthly interval (see its seed script).
 */
export const ADDON_PRICES: Record<string, AddOnTierPrice[]> = {
  tax_fast_track: [
    { region: 'us', currency: 'usd', tier: 'standard', priceCents: 14900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'standard', priceCents: 19900, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'standard', priceCents: 22900, maxSlots: null },
  ],
  student_success: [
    { region: 'us', currency: 'usd', tier: 'standard', priceCents: 7900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'standard', priceCents: 9900, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'standard', priceCents: 11900, maxSlots: null },
  ],
  // personal_insights bills MONTHLY (interval on its BillAddOn / seed script), so these are per-month figures.
  personal_insights: [
    { region: 'us', currency: 'usd', tier: 'standard', priceCents: 900, maxSlots: null },
    { region: 'ca', currency: 'cad', tier: 'standard', priceCents: 1200, maxSlots: null },
    { region: 'au', currency: 'aud', tier: 'standard', priceCents: 1400, maxSlots: null },
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

// ─── P0-1: region-aware pricing + explicit currency ───────────────────────────
// The marketing page previously rendered bare "$19" with no currency qualifier
// and always showed the USD row. These helpers make region + currency explicit.

export type PricingRegion = 'us' | 'ca' | 'au';

const COUNTRY_TO_REGION: Record<string, PricingRegion> = {
  CA: 'ca',
  AU: 'au',
};

/**
 * Map an ISO 3166-1 alpha-2 country code (e.g. from the
 * `x-vercel-ip-country` request header) to a pricing region.
 * Unknown/missing countries fall back to 'us'. Pure function — safe to unit test.
 */
export function regionFromCountry(countryCode: string | null | undefined): PricingRegion {
  if (!countryCode) return 'us';
  return COUNTRY_TO_REGION[countryCode.trim().toUpperCase()] ?? 'us';
}

/** Return the CORE_PLANS row for a plan code in the given region (falls back to 'us'). */
export function planForRegion(
  code: CorePlanPrice['code'],
  region: PricingRegion,
): CorePlanPrice {
  return (
    CORE_PLANS.find((p) => p.code === code && p.region === region) ??
    CORE_PLANS.find((p) => p.code === code && p.region === 'us')!
  );
}

const CURRENCY_LABEL: Record<string, string> = {
  usd: 'USD',
  cad: 'CAD',
  aud: 'AUD',
  gbp: 'GBP',
};

/**
 * Format cents with an explicit ISO currency code, e.g.
 * formatMoney(1900, 'usd') -> "$19 USD". The bare "$" convention is kept
 * for visual continuity; the appended code removes the ambiguity.
 */
export function formatMoney(cents: number, currency: string): string {
  const code = CURRENCY_LABEL[currency.toLowerCase()] ?? currency.toUpperCase();
  return `$${(cents / 100).toFixed(0)} ${code}`;
}

/** Two-decimal variant of formatMoney, e.g. formatMoneyPrecise(1517, 'cad') -> "$15.17 CAD". */
export function formatMoneyPrecise(cents: number, currency: string): string {
  const code = CURRENCY_LABEL[currency.toLowerCase()] ?? currency.toUpperCase();
  return `$${(cents / 100).toFixed(2)} ${code}`;
}

export interface AddOnDisplayMeta {
  code: string;
  name: string;
  /** One-line factual blurb. Must not imply tax filing or professional advice. */
  blurb: string;
  /** Billing interval shown to prospects. */
  intervalLabel: '/yr' | '/mo';
  /** Deep link for "learn more". */
  learnMoreHref: string;
}

/**
 * Marketing metadata for the four paid add-ons. Prices themselves live in
 * ADDON_PRICES (single source of truth); this is display copy only.
 *
 * OWNER DECISION REQUIRED: the ADDON_PRICES figures were set from 2026-07
 * value-anchor research and have not been confirmed as final public prices.
 * Confirm or adjust before this section ships to production.
 */
export const ADDON_DISPLAY: AddOnDisplayMeta[] = [
  {
    code: 'tax_fast_track',
    name: 'Tax Fast-Track',
    blurb: 'Year-end tax package for your accountant, assembled from your books.',
    intervalLabel: '/yr',
    learnMoreHref: '/guides/workflows',
  },
  {
    code: 'student_success',
    name: 'Student Success',
    blurb: 'Scholarship, jobs & co-op, and housing copilots for student life.',
    intervalLabel: '/yr',
    learnMoreHref: '/guides/students',
  },
  {
    code: 'personal_insights',
    name: 'Personal Insights',
    blurb: 'A personal-finance money view across your accounts and spending.',
    intervalLabel: '/mo',
    learnMoreHref: '/guides/workflows',
  },
  {
    code: 'startup_tax_benefits',
    name: 'Startup Tax Benefits',
    blurb: 'Burn & runway tracking, R&D benefit guidance, and a CPA seat.',
    intervalLabel: '/yr',
    learnMoreHref: '/guides/startup-founders',
  },
];

/**
 * The public standard-tier price for an add-on in a region (what the
 * marketing page shows). Falls back to the 'us' row when the region is absent.
 * Returns null when the add-on has no standard tier at all.
 */
export function addOnStandardPrice(
  code: string,
  region: PricingRegion,
): AddOnTierPrice | null {
  const tiers = ADDON_PRICES[code];
  if (!tiers) return null;
  return (
    tiers.find((t) => t.region === region && t.tier === 'standard') ??
    tiers.find((t) => t.region === 'us' && t.tier === 'standard') ??
    null
  );
}
