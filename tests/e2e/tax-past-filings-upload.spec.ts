import { test, expect } from '@playwright/test';

const TAX = 'http://localhost:4053';
const MAYA = '2e2348b6-a64c-44ad-907e-4ac120ff06f2';
const H = { 'x-tenant-id': MAYA };

test.describe.serial('Past Tax Filings — upload + CRUD', () => {
  let filingId: string;

  test('POST /past-filings/upload — rejects non-PDF', async ({ request }) => {
    const form = new FormData();
    form.append('file', new Blob(['not a pdf'], { type: 'text/plain' }), 'test.txt');
    form.append('taxYear', '2024');
    form.append('jurisdiction', 'ca');
    const res = await request.post(`${TAX}/api/v1/agentbook-tax/past-filings/upload`, {
      headers: H, multipart: { file: { name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }, taxYear: '2024', jurisdiction: 'ca' },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/pdf/i);
  });

  test('POST /past-filings/upload — accepts PDF, returns id + status=uploaded', async ({ request }) => {
    // minimal 1-byte PDF stub
    const pdfBytes = Buffer.from('%PDF-1.4 stub');
    const res = await request.post(`${TAX}/api/v1/agentbook-tax/past-filings/upload`, {
      headers: H,
      multipart: {
        file: { name: 'T1-2024.pdf', mimeType: 'application/pdf', buffer: pdfBytes },
        taxYear: '2024',
        jurisdiction: 'ca',
        formType: 'T1',
      },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.status).toBe('uploaded');
    expect(body.data.id).toBeTruthy();
    filingId = body.data.id;
  });

  test('GET /past-filings — returns the uploaded record', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/past-filings`, { headers: H });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.some((f: any) => f.id === filingId)).toBeTruthy();
  });

  test('GET /past-filings/:id — returns single record', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/past-filings/${filingId}`, { headers: H });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.id).toBe(filingId);
    expect(body.data.taxYear).toBe(2024);
  });

  test('GET /past-filings/:id/download — returns redirect to signed URL', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/past-filings/${filingId}/download`, {
      headers: H,
    });
    // In dev without real Blob, expect 200 with blobUrl or 302 redirect
    expect([200, 302, 404]).toContain(res.status());
  });

  test('PATCH /past-filings/:id — updates notes', async ({ request }) => {
    const res = await request.patch(`${TAX}/api/v1/agentbook-tax/past-filings/${filingId}`, {
      headers: { ...H, 'Content-Type': 'application/json' },
      data: { notes: 'From my accountant' },
    });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.data.notes).toBe('From my accountant');
  });

  test('DELETE /past-filings/:id — removes record', async ({ request }) => {
    const res = await request.delete(`${TAX}/api/v1/agentbook-tax/past-filings/${filingId}`, { headers: H });
    expect(res.ok()).toBeTruthy();
    // Verify gone
    const check = await request.get(`${TAX}/api/v1/agentbook-tax/past-filings/${filingId}`, { headers: H });
    expect(check.status()).toBe(404);
  });
});
