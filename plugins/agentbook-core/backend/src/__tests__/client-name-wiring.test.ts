import { describe, it, expect, vi } from 'vitest';

/**
 * WIRING GUARD for cleanClientName.
 *
 * client-name.test.ts covers the cleaner itself. It cannot tell you the
 * EXTRACTORS call it — and when I first wired this up I forgot the import
 * entirely, and all 538 unit tests still passed. Only `tsc` caught it, which
 * would not have helped had the call site been reachable but unconverted.
 *
 * This asserts on the classifier's extracted params, i.e. the value that
 * actually reaches resolveOrCreateClient and therefore decides whether a new
 * client row is written.
 */
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: { findMany: vi.fn(async () => []), create: vi.fn(async () => ({})) },
    abTenantConfig: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abExpense: { findMany: vi.fn(async () => []) },
    abAccount: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null) },
    abEvent: { create: vi.fn(async () => ({})) },
  },
}));

const CREATE_INVOICE = {
  name: 'create-invoice',
  description: 'Create an invoice for a client',
  category: 'invoicing',
  triggerPatterns: ['invoice'],
  parameters: {
    clientName: { type: 'string', required: true, extractHint: 'the client name' },
    amountCents: { type: 'number', required: true, extractHint: 'the amount' },
  },
  endpoint: { method: 'POST', url: '/api/v1/agentbook-invoice/invoices' },
};

async function clientNameFor(text: string): Promise<string | undefined> {
  const { classifyOnly } = await import('../server');
  const res: any = await classifyOnly(
    text, 'tenant-maya', 'web', [], [], [CREATE_INVOICE] as any, [], {},
  );
  return res?.extractedParams?.clientName;
}

describe('the invoice extractor stores a clean client name', () => {
  // Production had a client literally called "to Acme for" sitting next to
  // "Acme Corp" — two rows for one client, so neither showed what that client
  // actually owed.
  it('"invoice Acme for $5000" books Acme, not "Acme for"', async () => {
    expect(await clientNameFor('invoice Acme for $5000')).toBe('Acme');
  });

  it('"invoice to Acme for $5000" books Acme, not "to Acme for"', async () => {
    expect(await clientNameFor('invoice to Acme for $5000')).toBe('Acme');
  });

  it('the phrasing that always worked still works', async () => {
    expect(await clientNameFor('invoice TechCorp $5000 for January consulting')).toBe('TechCorp');
  });

  it('a multi-word company name survives', async () => {
    expect(await clientNameFor('invoice Acme Corp for $5000')).toBe('Acme Corp');
  });
});
