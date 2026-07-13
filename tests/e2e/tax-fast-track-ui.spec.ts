/**
 * Tax Fast-Track — UI-native path (PR-4, Task 8).
 *
 * Extends PR-3's tests/e2e/tax-fast-track.spec.ts (which covers the
 * CHAT path) with the plain-HTTP UI routes from Task 6: start → answer
 * (repeated) → poll status until the draft is ready → confirm both PDF
 * URLs resolve. Same conventions as the chat spec: register a fresh
 * throwaway tenant, seed a confirmed AbPastTaxFiling directly via prisma
 * (the upload/OCR pipeline is a different feature, out of scope here),
 * drive the API via in-page fetch().
 */
import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
test.use({ baseURL: BASE });

const CORE = '/api/v1/agentbook-core/tax-fast-track';

async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}
async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, path);
}

function fakeExtractedData(taxYear: number) {
  return {
    formType: 'W-2', taxYear, jurisdiction: 'us',
    totalIncomeCents: 8_500_000, netIncomeCents: 8_000_000,
    taxableIncomeCents: 7_200_000, taxPayableCents: 1_150_000,
    formFields: { wages: 85000, employer: 'Acme Consulting LLC', filingStatus: 'single' },
    attachedForms: {}, confidence: 0.92,
  };
}

async function registerAndLogin(page: import('@playwright/test').Page, prefix: string): Promise<string> {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `${prefix}-${suffix}@agentbook.test`;
  const password = 'e2e-tax-fast-track-ui-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Tax Fast Track UI' }),
    });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { email, password });
  expect(reg.status, JSON.stringify(reg.data)).toBeLessThan(300);

  await page.goto('/login');
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 20_000 });
  await page.waitForTimeout(2_000);

  return email;
}

test.describe('Tax fast-track — UI-native path', () => {
  let prisma: typeof import('@naap/database').prisma;

  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;
  });
  test.afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('start → answer (repeated) → draft ready, with both PDF URLs resolving', async ({ page }) => {
    test.setTimeout(120_000);

    const email = await registerAndLogin(page, 'e2e-taxft-ui-happy');
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeTruthy();
    const tenantId = user!.id;

    await prisma.abPastTaxFiling.create({
      data: {
        tenantId, taxYear: 2024, jurisdiction: 'us', formType: 'W-2',
        blobUrl: `local://e2e-tax-fast-track-ui/${tenantId}/2024.pdf`,
        blobKey: `e2e-tax-fast-track-ui/${tenantId}/2024.pdf`,
        extractedData: fakeExtractedData(2024), confidence: 0.92, status: 'confirmed',
      },
    });

    const start = await apiPost(page, `${CORE}/start`, {});
    expect(start.status, JSON.stringify(start.data)).toBe(200);
    expect(['question', 'done']).toContain(start.data.data.status);
    const sessionId: string = start.data.data.sessionId;
    expect(sessionId).toBeTruthy();

    let done = start.data.data.status === 'done';
    const plausibleAnswers = [
      "Still self-employed, same consulting work as last year.",
      'No new dependents this year.',
      'Income was roughly the same, maybe a little higher.',
    ];
    for (const answer of plausibleAnswers) {
      if (done) break;
      const turn = await apiPost(page, `${CORE}/answer`, { text: answer });
      expect(turn.status, JSON.stringify(turn.data)).toBe(200);
      expect(['question', 'done']).toContain(turn.data.data.status);
      if (turn.data.data.status === 'done') done = true;
    }

    // Poll /status until the draft is ready (background after() work needs
    // a few seconds — two LLM calls + two PDF renders + two blob uploads).
    let draft: any = null;
    for (let i = 0; i < 20; i++) {
      const status = await apiGet(page, `${CORE}/status`);
      expect(status.status).toBe(200);
      if (status.data.data.draft?.status === 'ready') { draft = status.data.data.draft; break; }
      if (status.data.data.draft?.status === 'failed') { throw new Error(`draft failed: ${status.data.data.draft.errorMsg}`); }
      await page.waitForTimeout(3_000);
    }
    expect(draft, 'draft should reach status=ready within the poll window').toBeTruthy();
    expect(draft.draftPdfUrl).toBeTruthy();
    expect(draft.letterPdfUrl).toBeTruthy();

    const draftPdfRes = await page.evaluate(async (url) => {
      const r = await fetch(url);
      return { status: r.status, contentType: r.headers.get('content-type') };
    }, draft.draftPdfUrl);
    expect(draftPdfRes.status).toBe(200);
    expect(draftPdfRes.contentType).toContain('application/pdf');
  });

  test('answer with no active session returns 400 no_active_session', async ({ page }) => {
    await registerAndLogin(page, 'e2e-taxft-ui-noactive');
    const res = await apiPost(page, `${CORE}/answer`, { text: 'anything' });
    expect(res.status).toBe(400);
    expect(res.data.error).toBe('no_active_session');
  });

  test('cancel mid-questionnaire, then /status reflects abandoned and no draft is created', async ({ page }) => {
    const email = await registerAndLogin(page, 'e2e-taxft-ui-cancel');
    const user = await prisma.user.findUnique({ where: { email } });
    const tenantId = user!.id;

    await prisma.abPastTaxFiling.create({
      data: {
        tenantId, taxYear: 2024, jurisdiction: 'us', formType: 'W-2',
        blobUrl: `local://e2e-tax-fast-track-ui/${tenantId}/2024.pdf`,
        blobKey: `e2e-tax-fast-track-ui/${tenantId}/2024.pdf`,
        extractedData: fakeExtractedData(2024), confidence: 0.92, status: 'confirmed',
      },
    });

    const start = await apiPost(page, `${CORE}/start`, {});
    expect(start.data.data.status).toBe('question');

    const cancel = await apiPost(page, `${CORE}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(cancel.data.data.status).toBe('cancelled');

    const status = await apiGet(page, `${CORE}/status`);
    expect(status.data.data.session.status).toBe('abandoned');
    expect(status.data.data.draft).toBeNull();
  });
});
