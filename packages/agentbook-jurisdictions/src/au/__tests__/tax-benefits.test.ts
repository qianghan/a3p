import { describe, it, expect } from 'vitest';
import { auTaxBenefits } from '../tax-benefits.js';

describe('auTaxBenefits.listPrograms / assessEligibility', () => {
  it('does not list the R&D Tax Incentive with zero R&D spend', () => {
    expect(auTaxBenefits.listPrograms({}).map((p) => p.programCode)).not.toContain('au_rd_tax_incentive');
  });

  it('treats R&D spend under the $20,000 minimum as not qualified', () => {
    const assessment = auTaxBenefits.assessEligibility('au_rd_tax_incentive', { annualRdSpendCents: 1_000_000 });
    expect(assessment.status).toBe('not_qualified');
    expect(assessment.reasoning).toMatch(/\$20,000 minimum/);
  });

  it('qualifies R&D spend at or above the $20,000 minimum, with a 13.5%-18.5% value range', () => {
    const assessment = auTaxBenefits.assessEligibility('au_rd_tax_incentive', { annualRdSpendCents: 10_000_000 });
    expect(assessment.status).toBe('qualified');
    expect(assessment.estValueLowCents).toBe(1_350_000);
    expect(assessment.estValueHighCents).toBe(1_850_000);
  });

  it('does not list ESIC status for a non-company structure', () => {
    expect(auTaxBenefits.listPrograms({ companyType: 'sole_trader' }).map((p) => p.programCode)).not.toContain('au_esic_offset');
  });

  it('possibly qualifies ESIC status for a pty_ltd company, with no company-side dollar value', () => {
    const assessment = auTaxBenefits.assessEligibility('au_esic_offset', { companyType: 'pty_ltd', incorporatedAt: new Date('2025-01-01') });
    expect(assessment.status).toBe('possibly_qualified');
    expect(assessment.estValueLowCents).toBeNull();
    expect(assessment.estValueHighCents).toBeNull();
  });

  it('lists Small Business CGT Concessions for any recorded business structure', () => {
    expect(auTaxBenefits.listPrograms({ companyType: 'sole_trader' }).map((p) => p.programCode)).toContain('au_small_business_cgt_concessions');
  });
});

describe('auTaxBenefits.draftApplication', () => {
  it('drafts the R&D Tax Incentive from profile + documents + an answered decision point, with correct provenance', () => {
    const draft = auTaxBenefits.draftApplication('au_rd_tax_incentive', {
      profile: { annualRdSpendCents: 10_000_000 },
      documents: {
        payroll_register: { totalWagesCents: 6_000_000, _id: 'doc-1' },
        project_time_allocation: { qualifiedPercent: 0.5, _id: 'doc-2' },
        ausindustry_registration: { _id: 'doc-3' },
      },
      answers: { '1': 'approve' },
    });

    expect(draft.programCode).toBe('au_rd_tax_incentive');
    const expenditure = draft.sections['Eligible R&D Expenditure'];
    expect(expenditure.find((f) => f.label === 'Annual R&D spend')).toMatchObject({ value: 100000, sourceType: 'book_entry' });
    expect(expenditure.find((f) => f.label === 'Payroll register total wages')).toMatchObject({ value: 60000, sourceType: 'document', sourceRef: 'doc-1' });

    expect(draft.sections['AusIndustry Registration'][0]).toMatchObject({ label: 'AusIndustry registration confirmation', value: 'Uploaded', sourceType: 'document', sourceRef: 'doc-3' });
    expect(draft.sections['Core R&D Activity Confirmation'][0]).toMatchObject({ value: 'approve', sourceType: 'user_input', sourceRef: '1' });
    expect(draft.completeness).toBe(1);
  });

  it('does not reach full completeness for the R&D Tax Incentive without the AusIndustry registration', () => {
    const draft = auTaxBenefits.draftApplication('au_rd_tax_incentive', {
      profile: { annualRdSpendCents: 10_000_000 },
      documents: {
        payroll_register: { totalWagesCents: 6_000_000, _id: 'doc-1' },
        project_time_allocation: { qualifiedPercent: 0.5, _id: 'doc-2' },
      },
      answers: { '1': 'approve' },
    });
    expect(draft.sections['AusIndustry Registration']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('does not count a rejected core-R&D-activity test as completing the confirmation section', () => {
    const draft = auTaxBenefits.draftApplication('au_rd_tax_incentive', {
      profile: { annualRdSpendCents: 10_000_000 },
      answers: { '1': 'reject' },
    });
    expect(draft.sections['Core R&D Activity Confirmation']).toEqual([]);
    const risk = auTaxBenefits.assessAuditRisk('au_rd_tax_incentive', draft);
    expect(risk.riskLevel).not.toBe('low');
  });

  it('drafts ESIC status from profile + documents + an approved decision point', () => {
    const draft = auTaxBenefits.draftApplication('au_esic_offset', {
      profile: { companyType: 'pty_ltd', incorporatedAt: new Date('2025-01-01') },
      documents: {
        expenditure_summary: { _id: 'doc-1' },
        income_summary: { _id: 'doc-2' },
        innovation_test_evidence: { _id: 'doc-3' },
      },
      answers: { '1': 'approve' },
    });
    expect(draft.sections['Company Details'][0]).toMatchObject({ label: 'Company type', value: 'pty_ltd', sourceType: 'book_entry' });
    expect(draft.sections['Early-Stage Test Evidence']).toHaveLength(2);
    expect(draft.sections['Innovation Test Evidence'].find((f) => f.label === 'Innovation test evidence')).toMatchObject({ value: 'Uploaded', sourceType: 'document', sourceRef: 'doc-3' });
    expect(draft.sections['Early-Stage Confirmation'][0]).toMatchObject({ label: 'Early-stage eligibility confirmed', value: 'approve', sourceType: 'user_input', sourceRef: '1' });
    expect(draft.completeness).toBe(1);
  });

  it('reaches full completeness for ESIC status with only one of the two early-stage test documents (the both-documents check is an audit-risk finding, not a completeness gate)', () => {
    const draft = auTaxBenefits.draftApplication('au_esic_offset', {
      profile: { companyType: 'pty_ltd' },
      documents: { expenditure_summary: { _id: 'doc-1' }, innovation_test_evidence: { _id: 'doc-3' } },
      answers: { '1': 'approve' },
    });
    expect(draft.sections['Early-Stage Test Evidence']).toHaveLength(1);
    expect(draft.completeness).toBe(1);
    const risk = auTaxBenefits.assessAuditRisk('au_esic_offset', draft);
    expect(risk.riskLevel).toBe('medium');
    expect(risk.findings[0]).toMatchObject({ severity: 'medium', ruleRef: 'ato:esic-early-stage-test' });
  });

  it('does not reach full completeness for ESIC status until the early-stage confirmation decision point is answered, even with all documents uploaded', () => {
    const draft = auTaxBenefits.draftApplication('au_esic_offset', {
      profile: { companyType: 'pty_ltd' },
      documents: {
        expenditure_summary: { _id: 'doc-1' },
        income_summary: { _id: 'doc-2' },
        innovation_test_evidence: { _id: 'doc-3' },
      },
    });
    expect(draft.sections['Early-Stage Confirmation']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('drafts Small Business CGT Concessions from profile + at least one entity-test document + a concession selection', () => {
    const draft = auTaxBenefits.draftApplication('au_small_business_cgt_concessions', {
      profile: { companyType: 'pty_ltd' },
      documents: { turnover_summary: { _id: 'doc-1' } },
      answers: { '1': '15-year exemption' },
    });
    expect(draft.sections['Small Business Entity Test'][0]).toMatchObject({ label: 'Aggregated turnover summary', value: 'Uploaded', sourceType: 'document', sourceRef: 'doc-1' });
    expect(draft.sections['Concession Selection'][0]).toMatchObject({ value: '15-year exemption', sourceType: 'user_input', sourceRef: '1' });
    expect(draft.completeness).toBe(1);
  });

  it('does not reach full completeness for Small Business CGT Concessions until the concession-selection decision point is answered', () => {
    const draft = auTaxBenefits.draftApplication('au_small_business_cgt_concessions', {
      profile: { companyType: 'pty_ltd' },
      documents: { net_asset_statement: { _id: 'doc-2' } },
    });
    expect(draft.sections['Concession Selection']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('throws for an unknown program code (matches existing requireProgram behavior)', () => {
    expect(() => auTaxBenefits.draftApplication('nonexistent', { profile: {} })).toThrow('Unknown AU tax benefit program');
  });
});

describe('auTaxBenefits.assessAuditRisk', () => {
  it('is low risk with no findings when the R&D Tax Incentive draft is complete with both evidentiary documents', () => {
    const draft = auTaxBenefits.draftApplication('au_rd_tax_incentive', {
      profile: { annualRdSpendCents: 10_000_000 },
      documents: {
        payroll_register: { totalWagesCents: 6_000_000, _id: 'doc-1' },
        project_time_allocation: { qualifiedPercent: 0.5, _id: 'doc-2' },
        ausindustry_registration: { _id: 'doc-3' },
      },
      answers: { '1': 'approve' },
    });
    const risk = auTaxBenefits.assessAuditRisk('au_rd_tax_incentive', draft);
    expect(risk).toEqual({ riskLevel: 'low', findings: [] });
  });

  it('flags high risk when the R&D Tax Incentive draft is complete but the AusIndustry registration is missing', () => {
    // Force completeness to 1 by answering everything except registration is
    // impossible without registration populating its own section — so this
    // exercises the audit-check path directly rather than via a complete draft,
    // matching how the US suite tests auditChecks against a hand-built draft.
    const draft = {
      programCode: 'au_rd_tax_incentive',
      sections: {
        'Eligible R&D Expenditure': [{ label: 'Payroll register total wages', value: 60000, sourceType: 'document' as const, sourceRef: 'doc-1' }, { label: 'Qualified R&D time allocation', value: '50%', sourceType: 'document' as const, sourceRef: 'doc-2' }],
        'AusIndustry Registration': [],
        'Core R&D Activity Confirmation': [{ label: 'Core R&D activity test confirmed', value: 'approve', sourceType: 'user_input' as const, sourceRef: '1' }],
      },
      completeness: 1,
    };
    const risk = auTaxBenefits.assessAuditRisk('au_rd_tax_incentive', draft);
    expect(risk.riskLevel).toBe('high');
    expect(risk.findings[0]).toMatchObject({ severity: 'high', ruleRef: 'ausindustry:registration-required' });
  });

  it('is low risk for ESIC status when both the early-stage and innovation test evidence are present', () => {
    const draft = auTaxBenefits.draftApplication('au_esic_offset', {
      profile: { companyType: 'pty_ltd' },
      documents: {
        expenditure_summary: { _id: 'doc-1' },
        income_summary: { _id: 'doc-2' },
        innovation_test_evidence: { _id: 'doc-3' },
      },
      answers: { '1': 'approve' },
    });
    const risk = auTaxBenefits.assessAuditRisk('au_esic_offset', draft);
    expect(risk).toEqual({ riskLevel: 'low', findings: [] });
  });

  it('flags high risk for ESIC status when no innovation test evidence is uploaded, even with the early-stage test documents present', () => {
    const draft = {
      programCode: 'au_esic_offset',
      sections: {
        'Company Details': [{ label: 'Company type', value: 'pty_ltd', sourceType: 'book_entry' as const }],
        'Early-Stage Test Evidence': [{ label: 'Prior-year expenditure summary', value: 'Uploaded', sourceType: 'document' as const, sourceRef: 'doc-1' }, { label: 'Prior-year income summary', value: 'Uploaded', sourceType: 'document' as const, sourceRef: 'doc-2' }],
        'Innovation Test Evidence': [{ label: 'Early-stage eligibility confirmed', value: 'approve', sourceType: 'user_input' as const, sourceRef: '1' }],
      },
      completeness: 1,
    };
    const risk = auTaxBenefits.assessAuditRisk('au_esic_offset', draft);
    expect(risk.riskLevel).toBe('high');
    expect(risk.findings[0]).toMatchObject({ severity: 'high', ruleRef: 'ato:esic-innovation-test' });
  });

  it('flags high risk for Small Business CGT Concessions when neither entity-test document is present', () => {
    const draft = {
      programCode: 'au_small_business_cgt_concessions',
      sections: {
        'Company Details': [{ label: 'Company type', value: 'pty_ltd', sourceType: 'book_entry' as const }],
        'Small Business Entity Test': [],
        'Concession Selection': [{ label: 'Concession being tracked', value: '15-year exemption', sourceType: 'user_input' as const, sourceRef: '1' }],
      },
      completeness: 1,
    };
    const risk = auTaxBenefits.assessAuditRisk('au_small_business_cgt_concessions', draft);
    expect(risk.riskLevel).toBe('high');
    expect(risk.findings[0]).toMatchObject({ severity: 'high', ruleRef: 'ato:sb-cgt-entity-test' });
  });

  it('stays conservative: an incomplete draft is never low risk regardless of which documents are uploaded', () => {
    const draft = auTaxBenefits.draftApplication('au_esic_offset', {
      profile: { companyType: 'pty_ltd' },
      documents: {
        expenditure_summary: { _id: 'doc-1' },
        income_summary: { _id: 'doc-2' },
        innovation_test_evidence: { _id: 'doc-3' },
      },
      // no answer to the early-stage confirmation decision point — draft stays incomplete
    });
    const risk = auTaxBenefits.assessAuditRisk('au_esic_offset', draft);
    expect(risk.riskLevel).not.toBe('low');
    expect(risk.findings[0].ruleRef).toBe('internal:completeness-gate');
  });
});

describe('auTaxBenefits.getFilingDeadlines', () => {
  it('gives the R&D Tax Incentive a critical 10-month AusIndustry registration deadline', () => {
    const deadlines = auTaxBenefits.getFilingDeadlines('au_rd_tax_incentive', new Date(Date.UTC(2025, 5, 30))); // FYE 30 June 2025
    const registration = deadlines.find((d) => d.label.includes('AusIndustry'));
    expect(registration?.urgency).toBe('critical');
    expect(registration?.date.toISOString().slice(0, 10)).toBe('2026-04-30');
  });

  it('gives ESIC status a critical 31 July ATO report deadline', () => {
    const deadlines = auTaxBenefits.getFilingDeadlines('au_esic_offset', new Date(Date.UTC(2025, 5, 30)));
    expect(deadlines[0].date.toISOString().slice(0, 10)).toBe('2025-07-31');
    expect(deadlines[0].urgency).toBe('critical');
  });
});
