import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Editing a critical income field must move the tax figure the review screen
 * shows.
 *
 * Before C4, computeFilingTotals() derived tax payable live from
 * calculateTax(taxableIncomeCents, ...), so an edit at least moved the number.
 * C4 correctly changed it to read the jurisdiction's OWN pre-computed
 * total_tax_* line out of the stored forms blob (so the review can't disagree
 * with the form being submitted) — but updateFilingField() wrote the edited
 * value into that blob and never re-evaluated the formulas that feed the
 * total. Net effect: after an edit the approve-and-file screen showed a tax
 * figure with no relationship to the number the user had just typed, and
 * confirmAndSubmit() hashed and filed it in exactly that state.
 *
 * These tests use the REAL form templates (captured out of seedUsForms /
 * seedCanadianForms) and the REAL formula evaluator — a hand-written template
 * would let a wrong formula pass.
 */

const filingFindFirst = vi.fn();
const filingUpdate = vi.fn();
const templateFindFirst = vi.fn();
const templateCreate = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: (...a: any[]) => filingFindFirst(...a), update: (...a: any[]) => filingUpdate(...a) },
    abTaxFormTemplate: {
      findFirst: (...a: any[]) => templateFindFirst(...a),
      create: (...a: any[]) => templateCreate(...a),
      update: vi.fn(),
      findMany: vi.fn(),
    },
    // NOTE: no abJournalLine / abTaxSlip / abTenantConfig here on purpose.
    // Recomputing formulas must never re-run resolveSourceQuery() against the
    // ledger — that would overwrite the tenant's manual entries with freshly
    // queried values. If it ever does, these tests fail with a TypeError
    // rather than passing quietly.
  },
}));

/** The real seeded templates for a jurisdiction, keyed by form code. */
async function realTemplates(jurisdiction: 'us' | 'ca' | 'au'): Promise<Record<string, any>> {
  const captured: Record<string, any> = {};
  templateFindFirst.mockResolvedValue(null);
  templateCreate.mockImplementation(async ({ data }: any) => { captured[data.formCode] = data; return data; });
  const forms = await import('../tax-forms.js');
  const seed = { us: forms.seedUsForms, ca: forms.seedCanadianForms, au: forms.seedAuForms }[jurisdiction];
  await seed();
  templateCreate.mockReset();
  return captured;
}

function savedForms(): Record<string, Record<string, any>> {
  return filingUpdate.mock.calls[0][0].data.forms;
}

beforeEach(() => vi.clearAllMocks());

describe('updateFilingField — recomputes the edited form\'s calculated fields', () => {
  it('editing US taxable income moves 1040.total_tax_24, the exact field the review screen reads', async () => {
    const templates = await realTemplates('us');
    const { evaluateFormula } = await import('../tax-forms.js');
    const { updateFilingField } = await import('../tax-filing.js');

    // A coherent, fully-populated blob, the shape populateFiling() leaves behind.
    const seTax = 1412955; // SE_TAX($100,000 net profit)
    const originalTotalTax = 1234567; // whatever it was; the point is it must not stay
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'us', region: 'CA', missingFields: [],
      forms: {
        ScheduleC: { gross_receipts_1: 12000000, gross_income_7: 12000000, total_expenses_28: 2000000, tentative_profit_29: 10000000, net_profit_31: 10000000 },
        '1040': {
          full_name: 'Jamie Test', ssn: '123456789', filing_status: 'single',
          self_employment_income: 10000000, total_income_9: 10000000,
          se_tax: seTax, se_tax_deduction_half: 706478, standard_deduction: 1500000,
          taxable_income: 7793522, federal_tax_16: 999999, total_tax_24: originalTotalTax,
          withholding_25a: 0, balance_owing_37: originalTotalTax,
        },
      },
    });
    templateFindFirst.mockResolvedValue(templates['1040']);

    const newTaxable = 2000000; // the user says "taxable income is $20,000"
    await updateFilingField('t1', 2025, '1040', 'taxable_income', newTaxable);

    const forms = savedForms();
    // The edit itself sticks — a manual override of a calculated field must
    // not be recomputed back over the top of the user's own number.
    expect(forms['1040'].taxable_income).toBe(newTaxable);

    const expectedFederal = evaluateFormula('PROGRESSIVE_TAX(taxable_income, us_federal)', { taxable_income: newTaxable }, {}, 2025);
    expect(forms['1040'].federal_tax_16).toBe(expectedFederal);
    // The regression, stated directly: this is the number shown on the
    // approve-and-file screen, and it now reflects the edit.
    expect(forms['1040'].total_tax_24).toBe(expectedFederal! + seTax);
    expect(forms['1040'].total_tax_24).not.toBe(originalTotalTax);
    expect(forms['1040'].balance_owing_37).toBe(expectedFederal! + seTax);
  });

  it('recomputes only DOWNSTREAM fields — an earlier manual override upstream of the edit survives', async () => {
    const templates = await realTemplates('us');
    const { updateFilingField } = await import('../tax-filing.js');

    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'us', region: 'CA', missingFields: [],
      forms: {
        ScheduleC: { net_profit_31: 10000000 },
        '1040': {
          full_name: 'Jamie Test', ssn: '123456789',
          self_employment_income: 10000000,
          total_income_9: 99999999, // an earlier edit, deliberately != SUM(...)
          se_tax: 1412955, se_tax_deduction_half: 706478, standard_deduction: 1500000,
          taxable_income: 7793522, federal_tax_16: 999999, total_tax_24: 1234567, withholding_25a: 0,
        },
      },
    });
    templateFindFirst.mockResolvedValue(templates['1040']);

    await updateFilingField('t1', 2025, '1040', 'taxable_income', 2000000);

    const forms = savedForms();
    expect(forms['1040'].total_income_9).toBe(99999999);
    expect(forms['1040'].se_tax).toBe(1412955);
    // Auto/manual/identity values are never re-resolved either.
    expect(forms['1040'].ssn).toBe('123456789');
    expect(forms['1040'].standard_deduction).toBe(1500000);
  });

  it('editing CA total income moves T1.total_tax_43500 (and the taxable income it feeds)', async () => {
    const templates = await realTemplates('ca');
    const { evaluateFormula } = await import('../tax-forms.js');
    const { updateFilingField } = await import('../tax-filing.js');

    const cppSelf = 806820;
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON', missingFields: [],
      forms: {
        T2125: { gross_sales_8000: 7300000, adjusted_gross_8299: 7300000, total_expenses_9368: 0, net_income_9369: 7300000 },
        T1: {
          full_name: 'Jamie Test', sin: '123456789', province_territory: 'ON',
          self_employment_income_13500: 7300000, total_income_15000: 7300000,
          cpp_self_22200: cppSelf, total_deductions_23300: cppSelf,
          net_income_23600: 6493180, taxable_income_26000: 6493180,
          federal_tax_40400: 700000, provincial_tax_42800: 500000,
          total_tax_43500: 2006820, tax_deducted_43700: 0, balance_owing_48500: 2006820,
        },
      },
    });
    templateFindFirst.mockResolvedValue(templates.T1);

    await updateFilingField('t1', 2025, 'T1', 'total_income_15000', 9000000);

    const forms = savedForms();
    const expectedTaxable = 9000000 - cppSelf;
    expect(forms.T1.taxable_income_26000).toBe(expectedTaxable);
    const expectedProvincial = evaluateFormula(
      'PROVINCIAL_TAX(taxable_income_26000, province_territory)',
      { taxable_income_26000: expectedTaxable, province_territory: 'ON' }, {}, 2025,
    );
    expect(forms.T1.provincial_tax_42800).toBe(expectedProvincial);
    expect(forms.T1.total_tax_43500).toBe(700000 + expectedProvincial! + cppSelf);
    expect(forms.T1.total_tax_43500).not.toBe(2006820);
  });

  it('never replaces a real stored figure with a phantom zero derived from missing inputs', async () => {
    const templates = await realTemplates('ca');
    const { updateFilingField } = await import('../tax-filing.js');

    // A partially populated T1: total_deductions_23300 was never computed, so
    // net_income_23600 (= total_income - total_deductions) can't be evaluated.
    // The trap is MAX(0, net_income_23600): the evaluator scores a missing
    // operand as 0, which would write $0 taxable income — and a $0 provincial
    // tax — over real numbers on the approve-and-file screen.
    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'ca', region: 'ON', missingFields: [],
      forms: {
        T1: { total_income_15000: 7300000, taxable_income_26000: 7300000, total_tax_43500: 1639206, sin: '123456789' },
        T2125: {},
      },
    });
    templateFindFirst.mockResolvedValue(templates.T1);

    await updateFilingField('t1', 2025, 'T1', 'total_income_15000', 8000000);

    const forms = savedForms();
    expect(forms.T1.total_income_15000).toBe(8000000);
    expect(forms.T1.taxable_income_26000).toBe(7300000);
    expect(forms.T1.total_tax_43500).toBe(1639206);
  });

  it('a filing whose form template is missing still saves the edit rather than failing it', async () => {
    await realTemplates('us');
    const { updateFilingField } = await import('../tax-filing.js');

    filingFindFirst.mockResolvedValue({
      id: 'f1', tenantId: 't1', taxYear: 2025, jurisdiction: 'uk', region: '', missingFields: [],
      forms: { SA100: { total_income: 100 } },
    });
    templateFindFirst.mockResolvedValue(null);

    const result = await updateFilingField('t1', 2025, 'SA100', 'total_income', 5000);
    expect(result.updated).toBe(true);
    expect(savedForms().SA100.total_income).toBe(5000);
  });
});
