import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Task 3 — real US ScheduleC + 1040 form templates and `seedUsForms()`.
 *
 * This plugin has no existing direct test for `seedCanadianForms()`
 * (nearest sibling to `seedUsForms()`), so this is the first test to
 * exercise `db.abTaxFormTemplate` in this plugin. The mocking convention
 * mirrors the one already established for `db` mocks across the sibling
 * plugin (see plugins/agentbook-core/backend/src/__tests__/
 * seed-jurisdiction-route.test.ts and start-tax-fast-track-skill.test.ts):
 * `vi.mock('../db/client.js', () => ({ db: dbMock }))` plus a dynamic
 * `import('../tax-forms.js')` inside each test (a static top-level import
 * would be hoisted above the `vi.mock` factory below, so it must be
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

describe('seedUsForms() — real US ScheduleC + 1040 templates', () => {
  it('creates exactly 2 templates on the first run', async () => {
    const { seedUsForms } = await loadTaxForms();

    const result = await seedUsForms();

    expect(result).toEqual({ created: 2, updated: 0 });
    expect(dbMock.abTaxFormTemplate.create).toHaveBeenCalledTimes(2);
    expect(dbMock.abTaxFormTemplate.update).not.toHaveBeenCalled();

    const formCodes = dbMock.abTaxFormTemplate.create.mock.calls
      .map((c: any) => c[0].data.formCode)
      .sort();
    expect(formCodes).toEqual(['1040', 'ScheduleC']);

    // Every created row must satisfy the model's real required shape
    // (jurisdiction/formCode/version/sections), same fields
    // seedCanadianForms() writes for the CA templates.
    for (const call of dbMock.abTaxFormTemplate.create.mock.calls) {
      const data = call[0].data;
      expect(data.jurisdiction).toBe('us');
      expect(data.version).toBe('2025');
      expect(Array.isArray(data.sections)).toBe(true);
      expect(data.validationRules).toEqual([]);
    }
  });

  it('is idempotent — a second run updates the same 2 rows instead of re-creating them (0 created / 2 updated)', async () => {
    const { seedUsForms } = await loadTaxForms();

    // Simulate persistence across the two seedUsForms() calls: once a form
    // is "created", findFirst must find it on the next lookup.
    const existing: Record<string, { id: string }> = {};
    dbMock.abTaxFormTemplate.findFirst.mockImplementation(async (args: any) => existing[args.where.formCode] ?? null);
    dbMock.abTaxFormTemplate.create.mockImplementation(async (args: any) => {
      const row = { id: `tpl-${args.data.formCode}`, ...args.data };
      existing[args.data.formCode] = row;
      return row;
    });

    const first = await seedUsForms();
    expect(first).toEqual({ created: 2, updated: 0 });

    const second = await seedUsForms();
    expect(second).toEqual({ created: 0, updated: 2 });
    expect(dbMock.abTaxFormTemplate.update).toHaveBeenCalledTimes(2);
    // No additional creates on the second pass.
    expect(dbMock.abTaxFormTemplate.create).toHaveBeenCalledTimes(2);
  });
});

describe('autoPopulateForm — real ScheduleC template, full formula chain to net_profit_31', () => {
  it('gross_receipts_1 -> gross_income_7 -> total_expenses_28 -> tentative_profit_29 -> net_profit_31', async () => {
    const { seedUsForms, autoPopulateForm } = await loadTaxForms();

    // Capture the exact ScheduleC template body seedUsForms() writes to the
    // DB, so this test exercises the real production template rather than
    // a hand-rolled stand-in.
    let scheduleC: any;
    dbMock.abTaxFormTemplate.create.mockImplementation(async (args: any) => {
      if (args.data.formCode === 'ScheduleC') scheduleC = args.data;
      return { id: `tpl-${args.data.formCode}`, ...args.data };
    });
    await seedUsForms();
    expect(scheduleC).toBeDefined();

    // Stub the ledger: revenue_total reads account.code.startsWith('4');
    // expense_category:<code> reads account.code === <code> directly.
    // $10,000.00 revenue (1,000,000 cents), $500 advertising, $200 office,
    // $100 meals (halved to $50 by the meals_50pct modifier). All other
    // expense categories are zero.
    dbMock.abJournalLine.aggregate.mockImplementation(async (args: any) => {
      const codeFilter = args.where.account.code;
      if (codeFilter && typeof codeFilter === 'object' && codeFilter.startsWith === '4') {
        return { _sum: { creditCents: 1_000_000, debitCents: 0 } };
      }
      const debitByCode: Record<string, number> = {
        '5000': 50_000, // advertising_8
        '5800': 20_000, // office_18
        '6400': 10_000, // meals_24b (halved to 5,000 by meals_50pct)
      };
      return { _sum: { debitCents: debitByCode[codeFilter] ?? 0, creditCents: 0 } };
    });

    const allFormFields: Record<string, Record<string, any>> = {};
    const result = await autoPopulateForm('tenant-1', 2025, scheduleC, [], allFormFields);

    expect(result.fields.gross_receipts_1).toBe(1_000_000);
    expect(result.fields.gross_income_7).toBe(1_000_000);
    // total_expenses_28 = advertising(50,000) + office(20,000) + meals(5,000) = 75,000
    expect(result.fields.total_expenses_28).toBe(75_000);
    // tentative_profit_29 = gross_income_7 - total_expenses_28 = 925,000
    expect(result.fields.tentative_profit_29).toBe(925_000);
    // net_profit_31 = tentative_profit_29 (unchanged), same "not folded
    // into net income" precedent as CA_T2125_2025's net_income_9369.
    expect(result.fields.net_profit_31).toBe(925_000);

    // Cross-form reference wiring: allFormFields['ScheduleC'] must expose
    // net_profit_31 for US_1040_2025's self_employment_income formula
    // (`ScheduleC.net_profit_31`) to resolve against.
    expect(allFormFields.ScheduleC.net_profit_31).toBe(925_000);
  });
});
