import type { SalesTaxEngine, SalesTaxRate, SalesTaxResult } from '../interfaces.js';

// State-level sales tax rate only (no local/city/county add-ons) — all 50
// states + DC, sourced from the Tax Foundation's 2026 state sales tax data
// (https://taxfoundation.org/data/all/state/sales-tax-rates/). The 5 states
// with no state-level sales tax are explicit 0s, not omissions: Oregon, New
// Hampshire, Montana, Delaware, Alaska (Alaska has no state rate, though
// many of its localities levy their own — out of scope for this
// state-level-only engine, same as before this table was completed).
// Exported (not just used internally) so tests can enumerate real table
// membership directly, rather than only observing calculateTax's `?? 0`
// fallback output — which can't distinguish "genuinely zero" from "entry
// missing" from the outside.
export const STATE_RATES: Record<string, number> = {
  AL: 0.0400, AK: 0.0000, AZ: 0.0560, AR: 0.0650, CA: 0.0725, CO: 0.0290, CT: 0.0635, DE: 0.0000,
  FL: 0.0600, GA: 0.0400, HI: 0.0400, ID: 0.0600, IL: 0.0625, IN: 0.0700, IA: 0.0600, KS: 0.0650,
  KY: 0.0600, LA: 0.0500, ME: 0.0550, MD: 0.0600, MA: 0.0625, MI: 0.0600, MN: 0.0688, MS: 0.0700,
  MO: 0.0423, MT: 0.0000, NE: 0.0550, NV: 0.0685, NH: 0.0000, NJ: 0.0663, NM: 0.0488, NY: 0.0400,
  NC: 0.0475, ND: 0.0500, OH: 0.0575, OK: 0.0450, OR: 0.0000, PA: 0.0600, RI: 0.0700, SC: 0.0600,
  SD: 0.0420, TN: 0.0700, TX: 0.0625, UT: 0.0610, VT: 0.0600, VA: 0.0530, WA: 0.0650, WV: 0.0600,
  WI: 0.0500, WY: 0.0400, DC: 0.0600,
};

export const usSalesTax: SalesTaxEngine = {
  getRates(region: string): SalesTaxRate[] {
    const rate = STATE_RATES[region.toUpperCase()] ?? 0;
    return rate > 0 ? [{ region, taxType: 'state', rate, name: `${region} State Tax` }] : [];
  },
  calculateTax(amountCents: number, region: string): SalesTaxResult {
    const rate = STATE_RATES[region.toUpperCase()] ?? 0;
    const taxCents = Math.round(amountCents * rate);
    return {
      totalRate: rate,
      totalCents: taxCents,
      components: rate > 0 ? [{ type: 'state', rate, amountCents: taxCents }] : [],
    };
  },
  getFilingDeadlines(region: string, taxYear: number): Date[] {
    // Quarterly filing for most states
    return [
      new Date(taxYear, 3, 30), new Date(taxYear, 6, 31),
      new Date(taxYear, 9, 31), new Date(taxYear + 1, 0, 31),
    ];
  },
};
