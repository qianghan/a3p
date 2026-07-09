import type {
  TaxBenefitProvider,
  StartupProfile,
  TaxBenefitProgramSummary,
  EligibilityAssessment,
  DocumentRequirement,
  ApplicationInputs,
  DraftField,
  DraftResult,
  DecisionPoint,
  AuditFinding,
  AuditRiskAssessment,
  SubmissionInstructions,
  Deadline,
} from '../interfaces.js';

interface AUProgramDef {
  summary: TaxBenefitProgramSummary;
  roughlyApplies(profile: StartupProfile): boolean;
  assess(profile: StartupProfile): EligibilityAssessment;
  documents: DocumentRequirement[];
  decisionPoints(draft: DraftResult): DecisionPoint[];
  draftSections(inputs: ApplicationInputs): Record<string, DraftField[]>;
  auditChecks(draft: DraftResult): AuditFinding[];
  submissionInstructions: SubmissionInstructions;
  filingDeadlines(fiscalYearEnd: Date): Deadline[];
}

// ─── R&D Tax Incentive ───────────────────────────────────────────────────────
// Unlike the US credit (single IRS authority), this program is jointly
// administered: AusIndustry registers the R&D activities (a hard 10-month
// deadline, without which the ATO offset cannot be claimed at all) and the
// ATO pays out the offset via the company tax return.

const rdTaxIncentive: AUProgramDef = {
  summary: {
    programCode: 'au_rd_tax_incentive',
    name: 'R&D Tax Incentive',
    authority: 'AusIndustry / ATO',
    typicalValueLowCents: 1_350_000, // 13.5% of a $100,000 spend (base-rate company)
    typicalValueHighCents: 18_500_000, // 18.5% of a $100,000 spend (non-base-rate company)
  },
  roughlyApplies: (profile) => !!profile.annualRdSpendCents && profile.annualRdSpendCents > 0,
  assess: (profile) => {
    const spend = profile.annualRdSpendCents ?? 0;
    if (spend <= 0) {
      return {
        status: 'not_qualified',
        confidence: 0.9,
        reasoning: 'No R&D spend recorded yet. The R&D Tax Incentive requires notional deductions for eligible R&D activities.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    if (spend < 2_000_000) {
      return {
        status: 'not_qualified',
        confidence: 0.7,
        reasoning: 'Recorded R&D spend is below the $20,000 minimum expenditure threshold — below this you can only claim if you used a Research Service Provider (RSP).',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    // The refundable offset rate (43.5% for aggregated turnover under $20M) exceeds
    // the standard company tax deduction rate (25%/30%), so the *net cash benefit*
    // over simply deducting the spend is roughly the difference — 13.5-18.5 points —
    // not the full 43.5%. AgentBook doesn't yet track aggregated turnover, so this
    // assumes the refundable (small/medium company) rate rather than the
    // non-refundable, intensity-tiered premium rate that applies at $20M+ turnover.
    return {
      status: 'qualified',
      confidence: 0.7,
      reasoning: `$${(spend / 100).toLocaleString()} in recorded R&D spend likely qualifies for the 43.5% refundable R&D tax offset (aggregated turnover under $20M), subject to registering the activities with AusIndustry and them meeting the "core R&D activity" test (experimental activities whose outcome could not be known or determined in advance, based on established scientific principles).`,
      estValueLowCents: Math.round(spend * 0.135),
      estValueHighCents: Math.round(spend * 0.185),
    };
  },
  documents: [
    { docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid to employees performing eligible R&D activities, by pay period.', required: true },
    { docType: 'project_time_allocation', label: 'Project time allocation', description: 'Percentage of time each employee/contractor spent on core or supporting R&D activities vs. other work.', required: true },
    { docType: 'ausindustry_registration', label: 'AusIndustry registration confirmation', description: 'Confirmation number from registering the R&D activities with AusIndustry — required before the ATO offset can be claimed.', required: true },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'approval',
      prompt: 'Confirm the described activities meet the "core R&D activity" test — experimental activities conducted for generating new knowledge, whose outcome could not be known or determined in advance based on current knowledge — not routine software maintenance or bug fixes.',
      options: ['approve', 'reject'],
    },
  ],
  draftSections: (inputs) => {
    const expenditure: DraftField[] = [];
    if (typeof inputs.profile.annualRdSpendCents === 'number') {
      expenditure.push({ label: 'Annual R&D spend', value: inputs.profile.annualRdSpendCents / 100, sourceType: 'book_entry' });
    }
    const payroll = inputs.documents?.payroll_register as { totalWagesCents?: number; _id?: string } | undefined;
    if (payroll?.totalWagesCents != null && payroll._id) {
      expenditure.push({ label: 'Payroll register total wages', value: payroll.totalWagesCents / 100, sourceType: 'document', sourceRef: payroll._id });
    }
    const timeAlloc = inputs.documents?.project_time_allocation as { qualifiedPercent?: number; _id?: string } | undefined;
    if (timeAlloc?.qualifiedPercent != null && timeAlloc._id) {
      expenditure.push({ label: 'Qualified R&D time allocation', value: `${Math.round(timeAlloc.qualifiedPercent * 100)}%`, sourceType: 'document', sourceRef: timeAlloc._id });
    }

    const registration = documentPresenceFields(inputs, [
      { docType: 'ausindustry_registration', label: 'AusIndustry registration confirmation' },
    ]);

    // Only 'approve' counts — a 'reject' means the core-R&D-activity test wasn't
    // confirmed, so this section must stay unpopulated, keeping completeness/audit
    // risk conservative (mirrors the US R&D credit's four-part-test confirmation).
    const confirmation: DraftField[] = [];
    const answer = inputs.answers?.['1'];
    if (answer === 'approve') {
      confirmation.push({ label: 'Core R&D activity test confirmed', value: answer, sourceType: 'user_input', sourceRef: '1' });
    }

    return {
      'Eligible R&D Expenditure': expenditure,
      'AusIndustry Registration': registration,
      'Core R&D Activity Confirmation': confirmation,
    };
  },
  auditChecks: (draft) => {
    const findings: AuditFinding[] = [];
    const registration = draft.sections['AusIndustry Registration'] ?? [];
    if (registration.length === 0) {
      findings.push({
        severity: 'high',
        issue: 'No AusIndustry registration confirmation on file — without this, the ATO will not accept a claim for the R&D tax offset regardless of how well-documented the expenditure is.',
        recommendation: 'Register the R&D activities with AusIndustry (via business.gov.au) within 10 months of the income year end, then upload the registration confirmation.',
        ruleRef: 'ausindustry:registration-required',
      });
    }
    const expenditure = draft.sections['Eligible R&D Expenditure'] ?? [];
    const hasPayroll = expenditure.some((f) => f.label === 'Payroll register total wages');
    const hasTimeAlloc = expenditure.some((f) => f.label === 'Qualified R&D time allocation');
    if (!hasPayroll || !hasTimeAlloc) {
      findings.push({
        severity: 'medium',
        issue: `${!hasPayroll && !hasTimeAlloc ? 'Neither a payroll register nor a project time allocation record' : !hasPayroll ? 'No payroll register' : 'No project time allocation record'} has been uploaded to substantiate the claimed R&D expenditure.`,
        recommendation: 'Upload both documents so the eligible expenditure amount is supported from independent sources before lodging the R&D Tax Incentive schedule.',
        ruleRef: 'ato:rdti-substantiation',
      });
    }
    return findings;
  },
  submissionInstructions: {
    channel: 'cpa_handoff',
    summary: "Register the R&D activities with AusIndustry within 10 months of your income year end, then claim the offset on the R&D Tax Incentive schedule attached to your company's income tax return.",
    steps: [
      'Register the R&D activities with AusIndustry via business.gov.au (10-month deadline from income year end — a hard cutoff, no extensions).',
      'Complete the R&D Tax Incentive schedule using the AusIndustry registration number.',
      'Attach the schedule to your company income tax return, or hand off to your CPA with the supporting documents above.',
    ],
  },
  filingDeadlines: (fiscalYearEnd) => [
    {
      label: 'AusIndustry R&D activity registration due',
      date: addMonths(fiscalYearEnd, 10, 30),
      urgency: 'critical',
    },
    {
      label: 'R&D Tax Incentive schedule due with company income tax return',
      date: addMonths(fiscalYearEnd, 11, 15),
      urgency: 'critical',
    },
  ],
};

// ─── Early Stage Innovation Company (ESIC) ───────────────────────────────────
// Framed company-facing: the tax offset itself is claimed by investors, not
// the company, so this program helps a company self-assess and document its
// own ESIC eligibility (to attract ESIC-eligible investment) rather than
// modeling a separate investor user-type. The company still has a real
// filing obligation — the annual ESIC report to the ATO.

const esicOffset: AUProgramDef = {
  summary: {
    programCode: 'au_esic_offset',
    name: 'Early Stage Innovation Company (ESIC) Status',
    authority: 'ATO',
    // The 20% offset (capped at $200,000/year) is realized by investors on
    // their own tax return, not paid to the company — no company-side dollar
    // amount to quote, same shape as QSBS.
    typicalValueLowCents: null,
    typicalValueHighCents: null,
  },
  roughlyApplies: (profile) => profile.companyType === 'pty_ltd',
  assess: (profile) => {
    if (profile.companyType !== 'pty_ltd') {
      return {
        status: 'not_qualified',
        confidence: 0.9,
        reasoning: 'ESIC status applies only to companies (not sole traders, partnerships, or trusts) issuing new shares to investors.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    return {
      status: 'possibly_qualified',
      confidence: profile.incorporatedAt ? 0.6 : 0.3,
      reasoning: 'As a company you may qualify as an Early Stage Innovation Company, letting investors claim a 20% non-refundable tax offset (capped at $200,000/year) on newly issued shares — subject to the early-stage test (incorporated within the last 3 income years, assessable income under $200K and expenses under $1M in the prior income year, not listed on any stock exchange) and either the 100-point innovation test or the principles-based test.',
      estValueLowCents: null,
      estValueHighCents: null,
    };
  },
  documents: [
    { docType: 'expenditure_summary', label: 'Prior-year expenditure summary', description: "Total expenses for the prior income year, to confirm they're under the $1M early-stage threshold.", required: true },
    { docType: 'income_summary', label: 'Prior-year income summary', description: "Total assessable income for the prior income year, to confirm it's under the $200K early-stage threshold.", required: true },
    { docType: 'innovation_test_evidence', label: 'Innovation test evidence', description: 'Evidence supporting either the 100-point innovation test (e.g. R&D Tax Incentive registration) or the principles-based test (genuine focus on developing a new or significantly improved product for a broad addressable market).', required: true },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'approval',
      prompt: 'Confirm the company is not listed on any stock exchange and was incorporated within the last 3 income years (or otherwise qualifies under the extended early-stage eligibility tests).',
      options: ['approve', 'reject'],
    },
  ],
  draftSections: (inputs) => {
    const companyDetails: DraftField[] = [];
    if (inputs.profile.companyType) {
      companyDetails.push({ label: 'Company type', value: inputs.profile.companyType, sourceType: 'book_entry' });
    }
    if (inputs.profile.incorporatedAt) {
      companyDetails.push({ label: 'Incorporated at', value: inputs.profile.incorporatedAt.toISOString().slice(0, 10), sourceType: 'book_entry' });
    }

    const earlyStageTest = documentPresenceFields(inputs, [
      { docType: 'expenditure_summary', label: 'Prior-year expenditure summary' },
      { docType: 'income_summary', label: 'Prior-year income summary' },
    ]);

    const innovationTest = documentPresenceFields(inputs, [
      { docType: 'innovation_test_evidence', label: 'Innovation test evidence' },
    ]);

    // Its own section, separate from the document-driven sections above — so
    // completeness can never reach 1.0 purely from uploaded documents without
    // the early-stage confirmation actually being answered (mirrors the US
    // QSBS/DE franchise pattern's dedicated decision-point section).
    const confirmation: DraftField[] = [];
    const answer = inputs.answers?.['1'];
    if (answer === 'approve') {
      confirmation.push({ label: 'Early-stage eligibility confirmed', value: answer, sourceType: 'user_input', sourceRef: '1' });
    }

    return {
      'Company Details': companyDetails,
      'Early-Stage Test Evidence': earlyStageTest,
      'Innovation Test Evidence': innovationTest,
      'Early-Stage Confirmation': confirmation,
    };
  },
  auditChecks: (draft) => {
    const findings: AuditFinding[] = [];
    const innovation = draft.sections['Innovation Test Evidence'] ?? [];
    const hasEvidence = innovation.some((f) => f.label === 'Innovation test evidence');
    if (!hasEvidence) {
      findings.push({
        severity: 'high',
        issue: 'No innovation test evidence has been uploaded — ESIC status cannot be substantiated under either the 100-point test or the principles-based test without it.',
        recommendation: 'Upload evidence supporting the 100-point innovation test or the principles-based test before reporting the company as an ESIC to investors.',
        ruleRef: 'ato:esic-innovation-test',
      });
    }
    const earlyStage = draft.sections['Early-Stage Test Evidence'] ?? [];
    if (earlyStage.length < 2) {
      findings.push({
        severity: 'medium',
        issue: 'The prior-year expenditure and/or income summary is missing — the $1M expense cap and $200K assessable income cap for the early-stage test cannot both be verified.',
        recommendation: 'Upload both the prior-year expenditure summary and income summary.',
        ruleRef: 'ato:esic-early-stage-test',
      });
    }
    return findings;
  },
  submissionInstructions: {
    channel: 'portal',
    summary: 'Self-assess ESIC status against the early-stage test and the innovation test, then lodge the annual Early Stage Innovation Company report via the ATO Online Business Portal so eligible investors can claim their offset.',
    steps: [
      'Confirm the early-stage test (incorporation date, prior-year expenses and assessable income) and the innovation test (100-point test or principles-based test).',
      'Log in to the ATO Online Business Portal.',
      'Lodge the Early Stage Innovation Company report, listing investors who acquired newly issued shares in the income year.',
      'Provide each listed investor with confirmation of the company\'s ESIC status for their own tax return.',
    ],
  },
  filingDeadlines: (fiscalYearEnd) => [
    {
      label: 'Early Stage Innovation Company (ESIC) report due to the ATO',
      date: addMonths(fiscalYearEnd, 1, 31),
      urgency: 'critical',
    },
  ],
};

// ─── Small Business CGT Concessions ──────────────────────────────────────────
// Value is realized at a future CGT event (sale of the business), not a
// near-term dollar amount — same shape as QSBS: track eligibility today so
// the concession isn't lost for lack of records by the time of exit.

const smallBusinessCgtConcessions: AUProgramDef = {
  summary: {
    programCode: 'au_small_business_cgt_concessions',
    name: 'Small Business CGT Concessions',
    authority: 'ATO',
    typicalValueLowCents: null,
    typicalValueHighCents: null,
  },
  roughlyApplies: (profile) => !!profile.companyType,
  assess: (profile) => {
    if (!profile.companyType) {
      return {
        status: 'not_qualified',
        confidence: 0.5,
        reasoning: 'No business structure recorded yet — the small business CGT concessions require an active business asset held by a recognized entity (sole trader, partnership, company, or trust).',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    return {
      status: 'possibly_qualified',
      confidence: 0.35,
      reasoning: 'The small business CGT concessions (15-year exemption, 50% active asset reduction, retirement exemption, and small business rollover) may reduce or eliminate capital gains tax on a future sale of the business, subject to the $2M aggregated turnover test (or the $6M net asset value test) and the active asset test. AgentBook does not yet track turnover or net asset value, so eligibility cannot be confirmed until closer to a sale.',
      estValueLowCents: null,
      estValueHighCents: null,
    };
  },
  documents: [
    { docType: 'turnover_summary', label: 'Aggregated turnover summary', description: 'Aggregated turnover for the relevant income years, to test against the $2M small business entity threshold.', required: true },
    { docType: 'net_asset_statement', label: 'Net asset value statement', description: 'Net asset value immediately before the CGT event (excluding main residence and superannuation), to test against the $6M alternative threshold.', required: true },
    { docType: 'active_asset_history', label: 'Active asset use history', description: 'Records showing the asset was used in the business for at least half the ownership period (or 7.5 of the last 15 years).', required: false },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'key_input',
      prompt: 'Which concession are you tracking toward: the 15-year exemption, the 50% active asset reduction, the retirement exemption, or the small business rollover? Each has its own additional conditions.',
    },
  ],
  draftSections: (inputs) => {
    const companyDetails: DraftField[] = [];
    if (inputs.profile.companyType) {
      companyDetails.push({ label: 'Company type', value: inputs.profile.companyType, sourceType: 'book_entry' });
    }
    const entityTest = documentPresenceFields(inputs, [
      { docType: 'turnover_summary', label: 'Aggregated turnover summary' },
      { docType: 'net_asset_statement', label: 'Net asset value statement' },
    ]);
    const concessionSelection: DraftField[] = [];
    const answer = inputs.answers?.['1'];
    if (typeof answer === 'string') {
      concessionSelection.push({ label: 'Concession being tracked', value: answer, sourceType: 'user_input', sourceRef: '1' });
    }
    return {
      'Company Details': companyDetails,
      'Small Business Entity Test': entityTest,
      'Concession Selection': concessionSelection,
    };
  },
  auditChecks: (draft) => {
    const findings: AuditFinding[] = [];
    const entityTest = draft.sections['Small Business Entity Test'] ?? [];
    const hasTurnover = entityTest.some((f) => f.label === 'Aggregated turnover summary');
    const hasNetAssets = entityTest.some((f) => f.label === 'Net asset value statement');
    if (!hasTurnover && !hasNetAssets) {
      findings.push({
        severity: 'high',
        issue: 'Neither an aggregated turnover summary nor a net asset value statement has been uploaded — neither of the two alternative small business entity tests can be verified.',
        recommendation: 'Upload at least one: the aggregated turnover summary (for the $2M test) or the net asset value statement (for the $6M test).',
        ruleRef: 'ato:sb-cgt-entity-test',
      });
    }
    return findings;
  },
  submissionInstructions: {
    channel: 'cpa_handoff',
    summary: 'Claimed via the small business CGT concession labels on your income tax return in the year of the CGT event (sale) — there is no separate application to lodge in advance.',
    steps: [
      'Confirm the small business entity test ($2M aggregated turnover or $6M net asset value) and the active asset test.',
      'Select the concession(s) that apply at the time of sale.',
      'Complete the relevant CGT concession labels on your income tax return for the year of the sale, or hand off to your CPA with the supporting documents above.',
    ],
  },
  filingDeadlines: (fiscalYearEnd) => [
    {
      label: 'Reconfirm small business CGT concession eligibility ahead of any sale',
      date: addMonths(fiscalYearEnd, 12, 31),
      urgency: 'informational',
    },
  ],
};

const PROGRAM_REGISTRY: Record<string, AUProgramDef> = {
  [rdTaxIncentive.summary.programCode]: rdTaxIncentive,
  [esicOffset.summary.programCode]: esicOffset,
  [smallBusinessCgtConcessions.summary.programCode]: smallBusinessCgtConcessions,
};

const ALL_PROGRAMS = [rdTaxIncentive, esicOffset, smallBusinessCgtConcessions];

/** Add `months` calendar months to `date`, then set the day-of-month to `day`. */
function addMonths(date: Date, months: number, day: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, day));
}

function requireProgram(programCode: string): AUProgramDef {
  const program = PROGRAM_REGISTRY[programCode];
  if (!program) throw new Error(`Unknown AU tax benefit program: ${programCode}`);
  return program;
}

/**
 * Surfaces uploaded evidentiary documents as document-sourced DraftFields for
 * programs that don't extract a specific computed value out of the document —
 * the document's mere presence is the evidence. Mirrors us/tax-benefits.ts.
 */
function documentPresenceFields(
  inputs: ApplicationInputs,
  requirements: { docType: string; label: string }[],
): DraftField[] {
  const fields: DraftField[] = [];
  for (const req of requirements) {
    const doc = inputs.documents?.[req.docType] as { _id?: string } | undefined;
    if (doc?._id) {
      fields.push({ label: req.label, value: 'Uploaded', sourceType: 'document', sourceRef: doc._id });
    }
  }
  return fields;
}

function draftApplication(programCode: string, inputs: ApplicationInputs): DraftResult {
  const program = requireProgram(programCode);
  const sections = program.draftSections(inputs);
  const sectionCount = Object.keys(sections).length;
  const populatedSectionCount = Object.values(sections).filter((fields) => fields.length > 0).length;
  const completeness = sectionCount === 0 ? 0 : populatedSectionCount / sectionCount;
  return { programCode: program.summary.programCode, sections, completeness };
}

/** Conservative by design (bias toward flagging, per startup.html §11) — a low-completeness draft is never called low risk. Mirrors us/tax-benefits.ts. */
function assessAuditRisk(programCode: string, draft: DraftResult): AuditRiskAssessment {
  const program = requireProgram(programCode);
  if (draft.completeness < 1) {
    const severity: 'medium' | 'high' = draft.completeness > 0 ? 'medium' : 'high';
    return {
      riskLevel: severity,
      findings: [
        {
          severity,
          issue: 'Draft is incomplete — one or more decision points have not been resolved.',
          recommendation: 'Resolve all outstanding decision points before marking this application ready for review.',
          ruleRef: 'internal:completeness-gate',
        },
      ],
    };
  }
  const findings = program.auditChecks(draft);
  const riskLevel: 'low' | 'medium' | 'high' = findings.some((f) => f.severity === 'high')
    ? 'high'
    : findings.some((f) => f.severity === 'medium')
      ? 'medium'
      : 'low';
  return { riskLevel, findings };
}

export const auTaxBenefits: TaxBenefitProvider = {
  listPrograms: (profile) => ALL_PROGRAMS.filter((p) => p.roughlyApplies(profile)).map((p) => p.summary),
  assessEligibility: (programCode, profile) => requireProgram(programCode).assess(profile),
  getRequiredDocuments: (programCode) => requireProgram(programCode).documents,
  draftApplication,
  getDecisionPoints: (programCode, draft) => requireProgram(programCode).decisionPoints(draft),
  assessAuditRisk,
  getSubmissionInstructions: (programCode) => requireProgram(programCode).submissionInstructions,
  getFilingDeadlines: (programCode, fiscalYearEnd) => requireProgram(programCode).filingDeadlines(fiscalYearEnd),
};
