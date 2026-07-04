import { describe, it, expect } from 'vitest';
import { usTaxBenefits, AUDIT_REVIEW_MODEL_VERSION } from '../tax-benefits.js';

describe('usTaxBenefits.draftApplication', () => {
  it('drafts the R&D credit from profile + a payroll document + an answered decision point, with correct provenance', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', {
      profile: { annualRdSpendCents: 40_000_000 },
      documents: {
        payroll_register: { totalWagesCents: 25_000_000, _id: 'doc-1' },
        project_time_allocation: { qualifiedPercent: 0.6, _id: 'doc-2' },
      },
      answers: { '1': 'approve' },
    });

    expect(draft.programCode).toBe('us_rd_credit_41');
    const qre = draft.sections['Qualified Research Expenses'];
    expect(qre).toBeDefined();

    const spendField = qre.find((f) => f.label === 'Annual R&D spend');
    expect(spendField).toMatchObject({ value: 400000, sourceType: 'book_entry' });

    const payrollField = qre.find((f) => f.label === 'Payroll register total wages');
    expect(payrollField).toMatchObject({ value: 250000, sourceType: 'document', sourceRef: 'doc-1' });

    const confirmField = draft.sections['Four-Part Test Confirmation'];
    expect(confirmField[0]).toMatchObject({ value: 'approve', sourceType: 'user_input', sourceRef: '1' });

    expect(draft.completeness).toBe(1); // every section has at least one field, no pending decision points
  });

  it('has partial completeness when the decision point has not been answered yet', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', {
      profile: { annualRdSpendCents: 40_000_000 },
    });
    expect(draft.sections['Four-Part Test Confirmation']).toEqual([]);
    expect(draft.completeness).toBeGreaterThan(0);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('does not count a rejected four-part test as completing the confirmation section', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', {
      profile: { annualRdSpendCents: 40_000_000 },
      answers: { '1': 'reject' },
    });
    expect(draft.sections['Four-Part Test Confirmation']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
    // A rejected confirmation must never read as "low risk, ready to submit".
    const risk = usTaxBenefits.assessAuditRisk('us_rd_credit_41', draft);
    expect(risk.riskLevel).not.toBe('low');
  });

  it('drafts QSBS from profile + an answered key_input decision point + an uploaded document, in separate sections', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
      documents: { stock_issuance_record: { _id: 'doc-3' } },
      answers: { '1': '2024-03-15' },
    });
    expect(draft.sections['Company Details'][0]).toMatchObject({ label: 'Company type', value: 'c_corp', sourceType: 'book_entry' });
    expect(draft.sections['Share Issuance'][0]).toMatchObject({ label: 'Share issuance date', value: '2024-03-15', sourceType: 'user_input', sourceRef: '1' });
    expect(draft.sections['Supporting Documents'][0]).toMatchObject({ label: 'Stock issuance record', value: 'Uploaded', sourceType: 'document', sourceRef: 'doc-3' });
    expect(draft.completeness).toBe(1);
  });

  it('does not reach full completeness for QSBS until the share-issuance decision point is answered', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
    });
    expect(draft.sections['Company Details'].length).toBeGreaterThan(0);
    expect(draft.sections['Share Issuance']).toEqual([]);
    expect(draft.sections['Supporting Documents']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('does not reach full completeness for QSBS without at least one supporting document, even once the decision point is answered', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
      answers: { '1': '2024-03-15' },
    });
    expect(draft.sections['Share Issuance'].length).toBeGreaterThan(0);
    expect(draft.sections['Supporting Documents']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('does not reach full completeness for DE franchise optimization until the method-selection decision point is answered', () => {
    const draft = usTaxBenefits.draftApplication('us_de_franchise_optimization', {
      profile: { companyType: 'c_corp' },
    });
    expect(draft.sections['Company Details'].length).toBeGreaterThan(0);
    expect(draft.sections['Franchise Tax Method Selection']).toEqual([]);
    expect(draft.sections['Supporting Documents']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('drafts DE franchise optimization supporting documents from uploaded evidence', () => {
    const draft = usTaxBenefits.draftApplication('us_de_franchise_optimization', {
      profile: { companyType: 'c_corp' },
      documents: { authorized_shares_certificate: { _id: 'doc-4' } },
      answers: { '1': 'authorized shares method' },
    });
    expect(draft.sections['Supporting Documents'][0]).toMatchObject({ label: 'Authorized shares certificate', value: 'Uploaded', sourceType: 'document', sourceRef: 'doc-4' });
    expect(draft.completeness).toBe(1);
  });

  it('throws for an unknown program code (matches existing requireProgram behavior)', () => {
    expect(() => usTaxBenefits.draftApplication('nonexistent', { profile: {} })).toThrow('Unknown US tax benefit program');
  });
});

describe('usTaxBenefits.assessAuditRisk', () => {
  it('is low risk with no findings when the R&D credit draft is complete with both evidentiary documents', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', {
      profile: { annualRdSpendCents: 40_000_000 },
      documents: {
        payroll_register: { totalWagesCents: 25_000_000, _id: 'doc-1' },
        project_time_allocation: { qualifiedPercent: 0.6, _id: 'doc-2' },
      },
      answers: { '1': 'approve' },
    });
    const risk = usTaxBenefits.assessAuditRisk('us_rd_credit_41', draft);
    expect(risk).toEqual({ riskLevel: 'low', findings: [] });
  });

  it('flags high risk when the R&D credit four-part test is confirmed but zero evidentiary documents were uploaded', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', {
      profile: { annualRdSpendCents: 40_000_000 },
      answers: { '1': 'approve' },
    });
    const risk = usTaxBenefits.assessAuditRisk('us_rd_credit_41', draft);
    expect(risk.riskLevel).toBe('high');
    expect(risk.findings[0]).toMatchObject({ severity: 'high', ruleRef: 'irs:form-6765-substantiation' });
  });

  it('flags medium risk when the R&D credit draft has only one of the two evidentiary documents', () => {
    const draft = usTaxBenefits.draftApplication('us_rd_credit_41', {
      profile: { annualRdSpendCents: 40_000_000 },
      documents: { payroll_register: { totalWagesCents: 25_000_000, _id: 'doc-1' } },
      answers: { '1': 'approve' },
    });
    const risk = usTaxBenefits.assessAuditRisk('us_rd_credit_41', draft);
    expect(risk.riskLevel).toBe('medium');
    expect(risk.findings[0].severity).toBe('medium');
  });

  it('flags high risk when QSBS has no capitalization table, even with the stock issuance record present', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
      documents: { stock_issuance_record: { _id: 'doc-3' } },
      answers: { '1': '2024-03-15' },
    });
    const risk = usTaxBenefits.assessAuditRisk('us_qsbs_tracking', draft);
    expect(risk.riskLevel).toBe('high');
    expect(risk.findings.some((f) => f.ruleRef === 'irs:irc-1202-gross-assets-cap')).toBe(true);
  });

  it('is low risk for QSBS when both supporting documents are present', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
      documents: { stock_issuance_record: { _id: 'doc-3' }, cap_table: { _id: 'doc-4' } },
      answers: { '1': '2024-03-15' },
    });
    const risk = usTaxBenefits.assessAuditRisk('us_qsbs_tracking', draft);
    expect(risk).toEqual({ riskLevel: 'low', findings: [] });
  });

  it('is still low risk for DE franchise optimization when only the annual report draft is missing (a low-severity finding)', () => {
    const draft = usTaxBenefits.draftApplication('us_de_franchise_optimization', {
      profile: { companyType: 'c_corp' },
      documents: { authorized_shares_certificate: { _id: 'doc-5' } },
      answers: { '1': '10,000,000 authorized shares; $2M gross assets' },
    });
    const risk = usTaxBenefits.assessAuditRisk('us_de_franchise_optimization', draft);
    expect(risk.riskLevel).toBe('low');
    expect(risk.findings).toEqual([
      expect.objectContaining({ severity: 'low', ruleRef: 'de-corp:annual-report' }),
    ]);
  });

  it('flags medium risk for DE franchise optimization when the authorized shares certificate is missing', () => {
    const draft = usTaxBenefits.draftApplication('us_de_franchise_optimization', {
      profile: { companyType: 'c_corp' },
      documents: { annual_report_draft: { _id: 'doc-6' } },
      answers: { '1': '10,000,000 authorized shares; $2M gross assets' },
    });
    const risk = usTaxBenefits.assessAuditRisk('us_de_franchise_optimization', draft);
    expect(risk.riskLevel).toBe('medium');
  });

  it('stays conservative: an incomplete draft is never low risk regardless of which documents are uploaded', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
      documents: { stock_issuance_record: { _id: 'doc-3' }, cap_table: { _id: 'doc-4' } },
      // no answer to the share-issuance decision point — draft stays incomplete
    });
    const risk = usTaxBenefits.assessAuditRisk('us_qsbs_tracking', draft);
    expect(risk.riskLevel).not.toBe('low');
    expect(risk.findings[0].ruleRef).toBe('internal:completeness-gate');
  });
});

describe('AUDIT_REVIEW_MODEL_VERSION', () => {
  it('is exported as a non-empty string', () => {
    expect(typeof AUDIT_REVIEW_MODEL_VERSION).toBe('string');
    expect(AUDIT_REVIEW_MODEL_VERSION.length).toBeGreaterThan(0);
  });
});
