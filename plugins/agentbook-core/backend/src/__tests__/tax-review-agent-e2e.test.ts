import { describe, it, expect, vi } from 'vitest';

/**
 * Task 18 — end-to-end integration test, CA path.
 *
 * Proves Tasks 1-15 (form templates, bracket math, review packs,
 * startReview/answerReviewMessage state machine, HTTP endpoints) and
 * Tasks 16-17 (the submit-review gate + agent-brain.ts's early
 * interception) all work together as ONE mechanism, not just as
 * independently-passing units.
 *
 * Mocking strategy (per the plan's Task 18 Step 1): only the two true
 * external boundaries are mocked —
 *   1. callGemini — the LLM call itself.
 *   2. The HTTP layer between agent-brain.ts / server.ts's
 *      handleTaxFilingSubmit and the tax plugin's Express server. In
 *      production this is a real network hop (see server.ts's
 *      checkActiveTaxReview/answerTaxReview ctx wiring and
 *      resolveTaxBaseUrl()); here it's replaced with direct in-process
 *      calls into the REAL tax-review-agent.ts functions, which is exactly
 *      what the real HTTP handlers in agentbook-tax/backend/src/server.ts
 *      do (see lines ~1648-1707: review/active -> getActiveReviewForTenant,
 *      review/start -> startReview, review/message -> answerReviewMessage,
 *      review/status -> hasConfirmedFreshReview).
 *
 * Everything else in the chain is real: startReview(), answerReviewMessage(),
 * applyFieldEdit(), confirmAndSubmit(), updateFilingField(), submitFiling()
 * (including its real buildFilingOutcome() honesty rule), validateFiling(),
 * the real CA bracket calculator, and the real CaTaxReviewPack. The tax
 * plugin's own Prisma client (plugins/agentbook-tax/backend/src/db/client.js)
 * is replaced with a small stateful in-memory fake — the same
 * vi.mock('../db/client.js', ...) convention already used by
 * tax-review-agent-start.test.ts / tax-review-agent-answer.test.ts, just
 * carrying real state across this test's multiple steps instead of a
 * single static mockResolvedValue.
 *
 * updateFilingField and submitFiling are wrapped (vi.importActual + vi.fn)
 * rather than fully mocked, so this test can both assert exactly how they
 * were called AND let their real implementations run — the same "keep
 * the real chain real" requirement that makes this an integration test
 * rather than another unit test.
 */

// ─── Tax plugin's own DB (agentbook-tax/backend/src/db/client.js) ─────────
// Stateful in-memory fake — the review conversation spans several calls
// across this test's 5 steps, so (unlike the single-call unit tests) a
// static mockResolvedValue can't represent it; state must actually persist
// between calls the way the real Prisma-backed store would.

let filingRow: any = {
  id: 'f1',
  tenantId: 't1',
  taxYear: 2025,
  jurisdiction: 'ca',
  region: 'ON',
  filingType: 'personal_return',
  status: 'complete',
  filedAt: null,
  filedRef: null,
  filedStatus: null,
  missingFields: [],
  forms: {
    T1: {
      total_income_15000: 7300000, // $73,000.00
      taxable_income_26000: 7300000,
      // The T1 total-payable line, as populateFiling's formula chain would
      // have computed it (federal + provincial + CPP). computeFilingTotals
      // reads THIS rather than re-deriving income tax from the brackets, so
      // the review can never show a figure that disagrees with the form the
      // user is about to submit. $16,392.06 also happens to equal
      // caTaxBrackets.calculateTax(7300000, 2025, undefined, 'ON').taxCents.
      total_tax_43500: 1639206,
      balance_owing_48500: 0,
      sin: '123456789',
      full_name: 'Jamie Test',
    },
    T2125: {
      gross_sales_8000: 7300000,
      adjusted_gross_8299: 7300000,
      total_expenses_9368: 0,
    },
    'GST-HST': { gst_number: '123456789RT0001' },
  },
};
let reviewRow: any = null;

const abTaxFilingFindFirst = vi.fn(async () => (filingRow ? { ...filingRow, forms: filingRow.forms } : null));
const abTaxFilingUpdate = vi.fn(async (args: any) => {
  filingRow = { ...filingRow, ...args.data };
  return { ...filingRow };
});
const abTaxFilingReviewFindFirst = vi.fn(async () => (reviewRow ? { ...reviewRow } : null));
const abTaxFilingReviewUpsert = vi.fn(async (args: any) => {
  reviewRow = reviewRow ? { ...reviewRow, ...args.update } : { id: 'r1', ...args.create };
  return { ...reviewRow };
});
const abTaxFilingReviewUpdate = vi.fn(async (args: any) => {
  reviewRow = { ...reviewRow, ...args.data };
  return { ...reviewRow };
});
const abTenantConfigFindFirstTax = vi.fn(async () => ({ jurisdiction: 'ca', region: 'ON', locale: 'en-CA' }));
// No certified partner registered — submitFiling must take the mock-provider
// path and report the honest "exported, not filed" outcome.
const abTaxFilingPartnerFindFirst = vi.fn(async () => null);

vi.mock('../../../../agentbook-tax/backend/src/db/client.js', () => ({
  db: {
    abTaxFiling: { findFirst: abTaxFilingFindFirst, update: abTaxFilingUpdate },
    abTaxFilingReview: {
      findFirst: abTaxFilingReviewFindFirst,
      upsert: abTaxFilingReviewUpsert,
      update: abTaxFilingReviewUpdate,
    },
    abTenantConfig: { findFirst: abTenantConfigFindFirstTax },
    abTaxFilingPartner: { findFirst: abTaxFilingPartnerFindFirst },
  },
}));

// Wrap (not fully replace) updateFilingField and submitFiling: real
// implementation still runs (so forms are really recomputed and
// submitFiling's real buildFilingOutcome message really comes back), but
// wrapped in vi.fn() so this test can assert exactly how they were called —
// the direct equivalent of tax-review-agent-answer.test.ts's assertions on
// these same two functions, minus the full mock that test uses instead.
vi.mock('../../../../agentbook-tax/backend/src/tax-filing.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../agentbook-tax/backend/src/tax-filing.js')>(
    '../../../../agentbook-tax/backend/src/tax-filing.js',
  );
  return { ...actual, updateFilingField: vi.fn(actual.updateFilingField) };
});
vi.mock('../../../../agentbook-tax/backend/src/tax-efiling.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../agentbook-tax/backend/src/tax-efiling.js')>(
    '../../../../agentbook-tax/backend/src/tax-efiling.js',
  );
  return { ...actual, submitFiling: vi.fn(actual.submitFiling) };
});

// ─── agentbook-core/backend's own DB ───────────────────────────────────────
// Same DB-free scaffold used by agent-brain-tax-review-interception.test.ts
// (Task 17's own test) — handleAgentMessage's session-recovery/context-
// assembly steps run before Step 1.5's interception check regardless of
// outcome, so every table they might touch needs a stub. handleTaxFilingSubmit
// additionally writes an AbConversation row on a successful real submit
// (not exercised here, since step 2's submit attempt is gated into a
// review instead — included anyway for parity with
// tax-filing-submit-review-gate.test.ts's own mock).
vi.mock('../db/client.js', () => ({
  db: {
    abConversation: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      create: vi.fn(async () => ({})),
    },
    abConvThread: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({
        id: 'thread-1', lastActiveAt: new Date(), turns: [], activeEntities: [], parkedFills: [],
        ...args.data,
      })),
      update: vi.fn(async () => ({})),
    },
    abAgentSession: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (args: any) => ({ id: 'sess-new', version: 1, ...args.data })),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTaxQuestionnaireSession: {
      findFirst: vi.fn(async () => null),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    abTenantConfig: { findFirst: vi.fn(async () => null) },
    abUserMemory: { findMany: vi.fn(async () => []) },
    abSkillManifest: { findMany: vi.fn(async () => []) },
    abEvent: { create: vi.fn(async () => ({})) },
    $executeRaw: vi.fn(async () => 1),
  },
}));

// The one true LLM boundary. mockResolvedValueOnce covers startReview's
// single callGemini call (step 2) — the field-edit (step 4) and confirm
// (step 5) paths never call the LLM at all, matching answerReviewMessage's
// own deterministic classifyReply() routing.
const callGeminiMock = vi.fn().mockResolvedValueOnce(
  // $73,000 and $16,392.06 (rounds to $16,392) are the REAL computed
  // totalIncomeCents/taxableIncomeCents and the filing's own
  // T1.total_tax_43500 total-payable line (see the fixture above) —
  // verifyGroundedNumbers() rejects anything
  // that isn't grounded in one of startReview's own computed totals, so an
  // invented figure here (as in Task 11's own anti-hallucination test)
  // would silently fall back to the deterministic summary instead of this
  // narrated one.
  JSON.stringify({
    summaryText:
      "Your total income for 2025 is $73,000 and your estimated tax payable to the CRA is $16,392. Anything you'd like to change before submitting?",
  }),
);

describe('Tax Review Agent — full conversation, CA path (Task 18 end-to-end)', () => {
  it('submit attempt -> gated into review -> summary shown -> field edit -> recomputed -> confirm -> real submitFiling outcome', async () => {
    const { handleTaxFilingSubmit } = await import('../server.js');
    const { handleAgentMessage } = await import('../agent-brain.js');
    const { updateFilingField } = await import('../../../../agentbook-tax/backend/src/tax-filing.js');
    const { submitFiling } = await import('../../../../agentbook-tax/backend/src/tax-efiling.js');
    const { getActiveReviewForTenant, answerReviewMessage } = await import(
      '../../../../agentbook-tax/backend/src/tax-review-agent.js'
    );

    // ── Step 2: submit attempt, before any review exists ──────────────────
    // Mocks the HTTP layer handleTaxFilingSubmit uses to reach the tax
    // plugin (review/status, review/start, submit) with direct in-process
    // calls into the same real functions the tax plugin's own Express
    // handlers call (server.ts lines ~1656-1682).
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/review/status')) {
        const { hasConfirmedFreshReview } = await import('../../../../agentbook-tax/backend/src/tax-review-agent.js');
        const confirmedAndFresh = await hasConfirmedFreshReview('t1', 2025);
        return { json: async () => ({ success: true, data: { confirmedAndFresh } }) };
      }
      if (u.includes('/review/start')) {
        const { startReview } = await import('../../../../agentbook-tax/backend/src/tax-review-agent.js');
        const result = await startReview('t1', 2025, callGeminiMock);
        return { json: async () => ({ success: true, data: result }) };
      }
      if (u.includes('/submit')) {
        const result = await submitFiling('t1', 2025);
        return { json: async () => (result.success ? { success: true, data: result.data } : { success: false, error: result.error }) };
      }
      throw new Error(`Unexpected fetch in test: ${u}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const submitResult = await handleTaxFilingSubmit({
      tenantId: 't1',
      extractedParams: { taxYear: 2025 },
    } as any);

    // Assert 1: the response is the review summary, NOT a submit outcome —
    // and submitFiling was never called yet.
    expect(submitResult.responseData.message).toContain('$73,000');
    expect(submitResult.responseData.message).toContain('$16,392');
    expect(submitResult.responseData.skillUsed).not.toBe('tax-filing-submit');
    expect(submitFiling).not.toHaveBeenCalled();
    const fetchedUrls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(fetchedUrls.some((u) => u.includes('/submit') && !u.includes('review'))).toBe(false);

    // ── Step 4: field-edit reply, routed through agent-brain.ts's real
    // early-interception (Task 17), reaching the real state machine
    // (Task 12) via direct-call ctx (standing in for the HTTP boundary). ──
    const ctx = {
      callGemini: callGeminiMock,
      classifyOnly: vi.fn(),
      classifyAndExecuteV1: vi.fn(),
      executeClassification: vi.fn(),
      checkActiveTaxReview: async (tid: string) => {
        const active = await getActiveReviewForTenant(tid);
        return active ? { active: true, taxYear: active.taxYear } : { active: false };
      },
      answerTaxReview: async (tid: string, taxYear: number, text: string) => answerReviewMessage(tid, taxYear, text, callGeminiMock),
    };

    const editResult = await handleAgentMessage(
      { text: 'change total income to 80000', tenantId: 't1', channel: 'web' } as any,
      ctx as any,
    );

    expect(updateFilingField).toHaveBeenCalledWith('t1', 2025, 'T1', 'total_income_15000', 8000000);
    expect(editResult.data.message).toContain('$80,000');
    expect(filingRow.forms.T1.total_income_15000).toBe(8000000); // really recomputed and persisted

    // ── Step 5: confirm reply, same interception path, real submitFiling. ──
    const confirmResult = await handleAgentMessage(
      { text: 'looks good, submit it', tenantId: 't1', channel: 'web' } as any,
      ctx as any,
    );

    expect(submitFiling).toHaveBeenCalledTimes(1);
    expect(submitFiling).toHaveBeenCalledWith('t1', 2025);
    // The honest "exported, not filed" outcome from buildFilingOutcome —
    // no certified partner exists in this test's DB fixture, so this must
    // never claim the return was actually filed with the tax authority.
    expect(confirmResult.data.message).toContain('finalized and exported');
    expect(confirmResult.data.message).toContain('This is NOT a filing');
    expect(filingRow.status).toBe('exported');
    expect(filingRow.filedRef).toMatch(/^AB-/);
  });
});
