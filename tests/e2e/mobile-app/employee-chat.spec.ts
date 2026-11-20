import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { catalogT, loginAs, loginUnavailableReason, newPersonaContext } from './helpers';
import { runTag, type Persona } from './fixtures';
import { api } from '../nightly/helpers/api';

/**
 * PR 4e (R-EMP-5) — employee / pay-frequency chat on a DEPLOYED site.
 *
 * Per market: create a TAGGED biweekly employee, ask chat for its pay frequency via
 * POST /api/v1/agentbook-core/agent/message and require the market label (Fortnightly in AU, Bi-weekly in
 * US/CA — in whichever of en/fr-CA/zh-CN the reply came back in; the other market's label must be absent);
 * then ask to change it to weekly, confirm the plan card, and verify with GET employees/[id]; then change
 * the rate and require the "next draft pay run" note; finally a typed SSN-shaped value is refused and does
 * not come back in the reply. The LLM is real on prod, so each exchange loops until a TERMINAL reply
 * (no pending plan) instead of scripting a turn count. No pay run is generated (prod runs are not
 * reversible); only the tagged employee is touched and afterAll deletes it.
 */
test.describe.configure({ mode: 'serial' });

const PAYROLL = '/api/v1/agentbook-payroll';
const CHAT = '/api/v1/agentbook-core/agent/message';
const LOCALES = ['en', 'fr-CA', 'zh-CN'];
const label = (key: string) => LOCALES.map((l) => catalogT(l)(key));
const MARKETS: Array<{ persona: Exclude<Persona, 'fresh'>; jurisdiction: 'ca' | 'us' | 'au'; want: string; notWant: string }> = [
  { persona: 'maya', jurisdiction: 'ca', want: 'agent.bi_weekly', notWant: 'agent.fortnightly' },
  { persona: 'alex', jurisdiction: 'us', want: 'agent.bi_weekly', notWant: 'agent.fortnightly' },
  { persona: 'sydney', jurisdiction: 'au', want: 'agent.fortnightly', notWant: 'agent.bi_weekly' },
];

interface Reply { message: string; skillUsed?: string; plan?: { requiresConfirmation?: boolean } }

async function say(page: Page, body: Record<string, unknown>): Promise<Reply> {
  const res = await api(page).post(CHAT, { channel: 'web', ...body });
  expect(res.status, `chat ${JSON.stringify(body).slice(0, 60)}`).toBe(200);
  return (res.data as { data: Reply }).data;
}

/** Send, then confirm any plan card, until a reply with no pending confirmation (max 5 turns). */
async function untilTerminal(page: Page, text: string): Promise<Reply[]> {
  const turns: Reply[] = [await say(page, { text })];
  while (turns.length < 5 && turns[turns.length - 1].plan?.requiresConfirmation) {
    turns.push(await say(page, { sessionAction: 'confirm', text: 'yes' }));
  }
  expect(turns[turns.length - 1].plan?.requiresConfirmation ?? false, 'reached a terminal reply').toBe(false);
  return turns;
}

for (const m of MARKETS) {
  test.describe(`employee chat — ${m.persona} (${m.jurisdiction})`, () => {
    const tag = runTag('E2EEMPCHAT');
    const name = `${tag} Chatworker`;
    let context: BrowserContext | undefined;
    let page: Page;
    let id = '';

    test.beforeAll(async ({ browser }, testInfo) => {
      const reason = loginUnavailableReason(testInfo.project.use.baseURL);
      expect(reason, reason ?? '').toBeNull();
      context = await newPersonaContext(browser, testInfo.project.use.baseURL);
      page = await context.newPage();
      await loginAs(page, m.persona);
      await page.goto('/app/capture');
      const res = await api(page).post(`${PAYROLL}/employees`, {
        name, payRateCents: 5_200_000, payType: 'salary', payFrequency: 'biweekly', jurisdiction: m.jurisdiction,
      });
      expect(res.status, 'create employee').toBe(201);
      id = (res.data as { data: { id: string } }).data.id;
    });

    test.afterAll(async () => {
      if (!context) return;
      try {
        if (id) {
          expect([200, 404]).toContain((await api(page).delete(`${PAYROLL}/employees/${id}`)).status);
          expect((await api(page).get(`${PAYROLL}/employees/${id}`)).status, 'tagged employee removed').toBe(404);
        }
      } finally { await context.close(); }
    });

    test('asks the pay frequency → market label', async () => {
      const turns = await untilTerminal(page, `What is ${name}'s pay frequency?`);
      const msg = turns[turns.length - 1].message;
      expect(msg).toContain(name);
      expect(label(m.want).some((l) => msg.includes(l)), `one of ${label(m.want).join(' | ')} in: ${msg}`).toBe(true);
      for (const wrong of label(m.notWant)) if (!label(m.want).includes(wrong)) expect(msg).not.toContain(wrong);
    });

    test('changes the frequency after confirm, verified via GET', async () => {
      const turns = await untilTerminal(page, `Change ${name} to weekly`);
      expect(turns.some((r) => r.plan?.requiresConfirmation), 'a plan card was shown before the write').toBe(true);
      const got = await api(page).get(`${PAYROLL}/employees/${id}`);
      expect(got.status).toBe(200);
      expect((got.data as { data: { payFrequency: string } }).data.payFrequency).toBe('weekly');
    });

    test('rate change applies from the next draft (says so)', async () => {
      const turns = await untilTerminal(page, `Set ${name}'s rate to $60k`);
      const msg = turns[turns.length - 1].message;
      expect(label('agent.employee_next_draft_note').some((l) => msg.includes(l)), msg).toBe(true);
      const got = await api(page).get(`${PAYROLL}/employees/${id}`);
      expect((got.data as { data: { payRateCents: number } }).data.payRateCents).toBe(6_000_000);
    });

    test('a typed SSN is refused and not echoed', async () => {
      const r = await say(page, { text: `${name}'s SSN is 219-09-9999` });
      expect(r.skillUsed).toBe('sensitive-refused');
      expect(r.message).not.toContain('219-09-9999');
      expect(r.message.replace(/\D/g, '')).not.toContain('219099999');
    });
  });
}
