import { describe, it, expect } from 'vitest';
import { usTaxBenefits } from '../tax-benefits.js';

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

  it('drafts QSBS from profile + an answered key_input decision point, in separate sections', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
      answers: { '1': '2024-03-15' },
    });
    expect(draft.sections['Company Details'][0]).toMatchObject({ label: 'Company type', value: 'c_corp', sourceType: 'book_entry' });
    expect(draft.sections['Share Issuance'][0]).toMatchObject({ label: 'Share issuance date', value: '2024-03-15', sourceType: 'user_input', sourceRef: '1' });
    expect(draft.completeness).toBe(1);
  });

  it('does not reach full completeness for QSBS until the share-issuance decision point is answered', () => {
    const draft = usTaxBenefits.draftApplication('us_qsbs_tracking', {
      profile: { companyType: 'c_corp' },
    });
    expect(draft.sections['Company Details'].length).toBeGreaterThan(0);
    expect(draft.sections['Share Issuance']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('does not reach full completeness for DE franchise optimization until the method-selection decision point is answered', () => {
    const draft = usTaxBenefits.draftApplication('us_de_franchise_optimization', {
      profile: { companyType: 'c_corp' },
    });
    expect(draft.sections['Company Details'].length).toBeGreaterThan(0);
    expect(draft.sections['Franchise Tax Method Selection']).toEqual([]);
    expect(draft.completeness).toBeLessThan(1);
  });

  it('throws for an unknown program code (matches existing requireProgram behavior)', () => {
    expect(() => usTaxBenefits.draftApplication('nonexistent', { profile: {} })).toThrow('Unknown US tax benefit program');
  });
});
