import { describe, it, expect } from 'vitest';
import { AuPastFilingPack } from '../au/past-filing-pack.js';

const pack = new AuPastFilingPack();

describe('AuPastFilingPack', () => {
  it('has jurisdiction set to "au"', () => {
    expect(pack.jurisdiction).toBe('au');
  });

  it('lists the supported AU form types', () => {
    const types = pack.supportedFormTypes().map((f) => f.formType);
    expect(types).toEqual(['income-statement', 'notice-of-assessment', 'payg-instalment']);
  });

  it('identificationPrompt mentions AU form types and jurisdiction', () => {
    const prompt = pack.identificationPrompt();
    expect(prompt).toContain('income-statement');
    expect(prompt).toContain('notice-of-assessment');
    expect(prompt).toContain('"au"');
  });

  describe('extractionPrompt', () => {
    it('income-statement prompt asks for gross payments, tax withheld, and super', () => {
      const prompt = pack.extractionPrompt('income-statement', 2024);
      expect(prompt).toContain('grossPayments');
      expect(prompt).toContain('taxWithheld');
      expect(prompt).toContain('superGuaranteeContributions');
      expect(prompt).toContain('CENTS');
    });

    it('notice-of-assessment prompt asks for taxable income, Medicare levy, and HECS-HELP', () => {
      const prompt = pack.extractionPrompt('notice-of-assessment', 2024);
      expect(prompt).toContain('taxableIncome');
      expect(prompt).toContain('medicareLevy');
      expect(prompt).toContain('hecsHelpRepayment');
      expect(prompt).toContain('refundOrBalance');
    });

    it('payg-instalment prompt asks for instalment income and amount due', () => {
      const prompt = pack.extractionPrompt('payg-instalment', 2024);
      expect(prompt).toContain('instalmentIncome');
      expect(prompt).toContain('amountDue');
    });

    it('falls back to a generic formFields extraction for an unrecognized form type', () => {
      const prompt = pack.extractionPrompt('other', 2024);
      expect(prompt).toContain('"formType": "other"');
      expect(prompt).toContain('formFields');
    });
  });

  describe('parseExtraction', () => {
    it('maps an income-statement extraction onto the standard fields', () => {
      const raw = {
        formType: 'income-statement',
        taxYear: 2024,
        jurisdiction: 'au',
        employer: 'Acme Pty Ltd',
        formFields: {
          grossPayments: 8500000,
          taxWithheld: 1500000,
          reportableFringeBenefits: null,
          reportableSuperContributions: null,
          superGuaranteeContributions: 935000,
        },
        confidence: 0.9,
      };
      const extract = pack.parseExtraction(raw, 'income-statement', 2024);
      expect(extract.jurisdiction).toBe('au');
      expect(extract.totalIncomeCents).toBe(8500000);
      expect(extract.netIncomeCents).toBe(8500000);
      expect(extract.savingsRoomCents).toBe(935000);
      expect(extract.confidence).toBe(0.9);
    });

    it('maps a notice-of-assessment extraction onto the standard fields, including a refund', () => {
      const raw = {
        formType: 'notice-of-assessment',
        taxYear: 2024,
        jurisdiction: 'au',
        region: 'NSW',
        assessmentDate: '2025-03-01',
        noaLines: {
          taxableIncome: 8000000,
          taxOnTaxableIncome: 1500000,
          medicareLevy: 160000,
          medicareLevySurcharge: null,
          hecsHelpRepayment: null,
          taxOffsets: null,
          refundOrBalance: 200000,
        },
        confidence: 0.85,
      };
      const extract = pack.parseExtraction(raw, 'notice-of-assessment', 2024);
      expect(extract.taxableIncomeCents).toBe(8000000);
      expect(extract.totalIncomeCents).toBe(8000000);
      expect(extract.taxPayableCents).toBe(1500000);
      expect(extract.refundOrBalanceCents).toBe(200000);
      expect(extract.region).toBe('NSW');
      expect((extract.formFields as Record<string, unknown>).assessmentDate).toBe('2025-03-01');
    });

    it('maps a notice-of-assessment extraction with a balance owing (negative refundOrBalance)', () => {
      const raw = {
        formType: 'notice-of-assessment',
        taxYear: 2024,
        jurisdiction: 'au',
        noaLines: { taxableIncome: 9000000, taxOnTaxableIncome: 2000000, refundOrBalance: -50000 },
        confidence: 0.8,
      };
      const extract = pack.parseExtraction(raw, 'notice-of-assessment', 2024);
      expect(extract.refundOrBalanceCents).toBe(-50000);
    });

    it('throws a clear error on malformed JSON input', () => {
      expect(() => pack.parseExtraction('{not json', 'income-statement', 2024)).toThrow(/malformed JSON/);
    });

    it('defaults confidence to 0 when not provided', () => {
      const extract = pack.parseExtraction({ formType: 'other', formFields: {} }, 'other', 2024);
      expect(extract.confidence).toBe(0);
    });
  });

  describe('preFillMap', () => {
    it('returns an empty array (no AU pre-fill mapping defined yet)', () => {
      const extract = pack.parseExtraction({ formType: 'income-statement', formFields: {} }, 'income-statement', 2024);
      expect(pack.preFillMap(extract)).toEqual([]);
    });
  });

  describe('summarize', () => {
    it('formats an income-statement summary in AUD with super guarantee shown', () => {
      const extract = pack.parseExtraction(
        { formType: 'income-statement', taxYear: 2024, formFields: { grossPayments: 8500000, taxWithheld: 1500000, superGuaranteeContributions: 935000 } },
        'income-statement',
        2024,
      );
      const summary = pack.summarize(extract);
      expect(summary).toContain('2024-25');
      expect(summary).toContain('income-statement');
      expect(summary).toContain('$85,000');
      expect(summary).toContain('Super guarantee');
    });

    it('formats a notice-of-assessment summary with a refund line', () => {
      const extract = pack.parseExtraction(
        { formType: 'notice-of-assessment', taxYear: 2024, region: 'VIC', noaLines: { taxableIncome: 8000000, taxOnTaxableIncome: 1500000, refundOrBalance: 200000 } },
        'notice-of-assessment',
        2024,
      );
      const summary = pack.summarize(extract);
      expect(summary).toContain('AU / VIC');
      expect(summary).toContain('Refund: $2,000');
    });

    it('formats a notice-of-assessment summary with a balance-owing line', () => {
      const extract = pack.parseExtraction(
        { formType: 'notice-of-assessment', taxYear: 2024, noaLines: { taxableIncome: 9000000, taxOnTaxableIncome: 2000000, refundOrBalance: -50000 } },
        'notice-of-assessment',
        2024,
      );
      const summary = pack.summarize(extract);
      expect(summary).toContain('Balance owing: $500');
    });
  });
});
