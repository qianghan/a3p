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

interface USProgramDef {
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

// ─── US R&D Tax Credit (IRC §41) ─────────────────────────────────────────────

const rdTaxCredit41: USProgramDef = {
  summary: {
    programCode: 'us_rd_credit_41',
    name: 'Federal R&D Tax Credit (IRC §41)',
    authority: 'IRS',
    typicalValueLowCents: 1_000_000, // $10,000
    typicalValueHighCents: 25_000_000, // $250,000
  },
  roughlyApplies: (profile) => !!profile.annualRdSpendCents && profile.annualRdSpendCents > 0,
  assess: (profile) => {
    const spend = profile.annualRdSpendCents ?? 0;
    if (spend <= 0) {
      return {
        status: 'not_qualified',
        confidence: 0.9,
        reasoning: 'No R&D spend recorded yet. The credit requires qualified research expenses (QREs) under IRC §41.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    if (spend < 1_000_000) {
      return {
        status: 'possibly_qualified',
        confidence: 0.4,
        reasoning: 'Some R&D spend is recorded, but it is small enough that a claim may not be worth the filing overhead yet.',
        estValueLowCents: Math.round(spend * 0.1),
        estValueHighCents: Math.round(spend * 0.2),
      };
    }
    return {
      status: 'qualified',
      confidence: 0.75,
      reasoning: `$${(spend / 100).toLocaleString()} in recorded R&D spend likely qualifies as qualified research expense under the four-part test (permitted purpose, technological in nature, elimination of uncertainty, process of experimentation).`,
      estValueLowCents: Math.round(spend * 0.1),
      estValueHighCents: Math.round(spend * 0.2),
    };
  },
  documents: [
    { docType: 'payroll_register', label: 'Payroll register', description: 'Wages paid to employees performing qualified research, by pay period.', required: true },
    { docType: 'project_time_allocation', label: 'Project time allocation', description: 'Percentage of time each employee/contractor spent on qualified research vs. other work.', required: true },
    { docType: 'contractor_agreement', label: 'Contractor agreements', description: 'Agreements with any contractors performing qualified research (65% of contract research costs are includible).', required: false },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'approval',
      prompt: 'Confirm the described engineering/contractor work involved eliminating technical uncertainty through a process of experimentation (the "four-part test" under IRC §41) — not routine software maintenance or bug fixes.',
      options: ['approve', 'reject'],
    },
  ],
  draftSections: (inputs) => {
    const qre: DraftField[] = [];
    if (typeof inputs.profile.annualRdSpendCents === 'number') {
      qre.push({ label: 'Annual R&D spend', value: inputs.profile.annualRdSpendCents / 100, sourceType: 'book_entry' });
    }
    const payroll = inputs.documents?.payroll_register as { totalWagesCents?: number; _id?: string } | undefined;
    if (payroll?.totalWagesCents != null && payroll._id) {
      qre.push({ label: 'Payroll register total wages', value: payroll.totalWagesCents / 100, sourceType: 'document', sourceRef: payroll._id });
    }
    const timeAlloc = inputs.documents?.project_time_allocation as { qualifiedPercent?: number; _id?: string } | undefined;
    if (timeAlloc?.qualifiedPercent != null && timeAlloc._id) {
      qre.push({ label: 'Qualified research time allocation', value: `${Math.round(timeAlloc.qualifiedPercent * 100)}%`, sourceType: 'document', sourceRef: timeAlloc._id });
    }

    // Only 'approve' counts as resolving this section — a 'reject' answer
    // means the four-part test wasn't confirmed, so the section must stay
    // unpopulated (not "complete with a negative answer"), keeping
    // completeness/audit-risk conservative per the interface's contract.
    const confirmation: DraftField[] = [];
    const answer = inputs.answers?.['1'];
    if (answer === 'approve') {
      confirmation.push({ label: 'Four-part test confirmed', value: answer, sourceType: 'user_input', sourceRef: '1' });
    }

    return {
      'Qualified Research Expenses': qre,
      'Four-Part Test Confirmation': confirmation,
    };
  },
  auditChecks: (draft) => {
    const findings: AuditFinding[] = [];
    const qre = draft.sections['Qualified Research Expenses'] ?? [];
    const hasPayroll = qre.some((f) => f.label === 'Payroll register total wages');
    const hasTimeAlloc = qre.some((f) => f.label === 'Qualified research time allocation');
    if (!hasPayroll && !hasTimeAlloc) {
      findings.push({
        severity: 'high',
        issue: 'The four-part test was confirmed but no supporting documentation (payroll register or project time allocation) has been uploaded.',
        recommendation: 'Upload a payroll register and/or project time allocation record before filing — an unsubstantiated claim is the most common reason R&D credit claims are challenged on audit.',
        ruleRef: 'irs:form-6765-substantiation',
      });
    } else if (!hasPayroll || !hasTimeAlloc) {
      findings.push({
        severity: 'medium',
        issue: `Only ${hasPayroll ? 'a payroll register' : 'a project time allocation record'} has been uploaded — the other evidentiary document type is still missing.`,
        recommendation: 'Upload the remaining document type so the qualified research expense amount is supported from two independent sources.',
        ruleRef: 'irs:form-6765-substantiation',
      });
    }
    return findings;
  },
  submissionInstructions: {
    channel: 'cpa_handoff',
    summary: 'File Form 6765 attached to your federal income tax return. If pre-revenue with under $5M gross receipts, elect the payroll tax offset via Form 8974 instead.',
    steps: [
      'Complete Form 6765 (Credit for Increasing Research Activities).',
      'If electing the payroll tax offset, also complete Form 8974 and attach it to your quarterly Form 941.',
      'Attach both to your federal filing or hand off to your CPA with the supporting documents above.',
    ],
  },
  filingDeadlines: (fiscalYearEnd) => [
    {
      label: 'Form 6765 due with federal income tax return',
      date: addMonths(fiscalYearEnd, 4, 15),
      urgency: 'critical',
    },
  ],
};

// ─── QSBS Eligibility Tracking (IRC §1202) ───────────────────────────────────

const qsbsTracking: USProgramDef = {
  summary: {
    programCode: 'us_qsbs_tracking',
    name: 'QSBS Eligibility Tracking (IRC §1202)',
    authority: 'IRS',
    // Value is realized at a future exit (up to $10M or 10x basis exclusion) —
    // not a near-term dollar amount, so no typical range is quoted.
    typicalValueLowCents: null,
    typicalValueHighCents: null,
  },
  roughlyApplies: (profile) => profile.companyType === 'c_corp',
  assess: (profile) => {
    if (profile.companyType !== 'c_corp') {
      return {
        status: 'not_qualified',
        confidence: 0.9,
        reasoning: 'Qualified Small Business Stock status under IRC §1202 requires the issuing entity to be a domestic C-corporation.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    return {
      status: 'possibly_qualified',
      confidence: profile.incorporatedAt ? 0.6 : 0.3,
      reasoning: 'As a C-corp you may qualify, subject to the $50M gross-assets-at-issuance cap, the active-business requirement, and a 5-year holding period starting from your share issuance date.',
      estValueLowCents: null,
      estValueHighCents: null,
    };
  },
  documents: [
    { docType: 'stock_issuance_record', label: 'Stock issuance record', description: 'Board consent and stock purchase agreement documenting the issuance date and price.', required: true },
    { docType: 'cap_table', label: 'Capitalization table', description: 'Current cap table to confirm gross assets did not exceed $50M immediately after issuance.', required: true },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'key_input',
      prompt: 'Enter the exact date qualified small business stock was issued — this starts your 5-year holding period clock under IRC §1202.',
    },
  ],
  draftSections: (inputs) => {
    const companyDetails: DraftField[] = [];
    if (inputs.profile.companyType) {
      companyDetails.push({ label: 'Company type', value: inputs.profile.companyType, sourceType: 'book_entry' });
    }
    const shareIssuance: DraftField[] = [];
    const answer = inputs.answers?.['1'];
    if (typeof answer === 'string') {
      shareIssuance.push({ label: 'Share issuance date', value: answer, sourceType: 'user_input', sourceRef: '1' });
    }
    const supportingDocuments = documentPresenceFields(inputs, [
      { docType: 'stock_issuance_record', label: 'Stock issuance record' },
      { docType: 'cap_table', label: 'Capitalization table' },
    ]);
    // Three sections (not one) so completeness can't reach 1.0 from
    // companyType alone — the decision point must be answered AND at least
    // one supporting document uploaded. Mirrors the R&D credit program's
    // existing multi-section pattern above.
    return { 'Company Details': companyDetails, 'Share Issuance': shareIssuance, 'Supporting Documents': supportingDocuments };
  },
  auditChecks: (draft) => {
    const findings: AuditFinding[] = [];
    const docs = draft.sections['Supporting Documents'] ?? [];
    const hasCapTable = docs.some((f) => f.label === 'Capitalization table');
    const hasIssuanceRecord = docs.some((f) => f.label === 'Stock issuance record');
    if (!hasCapTable) {
      findings.push({
        severity: 'high',
        issue: 'No capitalization table has been uploaded — the $50M gross-assets-at-issuance cap under IRC §1202 cannot be verified.',
        recommendation: 'Upload the cap table from immediately after the share issuance date before relying on QSBS status.',
        ruleRef: 'irs:irc-1202-gross-assets-cap',
      });
    }
    if (!hasIssuanceRecord) {
      findings.push({
        severity: 'medium',
        issue: 'No stock issuance record has been uploaded — the issuance date and price are not independently verifiable.',
        recommendation: 'Upload the board consent and stock purchase agreement documenting the issuance.',
        ruleRef: 'irs:irc-1202-holding-period',
      });
    }
    return findings;
  },
  submissionInstructions: {
    channel: 'cpa_handoff',
    summary: 'No annual filing is required now. QSBS status is claimed on Form 8949/Schedule D when shares are eventually sold — track eligibility today so the exclusion is not lost for lack of records.',
    steps: [
      'Record the exact share issuance date and confirm gross assets were under $50M immediately after issuance.',
      'Re-confirm the active-business requirement annually until sale.',
      'Keep this file for your CPA to reference at the time of a future sale or exit.',
    ],
  },
  filingDeadlines: (fiscalYearEnd) => [
    {
      label: 'Reconfirm QSBS active-business requirement still holds',
      date: addMonths(fiscalYearEnd, 12, 31),
      urgency: 'informational',
    },
  ],
};

// ─── Delaware Franchise Tax Optimization ─────────────────────────────────────

const deFranchiseOptimization: USProgramDef = {
  summary: {
    programCode: 'us_de_franchise_optimization',
    name: 'Delaware Franchise Tax Optimization',
    authority: 'Delaware Division of Corporations',
    typicalValueLowCents: 50_000, // $500
    typicalValueHighCents: 5_000_000, // $50,000
  },
  roughlyApplies: (profile) => profile.companyType === 'c_corp',
  assess: (profile) => {
    if (profile.companyType !== 'c_corp') {
      return {
        status: 'not_qualified',
        confidence: 0.7,
        reasoning: 'Delaware franchise tax optimization applies to Delaware C-corporations.',
        estValueLowCents: null,
        estValueHighCents: null,
      };
    }
    return {
      status: 'qualified',
      confidence: 0.6,
      reasoning: 'Delaware defaults to the Authorized Shares Method, which is often far more expensive than the Assumed Par Value Capital Method for an early-stage company with many authorized shares but few assets. Most startups save money by switching methods.',
      estValueLowCents: deFranchiseOptimization.summary.typicalValueLowCents,
      estValueHighCents: deFranchiseOptimization.summary.typicalValueHighCents,
    };
  },
  documents: [
    { docType: 'annual_report_draft', label: 'Delaware annual report draft', description: 'The draft annual report as pre-filled by the state.', required: true },
    { docType: 'authorized_shares_certificate', label: 'Authorized shares certificate', description: 'Certificate of incorporation or amendment showing total authorized shares.', required: true },
  ],
  decisionPoints: () => [
    {
      sequenceOrder: 1,
      kind: 'key_input',
      prompt: 'Enter total authorized shares and total gross assets from your balance sheet — required to calculate whether the Assumed Par Value Capital Method saves more than the default Authorized Shares Method.',
    },
  ],
  draftSections: (inputs) => {
    const companyDetails: DraftField[] = [];
    if (inputs.profile.companyType) {
      companyDetails.push({ label: 'Company type', value: inputs.profile.companyType, sourceType: 'book_entry' });
    }
    const methodSelection: DraftField[] = [];
    const answer = inputs.answers?.['1'];
    if (typeof answer === 'string') {
      methodSelection.push({ label: 'Authorized shares & gross assets', value: answer, sourceType: 'user_input', sourceRef: '1' });
    }
    const supportingDocuments = documentPresenceFields(inputs, [
      { docType: 'annual_report_draft', label: 'Delaware annual report draft' },
      { docType: 'authorized_shares_certificate', label: 'Authorized shares certificate' },
    ]);
    // Three sections (not one) — see the identical note on QSBS above.
    return { 'Company Details': companyDetails, 'Franchise Tax Method Selection': methodSelection, 'Supporting Documents': supportingDocuments };
  },
  auditChecks: (draft) => {
    const findings: AuditFinding[] = [];
    const docs = draft.sections['Supporting Documents'] ?? [];
    const hasCertificate = docs.some((f) => f.label === 'Authorized shares certificate');
    const hasAnnualReport = docs.some((f) => f.label === 'Delaware annual report draft');
    if (!hasCertificate) {
      findings.push({
        severity: 'medium',
        issue: 'No authorized shares certificate has been uploaded — the recommended tax-method switch may be based on an unverified share count.',
        recommendation: 'Upload the certificate of incorporation or the amendment showing total authorized shares.',
        ruleRef: 'de-corp:franchise-tax-method',
      });
    }
    if (!hasAnnualReport) {
      findings.push({
        severity: 'low',
        issue: 'No draft annual report is on file yet.',
        recommendation: 'Upload the state-prefilled draft annual report once available to confirm final figures before filing.',
        ruleRef: 'de-corp:annual-report',
      });
    }
    return findings;
  },
  submissionInstructions: {
    channel: 'portal',
    summary: "File Delaware's Annual Franchise Tax Report through the Delaware Division of Corporations portal (corp.delaware.gov), selecting the Assumed Par Value Capital Method if it produces a lower tax than the default.",
    steps: [
      'Log in to corp.delaware.gov with your business entity file number.',
      'Enter total authorized shares, issued shares, and total gross assets.',
      'Compare the two calculated amounts and select the lower one before submitting.',
      'Pay and retain the confirmation for your records.',
    ],
  },
  filingDeadlines: () => [
    {
      label: 'Delaware Annual Franchise Tax Report due',
      date: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 2, 1)), // March 1 following the current year
      urgency: 'critical',
    },
  ],
};

const PROGRAM_REGISTRY: Record<string, USProgramDef> = {
  [rdTaxCredit41.summary.programCode]: rdTaxCredit41,
  [qsbsTracking.summary.programCode]: qsbsTracking,
  [deFranchiseOptimization.summary.programCode]: deFranchiseOptimization,
};

const ALL_PROGRAMS = [rdTaxCredit41, qsbsTracking, deFranchiseOptimization];

/** Add `months` calendar months to `date`, then set the day-of-month to `day`. */
function addMonths(date: Date, months: number, day: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, day));
}

function requireProgram(programCode: string): USProgramDef {
  const program = PROGRAM_REGISTRY[programCode];
  if (!program) throw new Error(`Unknown US tax benefit program: ${programCode}`);
  return program;
}

/**
 * Surfaces uploaded evidentiary documents as document-sourced DraftFields
 * for programs (QSBS, DE franchise) that don't extract a specific computed
 * value out of the document — the document's mere presence is the evidence.
 * Without this, uploading a program's required documents had no visible
 * effect on the draft at all.
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

/**
 * Populates every section computable from books/documents/decision-point
 * answers, tagging each field with where it came from (story C4). Each
 * program's sections map 1:1 either to book/document-derived data or a
 * single decision point, so "fraction of sections with at least one field"
 * doubles as "fraction of fields populated without a pending decision
 * point" — the completeness contract the interface documents.
 */
function draftApplication(programCode: string, inputs: ApplicationInputs): DraftResult {
  const program = requireProgram(programCode);
  const sections = program.draftSections(inputs);
  const sectionCount = Object.keys(sections).length;
  const populatedSectionCount = Object.values(sections).filter((fields) => fields.length > 0).length;
  const completeness = sectionCount === 0 ? 0 : populatedSectionCount / sectionCount;
  return { programCode: program.summary.programCode, sections, completeness };
}

export const AUDIT_REVIEW_MODEL_VERSION = 'us-audit-v1';

/** Conservative by design (bias toward flagging, per startup.html §11) — a low-completeness draft is never called low risk. */
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

export const usTaxBenefits: TaxBenefitProvider = {
  listPrograms: (profile) => ALL_PROGRAMS.filter((p) => p.roughlyApplies(profile)).map((p) => p.summary),
  assessEligibility: (programCode, profile) => requireProgram(programCode).assess(profile),
  getRequiredDocuments: (programCode) => requireProgram(programCode).documents,
  draftApplication,
  getDecisionPoints: (programCode, draft) => requireProgram(programCode).decisionPoints(draft),
  assessAuditRisk,
  getSubmissionInstructions: (programCode) => requireProgram(programCode).submissionInstructions,
  getFilingDeadlines: (programCode, fiscalYearEnd) => requireProgram(programCode).filingDeadlines(fiscalYearEnd),
};
