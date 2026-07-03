/**
 * Drafted contract-template content for the four jurisdictions AgentBook
 * already supports, per sales-rep.html §16. Content-complete enough to
 * build and test the full application flow against — NOT attorney-
 * certified. `legallyReviewed: false` on every seeded row reflects that;
 * flipping it to true is a real legal sign-off event, not a code change.
 *
 * Shared between the one-off seed script (bin/seed-sales-rep-contract-templates.ts)
 * and anything that needs the raw content outside a DB round-trip (tests).
 */

export type LiabilitySectionKey =
  | 'commission_payout'
  | 'fee_rebate'
  | 'contractor_status'
  | 'no_guaranteed_income'
  | 'termination';

export const LIABILITY_SECTION_KEYS: LiabilitySectionKey[] = [
  'commission_payout',
  'fee_rebate',
  'contractor_status',
  'no_guaranteed_income',
  'termination',
];

export interface ContractTemplateSeed {
  jurisdiction: string;
  taxFormType: string;
  bodyTemplate: string;
  liabilityClauses: Record<LiabilitySectionKey, { title: string; body: string }>;
}

const US_BODY = `AGENTBOOK PARTNER PROGRAM — SALES REPRESENTATIVE AGREEMENT

1. PARTIES & EFFECTIVE DATE
   This Agreement is between AgentBook ("Company") and {{legalName}} ("Representative"),
   effective as of the date of electronic signature below.

2. APPOINTMENT
   Company appoints Representative as a non-exclusive, independent sales representative
   to refer prospective customers to Company's products. This appointment does not
   restrict Company from appointing other representatives or selling directly.

3. COMMISSION
   Representative will earn {{commissionBps}} basis points ({{commissionPercent}}%) of
   net revenue collected from each customer referred through Representative's unique
   referral link, for as long as that customer's subscription remains active, paid
   {{payoutFrequency}} via Representative's connected Stripe account.

4. FIRST-QUARTER FEE REBATE
   If Representative's cumulative commission within the 90 days following activation
   reaches {{rebateCommissionMultiple}}x the annual subscription fee Representative paid
   to Company, Company will refund that fee in full. This is a one-time incentive
   available only in Representative's first 90 days as an active representative and
   does not recur at renewal.

5. INDEPENDENT CONTRACTOR STATUS
   Representative is an independent contractor, not an employee, agent (beyond the
   limited referral authority above), partner, or joint venturer of Company.
   Representative is solely responsible for all applicable federal, state, and local
   taxes on amounts earned under this Agreement, including self-employment tax.
   Company will not withhold taxes on Representative's behalf.

6. TAX REPORTING
   Representative will provide a completed Form W-9 before any payment is issued.
   Company will issue Form 1099-NEC for any calendar year in which payments to
   Representative equal or exceed the applicable IRS threshold.

7. NO GUARANTEED INCOME
   Representative acknowledges that commission is earned solely on actual referred
   revenue. Company makes no representation as to the number of referrals
   Representative will generate or the income Representative will earn.

8. TERM & TERMINATION
   This Agreement continues until terminated. Either party may terminate for
   convenience with 14 days' written notice, or immediately for a material breach,
   including misuse of Company trademarks or provided marketing materials.
   Commission already earned on referrals made before termination remains payable
   per Section 3; no new commission accrues after the termination date.

9. CONFIDENTIALITY
   Representative will not disclose Company's non-public business information
   obtained through this Agreement to any third party.

10. MARKETING CONDUCT
    Representative may use Company-provided marketing materials in their own
    channels, including paid advertising, subject to Company's then-current brand
    guidelines. Representative will not make claims about Company's products beyond
    what Company's own materials state, will not bid on Company's trademarks in paid
    search, and will disclose the commission relationship where required by
    applicable advertising-disclosure law.

11. GOVERNING LAW
    This Agreement is governed by the laws of {{governingState}}, without regard to
    conflict-of-law principles.

12. ENTIRE AGREEMENT
    This Agreement, together with the disclosures presented during the application
    process, is the entire agreement between the parties regarding the Partner
    Program and supersedes any prior discussions.

SIGNATURE
Representative: {{signedByName}}          Date: {{signedAt}}
(Electronically signed.)`;

/**
 * String.replace() silently no-ops if `search` isn't found — a future edit
 * to US_BODY that isn't mirrored here would quietly ship a CA/UK/AU
 * contract that's just the US text, with no test necessarily catching it.
 * Fail fast at module load instead.
 */
function replaceOrThrow(source: string, search: string, replacement: string): string {
  if (!source.includes(search)) {
    throw new Error(
      `sales-rep-contract-templates: expected US_BODY to contain the text being replaced — ` +
        `it has drifted out of sync with a jurisdiction delta. Fragment: ${JSON.stringify(search.slice(0, 40))}...`,
    );
  }
  return source.replace(search, replacement);
}

const CA_BODY = replaceOrThrow(
  US_BODY,
  `6. TAX REPORTING
   Representative will provide a completed Form W-9 before any payment is issued.
   Company will issue Form 1099-NEC for any calendar year in which payments to
   Representative equal or exceed the applicable IRS threshold.`,
  `6. TAX REPORTING
   Company will issue a T4A slip for any calendar year in which payments to
   Representative equal or exceed the applicable CRA reporting threshold.
   Representative will provide a Social Insurance Number or Business Number on
   request, for T4A preparation only. If Representative's total commercial
   activity (including amounts earned under this Agreement) exceeds the CRA's
   small-supplier threshold, Representative may be required to register for
   and collect GST/HST; that registration and collection is Representative's
   own responsibility, not Company's.`,
);

const UK_BODY = replaceOrThrow(
  US_BODY,
  `5. INDEPENDENT CONTRACTOR STATUS
   Representative is an independent contractor, not an employee, agent (beyond the
   limited referral authority above), partner, or joint venturer of Company.
   Representative is solely responsible for all applicable federal, state, and local
   taxes on amounts earned under this Agreement, including self-employment tax.
   Company will not withhold taxes on Representative's behalf.

6. TAX REPORTING
   Representative will provide a completed Form W-9 before any payment is issued.
   Company will issue Form 1099-NEC for any calendar year in which payments to
   Representative equal or exceed the applicable IRS threshold.`,
  `5. INDEPENDENT CONTRACTOR STATUS
   Representative is an independent contractor, not an employee, agent (beyond the
   limited referral authority above), partner, or joint venturer of Company.
   Representative confirms they are responsible for registering as self-employed
   with HMRC and for filing their own Self Assessment return covering amounts
   earned under this Agreement. Company does not operate PAYE or National
   Insurance contributions on Representative's behalf.

6. TAX REPORTING
   Company will provide Representative an annual summary of amounts paid under
   this Agreement. Company does not issue a UK equivalent of a Form 1099 or T4A;
   Representative is responsible for reporting this income to HMRC themselves.`,
);

const AU_BODY = replaceOrThrow(
  US_BODY,
  `6. TAX REPORTING
   Representative will provide a completed Form W-9 before any payment is issued.
   Company will issue Form 1099-NEC for any calendar year in which payments to
   Representative equal or exceed the applicable IRS threshold.`,
  `6. TAX REPORTING
   Representative will provide an Australian Business Number (ABN) before any
   payment is issued. If Representative does not provide an ABN, Company may be
   required to withhold tax from payments at the applicable no-ABN withholding
   rate under Australian law.`,
);

function liabilityClauses(
  contractorStatus: string,
): Record<LiabilitySectionKey, { title: string; body: string }> {
  return {
    commission_payout: {
      title: 'Commission & payout',
      body:
        "You'll earn {{commissionPercent}}% of net revenue from customers you refer, for as long as their " +
        "subscription stays active, paid {{payoutFrequency}} via your connected Stripe account.",
    },
    fee_rebate: {
      title: 'First-90-days fee rebate',
      body:
        "If your cumulative commission in your first 90 days as an active Partner reaches " +
        "{{rebateCommissionMultiple}}x the annual fee you paid ({{annualFeeFormatted}}), we'll refund that fee " +
        "in full. This is a one-time, first-90-days incentive — it does not repeat at renewal.",
    },
    contractor_status: {
      title: 'Independent contractor status & taxes',
      body: contractorStatus,
    },
    no_guaranteed_income: {
      title: 'No guaranteed income',
      body:
        "Commission is earned only on actual referred revenue. We make no promise about how many referrals " +
        "you'll generate or how much you'll earn.",
    },
    termination: {
      title: 'Term & termination',
      body:
        "This agreement continues until either of us ends it — 14 days' written notice for convenience, or " +
        "immediately for a material breach (like misusing our marketing materials or trademarks). Commission " +
        "already earned before termination stays payable; nothing new accrues after that.",
    },
  };
}

export const CONTRACT_TEMPLATE_SEEDS: ContractTemplateSeed[] = [
  {
    jurisdiction: 'us',
    taxFormType: '1099-NEC',
    bodyTemplate: US_BODY,
    liabilityClauses: liabilityClauses(
      "You'll be an independent contractor, not an employee. You're responsible for your own federal, state, " +
        "and self-employment taxes — we won't withhold anything. We'll collect a W-9 from you before your " +
        "first payout and issue a 1099-NEC if your annual payments reach the IRS reporting threshold.",
    ),
  },
  {
    jurisdiction: 'ca',
    taxFormType: 'T4A',
    bodyTemplate: CA_BODY,
    liabilityClauses: liabilityClauses(
      "You'll be self-employed, not an employee. You're responsible for your own taxes; we won't withhold " +
        "anything. We'll issue a T4A if your annual payments reach the CRA reporting threshold, and if your " +
        "total commercial activity (including this income) crosses the small-supplier threshold, you may need " +
        "to register for GST/HST yourself.",
    ),
  },
  {
    jurisdiction: 'uk',
    taxFormType: 'self_assessment_notice',
    bodyTemplate: UK_BODY,
    liabilityClauses: liabilityClauses(
      "You'll be self-employed, not an employee. You are responsible for registering with HMRC and filing " +
        "your own Self Assessment — we do not operate PAYE or National Insurance on your behalf. We'll provide " +
        "an annual earnings summary, not a UK equivalent of a 1099/T4A.",
    ),
  },
  {
    jurisdiction: 'au',
    taxFormType: 'abn_notice',
    bodyTemplate: AU_BODY,
    liabilityClauses: liabilityClauses(
      "You'll be an independent contractor, not an employee. You're responsible for your own tax obligations. " +
        "We'll ask for your ABN — if you don't provide one, we may be required to withhold tax at the " +
        "applicable no-ABN withholding rate before paying you.",
    ),
  },
];
