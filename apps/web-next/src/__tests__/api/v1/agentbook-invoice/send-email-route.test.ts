import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const safeResolve = vi.fn();
const sendNotificationEmail = vi.fn();
const invoiceFindFirst = vi.fn();
const invoiceUpdate = vi.fn();
const eventCreate = vi.fn();

// Real InvoicePayLinkError class so the route's `instanceof` check works.
const { InvoicePayLinkError, createInvoicePayLink } = vi.hoisted(() => {
  class InvoicePayLinkError extends Error {}
  return { InvoicePayLinkError, createInvoicePayLink: vi.fn() };
});

vi.mock('@/lib/agentbook-tenant', () => ({ safeResolveAgentbookTenant: (...a: unknown[]) => safeResolve(...a) }));
vi.mock('@/lib/email', () => ({ sendNotificationEmail: (...a: unknown[]) => sendNotificationEmail(...a) }));
vi.mock('@/lib/agentbook-config', () => ({ getAppBaseUrl: () => 'https://agentbook.brainliber.com' }));
vi.mock('@/lib/agentbook-audit', () => ({ audit: vi.fn(async () => {}) }));
vi.mock('@/lib/agentbook-audit-context', () => ({ inferSource: () => 'web', inferActor: async () => 'user' }));
vi.mock('@/lib/invoice-connect', () => ({ createInvoicePayLink, InvoicePayLinkError }));
vi.mock('@naap/database', () => ({
  prisma: {
    abInvoice: { findFirst: (...a: unknown[]) => invoiceFindFirst(...a) },
    $transaction: async (fn: (tx: unknown) => unknown) =>
      fn({ abInvoice: { update: (...a: unknown[]) => invoiceUpdate(...a) }, abEvent: { create: (...a: unknown[]) => eventCreate(...a) } }),
  },
}));

import { POST } from '@/app/api/v1/agentbook-invoice/invoices/[id]/send/route';

function req(): NextRequest { return new NextRequest('http://x/api/v1/agentbook-invoice/invoices/inv1/send', { method: 'POST' }); }
function ctx(id = 'inv1') { return { params: Promise.resolve({ id }) }; }

beforeEach(() => {
  vi.clearAllMocks();
  safeResolve.mockResolvedValue({ tenantId: 't1' });
  invoiceUpdate.mockResolvedValue({ id: 'inv1', status: 'sent', number: 'INV-1' });
  eventCreate.mockResolvedValue({});
  sendNotificationEmail.mockResolvedValue({ success: true });
  createInvoicePayLink.mockResolvedValue('https://checkout.stripe.com/x');
});

describe('POST /invoices/:id/send — client email', () => {
  it('emails the client a pay link and reports emailSent=true', async () => {
    invoiceFindFirst.mockResolvedValue({ id: 'inv1', tenantId: 't1', status: 'draft', number: 'INV-1', amountCents: 484000, currency: 'AUD', dueDate: new Date('2026-08-01'), client: { email: 'client@x.com', name: 'Acme' } });
    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.emailSent).toBe(true);
    expect(sendNotificationEmail).toHaveBeenCalledWith('client@x.com', expect.objectContaining({ ctaUrl: 'https://agentbook.brainliber.com/pay/inv1' }));
  });

  it('still transitions to sent but emailSent=false when the client has no email', async () => {
    invoiceFindFirst.mockResolvedValue({ id: 'inv1', tenantId: 't1', status: 'draft', number: 'INV-1', amountCents: 1000, currency: 'USD', dueDate: new Date('2026-08-01'), client: { email: null } });
    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.emailSent).toBe(false);
    expect(sendNotificationEmail).not.toHaveBeenCalled();
  });

  it('does not fail the send when email delivery errors', async () => {
    invoiceFindFirst.mockResolvedValue({ id: 'inv1', tenantId: 't1', status: 'draft', number: 'INV-1', amountCents: 1000, currency: 'USD', dueDate: new Date('2026-08-01'), client: { email: 'c@x.com' } });
    sendNotificationEmail.mockResolvedValue({ success: false, error: 'no key' });
    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.emailSent).toBe(false);
  });

  it('rejects a voided invoice (422)', async () => {
    invoiceFindFirst.mockResolvedValue({ id: 'inv1', tenantId: 't1', status: 'void', client: {} });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(422);
  });

  it('attaches a card pay-link and reports payLinkAttached=true when Connect is ready', async () => {
    invoiceFindFirst.mockResolvedValue({ id: 'inv1', tenantId: 't1', status: 'draft', number: 'INV-1', amountCents: 1000, currency: 'USD', dueDate: new Date('2026-08-01'), client: { email: 'c@x.com' } });
    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.payLinkAttached).toBe(true);
    expect(createInvoicePayLink).toHaveBeenCalledWith('inv1', 't1', 'https://agentbook.brainliber.com');
  });

  it('still sends (payLinkAttached=false) when the tenant has no Connect account', async () => {
    invoiceFindFirst.mockResolvedValue({ id: 'inv1', tenantId: 't1', status: 'draft', number: 'INV-1', amountCents: 1000, currency: 'USD', dueDate: new Date('2026-08-01'), client: { email: 'c@x.com' } });
    createInvoicePayLink.mockRejectedValue(new InvoicePayLinkError('Connect a payout account first.'));
    const res = await POST(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.payLinkAttached).toBe(false);
    expect(body.emailSent).toBe(true); // email still goes out
  });
});
