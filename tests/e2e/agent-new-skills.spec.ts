/**
 * Follow-on F1 e2e — the new agent skills answer via chat on the deployed app.
 *
 * Logs in as Maya, then sends each question to the agent /message endpoint
 * and asserts it returns 200 with a non-empty reply routed to the right skill.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const PASSWORD = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

function reply(data: any): string {
  if (!data) return '';
  return data.data?.message || data.message || data.reply || data.text || data.answer || '';
}
function skillOf(data: any): string {
  return data?.data?.skillUsed || data?.skillUsed || '';
}

async function ask(page: import('@playwright/test').Page, text: string) {
  return page.evaluate(async (t) => {
    const r = await fetch('/api/v1/agentbook-core/agent/message', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: t }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, text);
}

test('new agent skills answer via chat', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/login');
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/dashboard|\/agentbook|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  const cases: { q: string; skill: string }[] = [
    { q: "what's my net worth?", skill: 'personal-snapshot' },
    { q: 'what bills are due?', skill: 'manage-bills' },
    { q: 'who is on payroll?', skill: 'payroll-status' },
    { q: 'review my books', skill: 'cpa-review' },
  ];

  for (const c of cases) {
    const res = await ask(page, c.q);
    expect(res.status, `${c.q} → ${JSON.stringify(res.data)?.slice(0, 200)}`).toBe(200);
    expect(reply(res.data).length, `reply for "${c.q}"`).toBeGreaterThan(0);
    expect(skillOf(res.data), `skill for "${c.q}" got ${JSON.stringify(res.data?.data?.message)?.slice(0, 120)}`).toBe(c.skill);
  }
});
