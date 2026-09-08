import { test, expect } from '@playwright/test';

const TAX = 'http://localhost:4053';
const MAYA = '2e2348b6-a64c-44ad-907e-4ac120ff06f2';
const H = { 'x-tenant-id': MAYA, 'Content-Type': 'application/json' };

/**
 * This file used to test `netfile-xml` and `mef-xml`, which emitted files named
 * for agency submission formats under invented XML namespaces, with every
 * monetary value zero. It asserted `<?xml`, `<Return` and `TaxYear` — all of
 * which the broken output contained — and never once asserted an amount. The
 * shape was checked; the content was not. That is why the bug survived.
 *
 * The assertions below are about content: the disclaimer that has to travel
 * inside the file, and the absence of anything claiming to be a submission.
 */
test.describe.serial('Filing worksheet export', () => {
  test('GET /tax/export/worksheet — CSV, or a reason it cannot be produced', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/tax/export/worksheet?year=2025`, { headers: H });
    // 404: no filing seeded in dev. 422: a filing exists but fails validation
    // (e.g. no SIN captured), which is a real answer carrying the reasons.
    expect([200, 404, 422]).toContain(res.status());

    if (res.status() === 422) {
      const body = await res.json();
      expect(body.success).toBe(false);
      // The reasons are the actionable part — a bare 422 helps nobody.
      expect(body.error).toBeTruthy();
      return;
    }
    if (res.status() !== 200) return;

    expect(res.headers()['content-type']).toContain('text/csv');
    // A tax worksheet is per-tenant and must never sit in a shared cache.
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(res.headers()['content-disposition']).toContain('agentbook-worksheet-');
    expect(res.headers()['content-disposition']).not.toMatch(/mef|netfile/i);

    const text = await res.text();
    expect(text.split('\n')[0]).toBe('Form,Line,Description,Amount,Currency');

    // The disclaimer has to be IN the file, because the file is what gets
    // forwarded to an accountant — a note on the download page does not travel.
    expect(text).toContain('not an authorised e-file');
    expect(text.toLowerCase()).toContain('worksheet');

    // Nothing may present itself as an agency submission.
    expect(text).not.toMatch(/urn:(us:treasury|cra-arc)/i);
    expect(text).not.toMatch(/<\?xml/);
  });

  test('the retired XML endpoints are gone', async ({ request }) => {
    for (const path of ['netfile-xml', 'mef-xml']) {
      const res = await request.get(`${TAX}/api/v1/agentbook-tax/tax/export/${path}?year=2025`, { headers: H });
      expect(res.status(), `${path} should no longer route`).toBe(404);
    }
  });

  test('regression: the e-file submit endpoint still responds', async ({ request }) => {
    const res = await request.post(`${TAX}/api/v1/agentbook-tax/tax-filing/2025/submit`, { headers: H });
    // Was `expect(res.status()).toBeGreaterThan(0)`, which no response can
    // fail. A connection refusal throws before this line, so assert the shape
    // of the answers this endpoint is actually allowed to give.
    expect([200, 400, 404, 409, 422, 500]).toContain(res.status());
  });
});
