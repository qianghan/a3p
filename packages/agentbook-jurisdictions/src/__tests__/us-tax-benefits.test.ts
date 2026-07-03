import { describe, it, expect } from 'vitest';
import { usTaxBenefits } from '../us/tax-benefits.js';

describe('US Tax Benefits — R&D Credit (IRC §41)', () => {
  it('lists the R&D credit for a profile with R&D spend', () => {
    const programs = usTaxBenefits.listPrograms({ annualRdSpendCents: 40_000_000 });
    expect(programs.map((p) => p.programCode)).toContain('us_rd_credit_41');
  });

  it('does not list the R&D credit for a profile with zero R&D spend', () => {
    const programs = usTaxBenefits.listPrograms({ annualRdSpendCents: 0 });
    expect(programs.map((p) => p.programCode)).not.toContain('us_rd_credit_41');
  });

  it('marks a profile with no R&D spend as not_qualified', () => {
    const result = usTaxBenefits.assessEligibility('us_rd_credit_41', {});
    expect(result.status).toBe('not_qualified');
    expect(result.estValueLowCents).toBeNull();
  });

  it('marks a profile with significant R&D spend as qualified with a plausible dollar range', () => {
    // Marcus persona: $400K/yr eng spend -> $40K-$80K claim (startup.html §1)
    const result = usTaxBenefits.assessEligibility('us_rd_credit_41', { annualRdSpendCents: 40_000_000 });
    expect(result.status).toBe('qualified');
    expect(result.estValueLowCents).toBe(4_000_000); // 10% of spend
    expect(result.estValueHighCents).toBe(8_000_000); // 20% of spend
  });

  it('marks a small amount of R&D spend as only possibly_qualified', () => {
    const result = usTaxBenefits.assessEligibility('us_rd_credit_41', { annualRdSpendCents: 500_000 });
    expect(result.status).toBe('possibly_qualified');
  });

  it('lists payroll register and project time allocation as required documents', () => {
    const docs = usTaxBenefits.getRequiredDocuments('us_rd_credit_41');
    expect(docs.map((d) => d.docType)).toEqual(
      expect.arrayContaining(['payroll_register', 'project_time_allocation']),
    );
  });

  it('returns at least one decision point on the four-part test', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', { profile: { annualRdSpendCents: 40_000_000 } });
    const points = usTaxBenefits.getDecisionPoints('us_rd_credit_41', draft);
    expect(points.length).toBeGreaterThan(0);
    expect(points[0].kind).toBe('approval');
  });

  it('flags a low-completeness draft as at least medium audit risk', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', { profile: {} });
    const risk = usTaxBenefits.assessAuditRisk('us_rd_credit_41', draft);
    expect(['medium', 'high']).toContain(risk.riskLevel);
    expect(risk.findings.length).toBeGreaterThan(0);
  });

  it('gives CPA hand-off submission instructions', () => {
    const instructions = usTaxBenefits.getSubmissionInstructions('us_rd_credit_41');
    expect(instructions.channel).toBe('cpa_handoff');
    expect(instructions.steps.length).toBeGreaterThan(0);
  });

  it('computes a filing deadline after the fiscal year end', () => {
    const fiscalYearEnd = new Date('2026-12-31');
    const deadlines = usTaxBenefits.getFilingDeadlines('us_rd_credit_41', fiscalYearEnd);
    expect(deadlines.length).toBeGreaterThan(0);
    expect(deadlines[0].date.getTime()).toBeGreaterThan(fiscalYearEnd.getTime());
  });
});

describe('US Tax Benefits — QSBS Eligibility Tracking', () => {
  it('is not_qualified for a non-C-corp', () => {
    const result = usTaxBenefits.assessEligibility('us_qsbs_tracking', { companyType: 'llc' });
    expect(result.status).toBe('not_qualified');
  });

  it('is possibly_qualified for an incorporated C-corp', () => {
    const result = usTaxBenefits.assessEligibility('us_qsbs_tracking', {
      companyType: 'c_corp',
      incorporatedAt: new Date('2026-01-01'),
    });
    expect(result.status).toBe('possibly_qualified');
    // Value is realized at a future exit, not now — must not fabricate a number.
    expect(result.estValueLowCents).toBeNull();
    expect(result.estValueHighCents).toBeNull();
  });

  it('asks for the exact share issuance date as a key_input decision point', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', { profile: { companyType: 'c_corp' } });
    const points = usTaxBenefits.getDecisionPoints('us_qsbs_tracking', draft);
    expect(points.some((p) => p.kind === 'key_input')).toBe(true);
  });
});

describe('US Tax Benefits — Delaware Franchise Tax Optimization', () => {
  it('roughly applies only to C-corps', () => {
    const programs = usTaxBenefits.listPrograms({ companyType: 'c_corp' });
    expect(programs.map((p) => p.programCode)).toContain('us_de_franchise_optimization');
    const notApplicable = usTaxBenefits.listPrograms({ companyType: 'llc' });
    expect(notApplicable.map((p) => p.programCode)).not.toContain('us_de_franchise_optimization');
  });

  it('requires authorized share count and gross assets as a key_input decision point', () => {
    const draft = usTaxBenefits.draftApplication('us_de_franchise_optimization', { profile: { companyType: 'c_corp' } });
    const points = usTaxBenefits.getDecisionPoints('us_de_franchise_optimization', draft);
    expect(points.some((p) => p.kind === 'key_input')).toBe(true);
  });

  it('gives a March 1 Delaware portal filing deadline', () => {
    const deadlines = usTaxBenefits.getFilingDeadlines('us_de_franchise_optimization', new Date('2026-12-31'));
    expect(deadlines[0].date.getUTCMonth()).toBe(2); // March = index 2
    expect(deadlines[0].date.getUTCDate()).toBe(1);
  });
});
