import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { loginAs, loginUnavailableReason, newPersonaContext } from './helpers';
import { runTag, type Persona } from './fixtures';
import { api } from '../nightly/helpers/api';

/**
 * PR 4b — employee API + privacy, proved on a DEPLOYED site for each market.
 *
 * Every persona creates one TAGGED employee through the existing POST employees route, then: GET is masked
 * (no ciphertext, only last4/flags), a non-sensitive PUT lands, an unknown key is a 400, and a sensitive PUT is
 * checked in whichever state the server is in. EMPLOYEE_PII_ENCRYPTION_KEY may or may not be set on the target:
 *   - unconfigured: PUT answers 503 pii_key_unconfigured and NOTHING is stored (GET shows no last4, reveal is 404/503);
 *   - configured:   masked GET shows last4, reveal returns the full value (twice), the list never carries it.
 * Both branches always assert something; nothing is skipped. A cross-tenant GET (maya's id from alex) is a 404.
 * Fixtures are deleted in afterAll and the test asserts nothing tagged remains in the active list.
 * The real values below are syntactically valid test numbers, not anyone's identifiers.
 */
test.describe.configure({ mode: 'serial' });

const PAYROLL = '/api/v1/agentbook-payroll';

interface Market { persona: Exclude<Persona, 'fresh'>; jurisdiction: 'ca' | 'us' | 'au'; taxId: string; bank: string; routing: string }
const MARKETS: Market[] = [
  { persona: 'maya', jurisdiction: 'ca', taxId: '046454286', bank: '1234567', routing: '12345678' },
  { persona: 'alex', jurisdiction: 'us', taxId: '123456789', bank: '123456789012', routing: '021000021' },
  { persona: 'sydney', jurisdiction: 'au', taxId: '123456782', bank: '12345678', routing: '062000' },
];

const FORBIDDEN_KEYS = /(Enc|ciphertext)$/;
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.push(k); keysDeep(x, out); }
  return out;
}

async function createEmployee(page: Page, tag: string, jurisdiction: string): Promise<string> {
  const res = await api(page).post(`${PAYROLL}/employees`, {
    name: `${tag} Employee`, payRateCents: 5_000_000, payType: 'salary', payFrequency: 'biweekly', jurisdiction,
  });
  expect(res.status, 'create employee').toBe(201);
  return (res.data as { data: { id: string } }).data.id;
}

async function activeTagged(page: Page, tag: string): Promise<string[]> {
  const res = await api(page).get(`${PAYROLL}/employees`);
  expect(res.status, 'list employees').toBe(200);
  return ((res.data as { data: Array<{ id: string; name: string }> }).data).filter((e) => e.name.includes(tag)).map((e) => e.id);
}

async function cleanup(page: Page, tag: string, ids: string[]) {
  for (const id of ids) {
    const res = await api(page).delete(`${PAYROLL}/employees/${id}`);
    expect([200, 404], `delete fixture ${id}`).toContain(res.status);
  }
  expect(await activeTagged(page, tag), `nothing tagged ${tag} remains`).toEqual([]);
}

for (const m of MARKETS) {
  test.describe(`employee privacy — ${m.persona} (${m.jurisdiction})`, () => {
    const tag = runTag('E2EEMP');
    const ids: string[] = [];
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
      id = await createEmployee(page, tag, m.jurisdiction);
      ids.push(id);
    });
    test.afterAll(async () => {
      if (!context) return;
      try { await cleanup(page, tag, ids); } finally { await context.close(); }
    });

    test('GET is masked: no ciphertext keys, only last4 fields', async () => {
      const res = await api(page).get(`${PAYROLL}/employees/${id}`);
      expect(res.status).toBe(200);
      const body = res.data as { data: Record<string, unknown> };
      const bad = keysDeep(body).filter((k) => FORBIDDEN_KEYS.test(k) && !/last4$/i.test(k));
      expect(bad, 'no ciphertext-shaped keys in the response').toEqual([]);
      const text = JSON.stringify(body);
      for (const secret of [m.taxId, m.bank]) expect(text, 'no full identifier in the response').not.toContain(secret);
      expect(body.data.name).toBe(`${tag} Employee`);
    });

    test('a non-sensitive PUT (phone, address) succeeds and is reflected', async () => {
      const put = await api(page).put(`${PAYROLL}/employees/${id}`, { phone: '555-0100', address: 'E2E 1 Test Street' });
      expect(put.status, JSON.stringify(put.data)).toBe(200);
      const got = ((await api(page).get(`${PAYROLL}/employees/${id}`)).data as { data: Record<string, unknown> }).data;
      expect(JSON.stringify(got)).toContain('E2E 1 Test Street');
    });

    test('an unknown key is a 400 and changes nothing', async () => {
      const put = await api(page).put(`${PAYROLL}/employees/${id}`, { address: 'Should Not Land', notAField: 1 });
      expect(put.status).toBe(400);
      const got = JSON.stringify((await api(page).get(`${PAYROLL}/employees/${id}`)).data);
      expect(got).not.toContain('Should Not Land');
    });

    test('sensitive PUT: fails closed without the key, round-trips with it', async () => {
      const put = await api(page).put(`${PAYROLL}/employees/${id}`, { taxId: m.taxId, bankAccount: m.bank, bankRoutingLabel: m.routing });
      const after = ((await api(page).get(`${PAYROLL}/employees/${id}`)).data as { data: Record<string, unknown> }).data;
      const afterText = JSON.stringify(after);
      expect(afterText, 'full values never come back in GET').not.toContain(m.taxId);
      expect(afterText).not.toContain(m.bank);

      if (put.status === 503) {
        expect((put.data as { code?: string }).code).toBe('pii_key_unconfigured');
        // Nothing stored: no last4 of either value, and reveal has nothing to return.
        expect(afterText, 'tax id last4 not stored').not.toContain(m.taxId.slice(-4));
        expect(afterText, 'bank last4 not stored').not.toContain(m.bank.slice(-4));
        const rev = await api(page).post(`${PAYROLL}/employees/${id}/reveal`, { field: 'taxId' });
        expect([404, 503], 'reveal has no value to give').toContain(rev.status);
        expect(JSON.stringify(rev.data)).not.toContain(m.taxId);
        return;
      }

      expect(put.status, JSON.stringify(put.data)).toBe(200);
      expect(afterText, 'masked GET shows last4 of the tax id').toContain(m.taxId.slice(-4));
      expect(afterText, 'masked GET shows last4 of the bank account').toContain(m.bank.slice(-4));

      const r1 = await api(page).post(`${PAYROLL}/employees/${id}/reveal`, { field: 'taxId' });
      expect(r1.status).toBe(200);
      expect((r1.data as { data: { value: string } }).data.value).toBe(m.taxId);
      const r2 = await api(page).post(`${PAYROLL}/employees/${id}/reveal`, { field: 'bankAccount' });
      expect(r2.status, 'a second reveal inside the limits works').toBe(200);
      expect((r2.data as { data: { value: string } }).data.value).toBe(m.bank);

      const list = JSON.stringify((await api(page).get(`${PAYROLL}/employees`)).data);
      expect(list, 'list never carries the full tax id').not.toContain(m.taxId);
      expect(list, 'list never carries the full bank account').not.toContain(m.bank);
    });
  });
}

test.describe('employee privacy — cross-tenant', () => {
  const tag = runTag('E2EEMPX');
  const ids: string[] = [];
  let mayaCtx: BrowserContext | undefined;
  let alexCtx: BrowserContext | undefined;
  let maya: Page;
  let alex: Page;

  async function open(browser: Browser, baseURL: string | undefined, p: Persona) {
    const context = await newPersonaContext(browser, baseURL);
    const page = await context.newPage();
    await loginAs(page, p);
    await page.goto('/app/capture');
    return { context, page };
  }

  test.beforeAll(async ({ browser }, testInfo) => {
    const reason = loginUnavailableReason(testInfo.project.use.baseURL);
    expect(reason, reason ?? '').toBeNull();
    const a = await open(browser, testInfo.project.use.baseURL, 'maya');
    mayaCtx = a.context; maya = a.page;
    const b = await open(browser, testInfo.project.use.baseURL, 'alex');
    alexCtx = b.context; alex = b.page;
  });
  test.afterAll(async () => {
    try { if (maya) await cleanup(maya, tag, ids); } finally {
      await mayaCtx?.close();
      await alexCtx?.close();
    }
  });

  test("another tenant's employee id is a 404 for GET, PUT and reveal", async () => {
    const id = await createEmployee(maya, tag, 'ca');
    ids.push(id);
    expect((await api(maya).get(`${PAYROLL}/employees/${id}`)).status, 'owner can read it').toBe(200);
    expect((await api(alex).get(`${PAYROLL}/employees/${id}`)).status).toBe(404);
    expect((await api(alex).put(`${PAYROLL}/employees/${id}`, { address: 'Hijack' })).status).toBe(404);
    expect((await api(alex).post(`${PAYROLL}/employees/${id}/reveal`, { field: 'taxId' })).status).toBe(404);
    const owner = JSON.stringify((await api(maya).get(`${PAYROLL}/employees/${id}`)).data);
    expect(owner).not.toContain('Hijack');
  });
});
