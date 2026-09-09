import { getJurisdictionPack, loadBuiltInPacks } from './loader.js';
import { AU_GST_THRESHOLD_CENTS } from './au/gst-registration.js';

/**
 * The statutory rates and thresholds an advisory answer is allowed to quote.
 *
 * WHY THIS EXISTS
 *
 * The consultation reviewer checks every rate in a draft against the grounding
 * facts, and its rejection message reads "Rates must come from the pack, never
 * from the model." That was aspirational: nothing ever put a pack rate into
 * the grounding facts. `buildGroundingFacts` supplies the tenant's ledger and
 * profile and nothing else, so the set of known numbers held the user's own
 * money and no statutory figure at all.
 *
 * The result was that EVERY percentage the model produced was unverifiable.
 * "GST is 10% in Australia" — correct, from the pack we ship — was flagged,
 * and the repair brief instructed the model to delete it and say the rate
 * "depends on their circumstances". The reviewer built to stop invented
 * figures was deleting the true ones, and the user got a vaguer answer than
 * the model had actually produced.
 *
 * So this returns the pack's own rates as fact lines. Two consumers, one
 * source: the model reads them as context, and the reviewer accepts them as
 * grounded. If a rate is not in here, the model still may not assert it.
 *
 * Everything is READ FROM THE PACKS. Nothing is retyped — a second copy of a
 * rate table is how this product previously shipped a tax figure that had
 * silently gone stale.
 */

export interface StatutoryFacts {
  /** Fact lines for the model's context and the reviewer's rate check. */
  lines: string[];
  /**
   * Money-shaped statutory amounts (thresholds, caps) appearing in `lines`.
   *
   * Kept separate from the tenant's ledger facts on purpose. The reviewer
   * treats a money figure as grounded if it appears in either, so that the
   * agent can say "the threshold is A$75,000" — but the distinction stays in
   * the type, because the two are different kinds of claim and a future
   * tightening should be able to tell them apart.
   */
  amountLines: string[];
}

const fmtPct = (rate: number) => `${+(rate * 100).toFixed(4)}%`;

/**
 * What the national income tax is called here. "Federal" is right in the US,
 * Canada and Australia and simply wrong in the UK, and a line reading "UK
 * federal income tax" tells a British user the model does not know where they
 * live — the same trust failure as quoting the IRS at them.
 */
const NATIONAL_TAX_LABEL: Record<string, string> = {
  us: 'US federal income tax',
  ca: 'Canadian federal income tax',
  au: 'Australian income tax',
  uk: 'UK income tax',
};

/** The minor unit a jurisdiction quotes its per-distance rate in. */
const MINOR_UNIT: Record<string, string> = { us: 'cents', ca: 'cents', au: 'cents', uk: 'pence' };

/** Contribution keys as a person would name them, not as the code does. */
const CONTRIBUTION_NAMES: Record<string, string> = {
  social_security: 'Social Security', medicare: 'Medicare',
  additional_medicare: 'Additional Medicare', cpp: 'CPP', cpp2: 'CPP2',
  qpp: 'QPP', qpp2: 'QPP2', qpip: 'QPIP', ei: 'EI',
  medicare_levy: 'Medicare Levy', class_2: 'Class 2 National Insurance',
  class_4: 'Class 4 National Insurance',
};

/**
 * Build the statutory fact lines for one tenant's jurisdiction.
 *
 * Never throws: a pack that fails to answer degrades the answer to what the
 * ledger supports, which is the behaviour before this existed.
 */
export function statutoryFactLines(
  jurisdiction: string | null | undefined,
  region?: string | null,
  taxYear: number = new Date().getFullYear(),
): StatutoryFacts {
  const lines: string[] = [];
  const amountLines: string[] = [];
  const j = (jurisdiction || 'us').trim().toLowerCase();

  try {
    loadBuiltInPacks();
    const pack = getJurisdictionPack(j);
    if (!pack) return { lines, amountLines };

    // ── Income tax brackets ────────────────────────────────────────────────
    // The RATES only. Bracket BOUNDARIES are deliberately left out: they are
    // large round money figures, and admitting them to the money-grounded set
    // would let a draft assert "$190,000" about the user's income and pass.
    try {
      const brackets = pack.taxBrackets.getTaxBrackets(taxYear);
      const rates = [...new Set(brackets.map((b) => b.rate))].sort((a, b) => a - b);
      if (rates.length > 0) {
        const label = NATIONAL_TAX_LABEL[j] ?? `${j.toUpperCase()} income tax`;
        lines.push(`${label} marginal rates for ${taxYear}: ${rates.map(fmtPct).join(', ')}.`);
      }
    } catch { /* pack incomplete — the ledger facts still stand */ }

    // ── Sales tax / GST / VAT ──────────────────────────────────────────────
    try {
      const rates = pack.salesTax.getRates(region || (j === 'au' ? 'standard' : ''));
      for (const r of rates) {
        if (r.rate <= 0) continue;
        // The pack's `name` sometimes already carries the region ("ON HST"),
        // so appending it produced "ON HST rate in ON".
        const suffix = region && !r.name.toUpperCase().includes(region.toUpperCase()) ? ` in ${region}` : '';
        lines.push(`${r.name} rate${suffix}: ${fmtPct(r.rate)}.`);
      }
    } catch { /* not every jurisdiction answers for every region */ }

    // ── Mileage ────────────────────────────────────────────────────────────
    // Not a percentage, so the reviewer's rate check never sees it — included
    // because the model quoting the wrong cents-per-unit is its own problem,
    // and one line of correct context is cheaper than a repair round.
    try {
      // `region` is load-bearing: the CRA adds 4c/km in NT, YT and NU, and a
      // fact line quoting the provincial rate to a Whitehorse tenant
      // contradicts the amount the app books for the same trip.
      const m = pack.mileageRate.getRate(taxYear, 0, undefined, region ?? undefined);
      const minor = MINOR_UNIT[j] ?? 'cents';
      lines.push(`Mileage rate: ${Math.round(m.rate * 100)} ${minor} per ${m.unit}${m.tierDescription ? ` (${m.tierDescription})` : ''}.`);
      if (m.maxClaimableUnitsPerYear !== undefined) {
        lines.push(`Mileage claimable under this method is capped at ${m.maxClaimableUnitsPerYear.toLocaleString('en-US')} ${m.unit} per year.`);
      }
    } catch { /* optional */ }

    // ── Self-employment contributions ──────────────────────────────────────
    // Derived from the calculator rather than restated: run it at a level that
    // exercises every band, and report the effective rate it produces. A rate
    // typed here would be a second copy free to drift from the one that
    // actually computes the user's bill.
    try {
      const probe = 20_000_000; // $200,000 — above every ceiling we model
      const se = pack.selfEmploymentTax.calculate(probe, taxYear, { region });
      const parts = Object.entries(se.breakdown)
        .filter(([, v]) => v > 0)
        .map(([k]) => CONTRIBUTION_NAMES[k] ?? k);
      if (parts.length > 0) {
        lines.push(`Self-employed contributions in ${j.toUpperCase()}${region ? ` (${region})` : ''} comprise: ${parts.join(', ')}.`);
      }
    } catch { /* optional */ }

    // ── Jurisdiction-specific thresholds ───────────────────────────────────
    if (j === 'au') {
      const threshold = `A$${(AU_GST_THRESHOLD_CENTS / 100).toLocaleString('en-AU')}`;
      amountLines.push(`GST registration becomes compulsory once GST turnover reaches ${threshold} over any 12 months.`);
    }
  } catch {
    // Grounding is best-effort by design. Returning what we have degrades the
    // answer; throwing would break a conversation over a missing rate table.
  }

  return { lines, amountLines };
}
