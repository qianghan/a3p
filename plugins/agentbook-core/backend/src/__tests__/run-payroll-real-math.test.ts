import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PARITY-6, Task 4 — `run-payroll` chat/MCP skill uses real withholding
 * math (via the new non-persisting GET /api/v1/agentbook-payroll/pay-runs/
 * preview route from Task 3) instead of a rough gross-only estimate, with a
 * graceful fallback to the old estimate if the preview call fails.
 *
 * Mocking convention combines two existing precedents in this directory:
 * - payroll-skills-au-stp-disclosure.test.ts (PARITY-5): `executeClassification`
 *   imported directly from '../server', `../db/client.js` mocked, since
 *   run-payroll is an INTERNAL handler inside server.ts's
 *   _executeClassificationCore (no HTTP endpoint / ctx.callGemini involved).
 * - daily-briefing-tax-deadline.test.ts (PARITY-5): a single mocked
 *   `global.fetch` dispatched by URL, since the handler now makes an
 *   outbound fetch to the preview endpoint via the same baseUrls/fetch
 *   pattern already used elsewhere in server.ts.
 */

const mockAbEmployeeFindMany = vi.fn();
const mockAbConversationCreate = vi.fn(async () => ({}));

vi.mock('../db/client.js', () => ({
  db: {
    abEmployee: { findMany: (...args: any[]) => mockAbEmployeeFindMany(...args) },
    abConversation: { create: (...args: any[]) => mockAbConversationCreate(...args) },
    // executeClassification's finally-block skill-metrics write — fire-and-
    // forget in production (errors are swallowed), mocked here just to keep
    // test output free of the caught-error stderr noise.
    abSkillRun: { create: vi.fn(async () => ({})) },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';

function classification() {
  return {
    selectedSkill: { name: 'run-payroll', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
    extractedParams: {},
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: {},
  } as any;
}

function makeEmployee(overrides: Record<string, any> = {}) {
  return {
    id: 'emp-1',
    name: 'Jane Doe',
    payRateCents: 8_000_000,
    payFrequency: 'biweekly',
    payType: 'salary',
    jurisdiction: 'us',
    ...overrides,
  };
}

function jsonOk(body: any) {
  return { ok: true, json: async () => body };
}

function setupFetch(previewResponse: any) {
  mockFetch.mockImplementation(async (url: string) => {
    if (String(url).includes('/pay-runs/preview')) {
      if (previewResponse === 'throw') throw new Error('preview service down');
      return jsonOk(previewResponse);
    }
    return jsonOk({ success: false });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAbConversationCreate.mockResolvedValue({});
});

describe('run-payroll — real withholding math via preview endpoint (PARITY-6)', () => {
  it('includes real withheld/net figures sourced from a successful preview call', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee()]);
    setupFetch({
      success: true,
      data: { employees: [], totalGrossCents: 800_000, totalWithheldCents: 150_000, totalNetCents: 650_000 },
    });

    const result = await executeClassification(classification(), 'run payroll', 'tenant-1', 'api');

    // fmt() in the run-payroll handler is `'$' + Math.round(c/100).toLocaleString()`
    // (Node's default-locale toLocaleString, which inserts thousands
    // separators) — 800_000/150_000/650_000 cents render as $8,000/$1,500/$6,500.
    expect(result.responseData.message).toContain('$8,000');
    expect(result.responseData.message).toContain('$1,500');
    expect(result.responseData.message).toContain('$6,500');
    expect(result.responseData.message).toContain('withheld');
    expect(result.responseData.message).toContain('net');

    const previewCall = mockFetch.mock.calls.find(([url]: any[]) => String(url).includes('/pay-runs/preview'));
    expect(previewCall).toBeTruthy();
  });

  it('falls back to the old gross-only estimate when the preview fetch rejects (does not throw)', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee({ payRateCents: 26_000_00, payFrequency: 'biweekly' })]);
    setupFetch('throw');

    const result = await executeClassification(classification(), 'run payroll', 'tenant-1', 'api');

    expect(result.confidence).not.toBe(0);
    expect(result.responseData.message).toContain('about');
    expect(result.responseData.message).toContain('gross this period');
    expect(result.responseData.message).not.toContain('withheld');
  });

  it('falls back to the old gross-only estimate when the preview call returns success:false', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee()]);
    setupFetch({ success: false, error: 'no active employees to pay' });

    const result = await executeClassification(classification(), 'run payroll', 'tenant-1', 'api');

    expect(result.responseData.message).toContain('about');
    expect(result.responseData.message).toContain('gross this period');
  });

  it('still appends the AU STP disclosure regardless of which math path was used', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee({ jurisdiction: 'au' })]);
    setupFetch({
      success: true,
      data: { employees: [], totalGrossCents: 800_000, totalWithheldCents: 100_000, totalNetCents: 700_000 },
    });

    const result = await executeClassification(classification(), 'run payroll', 'tenant-1', 'api');

    expect(result.responseData.message).toContain('does NOT yet lodge');
  });

  it('still appends the AU STP disclosure on the fallback (preview failure) path', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee({ jurisdiction: 'au' })]);
    setupFetch('throw');

    const result = await executeClassification(classification(), 'run payroll', 'tenant-1', 'api');

    expect(result.responseData.message).toContain('does NOT yet lodge');
  });
});
