import type { StartupBenefitProgramSeed } from './us-programs.js';

export const AU_STARTUP_BENEFIT_PROGRAMS: StartupBenefitProgramSeed[] = [
  {
    jurisdiction: 'au',
    programCode: 'au_rd_tax_incentive',
    name: 'R&D Tax Incentive',
    authority: 'AusIndustry / ATO',
    typicalValueLowCents: 1_350_000,
    typicalValueHighCents: 1_850_000,
    eligibilityCriteria: [
      'Eligible R&D expenditure must be at least $20,000 in the income year, unless the R&D was conducted through a Research Service Provider (RSP).',
      'Activities must include at least one "core R&D activity" — an experimental activity whose outcome could not be known or determined in advance based on current knowledge, conducted for the purpose of generating new knowledge.',
      'The R&D activities must be registered with AusIndustry within 10 months of the end of the income year, before the offset can be claimed with the ATO.',
      'Companies with aggregated turnover under $20M generally receive a 43.5% refundable offset; companies at or above $20M receive a non-refundable offset with an intensity-tiered premium (8.5%/16.5%).',
    ],
    requiredDocuments: [
      { docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid to employees performing eligible R&D activities, by pay period.', required: true },
      { docType: 'project_time_allocation', label: 'Project time allocation', description: 'Percentage of time each employee/contractor spent on core or supporting R&D activities vs. other work.', required: true },
      { docType: 'ausindustry_registration', label: 'AusIndustry registration confirmation', description: 'Confirmation number from registering the R&D activities with AusIndustry.', required: true },
    ],
    sourceUrl: 'https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/incentives-and-concessions/research-and-development-tax-incentive',
  },
  {
    jurisdiction: 'au',
    programCode: 'au_esic_offset',
    name: 'Early Stage Innovation Company (ESIC) Status',
    authority: 'ATO',
    typicalValueLowCents: null,
    typicalValueHighCents: null,
    eligibilityCriteria: [
      'The issuing entity must be a company (not a sole trader, partnership, or trust) that is not listed on any stock exchange.',
      'The company must meet the early-stage test: incorporated within the last 3 income years (with extended tests up to 6/10 years for R&D-intensive companies), total expenses of $1M or less and assessable income of $200K or less in the prior income year.',
      'The company must also pass either the 100-point innovation test or the principles-based test (genuine focus on developing a new or significantly improved product for a broad addressable market).',
      "Investors in a qualifying ESIC can claim a 20% non-refundable carry-forward tax offset on new shares, capped at $200,000 per investor per year — the offset is claimed by investors, not the company.",
      'A qualifying company must lodge an annual Early Stage Innovation Company report with the ATO by 31 July, listing investors who acquired newly issued shares in the income year.',
    ],
    requiredDocuments: [
      { docType: 'expenditure_summary', label: 'Prior-year expenditure summary', description: "Total expenses for the prior income year, to confirm they're under the $1M early-stage threshold.", required: true },
      { docType: 'income_summary', label: 'Prior-year income summary', description: "Total assessable income for the prior income year, to confirm it's under the $200K early-stage threshold.", required: true },
      { docType: 'innovation_test_evidence', label: 'Innovation test evidence', description: 'Evidence supporting either the 100-point innovation test or the principles-based test.', required: true },
    ],
    sourceUrl: 'https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/incentives-and-concessions/early-stage-innovation-companies',
  },
  {
    jurisdiction: 'au',
    programCode: 'au_small_business_cgt_concessions',
    name: 'Small Business CGT Concessions',
    authority: 'ATO',
    typicalValueLowCents: null,
    typicalValueHighCents: null,
    eligibilityCriteria: [
      'The entity must be a CGT small business entity (aggregated turnover under $2M) or satisfy the $6M net asset value test.',
      'The CGT asset must satisfy the active asset test — used in the business for at least half the ownership period, or 7.5 of the last 15 years if owned for more than 15 years.',
      'Four concessions are available depending on circumstances: the 15-year exemption, the 50% active asset reduction, the retirement exemption (up to $500,000 lifetime), and the small business rollover.',
      'The concession is claimed on the income tax return in the year of the CGT event (sale) — there is no separate advance application.',
    ],
    requiredDocuments: [
      { docType: 'turnover_summary', label: 'Aggregated turnover summary', description: 'Aggregated turnover for the relevant income years, to test against the $2M small business entity threshold.', required: true },
      { docType: 'net_asset_statement', label: 'Net asset value statement', description: 'Net asset value immediately before the CGT event (excluding main residence and superannuation), to test against the $6M alternative threshold.', required: true },
      { docType: 'active_asset_history', label: 'Active asset use history', description: 'Records showing the asset was used in the business for the required active asset holding period.', required: false },
    ],
    sourceUrl: 'https://www.ato.gov.au/businesses-and-organisations/income-deductions-and-concessions/incentives-and-concessions/small-business-cgt-concessions',
  },
];
