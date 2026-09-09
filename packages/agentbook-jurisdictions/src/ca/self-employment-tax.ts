import type { SelfEmploymentTaxCalculator, SelfEmploymentTaxResult } from '../interfaces.js';

/**
 * Canadian self-employed pension and parental-insurance contributions.
 *
 * TWO REGIMES, NOT ONE. A Quebec resident does not contribute to the CPP.
 * They contribute to the Québec Pension Plan at a higher rate, and — unlike
 * the rest of Canada, where EI is optional for the self-employed — they must
 * also pay Québec Parental Insurance Plan premiums, which are compulsory.
 *
 * Treating every Canadian as a CPP contributor understated a Quebec sole
 * trader's obligation by roughly A CAD 1,470 a year at the ceilings: ~$610
 * from the 0.9-point rate gap, and ~$860 from omitting QPIP entirely. That
 * shortfall flowed straight into their quarterly tax reserve.
 */

// ── Shared between CPP and QPP: Quebec aligns these with the federal plan ──
const BASIC_EXEMPTION_CENTS = 350_000;        // $3,500
const MAX_PENSIONABLE_CENTS = 7_130_000;      // $71,300 (YMPE/MPE, 2025)
const SECOND_CEILING_CENTS = 8_120_000;       // $81,200 (YAMPE, 2025)
const SECOND_TIER_SE_RATE = 0.08;             // 4% x 2 for the self-employed

// ── Rest of Canada: CPP ────────────────────────────────────────────────────
const CPP_SE_RATE = 0.119;                    // 5.95% x 2

// ── Quebec: QPP ────────────────────────────────────────────────────────────
// 2025: 6.40% each, 12.80% self-employed. Max base contribution
// (71,300 - 3,500) x 12.80% = $8,678.40, which is the published figure.
const QPP_SE_RATE = 0.128;

// ── Quebec: QPIP (Québec Parental Insurance Plan) ──────────────────────────
// Compulsory for the self-employed, with no basic exemption and its own,
// much higher, earnings ceiling. Payable only once net business income
// reaches $2,000.
const QPIP_SE_RATE_BY_YEAR: Record<number, number> = {
  2024: 0.00878,
  2025: 0.00878,
  2026: 0.00764, // rates were cut ~13% for 2026
};
const QPIP_MAX_INSURABLE_CENTS = 9_800_000;   // $98,000 (2025)
const QPIP_MIN_INCOME_CENTS = 200_000;        // $2,000

/** True for Quebec, however the province happens to be spelled or cased. */
export function isQuebec(region: string | null | undefined): boolean {
  return (region || '').trim().toUpperCase() === 'QC';
}

export const caSelfEmploymentTax: SelfEmploymentTaxCalculator = {
  calculate(netSEIncomeCents: number, taxYear: number, region?: string | null): SelfEmploymentTaxResult {
    const quebec = isQuebec(region);

    // Base plan — same earnings band either side of the Ottawa River, only
    // the rate differs.
    const pensionable = Math.min(netSEIncomeCents, MAX_PENSIONABLE_CENTS);
    const base = Math.max(pensionable - BASIC_EXEMPTION_CENTS, 0);
    const baseContribution = Math.round(base * (quebec ? QPP_SE_RATE : CPP_SE_RATE));

    // Second tier (CPP2 / QPP2): 4% each on earnings between the two ceilings.
    const secondBase = Math.max(
      Math.min(netSEIncomeCents, SECOND_CEILING_CENTS) - MAX_PENSIONABLE_CENTS,
      0,
    );
    const secondContribution = Math.round(secondBase * SECOND_TIER_SE_RATE);

    // QPIP — Quebec only, and a real cost we used to leave out of the
    // estimate altogether. No basic exemption, its own ceiling, and a floor
    // below which no premium is payable at all.
    let qpip = 0;
    if (quebec && netSEIncomeCents >= QPIP_MIN_INCOME_CENTS) {
      const rate = QPIP_SE_RATE_BY_YEAR[taxYear] ?? QPIP_SE_RATE_BY_YEAR[2025];
      qpip = Math.round(Math.min(netSEIncomeCents, QPIP_MAX_INSURABLE_CENTS) * rate);
    }

    const totalContribution = baseContribution + secondContribution + qpip;

    return {
      amountCents: totalContribution,
      // Half, matching the convention this module has always used: the
      // self-employed contribution stands in for both the employee and the
      // employer share, and only the employer share is deductible. The exact
      // federal treatment of the enhanced portion (deduction vs credit) is
      // finer-grained than this estimate models, and the estimate discloses
      // that it is an estimate.
      deductiblePortionCents: Math.round(totalContribution / 2),
      breakdown: quebec
        ? { qpp: baseContribution, qpp2: secondContribution, qpip, ei: 0 }
        // EI stays optional for the self-employed outside Quebec, so it is
        // not assumed. Inside Quebec, QPIP replaces that choice with an
        // obligation.
        : { cpp: baseContribution, cpp2: secondContribution, ei: 0 },
    };
  },
};
