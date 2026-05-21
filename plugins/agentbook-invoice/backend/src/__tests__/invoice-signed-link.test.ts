import { describe, it, expect } from 'vitest';
import { signInvoiceLink, verifyInvoiceLink } from '../invoice-signed-link';

describe('invoice-signed-link', () => {
  const invoiceId = 'inv_abc123';
  const tenantId = 'tenant_x';

  it('signs and verifies a valid token', () => {
    const token = signInvoiceLink(invoiceId, tenantId);
    expect(verifyInvoiceLink(invoiceId, tenantId, token)).toBe(true);
  });

  it('rejects a token signed for a different invoice', () => {
    const token = signInvoiceLink(invoiceId, tenantId);
    expect(verifyInvoiceLink('different_invoice', tenantId, token)).toBe(false);
  });

  it('rejects a token signed for a different tenant', () => {
    const token = signInvoiceLink(invoiceId, tenantId);
    expect(verifyInvoiceLink(invoiceId, 'different_tenant', token)).toBe(false);
  });

  it('rejects an empty token', () => {
    expect(verifyInvoiceLink(invoiceId, tenantId, '')).toBe(false);
    expect(verifyInvoiceLink(invoiceId, tenantId, null)).toBe(false);
    expect(verifyInvoiceLink(invoiceId, tenantId, undefined)).toBe(false);
  });

  it('rejects a malformed token', () => {
    expect(verifyInvoiceLink(invoiceId, tenantId, 'not-a-token')).toBe(false);
    expect(verifyInvoiceLink(invoiceId, tenantId, 'too.many.parts.here')).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = signInvoiceLink(invoiceId, tenantId, -1);  // already expired
    expect(verifyInvoiceLink(invoiceId, tenantId, token)).toBe(false);
  });

  it('rejects a tampered signature', () => {
    const token = signInvoiceLink(invoiceId, tenantId);
    const tampered = token.slice(0, -2) + (token.endsWith('00') ? 'ff' : '00');
    expect(verifyInvoiceLink(invoiceId, tenantId, tampered)).toBe(false);
  });
});
