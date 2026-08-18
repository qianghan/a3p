import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * chat's tax-filing-start and the submit gate must mean the SAME filing year.
 *
 * handleTaxFilingSubmit resolves the year with defaultFilingYear() (the prior
 * calendar year, UTC — identical to the web review tab's currentFilingYear()),
 * while this skill kept a literal `|| 2025`. From 2027 that silently diverges:
 * chat would populate a 2025 filing while the gate looks for a confirmed 2026
 * review, and a real filing dead-ends with nothing to reconcile the two.
 */

const mockAbConversationCreate = vi.fn(async () => ({}));

vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { create: mockAbConversationCreate },
    abLLMProviderConfig: { findFirst: vi.fn(async () => null) },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

function classification() {
  return {
    selectedSkill: { name: 'tax-filing-start', endpoint: { method: 'INTERNAL', url: '' }, parameters: {} },
    extractedParams: {},
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: { jurisdiction: 'ca', region: 'ON' },
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data: { jurisdiction: 'ca', completeness: 1, forms: [], missingFields: [] } }),
  });
});
afterEach(() => vi.useRealTimers());

describe('tax-filing-start — filing year', () => {
  it('populates the year the submit gate will look for, not a hardcoded one', async () => {
    const { executeClassification, defaultFilingYear } = await import('../server.js');

    await executeClassification(classification(), 'start my tax filing', 'tenant-1', 'api');

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    const filingUrl = urls.find((u) => u.includes('/tax-filing/'));
    expect(filingUrl).toContain(`/tax-filing/${defaultFilingYear()}`);
  });

  it('moves with the calendar — in 2027 it starts a 2026 filing, not 2025', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-03-01T00:00:00Z'));

    const { executeClassification } = await import('../server.js');
    await executeClassification(classification(), 'start my tax filing', 'tenant-1', 'api');

    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/tax-filing/2026'))).toBe(true);
    expect(urls.some((u) => u.includes('/tax-filing/2025'))).toBe(false);
  });

  it('an explicit year in the message still wins', async () => {
    const { executeClassification } = await import('../server.js');
    const c = classification();
    c.extractedParams = { taxYear: 2023 };

    await executeClassification(c, 'start my 2023 tax filing', 'tenant-1', 'api');

    const urls = mockFetch.mock.calls.map((c2) => String(c2[0]));
    expect(urls.some((u) => u.includes('/tax-filing/2023'))).toBe(true);
  });
});
