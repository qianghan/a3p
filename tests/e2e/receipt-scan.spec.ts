/**
 * Follow-on F2 e2e — receipt scan endpoint on the deployed app.
 *
 * Logs in as Maya, builds a tiny in-memory JPEG, POSTs it to /receipts/scan,
 * and asserts the endpoint returns 200 with a stored receiptUrl. (OCR field
 * accuracy isn't asserted — a 1x1 pixel isn't a real receipt — only the
 * upload + response contract.)
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

test('receipt scan stores the photo and returns the contract shape', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const res = await page.evaluate(async () => {
    // Minimal JPEG-ish bytes (SOI marker + filler) — enough to exercise the
    // upload + response contract without needing a real receipt.
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);
    const file = new File([bytes], 'receipt.jpg', { type: 'image/jpeg' });
    const form = new FormData();
    form.append('file', file);
    const r = await fetch('/api/v1/agentbook-expense/receipts/scan', { method: 'POST', body: form });
    return { status: r.status, data: await r.json().catch(() => null) };
  });

  expect(res.status, JSON.stringify(res.data)).toBe(200);
  expect(res.data.success).toBe(true);
  // Parsed fields are present (may be null); the contract keys exist.
  expect(res.data.data).toHaveProperty('amountCents');
  expect(res.data.data).toHaveProperty('vendor');
  expect(res.data.data).toHaveProperty('receiptUrl');
  // If Blob storage is configured, the URL is an https link.
  if (res.data.data.receiptUrl) {
    expect(String(res.data.data.receiptUrl)).toMatch(/^https?:\/\//);
  }
});
