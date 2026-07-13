/**
 * Tax Fast-Track Foundation (PR-3, Task 5) — final e2e verification.
 *
 * Covers the full round-trip introduced by Task 3 (agent-brain.ts's "Step 1b"
 * session-recovery branch) and Task 4 (the `start-tax-fast-track` skill):
 * a tenant with a confirmed prior-year `AbPastTaxFiling` says an anchored
 * fast-track phrase, gets asked an adaptive first question, and can carry
 * the conversation forward turn by turn until the session completes or is
 * cancelled.
 *
 * Conventions follow `personal-finance.spec.ts`: log in via the real UI so
 * the httpOnly session cookie is set, drive the API via in-page `fetch()`
 * (relative paths resolve against `baseURL`), and reach for the real
 * `prisma` client only for setup/verification that isn't itself the feature
 * under test (seeding a *confirmed* `AbPastTaxFiling` directly, rather than
 * exercising the separate upload+parse pipeline; reading
 * `AbTaxQuestionnaireSession` rows directly where there is no HTTP endpoint
 * that exposes session status).
 *
 * Each test registers its own fresh, throwaway tenant (the
 * `student-persona.spec.ts` pattern) rather than reusing Maya/Alex/Jordan —
 * this feature's state (an `AbTaxQuestionnaireSession` per tenant, mutually
 * exclusive with `AbAgentSession`) is exactly the kind of shared, stateful
 * side effect that would make tests interfere with each other, or with any
 * other spec file's use of those shared demo tenants, if run concurrently
 * against the live deployment.
 *
 * Trigger phrases and `skillUsed` values below are taken verbatim from code
 * read for this task, not guessed:
 *   - Turn 1 (the `start-tax-fast-track` skill's own reply) reports
 *     `skillUsed: 'start-tax-fast-track'` — see server.ts's INTERNAL handler
 *     (`if (selectedSkill.name === 'start-tax-fast-track')`), every branch of
 *     which sets `skillUsed: 'start-tax-fast-track'` in `responseData`.
 *   - Every subsequent turn (agent-brain.ts's "Step 1b" session-recovery
 *     branch, including the cancel path) reports `skillUsed:
 *     'tax-questionnaire'` — see `buildResponse({ ..., skillUsed:
 *     'tax-questionnaire', ... })` at each of Step 1b's return points.
 *   - The exact anchored trigger phrase
 *     "help me do this year's filing based on last year's tax return" and
 *     the bare "start my tax filing" phrase are both taken directly from
 *     `plugins/agentbook-core/backend/src/__tests__/skill-routing-canonical.test.ts`'s
 *     `start-tax-fast-track vs. the full tax-skill family` suite, which
 *     already verifies (declaration order + 3 shuffled orders) that the
 *     first resolves to `start-tax-fast-track` and the second to
 *     `tax-filing-start` against the full tax-skill family — reused here
 *     rather than re-deriving new phrasing by hand.
 *   - The blocked-path (no confirmed filing) message and the cancel-path
 *     message are copied verbatim from server.ts / agent-brain.ts so the
 *     regexes below assert against the real strings, not approximations.
 *
 * LLM-dependent multi-turn assertions: `start-tax-fast-track` and Step 1b
 * both make a real `callGemini()` call per turn (there is no test-mode LLM
 * stub for this pipeline — confirmed by reading `agent-brain-v2.spec.ts`,
 * this repo's other real-LLM-dependent e2e spec, which handles the same
 * problem the same way: assert the response shape/route rather than exact
 * generated content, and branch on optional/variable fields instead of
 * asserting a fixed turn count). Rather than asserting an exact number of
 * questions or the exact turn `done: true` fires on, the happy-path test
 * below tolerates either outcome at every turn (a new question, or an early
 * `completed`) and stops driving the conversation the moment it observes
 * completion — then falls back to a direct `prisma` read of the
 * `AbTaxQuestionnaireSession` row as the authoritative check that real
 * progress was persisted (`qaHistory`/`askedCount`/`status`), rather than
 * trusting chat reply text alone.
 */

import { test, expect } from '@playwright/test';

const BASE = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';

test.use({ baseURL: BASE });

const CORE = '/api/v1/agentbook-core';
const AGENT_MESSAGE = `${CORE}/agent/message`;

// Verified against skill-routing-canonical.test.ts's own
// "start-tax-fast-track vs. the full tax-skill family" suite.
const FAST_TRACK_PHRASE = "help me do this year's filing based on last year's tax return";
const BARE_FILING_PHRASE = 'start my tax filing';

async function apiGet(page: import('@playwright/test').Page, path: string) {
  return page.evaluate(async (p) => {
    const r = await fetch(p, { headers: { 'content-type': 'application/json' } });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, path);
}
async function apiPost(page: import('@playwright/test').Page, path: string, body: unknown) {
  return page.evaluate(async ({ p, b }) => {
    const r = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, data: await r.json().catch(() => null) };
  }, { p: path, b: body });
}

/**
 * Registers a brand-new throwaway account and logs in via the UI (matches
 * `student-persona.spec.ts`'s documented prod e2e pattern: register via
 * in-page fetch, then a real `/login` form submit so the httpOnly session
 * cookie actually gets set for subsequent in-page fetch() calls).
 */
async function registerAndLogin(page: import('@playwright/test').Page, prefix: string): Promise<string> {
  const suffix = test.info().testId.replace(/[^a-z0-9]/gi, '').slice(0, 12);
  const email = `${prefix}-${suffix}@agentbook.test`;
  const password = 'e2e-tax-fast-track-2026-x';

  await page.goto('/login');
  const reg = await page.evaluate(async ({ email, password }) => {
    const r = await fetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, displayName: 'E2E Tax Fast Track' }),
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

// A realistic StandardTaxExtract shape (packages/agentbook-jurisdictions/src/interfaces.ts)
// for a confirmed prior-year filing to seed directly via prisma — the upload+parse
// pipeline itself is a different feature (tax-past-filings-upload.spec.ts), not under
// test here.
function fakeExtractedData(taxYear: number) {
  return {
    formType: 'W-2',
    taxYear,
    jurisdiction: 'us',
    totalIncomeCents: 8_500_000,
    netIncomeCents: 8_000_000,
    taxableIncomeCents: 7_200_000,
    taxPayableCents: 1_150_000,
    refundOrBalanceCents: 45_000,
    formFields: { wages: 85000, employer: 'Acme Consulting LLC', filingStatus: 'single' },
    attachedForms: {},
    confidence: 0.92,
  };
}

test.describe('Tax fast-track questionnaire', () => {
  let prisma: typeof import('@naap/database').prisma;

  test.beforeAll(async () => {
    const dbMod = await import('@naap/database');
    prisma = dbMod.prisma;
  });

  test.afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  test('happy path: confirmed prior filing → adaptive questionnaire progresses turn by turn', async ({ page }) => {
    test.setTimeout(90_000);

    const email = await registerAndLogin(page, 'e2e-taxft-happy');
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user, 'registered user should exist').toBeTruthy();
    const tenantId = user!.id;

    // Seed a *confirmed* AbPastTaxFiling directly — bypassing the upload/OCR
    // pipeline, which is a different feature not under test here.
    const filing = await prisma.abPastTaxFiling.create({
      data: {
        tenantId,
        taxYear: 2024,
        jurisdiction: 'us',
        formType: 'W-2',
        blobUrl: `local://e2e-tax-fast-track/${tenantId}/2024.pdf`,
        blobKey: `e2e-tax-fast-track/${tenantId}/2024.pdf`,
        extractedData: fakeExtractedData(2024),
        confidence: 0.92,
        status: 'confirmed',
      },
    });

    // Turn 1: the anchored fast-track phrase, verified against
    // skill-routing-canonical.test.ts to resolve to start-tax-fast-track
    // against the full tax-skill family.
    const turn1 = await apiPost(page, AGENT_MESSAGE, { text: FAST_TRACK_PHRASE });
    expect(turn1.status, JSON.stringify(turn1.data)).toBe(200);
    expect(turn1.data?.data?.skillUsed).toBe('start-tax-fast-track');
    expect(turn1.data?.data?.confidence).toBe(1);
    expect(turn1.data?.data?.sessionId).toBeTruthy();

    const turn1Message: string = turn1.data?.data?.message || '';
    expect(turn1Message.length).toBeGreaterThan(5);
    // Not the "no confirmed filing" upsell/blocked-path message...
    expect(turn1Message).not.toMatch(/confirmed prior-year return to fast-track/i);
    // ...and not the internal-error fallback message.
    expect(turn1Message).not.toMatch(/couldn't start the fast-track questionnaire/i);

    const sessionId: string = turn1.data.data.sessionId;
    let completed = /ready shortly/i.test(turn1Message);

    // 2-3 plausible free-text answers across separate /agent/message calls.
    // The pack's next-question generation is a real, live LLM call with no
    // test-mode stub in this pipeline (matching agent-brain-v2.spec.ts's own
    // handling of real-LLM-dependent turns) — tolerate either a new question
    // or an early `completed` at every turn, and stop driving once completed
    // rather than asserting an exact turn count.
    const plausibleAnswers = [
      "Yes, I'm still self-employed doing the same consulting work as last year.",
      'No dependents to report this year.',
      'My income was roughly the same as last year, maybe a little higher.',
    ];

    for (const answer of plausibleAnswers) {
      if (completed) break;
      const turn = await apiPost(page, AGENT_MESSAGE, { text: answer });
      expect(turn.status, JSON.stringify(turn.data)).toBe(200);
      expect(turn.data?.data?.skillUsed).toBe('tax-questionnaire');
      const msg: string = turn.data?.data?.message || '';
      expect(msg.length).toBeGreaterThan(0);
      // Never the version-conflict message in this single-threaded sequence.
      expect(msg).not.toMatch(/modified by another process/i);
      if (/ready shortly/i.test(msg)) completed = true;
    }

    // Don't trust chat reply text alone — re-fetch the authoritative
    // AbTaxQuestionnaireSession row and confirm real progress was persisted.
    const session = await prisma.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
    expect(session).toBeTruthy();
    expect(session!.tenantId).toBe(tenantId);
    expect(session!.sourceFilingId).toBe(filing.id);
    expect(['in_progress', 'completed']).toContain(session!.status);
    expect(session!.askedCount).toBeGreaterThanOrEqual(1);
    const qaHistory = session!.qaHistory as Array<{ question: string; answer: string }>;
    expect(Array.isArray(qaHistory)).toBe(true);
    expect(qaHistory.length).toBeGreaterThanOrEqual(1);
    // At least the first question was genuinely answered (not left pending).
    expect(qaHistory[0].answer.length).toBeGreaterThan(0);
  });

  test('no confirmed filing: fast-track phrase points at the upload flow instead of starting a session', async ({ page }) => {
    const email = await registerAndLogin(page, 'e2e-taxft-noconfirmed');
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeTruthy();
    const tenantId = user!.id;

    // Confirm there really is no confirmed filing for this fresh tenant
    // before asserting on the blocked path.
    const existing = await prisma.abPastTaxFiling.findMany({ where: { tenantId, status: 'confirmed' } });
    expect(existing.length).toBe(0);

    const res = await apiPost(page, AGENT_MESSAGE, { text: FAST_TRACK_PHRASE });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data?.data?.skillUsed).toBe('start-tax-fast-track');
    expect(res.data?.data?.confidence).toBe(1);
    // Blocked path never creates a session.
    expect(res.data?.data?.sessionId).toBeFalsy();

    const message: string = res.data?.data?.message || '';
    // Verbatim copy from server.ts's blocked-path branch.
    expect(message).toMatch(/confirmed prior-year return to fast-track/i);
    expect(message).toMatch(/Tax Package/i);
    expect(message).toMatch(/upload/i);

    // No AbTaxQuestionnaireSession should have been created for this tenant.
    const sessions = await prisma.abTaxQuestionnaireSession.findMany({ where: { tenantId } });
    expect(sessions.length).toBe(0);
  });

  test('mid-questionnaire cancel: "cancel" ends the session as abandoned', async ({ page }) => {
    const email = await registerAndLogin(page, 'e2e-taxft-cancel');
    const user = await prisma.user.findUnique({ where: { email } });
    expect(user).toBeTruthy();
    const tenantId = user!.id;

    await prisma.abPastTaxFiling.create({
      data: {
        tenantId,
        taxYear: 2024,
        jurisdiction: 'us',
        formType: 'W-2',
        blobUrl: `local://e2e-tax-fast-track/${tenantId}/2024.pdf`,
        blobKey: `e2e-tax-fast-track/${tenantId}/2024.pdf`,
        extractedData: fakeExtractedData(2024),
        confidence: 0.92,
        status: 'confirmed',
      },
    });

    // Start the questionnaire.
    const start = await apiPost(page, AGENT_MESSAGE, { text: FAST_TRACK_PHRASE });
    expect(start.status, JSON.stringify(start.data)).toBe(200);
    expect(start.data?.data?.skillUsed).toBe('start-tax-fast-track');
    const sessionId: string = start.data?.data?.sessionId;
    expect(sessionId).toBeTruthy();

    // Cancel mid-questionnaire. TAX_QUESTIONNAIRE_CANCEL_RE
    // (agent-brain.ts) is /^(cancel|stop|abort|never\s?mind|n)$/i — "cancel"
    // matches it exactly.
    const cancel = await apiPost(page, AGENT_MESSAGE, { text: 'cancel' });
    expect(cancel.status, JSON.stringify(cancel.data)).toBe(200);
    expect(cancel.data?.data?.skillUsed).toBe('tax-questionnaire');
    // Verbatim copy from agent-brain.ts's cancel-path reply.
    expect(cancel.data?.data?.message).toMatch(/cancelled the tax questionnaire/i);

    // No HTTP endpoint exposes AbTaxQuestionnaireSession status directly —
    // fall back to a direct prisma read, matching this repo's established
    // pattern (see personal-finance.spec.ts's AbPersonalNudgeLog reads).
    const session = await prisma.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
    expect(session).toBeTruthy();
    expect(session!.status).toBe('abandoned');

    // A further message no longer gets claimed by the (now-abandoned)
    // session — it falls through to normal classification instead of being
    // treated as another questionnaire answer.
    const after = await apiPost(page, AGENT_MESSAGE, { text: 'spent $12 on coffee' });
    expect(after.status, JSON.stringify(after.data)).toBe(200);
    expect(after.data?.data?.skillUsed).not.toBe('tax-questionnaire');
  });

  test('regression: a bare "start my tax filing" (no prior-year anchor) still routes to tax-filing-start', async ({ page }) => {
    await registerAndLogin(page, 'e2e-taxft-regression');

    // Verified against skill-routing-canonical.test.ts's own suite: this
    // exact bare phrase (no last-year/past-filing anchor) resolves to
    // tax-filing-start, never start-tax-fast-track.
    const res = await apiPost(page, AGENT_MESSAGE, { text: BARE_FILING_PHRASE });
    expect(res.status, JSON.stringify(res.data)).toBe(200);
    expect(res.data?.data?.skillUsed).toBe('tax-filing-start');
    expect(res.data?.data?.skillUsed).not.toBe('start-tax-fast-track');
  });
});
