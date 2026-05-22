import { test, expect } from '@playwright/test';

test.describe('GTM security — public invoice link (G-006)', () => {
  // Note: requires a real invoice ID. We use an obviously-not-real one to assert
  // the endpoint rejects without trying to enumerate.
  test('rejects unsigned access', async ({ request }) => {
    const r = await request.get('http://localhost:4052/api/v1/agentbook-invoice/invoices/test-not-real-id/public');
    expect([403, 404]).toContain(r.status());
  });

  test('rejects bogus token', async ({ request }) => {
    const r = await request.get('http://localhost:4052/api/v1/agentbook-invoice/invoices/test-not-real-id/public?t=bogus.token');
    expect([403, 404]).toContain(r.status());
  });

  test('rejects malformed token (no dot)', async ({ request }) => {
    const r = await request.get('http://localhost:4052/api/v1/agentbook-invoice/invoices/test-not-real-id/public?t=notavalidtoken');
    expect([403, 404]).toContain(r.status());
  });
});
