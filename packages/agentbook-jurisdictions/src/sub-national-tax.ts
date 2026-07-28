/**
 * US state & Canadian provincial income-tax engine.
 *
 * ARCHITECTURE (see docs/state-tax design): tax is computed DETERMINISTICALLY
 * from declarative rule data — the LLM never does the arithmetic. Adding or
 * updating a jurisdiction is a data change (one row in STATE_TAX_RULES), which
 * is exactly what an offline "rule-authoring" agent proposes from published
 * tax tables for human review (increment 2). This keeps figures correct,
 * auditable, and trivially extensible.
 *
 * Scope of increment 1: bracket / flat / no-tax rules for the highest-impact
 * US states + all Canadian provinces (rates reused from the vetted payroll
 * engine). States not yet modeled return { modeled: false } so the estimate
 * can disclose the gap honestly instead of silently understating (the prior
 * behaviour was federal-only for everyone).
 *
 * Rates are approximate top-of-2025 figures and MUST be verified/updated each
 * tax year — that maintenance is the authoring agent's job.
 */

export type StateBracket = { upToCents: number; rate: number }; // upToCents=Infinity for the top band

export interface StateTaxRule {
  code: string;                 // 'CA', 'NY', 'ON' …
  name: string;
  country: 'US' | 'CA';
  kind: 'none' | 'flat' | 'bracket';
  flatRate?: number;            // kind='flat'
  brackets?: StateBracket[];    // kind='bracket'
  /** Reduces taxable income before rates apply (single-filer default). */
  standardDeductionCents?: number;
  note?: string;
}

export interface StateTaxResult {
  taxCents: number;
  modeled: boolean;             // false → this region isn't in the table yet
  code: string;
  name?: string;
  note?: string;
}

function progressive(taxableCents: number, brackets: StateBracket[]): number {
  let tax = 0;
  let lower = 0;
  for (const b of brackets) {
    if (taxableCents <= lower) break;
    const upper = Math.min(taxableCents, b.upToCents);
    tax += (upper - lower) * b.rate;
    lower = b.upToCents;
  }
  return Math.round(tax);
}

const INF = Number.POSITIVE_INFINITY;

// ── US ──────────────────────────────────────────────────────────────────────
// Nine states levy no tax on wage/business income.
const US_NO_TAX = ['AK', 'FL', 'NV', 'NH', 'SD', 'TN', 'TX', 'WA', 'WY'];

// Flat-rate states (approx 2025 rates).
const US_FLAT: Record<string, number> = {
  AZ: 0.025, CO: 0.044, GA: 0.0539, ID: 0.057, IL: 0.0495, IN: 0.0305,
  KY: 0.04, MA: 0.05, MI: 0.0425, MS: 0.047, NC: 0.045, PA: 0.0307, UT: 0.0455,
};

// Bracketed states — the two largest by population/impact (approx 2025, single).
const US_BRACKETS: Record<string, StateBracket[]> = {
  CA: [
    { upToCents: 1075600, rate: 0.01 }, { upToCents: 2549900, rate: 0.02 },
    { upToCents: 4024500, rate: 0.04 }, { upToCents: 5658600, rate: 0.06 },
    { upToCents: 7060600, rate: 0.08 }, { upToCents: 36065900, rate: 0.093 },
    { upToCents: 43278700, rate: 0.103 }, { upToCents: 72131400, rate: 0.113 },
    { upToCents: INF, rate: 0.123 },
  ],
  NY: [
    { upToCents: 850000, rate: 0.04 }, { upToCents: 1170000, rate: 0.045 },
    { upToCents: 1390000, rate: 0.0525 }, { upToCents: 8065000, rate: 0.055 },
    { upToCents: 21540000, rate: 0.06 }, { upToCents: 107755000, rate: 0.0685 },
    { upToCents: 500000000, rate: 0.0965 }, { upToCents: 2500000000, rate: 0.103 },
    { upToCents: INF, rate: 0.109 },
  ],
};

// ── Canada — provincial brackets (approx 2025; mirrors the payroll engine) ────
const CA_PROVINCIAL: Record<string, StateBracket[]> = {
  ON: [{ upToCents: 5114200, rate: 0.0505 }, { upToCents: 10228400, rate: 0.0915 }, { upToCents: 15000000, rate: 0.1116 }, { upToCents: 22000000, rate: 0.1216 }, { upToCents: INF, rate: 0.1316 }],
  BC: [{ upToCents: 4707400, rate: 0.0506 }, { upToCents: 9414800, rate: 0.077 }, { upToCents: 10805600, rate: 0.105 }, { upToCents: 13108800, rate: 0.1229 }, { upToCents: 22786800, rate: 0.147 }, { upToCents: INF, rate: 0.168 }],
  AB: [{ upToCents: 14212200, rate: 0.10 }, { upToCents: 17070600, rate: 0.12 }, { upToCents: 22769200, rate: 0.13 }, { upToCents: 34153800, rate: 0.14 }, { upToCents: INF, rate: 0.15 }],
  QC: [{ upToCents: 5325500, rate: 0.14 }, { upToCents: 10649500, rate: 0.19 }, { upToCents: 12959000, rate: 0.24 }, { upToCents: INF, rate: 0.2575 }],
  MB: [{ upToCents: 4700000, rate: 0.108 }, { upToCents: 10000000, rate: 0.1275 }, { upToCents: INF, rate: 0.174 }],
  SK: [{ upToCents: 5346300, rate: 0.105 }, { upToCents: 15275000, rate: 0.125 }, { upToCents: INF, rate: 0.145 }],
  NB: [{ upToCents: 5130600, rate: 0.094 }, { upToCents: 10261400, rate: 0.14 }, { upToCents: 19006000, rate: 0.16 }, { upToCents: INF, rate: 0.195 }],
  NS: [{ upToCents: 3099500, rate: 0.0879 }, { upToCents: 6199100, rate: 0.1495 }, { upToCents: 9741700, rate: 0.1667 }, { upToCents: 15712400, rate: 0.175 }, { upToCents: INF, rate: 0.21 }],
  PE: [{ upToCents: 3332800, rate: 0.095 }, { upToCents: 6465600, rate: 0.1347 }, { upToCents: 10500000, rate: 0.166 }, { upToCents: 14000000, rate: 0.1762 }, { upToCents: INF, rate: 0.19 }],
  NL: [{ upToCents: 4419200, rate: 0.087 }, { upToCents: 8838200, rate: 0.145 }, { upToCents: 15779200, rate: 0.158 }, { upToCents: 22091000, rate: 0.178 }, { upToCents: 28221400, rate: 0.198 }, { upToCents: 56442900, rate: 0.208 }, { upToCents: 112885800, rate: 0.213 }, { upToCents: INF, rate: 0.218 }],
  YT: [{ upToCents: 5737500, rate: 0.064 }, { upToCents: 11475000, rate: 0.09 }, { upToCents: 17788200, rate: 0.109 }, { upToCents: 50000000, rate: 0.128 }, { upToCents: INF, rate: 0.15 }],
  NT: [{ upToCents: 5196400, rate: 0.059 }, { upToCents: 10393000, rate: 0.086 }, { upToCents: 16896700, rate: 0.122 }, { upToCents: INF, rate: 0.1405 }],
  NU: [{ upToCents: 5470700, rate: 0.04 }, { upToCents: 10941300, rate: 0.07 }, { upToCents: 17788100, rate: 0.09 }, { upToCents: INF, rate: 0.115 }],
};

/** Build the flat rule table once from the compact sources above. */
export const STATE_TAX_RULES: Record<string, StateTaxRule> = (() => {
  const rules: Record<string, StateTaxRule> = {};
  for (const code of US_NO_TAX) rules[`US:${code}`] = { code, name: code, country: 'US', kind: 'none' };
  for (const [code, flatRate] of Object.entries(US_FLAT)) rules[`US:${code}`] = { code, name: code, country: 'US', kind: 'flat', flatRate };
  for (const [code, brackets] of Object.entries(US_BRACKETS)) rules[`US:${code}`] = { code, name: code, country: 'US', kind: 'bracket', brackets };
  for (const [code, brackets] of Object.entries(CA_PROVINCIAL)) rules[`CA:${code}`] = { code, name: code, country: 'CA', kind: 'bracket', brackets };
  return rules;
})();

/**
 * Compute state/provincial income tax on `taxableIncomeCents`.
 * @param region  state/province code (e.g. 'CA', 'ON'). Empty → not modeled.
 * @param country 'US' | 'CA'. Other countries have no sub-national income tax here.
 */
export function calculateStateTax(
  taxableIncomeCents: number,
  region: string | null | undefined,
  country: string | null | undefined,
): StateTaxResult {
  const ctry = (country || '').toUpperCase();
  const code = (region || '').toUpperCase().trim();
  if (ctry !== 'US' && ctry !== 'CA') return { taxCents: 0, modeled: true, code, note: 'No sub-national income tax modeled for this country.' };
  if (!code) return { taxCents: 0, modeled: false, code, note: 'No state/province set — state income tax not included.' };

  const rule = STATE_TAX_RULES[`${ctry}:${code}`];
  if (!rule) {
    return { taxCents: 0, modeled: false, code, note: `${code} income tax isn't modeled yet — this estimate excludes it.` };
  }
  if (taxableIncomeCents <= 0 || rule.kind === 'none') {
    return { taxCents: 0, modeled: true, code, name: rule.name, note: rule.kind === 'none' ? `${code} levies no income tax.` : undefined };
  }
  const base = Math.max(0, taxableIncomeCents - (rule.standardDeductionCents ?? 0));
  const taxCents = rule.kind === 'flat'
    ? Math.round(base * (rule.flatRate ?? 0))
    : progressive(base, rule.brackets ?? []);
  return { taxCents, modeled: true, code, name: rule.name };
}

/** True if we have modeled rules for this region (for UI disclosure). */
export function isStateModeled(region: string | null | undefined, country: string | null | undefined): boolean {
  return calculateStateTax(1, region, country).modeled;
}
