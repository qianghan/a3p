# Launch-gap PR-11: Web / MCP / Chatbot Surface Parity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two real, narrow web/MCP/chatbot parity gaps found in the launch-gap audit — tax fast-track's "regenerate a stuck draft" is web-only, and there's no friendly chat/MCP redirect for "connect my bank" — plus fix CLAUDE.md's stale "16 built-in skills" documentation (the real count is 84).

**Architecture:** Both behavioral fixes land in `plugins/agentbook-core/backend/src/agent-brain.ts`, **not** as new `BUILT_IN_SKILLS` manifest entries. This is a deliberate deviation from this plan's own initial investigation (which assumed a manifest-entry approach, mirroring `start-tax-fast-track`) — tracing the actual message pipeline in `handleAgentMessage()` shows Step 1c's `TAX_DRAFT_STATUS_RE` regex (`/\b(filing draft|client letter|tax (fast.?track )?draft)\b/i`) runs and can return a response **before** Step 3a's skill classification ever executes. A "regenerate my tax draft" message contains the phrase "tax draft," so it would already be intercepted and answered as a status check by Step 1c long before a new manifest-entry skill's trigger patterns were ever evaluated — a skill added there would simply never fire. The correct fix layers regenerate-intent detection directly inside Step 1c, exactly the way `answer`/`cancel` are already inline branches rather than manifest entries for this same tax-questionnaire feature. The Plaid redirect is a new, analogous inline step (Step 1d) for the same architectural reason — it must run before general LLM fallback, and has no natural trigger-pattern skill to attach to.

**Tech Stack:** `plugins/agentbook-core/backend/src/agent-brain.ts` (chat-skill pipeline shared by web, Telegram, WhatsApp, and MCP's `ask_agentbook` passthrough — a fix here is automatically live on all four transports with zero MCP-side code, per the roadmap's own architecture finding).

## Global Constraints

- **No new `BUILT_IN_SKILLS` manifest entries in this PR.** Both fixes are inline branches in `agent-brain.ts`'s `handleAgentMessage()`, for the pipeline-ordering reason explained above. Do not add anything to `built-in-skills.ts`.
- **Reuse, don't reinvent, the exact eligibility logic already live in `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts`**: paid add-on gate (`hasAddOn(tenantId, 'tax_fast_track')`), session must be `status === 'completed'`, and the existing draft row (if any) must be `null`, `'failed'`, or stale (`isDraftStale()`) — a `'ready'` or fresh `'pending'` draft is NOT eligible for regeneration. Do not duplicate the actual PDF/LLM generation logic (`generateFilingDraft`, which lives in `apps/web-next` and is unreachable from the backend package per its own doc comment) — mirror `start-tax-fast-track`'s existing pattern of returning `taxDraftReady: true` + `sessionId` in the response, which the already-existing `apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts` wrapper (lines ~157-162) already picks up and fires `generateFilingDraft` for, with zero changes needed at that call site.
- **The Plaid redirect is a message only** — this PR does not attempt to build any interactive bank-connect flow into chat/MCP (Plaid Link is a browser-only widget, a genuine, accepted architectural constraint per the roadmap). Name the exact real page (`/personal`) and button label ("Connect bank") verbatim, matching the existing `buildTaxDraftStatusResponse()` message style (short, names the exact UI location, no apology padding).
- **CLAUDE.md's skill count fix is the real, independently-verified number: 84** (confirmed three independent ways — named-field grep, unique-name grep, object-literal-brace grep — all agree, zero duplicates). Do not just bump "16" to "84" without also replacing the stale flat name-list with the category breakdown below, since the flat list would otherwise need 84 names to stay accurate and immediately go stale again the next time a skill is added.

---

### Task 1: Tax fast-track "regenerate a stuck draft" — chat/MCP parity

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/tax-draft-regenerate.test.ts`

**Interfaces:**
- Consumes: `hasAddOn` from `@naap/billing` (not currently imported in this file — add it), `getLatestTaxQuestionnaireSession`/`isDraftStale` from `./tax-questionnaire-session.js` (already imported), `db.abTaxFastTrackDraft` (Prisma).
- Produces: no new exports — this is an internal branch inside the existing Step 1c block of `handleAgentMessage()`.

- [ ] **Step 1: Write the failing test**

First, read `plugins/agentbook-core/backend/src/agent-brain.ts` lines ~1-30 (imports) and ~900-925 (the current Step 1c block) in full to confirm the exact current code before editing — this plan's investigation already quoted it, but confirm no drift.

```ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

const hasAddOn = vi.fn();
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: unknown[]) => hasAddOn(...args) }));

const dbMock = {
  abTaxFastTrackDraft: { findUnique: vi.fn() },
  abTaxQuestionnaireSession: { findFirst: vi.fn() },
  abConversation: { create: vi.fn().mockResolvedValue({}) },
};
vi.mock('./db/client.js', () => ({ db: dbMock }));

import { handleAgentMessage } from '../agent-brain';

function baseCtx() {
  return {
    classifyOnly: vi.fn(),
    executeClassification: vi.fn(),
    classifyAndExecuteV1: vi.fn(),
    callGemini: vi.fn(),
  } as any;
}

function baseReq(text: string) {
  return { text, tenantId: 'tenant-1', channel: 'web' } as any;
}

describe('tax draft regenerate — chat/MCP parity', () => {
  beforeEach(() => {
    hasAddOn.mockReset().mockResolvedValue(true);
    dbMock.abTaxFastTrackDraft.findUnique.mockReset();
    dbMock.abTaxQuestionnaireSession.findFirst.mockReset();
  });

  it('triggers regeneration (taxDraftReady + sessionId) when the existing draft has failed', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-1', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'failed', updatedAt: new Date(), errorMsg: 'boom' });

    const result = await handleAgentMessage(baseReq('please regenerate my tax draft'), baseCtx());

    expect(result.data.taxDraftReady).toBe(true);
    expect(result.data.sessionId).toBe('sess-1');
  });

  it('triggers regeneration when no draft row exists yet', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-2', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue(null);

    const result = await handleAgentMessage(baseReq('can you redo the filing draft'), baseCtx());

    expect(result.data.taxDraftReady).toBe(true);
    expect(result.data.sessionId).toBe('sess-2');
  });

  it('does NOT regenerate a draft that is already ready — explains instead', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-3', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'ready', updatedAt: new Date() });

    const result = await handleAgentMessage(baseReq('regenerate my filing draft please'), baseCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/already ready/i);
  });

  it('does NOT regenerate a fresh pending draft — explains instead', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-4', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'pending', updatedAt: new Date() }); // fresh, not stale

    const result = await handleAgentMessage(baseReq('retry generating my client letter'), baseCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/still generating/i);
  });

  it('rejects with an add-on message when tax_fast_track is not enabled', async () => {
    hasAddOn.mockResolvedValue(false);
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-5', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'failed', updatedAt: new Date() });

    const result = await handleAgentMessage(baseReq('regenerate my tax draft'), baseCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/paid add-on/i);
  });

  it('a plain status question ("how is my filing draft doing") is unaffected — still returns status, not regenerate', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'sess-6', tenantId: 'tenant-1', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'ready', updatedAt: new Date(), draftPdfUrl: 'https://x/draft.pdf', letterPdfUrl: 'https://x/letter.pdf', draftSummary: null, errorMsg: null });

    const result = await handleAgentMessage(baseReq('how is my filing draft doing'), baseCtx());

    expect(result.data.taxDraftReady).toBeFalsy();
    expect(result.data.message).toMatch(/ready/i);
    expect(result.data.message).toContain('draft.pdf');
  });
});
```

Adjust the mock setup for whatever this file's ACTUAL existing test conventions are — check `plugins/agentbook-core/backend/src/__tests__/` for any pre-existing `agent-brain*.test.ts` file first (the plan's investigation found `agent-brain-confirm-gate.test.ts`, `agent-brain-confidence-escalation.test.ts`, `agent-brain-confirm-flow.test.ts` already exist) and match their exact mocking style/imports rather than inventing a new one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-draft-regenerate.test.ts`
Expected: FAIL — no regenerate branch exists yet, so "regenerate"-phrased messages fall through to the existing status-only behavior (no `taxDraftReady`).

- [ ] **Step 3: Implement the fix**

Add near the top of `agent-brain.ts`, alongside the existing `TAX_DRAFT_STATUS_RE` constant (line ~211):
```ts
import { hasAddOn } from '@naap/billing';
```
(add to the existing import block, wherever this file's imports are grouped by source — match the existing style.)

```ts
const TAX_DRAFT_REGENERATE_INTENT_RE = /\b(re-?generate|redo|retry|try\s+again|generate.*again)\b/i;
```

Add a new handler function near `buildTaxDraftStatusResponse` (after it, ~line 520):
```ts
/**
 * Chat/MCP equivalent of POST /tax-fast-track/regenerate — same eligibility
 * checks as that route (paid add-on, session completed, draft null/failed/
 * stale), but instead of firing generateFilingDraft() itself (unreachable
 * from this backend package — see that route's own doc comment), returns
 * taxDraftReady + sessionId the same way start-tax-fast-track's handler
 * does; the existing apps/web-next agent/message route wrapper already
 * fires generateFilingDraft() whenever it sees that flag, so no change is
 * needed there.
 */
async function handleTaxDraftRegenerate(
  tenantId: string,
  sessionId: string,
  draftRow: { status: string; updatedAt: Date } | null,
  startTime: number,
): Promise<AgentResponse> {
  if (!(await hasAddOn(tenantId, 'tax_fast_track'))) {
    return buildResponse({
      message: 'Tax Fast-Track is a paid add-on — enable it in Settings to regenerate a filing draft.',
      skillUsed: 'tax-draft-regenerate', confidence: 1, latencyMs: Date.now() - startTime,
    });
  }
  if (draftRow && draftRow.status !== 'failed' && !isDraftStale(draftRow)) {
    const message = draftRow.status === 'ready'
      ? "Your filing draft is already ready — no need to regenerate it. Ask me for its status if you want the links again."
      : "Your filing draft is still generating — check back in a few minutes before regenerating.";
    return buildResponse({ message, skillUsed: 'tax-draft-regenerate', confidence: 1, latencyMs: Date.now() - startTime });
  }
  return buildResponse({
    message: "Regenerating your filing draft now — I'll let you know once it's ready.",
    skillUsed: 'tax-draft-regenerate', confidence: 1, sessionId, taxDraftReady: true, latencyMs: Date.now() - startTime,
  });
}
```

Find (in Step 1c, ~line 906-921):
```ts
  // ── Step 1c: Tax draft/letter status (chat + MCP parity, PR-5) ────────
  if (TAX_DRAFT_STATUS_RE.test(text.trim())) {
    const latest = await getLatestTaxQuestionnaireSession(tenantId);
    if (latest?.status === 'completed') {
      const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: latest.id } });
      return buildTaxDraftStatusResponse(draftRow, startTime);
    }
  }
```
Replace with:
```ts
  // ── Step 1c: Tax draft/letter status + regenerate (chat + MCP parity,
  // PR-5 / Launch-gap PR-11) ──────────────────────────────────────────
  if (TAX_DRAFT_STATUS_RE.test(text.trim())) {
    const latest = await getLatestTaxQuestionnaireSession(tenantId);
    if (latest?.status === 'completed') {
      const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: latest.id } });
      if (TAX_DRAFT_REGENERATE_INTENT_RE.test(text.trim())) {
        return handleTaxDraftRegenerate(tenantId, latest.id, draftRow, startTime);
      }
      return buildTaxDraftStatusResponse(draftRow, startTime);
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-draft-regenerate.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Run the full existing agentbook-core backend suite for regressions**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: same pre-existing, unrelated failures already documented across this session's prior PRs (`agent-brain-confidence-escalation`/`agent-brain-confirm-flow`/`agent-brain-confirm-gate`, all `db.abConvThread.findFirst` mock issues) — no new failures.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/__tests__/tax-draft-regenerate.test.ts
git commit -m "feat(parity): chat/MCP regenerate-stuck-tax-draft, matching the web /regenerate route's eligibility rules"
```

---

### Task 2: Plaid "connect my bank" friendly redirect for chat/MCP

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/plaid-connect-redirect.test.ts`

**Interfaces:** none new — a self-contained regex + response branch, no DB reads needed (this is a static redirect, not a stateful check).

**Context:** confirmed by this plan's investigation that a "connect my bank" chat message today falls all the way through to `general-question`'s LLM path (or, if Gemini is unavailable, an unrelated financial-summary fallback) — no skill, handler, or redirect exists. The real web entry point is `/personal`'s "Connect bank" button (`apps/web-next/src/app/(dashboard)/personal/page.tsx`).

- [ ] **Step 1: Write the failing test**

Add to a new file (or extend Task 1's test file's imports/mocks if that's cleaner given shared setup — controller's call at implementation time, based on whichever keeps each file focused):
```ts
import { describe, expect, it, vi } from 'vitest';
import { handleAgentMessage } from '../agent-brain';

function baseCtx() {
  return { classifyOnly: vi.fn(), executeClassification: vi.fn(), classifyAndExecuteV1: vi.fn(), callGemini: vi.fn() } as any;
}
function baseReq(text: string) {
  return { text, tenantId: 'tenant-1', channel: 'web' } as any;
}

describe('Plaid connect-bank chat/MCP redirect', () => {
  it('redirects "connect my bank" to the /personal page and Connect bank button, verbatim', async () => {
    const result = await handleAgentMessage(baseReq('can you connect my bank account'), baseCtx());
    expect(result.data.message).toMatch(/personal/i);
    expect(result.data.message).toMatch(/connect bank/i);
  });

  it('redirects "link my bank" the same way', async () => {
    const result = await handleAgentMessage(baseReq('I want to link my bank'), baseCtx());
    expect(result.data.message).toMatch(/personal/i);
  });

  it('redirects a bare mention of Plaid', async () => {
    const result = await handleAgentMessage(baseReq('how do I set up plaid'), baseCtx());
    expect(result.data.message).toMatch(/personal/i);
  });

  it('does NOT intercept bank-reconciliation questions (existing skill, unrelated)', async () => {
    const ctx = baseCtx();
    ctx.classifyOnly.mockResolvedValue({ skill: { name: 'bank-reconciliation' }, extractedParams: {}, confidence: 0.9, tenantConfig: {} });
    ctx.executeClassification.mockResolvedValue({
      selectedSkill: { name: 'bank-reconciliation' }, extractedParams: {}, confidence: 0.9, skillUsed: 'bank-reconciliation', skillResponse: null,
      responseData: { message: 'You have 3 unmatched transactions.', skillUsed: 'bank-reconciliation', confidence: 0.9 },
    });
    const result = await handleAgentMessage(baseReq('what is my bank reconciliation status'), ctx);
    expect(result.data.message).not.toMatch(/connect bank/i);
  });
});
```
Adjust to match whatever this file's real, established test-mocking convention turns out to be once Task 1 is implemented (reuse the exact same pattern for consistency within this PR).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/plaid-connect-redirect.test.ts`
Expected: FAIL — no redirect exists yet; the first 3 cases won't mention "personal"/"connect bank".

- [ ] **Step 3: Implement the fix**

Add near `TAX_DRAFT_REGENERATE_INTENT_RE` (Task 1):
```ts
const PLAID_CONNECT_BANK_RE = /\b(connect|link|set\s?up|sync)\b.{0,20}\bbank\b|\bplaid\b/i;
```

Add a new Step, immediately after Step 1c and before Step 2 (Context assembly) in `handleAgentMessage()`:
```ts
  // ── Step 1d: Plaid connect-bank redirect (chat + MCP parity,
  // Launch-gap PR-11) ─────────────────────────────────────────────────
  // Plaid Link is an interactive browser widget — it cannot run inside a
  // chat transport, and this PR deliberately does not attempt to build
  // one. This is a friendly, explicit pointer to the real page instead of
  // the generic LLM fallback (or worse, an unrelated financial summary)
  // a "connect my bank" message would otherwise fall through to.
  if (PLAID_CONNECT_BANK_RE.test(text.trim())) {
    return buildResponse({
      message: "I can't connect a bank account directly in chat — that needs the interactive Plaid widget. Open Personal Finance (/personal) in the app and tap \"Connect bank\".",
      skillUsed: 'plaid-connect-redirect', confidence: 1, latencyMs: Date.now() - startTime,
    });
  }
```
Place this AFTER Step 1c's block closes (so a genuine tax-draft-related message is never accidentally caught by this broader check first) and confirm via the test file's 4th case that `bank-reconciliation`-routed messages (which mention "bank" but not "connect"/"link"/"set up"/"sync") are unaffected — the regex's `\b(connect|link|set\s?up|sync)\b.{0,20}\bbank\b` requires one of those verbs near "bank," so a bare "bank reconciliation status" question does not match.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/agentbook-core/backend && npx vitest run src/__tests__/plaid-connect-redirect.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 5: Run the full existing agentbook-core backend suite for regressions**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: same pre-existing, unrelated failures as Task 1's Step 5 confirmed — no new failures, and Task 1's own 7 tests still pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/__tests__/plaid-connect-redirect.test.ts
git commit -m "feat(parity): friendly chat/MCP redirect for connect-my-bank asks, pointing to /personal"
```

---

### Task 3: Fix CLAUDE.md's stale skill count

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Re-derive the current skill list and category breakdown yourself**

Run: `grep -c "^    name: '" plugins/agentbook-core/backend/src/built-in-skills.ts` and cross-check with `grep -oE "name: '[a-zA-Z0-9_-]+'" plugins/agentbook-core/backend/src/built-in-skills.ts | sort -u | wc -l` — confirm the count still matches 84 (or note the new real count if it has drifted since this plan's investigation, and use whatever the CURRENT true count is, not a stale number from this plan text). Group by each skill's `category:` field (grep for `category: '` alongside each skill's `name:`) to produce an accurate table.

- [ ] **Step 2: Replace the stale line**

Find (in `CLAUDE.md`, in the "Agent Brain v2 Architecture" section):
```
**Skills (16 built-in):** record-expense, query-expenses, query-finance, scan-receipt, scan-document, create-invoice, simulate-scenario, proactive-alerts, expense-breakdown, categorize-expenses, edit-expense, split-expense, review-queue, manage-recurring, vendor-insights, general-question
```
Replace with (using the exact current count and category breakdown you derived in Step 1 — this is illustrative of the shape, verify every number against your own Step 1 output before committing):
```
**Skills (84 built-in, by category):** tax (23), invoicing (19), finance (15), bookkeeping (15), student (5), insights (3), planning (1), personal-finance (1), tax_benefits (1), observability (1). Full manifest: `plugins/agentbook-core/backend/src/built-in-skills.ts`.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: correct stale '16 built-in skills' count to the real 84, by category"
```

---

### Task 4: Full verification, PR, CI, merge, and deploy

**Files:** none (verification-only task).

- [ ] **Step 1: Run the full affected test suite**

Run: `cd plugins/agentbook-core/backend && npx vitest run`
Expected: Task 1's 7 new tests and Task 2's 4 new tests all pass; only the same pre-existing, unrelated chronic failures remain (confirm against a clean `origin/main` comparison if the failure count looks different than expected).

- [ ] **Step 2: Typecheck**

Run: `cd plugins/agentbook-core/backend && npx tsc --noEmit`
Expected: no new errors in `agent-brain.ts` or the two new test files.

- [ ] **Step 3: Manual verification against the local dev server**

Start the local stack per this repo's CLAUDE.md Quick Start. Using a tenant with the `tax_fast_track` add-on enabled and a completed questionnaire session whose draft is in a `failed` state (seed one directly if needed), send "regenerate my filing draft" through the chat UI and confirm the response acknowledges regeneration (not a status readout) and that `generateFilingDraft` actually fires (check server logs / the draft row's `updatedAt` bumping). Separately, send "connect my bank" and confirm the redirect message appears and names `/personal` and "Connect bank" correctly.

- [ ] **Step 4: Final whole-branch review**

Dispatch a code-reviewer subagent on a capable model pointed at the full diff from `origin/main` to this branch's HEAD. Ask it to specifically: (a) independently re-verify that Step 1c's placement (checking `TAX_DRAFT_REGENERATE_INTENT_RE` only inside the existing `TAX_DRAFT_STATUS_RE`-gated block) cannot be bypassed or double-fire — trace every code path that could reach this block; (b) confirm the new Step 1d (Plaid redirect) is placed correctly relative to Step 1c and Step 2, and doesn't shadow any other existing skill/regex check earlier in the pipeline (re-read Steps 0 through 1c in full to confirm no overlap); (c) confirm the regenerate handler's eligibility logic is byte-for-byte equivalent in intent to the web route's (`/regenerate`'s three-way check: no draft / failed / stale → eligible, everything else → not) by reading both side by side; (d) confirm CLAUDE.md's new skill count and category breakdown is accurate against a fresh, independent count of `built-in-skills.ts`.

- [ ] **Step 5: Push, open PR, wait for CI, merge, deploy**

Push the branch, open a PR (conventional-commit title, e.g. `feat(parity): tax-draft regenerate + Plaid redirect for chat/MCP (Launch-gap PR-11)`). Describe both behavioral fixes and the doc fix, and explicitly note per the roadmap's own framing that this closes the FINAL item in the launch-gap-closure-roadmap. Wait for CI; the chronic pre-existing `Audit`/`Build`/`Quality-Gates`/`Shell-Tests` failure pattern (confirmed unrelated to this branch across every prior PR this session) is expected and safe to merge past once reconfirmed for this specific PR's run — also sanity-check any CodeQL result the way Launch-gap PR-10 did (verify any flagged line is byte-for-byte unchanged from `origin/main` before treating it as a false positive; do not reflexively dismiss a genuine new finding). Merge normally (no `--admin`). Deploy via the established `vercel build --prod` + `vercel deploy --prebuilt --prod` flow — no schema changes, no production-data actions, no separate confirmation gate needed (this PR is pure chat-response logic plus a documentation fix).
