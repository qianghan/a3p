import { test, expect } from '@playwright/test';

const TAX = 'http://localhost:4053';
const MAYA = '2e2348b6-a64c-44ad-907e-4ac120ff06f2';
const H = { 'x-tenant-id': MAYA, 'Content-Type': 'application/json' };

test.describe('Past Tax Filings — pre-fill', () => {
  test('GET /past-filings/prefill?year=2025 returns array', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/past-filings/prefill?year=2025`, { headers: H });
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(Array.isArray(body.data)).toBeTruthy();
    // If confirmed 2024 filings exist, data has suggestions; otherwise empty — both acceptable
  });

  test('prefill suggestions have required shape', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/past-filings/prefill?year=2025`, { headers: H });
    const body = await res.json();
    for (const s of body.data) {
      expect(s).toHaveProperty('fieldId');
      expect(s).toHaveProperty('value');
      expect(s).toHaveProperty('sourceField');
      expect(s).toHaveProperty('confidence');
    }
  });

  test('prefill does not duplicate fieldIds', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/past-filings/prefill?year=2025`, { headers: H });
    const suggestions = (await res.json()).data;
    const ids = suggestions.map((s: any) => s.fieldId);
    expect(ids.length).toBe(new Set(ids).size);
  });

  test('regression: existing tax-filing populate still works', async ({ request }) => {
    const res = await request.get(`${TAX}/api/v1/agentbook-tax/tax-filing/2025`, { headers: H });
    expect(res.ok()).toBeTruthy();
    expect((await res.json()).success).toBe(true);
  });
});
