// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
vi.mock('@/lib/agentbook-tenant', async () => (await import('@/__tests__/helpers/route-request')).tenantModuleMock);

import { memDb, type Row } from '@/__tests__/helpers/mem-db';
import { tenantReq, json } from '@/__tests__/helpers/route-request';
import { NOW, fullSeed, TENANT_CONFIGS } from '@/__tests__/helpers/mobile-fixtures';
import { computeTaxEstimate, TAX_ESTIMATE_JURISDICTIONS } from '@/lib/agentbook-tax-estimate';
import { GET } from '@/app/api/v1/agentbook-tax/tax/estimate/route';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  memDb.reset(fullSeed());
});
afterEach(() => vi.useRealTimers());

/**
 * Re-seed with t1's tenant config overridden, optional tax config rows, and an
 * optional t1 revenue figure (the fixture's $5,000 sits under AU's tax-free
 * threshold, which would pin nothing but zeros).
 */
function seedT1(cfg: Row, abTaxConfig: Row[] = [], revenueCents?: number) {
  const seed = fullSeed();
  const abJournalLine = revenueCents === undefined
    ? seed.abJournalLine
    : seed.abJournalLine.map((l) =>
        l.entryId !== 'je-rev' ? l : l.accountId === 'acc-rev' ? { ...l, creditCents: revenueCents } : { ...l, debitCents: revenueCents },
      );
  memDb.reset({
    ...seed,
    abJournalLine,
    abTenantConfig: TENANT_CONFIGS.map((c) => (c.userId === 't1' ? { ...c, ...cfg } : c)),
    abTaxConfig,
  });
}

/**
 * The default window starts at LOCAL midnight on 1 Jan, so its ISO string
 * depends on the machine's timezone. Swap it for a stable token (and assert
 * the token is exactly that value) so the pinned bodies match on any TZ.
 */
const LOCAL_YEAR_START = '<local 1 Jan 00:00>';
function stableBody(body: Record<string, unknown>): Record<string, unknown> {
  const range = (body.data as { dateRange?: { startDate: string } } | undefined)?.dateRange;
  if (range && range.startDate === new Date(NOW.getFullYear(), 0, 1).toISOString()) range.startDate = LOCAL_YEAR_START;
  return body;
}

const estimate = async (query = '', tenant = 't1') =>
  stableBody(await json<Record<string, unknown>>(await GET(tenantReq(`/api/v1/agentbook-tax/tax/estimate${query}`, tenant))));

// Characterization: pinned against the route BEFORE the computation moved into
// lib/agentbook-tax-estimate.ts. The whole response body (both the `data` cents
// shape and the legacy snake_case dollar fields) must stay byte-identical.
describe('tax/estimate route — characterization (pinned before the extraction)', () => {
  it('CA/ON accrual default (federal + provincial, no double count)', async () => {
    expect(await estimate()).toMatchInlineSnapshot(`
      {
        "amount_owed": 1040.38,
        "combined_mode": false,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 104038,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 22.61,
          "expensesCents": 39900,
          "grossRevenueCents": 500000,
          "incomeTaxCents": 68032,
          "jurisdiction": "ca",
          "netIncomeCents": 460100,
          "period": "2026-Q2",
          "region": "ON",
          "seTaxBreakdown": {
            "cpp": 13102,
            "cpp2": 0,
            "ei": 0,
          },
          "seTaxCents": 13102,
          "stateTaxCents": 22904,
          "stateTaxModeled": true,
          "stateTaxNote": null,
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 104038,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 22.61,
        "income_tax": 680.32,
        "net_income": 4601,
        "quarterly_payments": [],
        "self_employment_tax": 131.02,
        "success": true,
        "total_estimated_tax": 1040.38,
        "total_expenses": 399,
        "total_revenue": 5000,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('cash basis + explicit dates + period param', async () => {
    expect(await estimate('?basis=CASH&startDate=2026-06-01&endDate=2026-06-30&period=2026-Q2')).toMatchInlineSnapshot(`
      {
        "amount_owed": 0,
        "combined_mode": false,
        "data": {
          "accountingBasis": "cash",
          "amountOwedCents": 0,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-30T00:00:00.000Z",
            "startDate": "2026-06-01T00:00:00.000Z",
          },
          "effectiveRate": 0,
          "expensesCents": 31900,
          "grossRevenueCents": 30000,
          "incomeTaxCents": 0,
          "jurisdiction": "ca",
          "netIncomeCents": -1900,
          "period": "2026-Q2",
          "region": "ON",
          "seTaxBreakdown": {},
          "seTaxCents": 0,
          "stateTaxCents": 0,
          "stateTaxModeled": true,
          "stateTaxNote": null,
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 0,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 0,
        "income_tax": 0,
        "net_income": -19,
        "quarterly_payments": [],
        "self_employment_tax": 0,
        "success": true,
        "total_estimated_tax": 0,
        "total_expenses": 319,
        "total_revenue": 300,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('invalid dates fall back to year-start / now', async () => {
    const body = await estimate('?startDate=nope&endDate=also-nope');
    expect((body.data as { dateRange: unknown }).dateRange).toEqual({
      startDate: LOCAL_YEAR_START,
      endDate: NOW.toISOString(),
    });
  });

  it('US tenant (t2, CA state) accrual default', async () => {
    expect(await estimate('', 't2')).toMatchInlineSnapshot(`
      {
        "amount_owed": 2.43,
        "combined_mode": false,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 243,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 24.32,
          "expensesCents": 0,
          "grossRevenueCents": 999,
          "incomeTaxCents": 93,
          "jurisdiction": "us",
          "netIncomeCents": 999,
          "period": "2026-Q2",
          "region": "CA",
          "seTaxBreakdown": {
            "additional_medicare": 0,
            "medicare": 27,
            "social_security": 114,
          },
          "seTaxCents": 141,
          "stateTaxCents": 9,
          "stateTaxModeled": true,
          "stateTaxNote": null,
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 243,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 24.32,
        "income_tax": 0.93,
        "net_income": 9.99,
        "quarterly_payments": [],
        "self_employment_tax": 1.41,
        "success": true,
        "total_estimated_tax": 2.43,
        "total_expenses": 0,
        "total_revenue": 9.99,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('US with W-2 income + withholding (combined mode, MFJ)', async () => {
    seedT1({ jurisdiction: 'us', region: 'NY', currency: 'USD' }, [
      { id: 'tc-1', tenantId: 't1', w2IncomeAnnual: 8000000, w2WithheldYtd: 900000, filingStatus: 'married_jointly' },
    ]);
    expect(await estimate()).toMatchInlineSnapshot(`
      {
        "amount_owed": 9593.12,
        "combined_mode": true,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 959312,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": true,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 21.98,
          "expensesCents": 39900,
          "grossRevenueCents": 500000,
          "incomeTaxCents": 1345471,
          "jurisdiction": "us",
          "netIncomeCents": 460100,
          "period": "2026-Q2",
          "region": "NY",
          "seTaxBreakdown": {
            "additional_medicare": 0,
            "medicare": 12322,
            "social_security": 52688,
          },
          "seTaxCents": 65010,
          "stateTaxCents": 448831,
          "stateTaxModeled": true,
          "stateTaxNote": null,
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 1859312,
          "w2IncomeCents": 8000000,
          "w2WithheldCents": 900000,
        },
        "effective_rate": 21.98,
        "income_tax": 13454.71,
        "net_income": 4601,
        "quarterly_payments": [],
        "self_employment_tax": 650.1,
        "success": true,
        "total_estimated_tax": 18593.12,
        "total_expenses": 399,
        "total_revenue": 5000,
        "w2_income": 80000,
        "w2_withheld": 9000,
      }
    `);
  });

  it('AU sole trader (no US self-employment maths)', async () => {
    seedT1({ jurisdiction: 'au', region: 'NSW', currency: 'AUD', taxEntityType: 'sole_trader' }, [], 9000000);
    expect(await estimate()).toMatchInlineSnapshot(`
      {
        "amount_owed": 19460.32,
        "combined_mode": false,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 1946032,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 21.72,
          "expensesCents": 39900,
          "grossRevenueCents": 9000000,
          "incomeTaxCents": 1766830,
          "jurisdiction": "au",
          "netIncomeCents": 8960100,
          "period": "2026-Q2",
          "region": "NSW",
          "seTaxBreakdown": {
            "medicare_levy": 179202,
          },
          "seTaxCents": 179202,
          "stateTaxCents": 0,
          "stateTaxModeled": true,
          "stateTaxNote": "No sub-national income tax modeled for this country.",
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 1946032,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 21.72,
        "income_tax": 17668.3,
        "net_income": 89601,
        "quarterly_payments": [],
        "self_employment_tax": 1792.02,
        "success": true,
        "total_estimated_tax": 19460.32,
        "total_expenses": 399,
        "total_revenue": 90000,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('AU Pty Ltd company (flat company tax, $0 SE)', async () => {
    seedT1({ jurisdiction: 'au', region: 'NSW', currency: 'AUD', taxEntityType: 'pty_ltd' }, [], 9000000);
    expect(await estimate()).toMatchInlineSnapshot(`
      {
        "amount_owed": 22400.25,
        "combined_mode": false,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 2240025,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 25,
          "expensesCents": 39900,
          "grossRevenueCents": 9000000,
          "incomeTaxCents": 2240025,
          "jurisdiction": "au",
          "netIncomeCents": 8960100,
          "period": "2026-Q2",
          "region": "NSW",
          "seTaxBreakdown": {},
          "seTaxCents": 0,
          "stateTaxCents": 0,
          "stateTaxModeled": true,
          "stateTaxNote": "No sub-national income tax modeled for this country.",
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 2240025,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 25,
        "income_tax": 22400.25,
        "net_income": 89601,
        "quarterly_payments": [],
        "self_employment_tax": 0,
        "success": true,
        "total_estimated_tax": 22400.25,
        "total_expenses": 399,
        "total_revenue": 90000,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('Quebec (QPP/QPIP breakdown)', async () => {
    seedT1({ region: 'QC' });
    expect(await estimate()).toMatchInlineSnapshot(`
      {
        "amount_owed": 1484.83,
        "combined_mode": false,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 148483,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 32.27,
          "expensesCents": 39900,
          "grossRevenueCents": 500000,
          "incomeTaxCents": 67694,
          "jurisdiction": "ca",
          "netIncomeCents": 460100,
          "period": "2026-Q2",
          "region": "QC",
          "seTaxBreakdown": {
            "ei": 0,
            "qpip": 3515,
            "qpp": 14093,
            "qpp2": 0,
          },
          "seTaxCents": 17608,
          "stateTaxCents": 63181,
          "stateTaxModeled": true,
          "stateTaxNote": null,
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 148483,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 32.27,
        "income_tax": 676.94,
        "net_income": 4601,
        "quarterly_payments": [],
        "self_employment_tax": 176.08,
        "success": true,
        "total_estimated_tax": 1484.83,
        "total_expenses": 399,
        "total_revenue": 5000,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('unmodelled jurisdiction falls back to US brackets with $0 SE tax', async () => {
    seedT1({ jurisdiction: 'uk', region: '' });
    expect(await estimate()).toMatchInlineSnapshot(`
      {
        "amount_owed": 460.1,
        "combined_mode": false,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 46010,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 10,
          "expensesCents": 39900,
          "grossRevenueCents": 500000,
          "incomeTaxCents": 46010,
          "jurisdiction": "uk",
          "netIncomeCents": 460100,
          "period": "2026-Q2",
          "region": "",
          "seTaxBreakdown": {},
          "seTaxCents": 0,
          "stateTaxCents": 0,
          "stateTaxModeled": true,
          "stateTaxNote": "No sub-national income tax modeled for this country.",
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 46010,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 10,
        "income_tax": 460.1,
        "net_income": 4601,
        "quarterly_payments": [],
        "self_employment_tax": 0,
        "success": true,
        "total_estimated_tax": 460.1,
        "total_expenses": 399,
        "total_revenue": 5000,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('tenant with no config/accounts → zero estimate', async () => {
    expect(await estimate('', 't-empty')).toMatchInlineSnapshot(`
      {
        "amount_owed": 0,
        "combined_mode": false,
        "data": {
          "accountingBasis": "accrual",
          "amountOwedCents": 0,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 0,
          "expensesCents": 0,
          "grossRevenueCents": 0,
          "incomeTaxCents": 0,
          "jurisdiction": "us",
          "netIncomeCents": 0,
          "period": "2026-Q2",
          "region": "",
          "seTaxBreakdown": {},
          "seTaxCents": 0,
          "stateTaxCents": 0,
          "stateTaxModeled": false,
          "stateTaxNote": "No state/province set — state income tax not included.",
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 0,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 0,
        "income_tax": 0,
        "net_income": 0,
        "quarterly_payments": [],
        "self_employment_tax": 0,
        "success": true,
        "total_estimated_tax": 0,
        "total_expenses": 0,
        "total_revenue": 0,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('cash basis with no cash account falls back to the accrual expense view', async () => {
    const seed = fullSeed();
    memDb.reset({ ...seed, abAccount: seed.abAccount.filter((a) => a.id !== 'acc-cash') });
    expect(await estimate('?basis=cash')).toMatchInlineSnapshot(`
      {
        "amount_owed": 120.5,
        "combined_mode": false,
        "data": {
          "accountingBasis": "cash",
          "amountOwedCents": 12050,
          "calculatedAt": "2026-06-20T12:00:00.000Z",
          "combinedMode": false,
          "dateRange": {
            "endDate": "2026-06-20T12:00:00.000Z",
            "startDate": "<local 1 Jan 00:00>",
          },
          "effectiveRate": 20.05,
          "expensesCents": 39900,
          "grossRevenueCents": 100000,
          "incomeTaxCents": 9015,
          "jurisdiction": "ca",
          "netIncomeCents": 60100,
          "period": "2026-Q2",
          "region": "ON",
          "seTaxBreakdown": {
            "cpp": 0,
            "cpp2": 0,
            "ei": 0,
          },
          "seTaxCents": 0,
          "stateTaxCents": 3035,
          "stateTaxModeled": true,
          "stateTaxNote": null,
          "taxTablesYear": 2025,
          "taxYearNote": "This estimate uses 2025 tax tables — 2026 figures aren't loaded yet, so treat it as an approximation for 2026 and verify against current-year rates before filing.",
          "totalTaxCents": 12050,
          "w2IncomeCents": 0,
          "w2WithheldCents": 0,
        },
        "effective_rate": 20.05,
        "income_tax": 90.15,
        "net_income": 601,
        "quarterly_payments": [],
        "self_employment_tax": 0,
        "success": true,
        "total_estimated_tax": 120.5,
        "total_expenses": 399,
        "total_revenue": 1000,
        "w2_income": 0,
        "w2_withheld": 0,
      }
    `);
  });

  it('unauthenticated → the resolver response, untouched', async () => {
    const res = await GET(tenantReq('/api/v1/agentbook-tax/tax/estimate', 'none'));
    expect(res.status).toBe(401);
  });
});

describe('computeTaxEstimate — one engine for the route and mobile home', () => {
  it('the route returns exactly the engine result plus the legacy dollar fields', async () => {
    const route = await json<{ success: boolean; data: unknown; amount_owed: number; total_estimated_tax: number; quarterly_payments: unknown[] }>(
      await GET(tenantReq('/api/v1/agentbook-tax/tax/estimate', 't1')),
    );
    const lib = await computeTaxEstimate('t1');
    expect(route.success).toBe(true);
    expect(route.data).toEqual(JSON.parse(JSON.stringify(lib)));
    expect(route.amount_owed).toBe(lib.amountOwedCents / 100);
    expect(route.total_estimated_tax).toBe(lib.totalTaxCents / 100);
    expect(route.quarterly_payments).toEqual([]);
  });

  it('reads the tenant journal (accrual default)', async () => {
    const lib = await computeTaxEstimate('t1');
    expect(lib.jurisdiction).toBe('ca');
    expect(lib.accountingBasis).toBe('accrual');
    expect(lib.grossRevenueCents).toBe(500000);
    expect(lib.expensesCents).toBe(39900);
    expect(lib.netIncomeCents).toBe(460100);
  });

  it('honours explicit basis / date options exactly like the query params', async () => {
    const lib = await computeTaxEstimate('t1', { basis: 'CASH', startDate: '2026-06-01', endDate: '2026-06-30' });
    expect(lib.accountingBasis).toBe('cash');
    expect(lib.grossRevenueCents).toBe(30000);
    expect(lib.expensesCents).toBe(4000 + 12000 + 6000 + 9900);
  });

  it('lists exactly the modelled jurisdictions', () => {
    expect([...TAX_ESTIMATE_JURISDICTIONS].sort()).toEqual(['au', 'ca', 'us']);
  });
});
