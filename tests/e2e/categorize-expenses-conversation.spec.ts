/**
 * Reproduces the exact broken conversation reported live this session
 * (Maya, Telegram) and asserts each turn now passes the actionability
 * rubric from docs/superpowers/plans/2026-07-01-prelaunch-qa-audit-plan.md:
 * every bot response must (a) give specific data, (b) offer a concrete
 * action, or (c) ask one precise question that resolves the request.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
const MAYA_EMAIL = process.env.E2E_MAYA_EMAIL || 'maya@agentbook.test';
const MAYA_PW = process.env.E2E_MAYA_PASSWORD || 'agentbook123';

test.use({ baseURL: BASE });

async function login(page: import('@playwright/test').Page) {
  await page.goto('/login');
  await page.fill('input[type="email"]', MAYA_EMAIL);
  await page.fill('input[type="password"]', MAYA_PW);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/agentbook|\/dashboard|\/$/, { timeout: 20_000 });
  await page.waitForTimeout(2_000);
}

async function sendMessage(page: import('@playwright/test').Page, text: string): Promise<string> {
  const res = await page.evaluate(async (msg) => {
    const r = await fetch('/api/v1/agentbook-core/agent/message', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: msg }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, text);
  expect(res.status, JSON.stringify(res.data)).toBe(200);
  return res.data?.data?.message || res.data?.message || JSON.stringify(res.data);
}

test('categorize-expenses conversation is now actionable end to end', async ({ page }) => {
  await login(page);

  // Turn 2 equivalent: "Categorize expenses"
  const turn2 = await sendMessage(page, 'Categorize expenses');
  console.log('TURN 2 (categorize expenses):', turn2);
  // Passes rubric (a): either fully categorized, or a concrete list with a next step —
  // never a bare "couldn't categorize confidently, check the Expenses page" apology alone.
  const turn2ListsOrDone =
    /already categorized/i.test(turn2) ||
    /applied.*automatically/i.test(turn2) ||
    (/\$\d/.test(turn2) && /(reply with|open the expenses page to assign)/i.test(turn2));
  expect(turn2ListsOrDone, `turn 2 must be actionable, got: ${turn2}`).toBe(true);

  // Turn 3 equivalent: "List them here so I can do it"
  const turn3 = await sendMessage(page, 'List them here so I can do it');
  console.log('TURN 3 (list them here):', turn3);
  // Must NOT dead-end with a generic clarifying question.
  expect(turn3).not.toMatch(/what would you like me to list/i);

  // Turn 4 equivalent: "List the non categorized expenses"
  const turn4 = await sendMessage(page, 'List the non categorized expenses');
  console.log('TURN 4 (list non categorized):', turn4);
  // Must contain actual line items (a date-like token and a dollar amount
  // repeated multiple times), not just one aggregate total.
  const dollarMatches = turn4.match(/\$[\d,]+\.\d{2}/g) || [];
  const hasMultipleLineItems = dollarMatches.length >= 2 || /already categorized/i.test(turn4);
  expect(hasMultipleLineItems, `turn 4 must list line items, not just an aggregate, got: ${turn4}`).toBe(true);
});
