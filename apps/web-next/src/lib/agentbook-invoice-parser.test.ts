/**
 * Unit tests for the invoice NL parser. We exercise the regex fallback
 * directly so the suite can run offline; the Gemini path is integration-
 * tested elsewhere.
 */

import { describe, expect, it, vi } from 'vitest';
// Stub `server-only` so the parser can be loaded in a vitest environment.
vi.mock('server-only', () => ({}));
import { parseInvoiceWithRegex } from './agentbook-invoice-parser';

describe('parseInvoiceWithRegex', () => {
  it('parses a simple single-line invoice', () => {
    const result = parseInvoiceWithRegex('invoice Acme $5000 for July consulting');
    expect(result).not.toBeNull();
    expect(result?.clientNameHint).toBe('Acme');
    expect(result?.amountCents).toBe(500000);
    expect(result?.lines).toHaveLength(1);
    expect(result?.lines[0]).toMatchObject({
      description: 'July consulting',
      rateCents: 500000,
      quantity: 1,
    });
    expect(result?.dueDateHint).toBe('net-30');
    expect(result?.currencyHint).toBe('USD');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('handles the K suffix', () => {
    const result = parseInvoiceWithRegex('invoice Acme $5K for July consulting');
    expect(result).not.toBeNull();
    expect(result?.amountCents).toBe(500000);
    expect(result?.lines[0].rateCents).toBe(500000);
  });

  it('parses a multi-line invoice separated by commas', () => {
    const result = parseInvoiceWithRegex('invoice Acme $5K consulting, $1K hosting');
    expect(result).not.toBeNull();
    expect(result?.clientNameHint).toBe('Acme');
    expect(result?.lines).toHaveLength(2);
    expect(result?.lines[0]).toMatchObject({ description: 'consulting', rateCents: 500000 });
    expect(result?.lines[1]).toMatchObject({ description: 'hosting', rateCents: 100000 });
    expect(result?.amountCents).toBe(600000);
  });

  it('parses a multi-line invoice with "and"', () => {
    const result = parseInvoiceWithRegex('invoice TechCorp $3000 for design and $500 for hosting');
    expect(result).not.toBeNull();
    expect(result?.clientNameHint).toBe('TechCorp');
    expect(result?.lines).toHaveLength(2);
    expect(result?.amountCents).toBe(350000);
  });

  it('handles "bill" verb and multi-word client names', () => {
    const result = parseInvoiceWithRegex("bill Acme Corp $2,500 for retainer");
    expect(result).not.toBeNull();
    expect(result?.clientNameHint).toBe('Acme Corp');
    expect(result?.amountCents).toBe(250000);
  });

  it('returns null when the message does not start with an invoice trigger', () => {
    expect(parseInvoiceWithRegex('hi there')).toBeNull();
    expect(parseInvoiceWithRegex('spent $50 on lunch')).toBeNull();
    expect(parseInvoiceWithRegex('show my invoices')).toBeNull();
  });

  it('returns null when the trigger is present but no amount is given', () => {
    expect(parseInvoiceWithRegex('invoice Acme for some consulting')).toBeNull();
  });

  it('returns null when the client name is missing', () => {
    expect(parseInvoiceWithRegex('invoice $5000 for consulting')).toBeNull();
  });
});
