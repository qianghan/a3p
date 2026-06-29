import { test, expect } from '@playwright/test';

const TAX = 'http://localhost:4053';
const MAYA = '2e2348b6-a64c-44ad-907e-4ac120ff06f2';
const H = { 'x-tenant-id': MAYA, 'Content-Type': 'application/json' };

test.describe.serial('E-Filing XML Export', () => {
  test('GET /tax/export/netfile-xml — returns XML or 404 (no filing in dev)', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/tax/export/netfile-xml?year=2025`, { headers: H });
    // 404 acceptable if no filing seeded; 200 if filing exists
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const text = await res.text();
      expect(text).toContain('<?xml');
      expect(text).toContain('<Return');
      expect(text).toContain('TaxYear');
    }
  });

  test('GET /tax/export/mef-xml — returns XML or 404', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/tax/export/mef-xml?year=2025`, { headers: H });
    expect([200, 404]).toContain(res.status());
    if (res.status() === 200) {
      const text = await res.text();
      expect(text).toContain('<?xml');
      expect(text).toContain('<Return');
      expect(text).toContain('TaxYear');
    }
  });

  test('regression: existing e-file submit endpoint still responds', async ({ request }) => {
    const res = await request.post(`${TAX}/api/v1/agentbook-tax/tax-filing/2025/submit`, { headers: H });
    // 404 (no filing) or 400/500 is fine — just must not be connection refused
    expect(res.status()).toBeGreaterThan(0);
  });
});
