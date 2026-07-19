import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * PARITY-5, Task 1 — AU Single Touch Payroll (STP) disclosure in the
 * `payroll-status` and `run-payroll` chat/MCP skill handlers.
 *
 * AU-8 already shows a banner on apps/web-next's Payroll page
 * (apps/web-next/src/app/(dashboard)/payroll/page.tsx) warning that AU
 * payroll here doesn't lodge STP reports to the ATO. Before this fix, chat
 * gave no such warning — this test locks in that the exact same disclosure
 * text now appears whenever any employee on the tenant's payroll has
 * jurisdiction 'au', and never for a purely non-AU tenant.
 *
 * Mocking convention mirrors personal-snapshot-trend-skill.test.ts /
 * international-student-tax-help-skill.test.ts: `executeClassification` is
 * imported directly from '../server' and exercised against a mocked
 * '../db/client.js', since payroll-status/run-payroll are INTERNAL handlers
 * living inside server.ts's _executeClassificationCore (no HTTP endpoint,
 * no ctx-level ctx.callGemini involved here).
 */

const mockAbEmployeeFindMany = vi.fn();
const mockAbPayRunFindFirst = vi.fn();
const mockAbConversationCreate = vi.fn(async () => ({}));

vi.mock('../db/client.js', () => ({
  db: {
    abEmployee: { findMany: (...args: any[]) => mockAbEmployeeFindMany(...args) },
    abPayRun: { findFirst: (...args: any[]) => mockAbPayRunFindFirst(...args) },
    abConversation: { create: (...args: any[]) => mockAbConversationCreate(...args) },
    // executeClassification's finally-block skill-metrics write — fire-and-
    // forget in production (errors are swallowed), mocked here just to keep
    // test output free of the caught-error stderr noise.
    abSkillRun: { create: vi.fn(async () => ({})) },
  },
}));

// PARITY-6, Task 4 — run-payroll now calls the real GET /pay-runs/preview
// endpoint via fetch() before falling back to its old gross-only estimate.
// Without a fetch mock here, that call would hit the network for real
// (nothing listens on the localhost fallback in this unit-test process),
// hanging until the test framework's timeout. A `{ success: false }`
// response drives the handler down its pre-existing fallback path, which
// leaves this file's disclosure-text assertions (below) unaffected.
const mockFetch = vi.fn(async () => ({ ok: true, json: async () => ({ success: false }) }));
global.fetch = mockFetch as any;

import { executeClassification } from '../server';

const AU_STP_DISCLOSURE_FRAGMENT = 'Single Touch Payroll (STP) reports to the ATO in real time';

function classification(skillName: 'payroll-status' | 'run-payroll') {
  return {
    selectedSkill: { name: skillName, endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockAbPayRunFindFirst.mockResolvedValue(null);
  mockAbConversationCreate.mockResolvedValue({});
});

describe('payroll-status — AU STP disclosure', () => {
  it('includes the AU STP disclosure when an AU employee is on payroll', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee({ jurisdiction: 'au' })]);
    const result = await executeClassification(classification('payroll-status'), "how's payroll going", 'tenant-1', 'api');
    expect(result.responseData.message).toContain(AU_STP_DISCLOSURE_FRAGMENT);
  });

  it('does NOT mention Single Touch Payroll for a US-only tenant', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee({ jurisdiction: 'us' })]);
    const result = await executeClassification(classification('payroll-status'), "how's payroll going", 'tenant-1', 'api');
    expect(result.responseData.message).not.toMatch(/Single Touch Payroll/);
  });
});

describe('run-payroll — AU STP disclosure', () => {
  it('includes the AU STP disclosure when an AU employee is on payroll', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee({ jurisdiction: 'au' })]);
    const result = await executeClassification(classification('run-payroll'), 'run payroll', 'tenant-1', 'api');
    expect(result.responseData.message).toContain(AU_STP_DISCLOSURE_FRAGMENT);
  });

  it('does NOT mention Single Touch Payroll for a US-only tenant', async () => {
    mockAbEmployeeFindMany.mockResolvedValueOnce([makeEmployee({ jurisdiction: 'us' })]);
    const result = await executeClassification(classification('run-payroll'), 'run payroll', 'tenant-1', 'api');
    expect(result.responseData.message).not.toMatch(/Single Touch Payroll/);
  });
});
