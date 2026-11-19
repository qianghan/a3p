/**
 * PR 2b.8 — the chat wiring: record-expense POSTs the parsed tax phrase to
 * /agentbook-expense/expenses (where resolveExpenseTax runs) and the reply
 * states the split the server returned.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Every model answers empty: the record-expense path only needs lookups to not throw.
vi.mock('../db/client.js', () => {
  const listy = () => new Proxy({}, { get: (_t, k) => async () => (k === 'findMany' ? [] : k === 'count' ? 0 : null) });
  return { db: new Proxy({}, { get: (_t, k) => (k === '$transaction' ? async (fn: any) => fn(listy()) : listy()) }) };
});

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';

const ENDPOINT = { method: 'POST', url: '/api/v1/agentbook-expense/expenses' };
const classification = (extractedParams: Record<string, any>) => ({
  selectedSkill: { name: 'record-expense', endpoint: ENDPOINT, parameters: {} },
  extractedParams, confidence: 0.9, confirmBefore: false,
  memory: [], skills: [], conversation: [], tenantConfig: { jurisdiction: 'au', currency: 'AUD' },
}) as any;

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => ({
    ok: true, status: 201,
    json: async () => ({ success: true, data: { id: 'exp-1', amountCents: 11000, currency: 'AUD', description: 'Officeworks', taxCode: 'GST', recoverableTaxCents: 1000 } }),
  }));
});

describe('chat record-expense with "$110 incl GST"', () => {
  it('sends taxCode GST inclusive to the expenses route and states the split', async () => {
    const r = await executeClassification(
      classification({ amountCents: 11000, vendor: 'Officeworks', categoryId: 'acc-office' }),
      'spent $110 incl GST at Officeworks', 'tenant-au', 'api',
    );
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/agentbook-expense/expenses'));
    expect(call).toBeTruthy();
    const body = JSON.parse(call![1].body);
    expect(body).toMatchObject({ amountCents: 11000, taxCode: 'GST', taxInclusive: true, taxCodeIsHint: true });
    expect(r.responseData.message).toMatch(/GST \S*10\.00 claimable/);
  });

  it('"$100 + GST" sends the net with taxInclusive false', async () => {
    await executeClassification(classification({ amountCents: 10000, categoryId: 'acc-office' }), 'bought a chair $100 + GST', 'tenant-au', 'api');
    const call = mockFetch.mock.calls.find((c) => String(c[0]).includes('/agentbook-expense/expenses'));
    expect(JSON.parse(call![1].body)).toMatchObject({ amountCents: 10000, taxCode: 'GST', taxInclusive: false });
  });
});
