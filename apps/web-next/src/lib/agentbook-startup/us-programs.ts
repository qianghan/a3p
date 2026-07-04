/**
 * Mirrors plugins/agentbook-startup/backend/src/catalog/us-programs.ts
 * exactly. Duplicated here for the same reason as ./discovery.ts — see
 * that file's header comment.
 */
export interface StartupBenefitProgramSeed {
  jurisdiction: string;
  programCode: string;
  name: string;
  authority: string;
  typicalValueLowCents: number | null;
  typicalValueHighCents: number | null;
  eligibilityCriteria: string[];
  requiredDocuments: { docType: string; label: string; description: string; required: boolean }[];
  sourceUrl: string;
}

export const US_STARTUP_BENEFIT_PROGRAMS: StartupBenefitProgramSeed[] = [
  {
    jurisdiction: 'us',
    programCode: 'us_rd_credit_41',
    name: 'Federal R&D Tax Credit (IRC §41)',
    authority: 'IRS',
    typicalValueLowCents: 1_000_000,
    typicalValueHighCents: 25_000_000,
    eligibilityCriteria: [
      'Expenses must be qualified research expenses (QREs): wages, supplies, and 65% of contract research costs.',
      'Research must pass the four-part test: permitted purpose, technological in nature, elimination of uncertainty, and a process of experimentation.',
      'To elect the payroll tax offset (Form 8974) instead of an income tax credit, the company must have under $5M in current-year gross receipts and no gross receipts for any year before the 5 preceding years.',
    ],
    requiredDocuments: [
      { docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid to employees performing qualified research, by pay period.', required: true },
      { docType: 'project_time_allocation', label: 'Project time allocation', description: 'Percentage of time each employee/contractor spent on qualified research vs. other work.', required: true },
      { docType: 'contractor_agreement', label: 'Contractor agreements', description: 'Agreements with any contractors performing qualified research.', required: false },
    ],
    sourceUrl: 'https://www.irs.gov/forms-pubs/about-form-6765',
  },
  {
    jurisdiction: 'us',
    programCode: 'us_qsbs_tracking',
    name: 'QSBS Eligibility Tracking (IRC §1202)',
    authority: 'IRS',
    typicalValueLowCents: null,
    typicalValueHighCents: null,
    eligibilityCriteria: [
      'The issuing entity must be a domestic C-corporation.',
      "The corporation's gross assets must not have exceeded $50M at any time up to immediately after the stock issuance.",
      "At least 80% of the corporation's assets must be used in the active conduct of a qualified trade or business.",
      'Stock must be held for more than 5 years to claim the exclusion (up to $10M or 10x basis, whichever is greater) under IRC §1202.',
    ],
    requiredDocuments: [
      { docType: 'stock_issuance_record', label: 'Stock issuance record', description: 'Board consent and stock purchase agreement documenting the issuance date and price.', required: true },
      { docType: 'cap_table', label: 'Capitalization table', description: 'Current cap table to confirm gross assets did not exceed $50M immediately after issuance.', required: true },
    ],
    sourceUrl: 'https://www.irs.gov/pub/irs-pdf/i1202.pdf',
  },
  {
    jurisdiction: 'us',
    programCode: 'us_de_franchise_optimization',
    name: 'Delaware Franchise Tax Optimization',
    authority: 'Delaware Division of Corporations',
    typicalValueLowCents: 50_000,
    typicalValueHighCents: 5_000_000,
    eligibilityCriteria: [
      'Applies to any corporation incorporated in Delaware.',
      "Delaware's default calculation (Authorized Shares Method) can be dramatically higher than the alternative (Assumed Par Value Capital Method) for early-stage companies with many authorized shares but low assets.",
      'The lower of the two calculated amounts may be elected when filing the annual report.',
    ],
    requiredDocuments: [
      { docType: 'annual_report_draft', label: 'Delaware annual report draft', description: 'The draft annual report as pre-filled by the state.', required: true },
      { docType: 'authorized_shares_certificate', label: 'Authorized shares certificate', description: 'Certificate of incorporation or amendment showing total authorized shares.', required: true },
    ],
    sourceUrl: 'https://corp.delaware.gov/frtaxcalc/',
  },
];
