/**
 * Jurisdiction interfaces — implemented by each country pack.
 * Adding a new country = implement these interfaces. Zero framework changes.
 */

export interface TaxBracket {
  min: number;      // income threshold in cents
  max: number | null;
  rate: number;     // decimal (0.10 = 10%)
}

export interface TaxCalculation {
  taxCents: number;
  effectiveRate: number;
  marginalRate: number;
  bracketBreakdown: { bracket: TaxBracket; taxCents: number }[];
}

export interface TaxBracketProvider {
  jurisdiction: string;
  region?: string;
  getTaxBrackets(taxYear: number): TaxBracket[];
  calculateTax(taxableIncomeCents: number, taxYear: number): TaxCalculation;
}

export interface SelfEmploymentTaxResult {
  amountCents: number;
  deductiblePortionCents: number;
  breakdown: Record<string, number>;
}

export interface SelfEmploymentTaxCalculator {
  calculate(netSelfEmploymentIncomeCents: number, taxYear: number): SelfEmploymentTaxResult;
}

export interface SalesTaxRate {
  region: string;
  taxType: string;    // 'state' | 'GST' | 'HST' | 'PST'
  rate: number;       // decimal
  name: string;
}

export interface SalesTaxResult {
  totalRate: number;
  totalCents: number;
  components: { type: string; rate: number; amountCents: number }[];
}

export interface SalesTaxEngine {
  getRates(region: string): SalesTaxRate[];
  calculateTax(amountCents: number, region: string): SalesTaxResult;
  getFilingDeadlines(region: string, taxYear: number): Date[];
}

export interface TaxFormData {
  formId: string;
  taxYear: number;
  fields: Record<string, string | number>;
}

export interface TaxFormGenerator {
  formId: string;
  generate(ledgerSummary: Record<string, number>, taxYear: number): TaxFormData;
}

export interface InstallmentDeadline {
  quarter: number;
  deadline: Date;
  label: string;
}

export interface InstallmentSchedule {
  getDeadlines(taxYear: number): InstallmentDeadline[];
  calculateAmount(method: string, yearToDateIncomeCents: number, priorYearTaxCents: number): number;
}

export interface ContractorReport {
  contractorName: string;
  totalPaidCents: number;
  formId: string;
}

export interface ContractorReportGenerator {
  threshold: number;     // cents: US = 60000, CA = 50000
  formId: string;
  generate(payments: { name: string; totalCents: number }[], taxYear: number): ContractorReport[];
}

export interface Account {
  code: string;
  name: string;
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  taxCategory?: string;
  parent?: string;
}

export interface ChartOfAccountsTemplate {
  getDefaultAccounts(businessType: string): Account[];
  getTaxCategoryMapping(): Record<string, string>;
}

export interface MileageRate {
  rate: number;
  unit: 'mile' | 'km';
  tierDescription?: string;
}

export interface MileageRateProvider {
  getRate(taxYear: number, totalDistance: number): MileageRate;
}

export interface DeductionRule {
  id: string;
  name: string;
  description: string;
  category: string;
}

export interface DeductionRuleSet {
  getAvailableDeductions(businessType: string): DeductionRule[];
  calculateDeduction(ruleId: string, inputs: Record<string, number>): number;
}

export interface CalendarDeadline {
  titleKey: string;
  date: string;       // ISO date
  urgency: 'critical' | 'important' | 'informational';
  actionUrl?: string;
  actionLabelKey?: string;
  recurrence: 'annual' | 'quarterly' | 'monthly' | 'once';
}

export interface CalendarDeadlineProvider {
  getDeadlines(taxYear: number, region: string): CalendarDeadline[];
}

// ─── Past Filing Upload ──────────────────────────────────────────────────────

export interface StandardTaxExtract {
  formType: string
  taxYear: number
  jurisdiction: string
  region?: string
  totalIncomeCents?: number
  netIncomeCents?: number
  taxableIncomeCents?: number
  taxPayableCents?: number
  /** positive = refund, negative = balance owing */
  refundOrBalanceCents?: number
  /** RRSP room (CA) | KiwiSaver credit (NZ) | ISA allowance (UK) | super (AU) */
  savingsRoomCents?: number
  formFields: Record<string, number | string | boolean | null>
  attachedForms: Record<string, Record<string, any>>
  confidence: number
}

export interface PreFillSuggestion {
  fieldId: string
  value: any
  sourceField: string
  confidence: number
}

export interface EFileExport {
  format: 'xml' | 'json' | 'pdf'
  content: string
  filename: string
  instructions: string
}

export interface PastFilingFormDescriptor {
  formType: string
  displayName: string
  description: string
  typicalPages?: number
}

export interface PastFilingPack {
  jurisdiction: string
  supportedFormTypes(): PastFilingFormDescriptor[]
  identificationPrompt(): string
  extractionPrompt(formType: string, taxYear: number): string
  parseExtraction(raw: any, formType: string, taxYear: number): StandardTaxExtract
  preFillMap(extract: StandardTaxExtract): PreFillSuggestion[]
  summarize(extract: StandardTaxExtract): string
  generateEFileExport?(forms: Record<string, any>, taxYear: number, region?: string): EFileExport
}

// ─── Tax Fast-Track Questionnaire ────────────────────────────────────────────
// Adaptive, one-question-per-turn questionnaire pack used by the fast-track
// filing flow (a tenant with a confirmed prior-year filing asks "help me do
// this year's filing"). Both methods are pure and synchronous — the pack
// never calls an LLM itself and never sees a raw string; the caller is
// responsible for the callGemini() call and for markdown-fence-stripping +
// JSON.parse'ing the LLM's raw response before handing the parsed value to
// parseNextQuestionResponse(). See docs/superpowers/specs/2026-07-13-tax-fast-track-foundation-design.md
// ("Revised: pack interface") for why this shape, not an LLM-calling one.

export interface TaxQuestionnairePack {
  jurisdiction: string
  nextQuestionPrompt(input: {
    qaHistory: { question: string; answer: string }[]
    priorFiling?: StandardTaxExtract
    profile?: string
  }): string
  parseNextQuestionResponse(parsed: unknown): { question: string } | { done: true }
}

// ─── Startup Tax Benefits ────────────────────────────────────────────────────
// Jurisdiction-agnostic contract for the agentbook-startup plugin's 5-phase
// workflow (recommend → collect → draft → review → submit). One implementation
// per jurisdiction pack. See startup.html §8.2.

export interface StartupProfile {
  companyType?: string; // 'c_corp' | 'ccpc' | 'ltd' | 'llc' | ...
  incorporatedAt?: Date;
  headcount?: number;
  annualRdSpendCents?: number;
  equityRaisedCents?: number;
}

export interface TaxBenefitProgramSummary {
  programCode: string;
  name: string;
  authority: string;
  typicalValueLowCents: number | null;
  typicalValueHighCents: number | null;
}

export interface EligibilityAssessment {
  status: 'not_qualified' | 'possibly_qualified' | 'qualified';
  confidence: number; // 0–1
  reasoning: string;
  estValueLowCents: number | null;
  estValueHighCents: number | null;
}

export interface DocumentRequirement {
  docType: string;
  label: string;
  description: string;
  required: boolean;
}

export interface ApplicationInputs {
  profile: StartupProfile;
  documents?: Record<string, unknown>;
  answers?: Record<string, unknown>;
}

export interface DraftField {
  label: string;
  value: string | number;
  sourceType: 'book_entry' | 'document' | 'user_input' | 'computed';
  sourceRef?: string;
}

export interface DraftResult {
  programCode: string;
  sections: Record<string, DraftField[]>;
  completeness: number; // 0–1: fraction of fields populated without a pending decision point
}

export interface DecisionPoint {
  sequenceOrder: number;
  kind: 'approval' | 'key_input';
  prompt: string;
  options?: string[];
}

export interface AuditFinding {
  severity: 'low' | 'medium' | 'high';
  issue: string;
  recommendation: string;
  ruleRef: string;
}

export interface AuditRiskAssessment {
  riskLevel: 'low' | 'medium' | 'high';
  findings: AuditFinding[];
}

export interface SubmissionInstructions {
  channel: 'mail' | 'portal' | 'cpa_handoff';
  summary: string;
  steps: string[];
}

export interface Deadline {
  label: string;
  date: Date;
  urgency: 'critical' | 'important' | 'informational';
}

export interface TaxBenefitProvider {
  listPrograms(profile: StartupProfile): TaxBenefitProgramSummary[];
  assessEligibility(programCode: string, profile: StartupProfile): EligibilityAssessment;
  getRequiredDocuments(programCode: string): DocumentRequirement[];
  draftApplication(programCode: string, inputs: ApplicationInputs): DraftResult;
  getDecisionPoints(programCode: string, draft: DraftResult): DecisionPoint[];
  assessAuditRisk(programCode: string, draft: DraftResult): AuditRiskAssessment;
  getSubmissionInstructions(programCode: string): SubmissionInstructions;
  getFilingDeadlines(programCode: string, fiscalYearEnd: Date): Deadline[];
}
