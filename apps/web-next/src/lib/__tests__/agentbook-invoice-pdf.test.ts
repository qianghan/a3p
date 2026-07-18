import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('server-only', () => ({}));

import { renderInvoicePdf, type InvoicePdfData } from '../agentbook-invoice-pdf';

// The global test setup replaces `fetch` with a bare vi.fn() (see
// src/__tests__/setup.ts). yoga-layout's wasm loader (pulled in via
// @react-pdf/renderer) checks `typeof fetch === 'function'` to decide whether
// to fetch its wasm binary over the network instead of decoding the
// pre-embedded base64 copy — the mocked fetch resolves to undefined, so its
// `.then()` chain throws. Nothing in this file needs fetch, so drop it for
// the duration of this suite to force the safe, no-network base64 path.
const originalFetch = global.fetch;
beforeAll(() => {
  // @ts-expect-error - intentionally removing the mocked global for this suite
  delete global.fetch;
});
afterAll(() => {
  global.fetch = originalFetch;
});

const sampleInvoice: InvoicePdfData = {
  number: 'INV-2026-0042',
  issuedDate: new Date('2026-03-01T00:00:00Z'),
  dueDate: new Date('2026-03-31T00:00:00Z'),
  status: 'sent',
  amountCents: 5_500_00,
  taxCents: 500_00,
  subtotalCents: 5_000_00,
  currency: 'USD',
  notes: 'Net 30. Wire transfer preferred.',
  client: {
    name: 'Acme Corp',
    email: 'billing@acme.example',
    address: '123 Main St, Springfield, IL',
  },
  lines: [
    { description: 'March consulting (20h)', quantity: 20, rateCents: 250_00, amountCents: 5_000_00 },
  ],
  company: {
    name: 'Maya Consulting',
    email: 'maya@example.com',
    address: '456 Bay St, Toronto, ON',
    phone: '+1 (555) 123-4567',
  },
};

describe('renderInvoicePdf (G-OLD-006 / PR 29)', () => {
  it('produces a real PDF buffer (starts with %PDF)', async () => {
    const buf = await renderInvoicePdf(sampleInvoice);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(500); // even minimal PDF is >500 bytes
    // PDF spec: file MUST start with %PDF-<version>
    const header = buf.subarray(0, 8).toString('utf8');
    expect(header).toMatch(/^%PDF-/);
  }, 20_000);

  it('handles invoices with no tax (taxCents undefined)', async () => {
    const noTax: InvoicePdfData = { ...sampleInvoice, taxCents: null, subtotalCents: null };
    const buf = await renderInvoicePdf(noTax);
    expect(buf.length).toBeGreaterThan(500);
  }, 20_000);

  it('handles invoices with no notes', async () => {
    const noNotes: InvoicePdfData = { ...sampleInvoice, notes: null };
    const buf = await renderInvoicePdf(noNotes);
    expect(buf.length).toBeGreaterThan(500);
  }, 20_000);

  it('handles multi-line invoices', async () => {
    const multi: InvoicePdfData = {
      ...sampleInvoice,
      lines: [
        { description: 'Design discovery', quantity: 8, rateCents: 200_00, amountCents: 1_600_00 },
        { description: 'Prototype iteration', quantity: 12, rateCents: 200_00, amountCents: 2_400_00 },
        { description: 'Stakeholder presentation', quantity: 5, rateCents: 250_00, amountCents: 1_250_00 },
      ],
      amountCents: 5_250_00,
      subtotalCents: 5_250_00,
      taxCents: 0,
    };
    const buf = await renderInvoicePdf(multi);
    expect(buf.length).toBeGreaterThan(500);
  }, 20_000);

  it('handles non-USD currencies', async () => {
    for (const currency of ['CAD', 'GBP', 'EUR', 'AUD']) {
      const inv: InvoicePdfData = { ...sampleInvoice, currency };
      const buf = await renderInvoicePdf(inv);
      expect(buf.length).toBeGreaterThan(500);
    }
  }, 30_000);
});
