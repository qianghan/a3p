import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const findUnique = vi.fn();
const update = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: { abInvoice: { findUnique: (...a: unknown[]) => findUnique(...a), update: (...a: unknown[]) => update(...a) } },
}));

import { GET } from '@/app/api/v1/agentbook-invoice/invoices/[id]/public/route';

function req(): NextRequest { return new NextRequest('http://x/api/v1/agentbook-invoice/invoices/inv1/public'); }
function ctx(id = 'inv1') { return { params: Promise.resolve({ id }) }; }

beforeEach(() => { vi.clearAllMocks(); update.mockResolvedValue({}); });

describe('GET /invoices/:id/public', () => {
  it('returns public presentation data for a sent invoice and marks it viewed', async () => {
    findUnique.mockResolvedValue({
      id: 'inv1', number: 'INV-1', amountCents: 1000, currency: 'CAD',
      createdAt: new Date('2026-07-01'), dueDate: new Date('2026-08-01'), status: 'sent',
      client: { name: 'Acme' },
      lines: [{ description: 'Consulting', quantity: 2, rateCents: 500, amountCents: 1000 }],
    });
    const res = await GET(req(), ctx());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.number).toBe('INV-1');
    expect(body.data.currency).toBe('CAD');
    expect(body.data.status).toBe('viewed');
    expect(body.data.clientName).toBe('Acme');
    expect(body.data.lines).toHaveLength(1);
    expect(update).toHaveBeenCalled();
  });

  it('404s a draft invoice (never exposed publicly)', async () => {
    findUnique.mockResolvedValue({ id: 'inv1', status: 'draft', client: {}, lines: [] });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
    expect(update).not.toHaveBeenCalled();
  });

  it('404s a voided invoice', async () => {
    findUnique.mockResolvedValue({ id: 'inv1', status: 'void', client: {}, lines: [] });
    expect((await GET(req(), ctx())).status).toBe(404);
  });

  it('404s a non-existent invoice', async () => {
    findUnique.mockResolvedValue(null);
    expect((await GET(req(), ctx())).status).toBe(404);
  });
});
