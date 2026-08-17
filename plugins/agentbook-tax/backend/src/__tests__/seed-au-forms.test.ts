import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 4 — real AU BusinessSchedule + IndividualReturn form templates and
 * `seedAuForms()`.
 *
 * Mirrors seed-us-forms.test.ts (Task 3) exactly, same `db`-mocking
 * convention: `vi.mock('../db/client.js', () => ({ db: dbMock }))` plus a
 * dynamic `import('../tax-forms.js')` inside each test (a static top-level
 * import would be hoisted above the `vi.mock` factory below, so it must be
 * dynamic per that same documented workaround).
 */

// ─── Mocks ──────────────────────────────────────────────────────────────────

const dbMock = {
  abTaxFormTemplate: {
    findFirst: vi.fn(async (_args: any) => null as any),
    create: vi.fn(async (args: any) => ({ id: `tpl-${args.data.formCode}`, ...args.data })),
    update: vi.fn(async (args: any) => ({ id: args.where.id })),
  },
  abJournalLine: {
    aggregate: vi.fn(async (_args: any) => ({ _sum: { debitCents: 0, creditCents: 0 } } as any)),
  },
  abTenantConfig: {
    findFirst: vi.fn(async (_args: any) => null as any),
  },
};

vi.mock('../db/client.js', () => ({ db: dbMock }));

async function loadTaxForms() {
  return import('../tax-forms.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abTaxFormTemplate.findFirst.mockResolvedValue(null);
  dbMock.abTaxFormTemplate.create.mockImplementation(async (args: any) => ({ id: `tpl-${args.data.formCode}`, ...args.data }));
  dbMock.abTaxFormTemplate.update.mockImplementation(async (args: any) => ({ id: args.where.id }));
  dbMock.abJournalLine.aggregate.mockResolvedValue({ _sum: { debitCents: 0, creditCents: 0 } } as any);
  dbMock.abTenantConfig.findFirst.mockResolvedValue(null);
});

describe('seedAuForms() — real AU BusinessSchedule + IndividualReturn templates', () => {
  it('creates exactly 2 templates on the first run', async () => {
    const { seedAuForms } = await loadTaxForms();

    const result = await seedAuForms();

    expect(result).toEqual({ created: 2, updated: 0 });
    expect(dbMock.abTaxFormTemplate.create).toHaveBeenCalledTimes(2);
    expect(dbMock.abTaxFormTemplate.update).not.toHaveBeenCalled();

    const formCodes = dbMock.abTaxFormTemplate.create.mock.calls
      .map((c: any) => c[0].data.formCode)
      .sort();
    expect(formCodes).toEqual(['BusinessSchedule', 'IndividualReturn']);

    // Every created row must satisfy the model's real required shape
    // (jurisdiction/formCode/version/sections), same fields
    // seedUsForms()/seedCanadianForms() write for their templates.
    for (const call of dbMock.abTaxFormTemplate.create.mock.calls) {
      const data = call[0].data;
      expect(data.jurisdiction).toBe('au');
      expect(data.version).toBe('2025');
      expect(Array.isArray(data.sections)).toBe(true);
      expect(data.validationRules).toEqual([]);
    }
  });

  it('is idempotent — a second run updates the same 2 rows instead of re-creating them (0 created / 2 updated)', async () => {
    const { seedAuForms } = await loadTaxForms();

    // Simulate persistence across the two seedAuForms() calls: once a form
    // is "created", findFirst must find it on the next lookup.
    const existing: Record<string, { id: string }> = {};
    dbMock.abTaxFormTemplate.findFirst.mockImplementation(async (args: any) => existing[args.where.formCode] ?? null);
    dbMock.abTaxFormTemplate.create.mockImplementation(async (args: any) => {
      const row = { id: `tpl-${args.data.formCode}`, ...args.data };
      existing[args.data.formCode] = row;
      return row;
    });

    const first = await seedAuForms();
    expect(first).toEqual({ created: 2, updated: 0 });

    const second = await seedAuForms();
    expect(second).toEqual({ created: 0, updated: 2 });
    expect(dbMock.abTaxFormTemplate.update).toHaveBeenCalledTimes(2);
    // No additional creates on the second pass.
    expect(dbMock.abTaxFormTemplate.create).toHaveBeenCalledTimes(2);
  });
});

describe('autoPopulateForm — real BusinessSchedule template, formula chain gross_business_income -> total_expenses -> net_business_income', () => {
  it('gross_business_income -> total_expenses -> net_business_income', async () => {
    const { seedAuForms, autoPopulateForm } = await loadTaxForms();

    // Capture the exact BusinessSchedule template body seedAuForms() writes
    // to the DB, so this test exercises the real production template rather
    // than a hand-rolled stand-in.
    let businessSchedule: any;
    dbMock.abTaxFormTemplate.create.mockImplementation(async (args: any) => {
      if (args.data.formCode === 'BusinessSchedule') businessSchedule = args.data;
      return { id: `tpl-${args.data.formCode}`, ...args.data };
    });
    await seedAuForms();
    expect(businessSchedule).toBeDefined();

    // Stub the ledger: revenue_total reads account.code.startsWith('4');
    // expense_category:<code> reads account.code === <code> directly.
    // $10,000.00 revenue (1,000,000 cents), $500 advertising, $200 office
    // supplies. All other expense categories are zero.
    dbMock.abJournalLine.aggregate.mockImplementation(async (args: any) => {
      const codeFilter = args.where.account.code;
      if (codeFilter && typeof codeFilter === 'object' && codeFilter.startsWith === '4') {
        return { _sum: { creditCents: 1_000_000, debitCents: 0 } };
      }
      const debitByCode: Record<string, number> = {
        '5000': 50_000, // advertising
        '6100': 20_000, // office_supplies
      };
      return { _sum: { debitCents: debitByCode[codeFilter] ?? 0, creditCents: 0 } };
    });

    const allFormFields: Record<string, Record<string, any>> = {};
    const result = await autoPopulateForm('tenant-1', 2025, businessSchedule, [], allFormFields);

    expect(result.fields.gross_business_income).toBe(1_000_000);
    // total_expenses = advertising(50,000) + office_supplies(20,000) = 70,000
    expect(result.fields.total_expenses).toBe(70_000);
    // net_business_income = gross_business_income - total_expenses = 930,000
    expect(result.fields.net_business_income).toBe(930_000);

    // Cross-form reference wiring: allFormFields['BusinessSchedule'] must
    // expose net_business_income for AU_INDIVIDUAL_RETURN_2025's
    // business_income formula (`BusinessSchedule.net_business_income`) to
    // resolve against.
    expect(allFormFields.BusinessSchedule.net_business_income).toBe(930_000);
  });
});

describe('autoPopulateForm — real IndividualReturn template, formula chain taxable_income -> income_tax/medicare_levy -> total_tax_payable', () => {
  it('taxable_income -> income_tax/medicare_levy -> total_tax_payable', async () => {
    const { seedAuForms, autoPopulateForm } = await loadTaxForms();

    let individualReturn: any;
    dbMock.abTaxFormTemplate.create.mockImplementation(async (args: any) => {
      if (args.data.formCode === 'IndividualReturn') individualReturn = args.data;
      return { id: `tpl-${args.data.formCode}`, ...args.data };
    });
    await seedAuForms();
    expect(individualReturn).toBeDefined();

    // salary_wages and business_income are both 'manual'/'calculated' fields
    // that aren't backed by resolveSourceQuery in this template (business_income
    // resolves via cross-form reference, defaulting to 0 with no
    // BusinessSchedule data supplied); seed salary_wages directly via
    // allFormFields is not applicable here since it's a manual field with no
    // source — so pre-seed it into the fields map through a direct
    // autoPopulateForm pass is not possible. Instead, verify the tax
    // calculation chain using the calculated fields that ARE derived
    // (taxable_income defaults to MAX(0, 0 + 0) = 0 here), then separately
    // verify the formula wiring directly via evaluateFormula for a non-zero
    // income to confirm income_tax/medicare_levy/total_tax_payable compose
    // correctly.
    const allFormFields: Record<string, Record<string, any>> = {};
    const result = await autoPopulateForm('tenant-1', 2025, individualReturn, [], allFormFields);

    expect(result.fields.taxable_income).toBe(0);
    expect(result.fields.income_tax).toBe(0);
    expect(result.fields.medicare_levy).toBe(0);
    expect(result.fields.total_tax_payable).toBe(0);

    // Now verify the formula chain directly for a non-zero taxable income,
    // exercising the real formulas from the seeded template.
    const { evaluateFormula } = await loadTaxForms();
    const taxCalcSection = individualReturn.sections.find((s: any) => s.sectionId === 'tax_calculation');
    const incomeTaxField = taxCalcSection.fields.find((f: any) => f.fieldId === 'income_tax');
    const medicareLevyField = taxCalcSection.fields.find((f: any) => f.fieldId === 'medicare_levy');
    const totalTaxField = taxCalcSection.fields.find((f: any) => f.fieldId === 'total_tax_payable');

    const fields: Record<string, any> = { taxable_income: 10_000_000 }; // $100,000.00
    const incomeTax = evaluateFormula(incomeTaxField.formula, fields, {}, 2025);
    expect(incomeTax).not.toBeNull();
    fields.income_tax = incomeTax;

    const medicareLevy = evaluateFormula(medicareLevyField.formula, fields, {}, 2025);
    // medicare_levy = taxable_income * 2 / 100 = 200,000
    expect(medicareLevy).toBe(200_000);
    fields.medicare_levy = medicareLevy;

    const totalTax = evaluateFormula(totalTaxField.formula, fields, {}, 2025);
    expect(totalTax).toBe((incomeTax ?? 0) + (medicareLevy ?? 0));
  });
});
