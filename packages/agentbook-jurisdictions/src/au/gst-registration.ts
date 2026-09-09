/**
 * The ATO's compulsory GST-registration threshold, and what it means for an
 * invoice.
 *
 * Two rules, pulling in opposite directions, and AgentBook was getting the
 * first one wrong for every AU tenant:
 *
 *   1. You MUST NOT charge GST unless you are registered for it. A business
 *      under the threshold and unregistered that adds 10% to an invoice has
 *      taken money from its client that it has no BAS on which to remit.
 *      Only a registered business may issue a document headed "tax invoice".
 *   2. You MUST register once GST turnover reaches A$75,000 — measured on a
 *      rolling twelve months, current month included, and forward-looking:
 *      the obligation starts when you reach it OR expect to, not at year end.
 *      Registration is due within 21 days of becoming aware.
 *
 * An ABN is not GST registration. A sole trader can hold an ABN for years
 * without ever registering for GST, which is why `abn` cannot stand in for
 * the answer here.
 */

/** A$75,000, in cents. Non-profits get A$150,000; we do not model those. */
export const AU_GST_THRESHOLD_CENTS = 7_500_000;

/** Days the ATO allows to register once you become aware you have crossed. */
export const AU_GST_REGISTRATION_DAYS = 21;

export type GstStatus = 'registered' | 'not_registered' | 'unknown';

export interface GstThresholdCheck {
  /** Rolling twelve-month GST turnover considered. */
  turnoverCents: number;
  thresholdCents: number;
  /** turnover >= threshold. */
  overThreshold: boolean;
  /**
   * What the tenant should be told, or null when nothing needs saying.
   * `severity` is 'action' where the ATO imposes an obligation and 'question'
   * where we simply do not know enough to be charging what we charge.
   */
  advice: { severity: 'action' | 'question'; message: string } | null;
}

/**
 * Read a tenant's rolling-twelve-month turnover against the threshold.
 *
 * Deliberately does not decide anything on its own — it returns what to say.
 * The decision of whether to charge GST belongs to `shouldChargeGst`, which
 * reads the tenant's answer and nothing else: turnover crossing a threshold
 * creates an obligation to register, and registration is what permits the
 * charge. Inferring "over threshold, therefore charge GST" would have us
 * collecting tax on behalf of a business the ATO has no record of.
 */
export function checkGstThreshold(
  turnoverCents: number,
  status: GstStatus,
): GstThresholdCheck {
  const overThreshold = turnoverCents >= AU_GST_THRESHOLD_CENTS;
  const fmt = (c: number) => `A$${Math.round(c / 100).toLocaleString('en-AU')}`;

  let advice: GstThresholdCheck['advice'] = null;

  if (overThreshold && status !== 'registered') {
    advice = {
      severity: 'action',
      message: `Your GST turnover over the last 12 months is ${fmt(turnoverCents)}, at or above the ATO's ${fmt(AU_GST_THRESHOLD_CENTS)} threshold, so registering for GST is now compulsory — within ${AU_GST_REGISTRATION_DAYS} days of becoming aware. Register through the ATO or your registered tax agent, then set GST registration to "registered" in Settings so invoices carry GST and are issued as tax invoices.`,
    };
  } else if (!overThreshold && status === 'unknown') {
    // The quiet, expensive case. Under the threshold, most sole traders are
    // not registered — and we have been adding 10% to their invoices and
    // heading them "TAX INVOICE" without ever asking.
    advice = {
      severity: 'question',
      message: `Are you registered for GST? Your turnover over the last 12 months is ${fmt(turnoverCents)}, under the ${fmt(AU_GST_THRESHOLD_CENTS)} threshold, so registration is optional. AgentBook is currently adding 10% GST to your invoices — if you are not registered, you should not be charging it. Set your GST registration in Settings.`,
    };
  } else if (overThreshold && status === 'registered') {
    advice = null;
  }

  return { turnoverCents, thresholdCents: AU_GST_THRESHOLD_CENTS, overThreshold, advice };
}

/**
 * Whether GST applies to an AU invoice — one predicate, governing both the
 * 10% charge AND the "TAX INVOICE" heading, because the two must agree.
 *
 * An invoice that charges GST but is not headed "tax invoice" is not a valid
 * tax invoice, and the client cannot claim the input-tax credit on GST they
 * were nonetheless charged. Splitting these into a lenient rule for the
 * charge and a strict one for the heading produces exactly that document, so
 * there is deliberately only one function.
 *
 * `unknown` applies GST, which is what every AU tenant gets today. Flipping
 * the unanswered case would quietly stop a genuinely registered business from
 * collecting GST it still owes the ATO at BAS time — paid out of its own
 * pocket. Neither default is safe, so the unanswered case changes nothing and
 * `checkGstThreshold` asks the question instead of guessing at the answer.
 */
export function auGstApplies(status: GstStatus): boolean {
  return status !== 'not_registered';
}

/** Map the nullable DB column onto the tri-state. */
export function gstStatusOf(gstRegistered: boolean | null | undefined): GstStatus {
  if (gstRegistered === true) return 'registered';
  if (gstRegistered === false) return 'not_registered';
  return 'unknown';
}
