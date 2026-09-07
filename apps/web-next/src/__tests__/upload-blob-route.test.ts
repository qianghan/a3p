// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('server-only', () => ({}));

const updateMany = vi.fn();
const update = vi.fn();
vi.mock('@naap/database', () => ({
  prisma: { abExpense: { updateMany: (...a: unknown[]) => updateMany(...a), update: (...a: unknown[]) => update(...a) } },
}));

const resolveTenant = vi.fn();
vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));

const put = vi.fn();
vi.mock('@vercel/blob', () => ({ put: (...a: unknown[]) => put(...a) }));

import { NextRequest } from 'next/server';

const req = (body: unknown) =>
  new NextRequest('https://app.test/api/v1/agentbook-expense/receipts/upload-blob', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('POST receipts/upload-blob', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    updateMany.mockReset().mockResolvedValue({ count: 1 });
    update.mockReset();
    put.mockReset().mockResolvedValue({ url: 'https://abc.public.blob.vercel-storage.com/receipts/t1/x.jpg' });
    resolveTenant.mockReset().mockResolvedValue({ tenantId: 't1' });
    process.env.NODE_ENV = 'production';
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-token';
  });
  afterEach(() => {
    process.env = { ...saved };
    vi.unstubAllGlobals();
  });

  it('400s on a non-storage sourceUrl WITHOUT fetching it or writing to the database', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const { POST } = await import('@/app/api/v1/agentbook-expense/receipts/upload-blob/route');

    const res = await POST(req({ sourceUrl: 'http://169.254.169.254/latest/meta-data/', expenseId: 'e1' }));

    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
    // The old code fell through and wrote the caller's own URL to receiptUrl.
    expect(updateMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it('never writes the caller-supplied URL into receiptUrl when the download fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, headers: new Headers() }));
    const { POST } = await import('@/app/api/v1/agentbook-expense/receipts/upload-blob/route');

    const res = await POST(
      req({ sourceUrl: 'https://blob.vercel-storage.com/receipts/t1/1.jpg', expenseId: 'e1' }),
    );

    expect(res.status).toBe(502);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('scopes the expense update to the caller tenant', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      }),
    );
    const { POST } = await import('@/app/api/v1/agentbook-expense/receipts/upload-blob/route');

    const res = await POST(
      req({ sourceUrl: 'https://blob.vercel-storage.com/receipts/t1/1.jpg', expenseId: 'e-other-tenant' }),
    );

    expect(res.status).toBe(200);
    // `update({ where: { id } })` would have let a caller set receiptUrl on
    // another tenant's expense.
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'e-other-tenant', tenantId: 't1' },
      data: { receiptUrl: 'https://abc.public.blob.vercel-storage.com/receipts/t1/x.jpg' },
    });
  });

  it('404s when the expense belongs to someone else, instead of silently doing nothing', async () => {
    updateMany.mockResolvedValue({ count: 0 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }),
    );
    const { POST } = await import('@/app/api/v1/agentbook-expense/receipts/upload-blob/route');
    const res = await POST(
      req({ sourceUrl: 'https://blob.vercel-storage.com/receipts/t1/1.jpg', expenseId: 'e-nope' }),
    );
    expect(res.status).toBe(404);
  });

  it('stores the public blob under a randomised name', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      }),
    );
    const { POST } = await import('@/app/api/v1/agentbook-expense/receipts/upload-blob/route');
    await POST(req({ sourceUrl: 'https://blob.vercel-storage.com/receipts/t1/1.jpg' }));

    // Public blob + `receipts/<tenantId>/<Date.now()>.jpg` was guessable.
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^receipts\/t1\/\d+\.jpg$/),
      expect.anything(),
      expect.objectContaining({ access: 'public', addRandomSuffix: true }),
    );
  });
});
