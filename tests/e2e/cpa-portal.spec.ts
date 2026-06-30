/**
 * Follow-on F5 e2e — CPA human portal on the deployed app.
 *
 * As Maya: invite a named CPA → get a magic-link token. In a fresh
 * unauthenticated context, open the portal, request a document. Back as
 * Maya, see the open request and fulfill it; the portal then shows it fulfilled.
 */

import { test, expect, chromium } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function api(page: import('@playwright/test').Page, method: string, path: string, body?: unknown) {
  return page.evaluate(async ({ m, p, b }) => {
    const r = await fetch(p, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { m: method, p: path, b: body });
}

test('CPA invite → portal request → owner fulfill', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  // Owner invites a named CPA.
  const invite = await api(page, 'POST', '/api/v1/agentbook-cpa/invite', { cpaEmail: 'e2e-cpa@example.com', cpaName: 'E2E CPA' });
  expect(invite.status, JSON.stringify(invite.data)).toBe(201);
  const token = invite.data.data.token as string;

  // --- CPA side: fresh unauthenticated context ---
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ baseURL: BASE });
  const guest = await ctx.newPage();
  let requestId = '';
  try {
    await guest.goto(`/cpa-portal/${token}`);
    await guest.waitForTimeout(1_000);
    const portal = await api(guest, 'GET', `/api/v1/agentbook-cpa/portal/${token}`);
    expect(portal.status, JSON.stringify(portal.data)).toBe(200);
    expect(portal.data.data.pnl).toBeTruthy();

    const reqRes = await api(guest, 'POST', `/api/v1/agentbook-cpa/portal/${token}/document-request`, {
      description: 'Receipt for the $1,200 AWS charge in March',
    });
    expect(reqRes.status).toBe(201);
    requestId = reqRes.data.data.id;
  } finally {
    await browser.close();
  }

  // Owner sees the open request and fulfills it.
  const open = await api(page, 'GET', '/api/v1/agentbook-cpa/document-requests?status=open');
  expect(open.status).toBe(200);
  expect(open.data.data.some((d: any) => d.id === requestId)).toBe(true);

  const fulfill = await api(page, 'POST', '/api/v1/agentbook-cpa/document-requests', {
    id: requestId, url: 'https://example.com/receipts/aws-march.pdf',
  });
  expect(fulfill.status).toBe(200);
  expect(fulfill.data.data.status).toBe('fulfilled');
});
