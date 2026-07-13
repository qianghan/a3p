# Tax Fast-Track Filing Draft + Client Letter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a fast-track tax questionnaire session (PR-3) completes, automatically generate a filing-draft PDF and an accountant client-letter PDF, and add a UI-native way to run the whole questionnaire from `TaxPackage.tsx` (not just chat).

**Architecture:** Extract PR-3's questionnaire state machine (start/answer/cancel) out of chat-only code in `server.ts`/`agent-brain.ts` into a plain, dependency-injected core module that both the existing chat skill and five new UI-facing HTTP routes call. On questionnaire completion, a new orchestrator combines last year's real `StandardTaxExtract` baseline with an LLM-extracted structured delta, feeds both into the existing (unmodified) `{us,ca}TaxBrackets.calculateTax()` bracket calculator for a real number, and renders two `@react-pdf/renderer` PDFs from the result.

**Tech Stack:** TypeScript, Prisma (`plugin_agentbook_core` schema), Vitest, `@react-pdf/renderer`, Next.js App Router API routes, React (plain `useState`/`useEffect`, no new state library), Playwright e2e.

## Global Constraints

- Every `callGemini()` call must check for a falsy return explicitly, before any `try/catch` around `JSON.parse` — `callGemini()` never throws; a missing key, HTTP error, or empty response are all a `null` return. This is the single most-repeated bug class across PR-1 through PR-3's reviews.
- No new tax-calculation logic — reuse `usTaxBrackets`/`caTaxBrackets`'s existing, unmodified `calculateTax(taxableIncomeCents, taxYear): TaxCalculation` from `packages/agentbook-jurisdictions/src/{us,ca}/tax-brackets.ts`.
- Do NOT use `getJurisdictionPack()`/`loadBuiltInPacks()` from `@agentbook/jurisdictions` (the root loader) — it requires `loadBuiltInPacks()` to have run as a side effect in the *same* Node module graph (only `agentbook-startup`'s backend does this today), and returns `undefined` silently otherwise. Import `usTaxBrackets`/`caTaxBrackets` directly by name, mirroring `tax-questionnaire-loader.ts`'s own explicit-map style.
- `callGemini` must be passed as an explicit function parameter (dependency injection) into every new core function — never imported directly from `server.ts` into the new core module. `server.ts` already imports from `agent-brain.ts`; if the new core module imported `callGemini` from `server.ts` and `agent-brain.ts` imported the core module, that would be a circular import (`server.ts` → `agent-brain.ts` → core module → `server.ts`). DI breaks the cycle with zero new files.
- `db.abTenantConfig`'s tenant-scoping column is named `userId`, not `tenantId` — `db.abTenantConfig.findFirst({ where: { userId: tenantId } })` is the correct (if confusingly named) lookup, copied verbatim from `classifyOnly()` in `server.ts:2938`.
- Every new failure path persists a categorized code, never a raw exception message or stack trace, mirroring `TaxPackageFailureCode` (`apps/web-next/src/lib/agentbook-tax-package.ts:84-90`).
- The regression tests `plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-recovery.test.ts` and `start-tax-fast-track-skill.test.ts` must pass **unchanged** (not edited) after Task 2's extraction — this is the proof the refactor preserved exact behavior. If a test needs editing to pass, that is a regression to fix, not a test to loosen.

---

## Task 1: Schema — `AbTaxFastTrackDraft` model

**Files:**
- Modify: `packages/database/prisma/schema.prisma` (add the new model directly after `AbTaxQuestionnaireSession`, which ends at line 2863)

**Interfaces:**
- Produces: the `AbTaxFastTrackDraft` Prisma model and generated client type, consumed by Task 4's orchestrator and Task 6's `/status`/`/regenerate` routes.

- [ ] **Step 1: Add the model**

Insert immediately after the `AbTaxQuestionnaireSession` model's closing `}` (currently `schema.prisma:2863`):

```prisma
model AbTaxFastTrackDraft {
  id           String   @id @default(uuid())
  tenantId     String
  sessionId    String   @unique
  taxYear      Int
  jurisdiction String
  status       String   @default("pending") // pending | ready | failed
  draftPdfUrl  String?
  letterPdfUrl String?
  draftSummary Json?
  errorMsg     String?
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  @@index([tenantId])
  @@schema("plugin_agentbook_core")
}
```

- [ ] **Step 2: Format and validate**

Run:
```bash
cd packages/database && npx prisma format
DATABASE_URL="postgresql://x:x@localhost:5432/x" DATABASE_URL_UNPOOLED="postgresql://x:x@localhost:5432/x" npx prisma validate
```
Expected: `The schema at prisma/schema.prisma is valid 🚀` (the dummy `DATABASE_URL` values are sufficient — `validate` only parses the schema, it doesn't connect).

- [ ] **Step 3: Push to an isolated verify database and confirm a round trip**

Do NOT push against the shared local `naap` database other worktrees may be using concurrently — create a throwaway database name for this verification only:

```bash
docker compose up -d database
docker exec -it $(docker compose ps -q database) createdb -U postgres naap_verify_pr4filingdraft
cd packages/database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_verify_pr4filingdraft" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_verify_pr4filingdraft" \
npx prisma db push --skip-generate
npx prisma generate
```
Expected: `Your database is now in sync with your Prisma schema.` and a successful client generation with no errors.

Then confirm the table round-trips a row:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap_verify_pr4filingdraft" \
DATABASE_URL_UNPOOLED="postgresql://postgres:postgres@localhost:5432/naap_verify_pr4filingdraft" \
npx tsx -e "
import { prisma } from '@naap/database';
(async () => {
  const row = await prisma.abTaxFastTrackDraft.create({
    data: { tenantId: 't1', sessionId: 'verify-session-1', taxYear: 2025, jurisdiction: 'us' },
  });
  console.log('created', row.id, row.status);
  const found = await prisma.abTaxFastTrackDraft.findUnique({ where: { sessionId: 'verify-session-1' } });
  console.log('found', found?.id === row.id);
  await prisma.abTaxFastTrackDraft.delete({ where: { id: row.id } });
  await prisma.\$disconnect();
})();
"
```
Expected output: `created <uuid> pending` then `found true`, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/database/prisma/schema.prisma
git commit -m "feat(tax): AbTaxFastTrackDraft schema (PR-4, Task 1)"
```

---

## Task 2: Extract PR-3's questionnaire state machine into a shared core module

**This is the highest-risk task in this plan** — it touches already-shipped, production-verified PR-3 code (`server.ts`'s `start-tax-fast-track` handler and `agent-brain.ts`'s "Step 1b"). The goal is a **mechanical** extraction: move the logic, change nothing observable. The two existing regression test files are the proof.

**Files:**
- Create: `plugins/agentbook-core/backend/src/tax-questionnaire-core.ts`
- Modify: `plugins/agentbook-core/backend/src/server.ts:4267-4424` (replace the `start-tax-fast-track` handler body with a thin wrapper); also delete the now-dead `cleanJsonForTaxFastTrack` helper at `server.ts:1149-1167` (its only caller moves into the new core module)
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts:874-1029` (replace Step 1b's body with a thin wrapper); also delete the now-dead `cleanJson` helper at `agent-brain.ts:464-472` and the now-dead `handleTaxQuestionnaireFailure` function at `agent-brain.ts:474-522` (their logic moves into the new core module; keep `TAX_QUESTIONNAIRE_CANCEL_RE` at line 203 — cancel-keyword detection stays chat-specific)
- Test: `plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-recovery.test.ts` (existing — run unchanged as the regression gate)
- Test: `plugins/agentbook-core/backend/src/__tests__/start-tax-fast-track-skill.test.ts` (existing — run unchanged as the regression gate)

**Interfaces:**
- Produces: `CoreResult` type, `startTaxQuestionnaire(tenantId, params, callGemini)`, `answerTaxQuestionnaire(tqSession, text, callGemini)`, `cancelTaxQuestionnaire(tqSession)`, `type CallGeminiFn`, `cleanJson(raw: string): string` (exported — Task 4's orchestrator reuses it) — all from `tax-questionnaire-core.ts`. Consumed by Task 5 (which adds the `generateFilingDraft` call on completion) and Task 6 (new UI routes call these same three functions directly).
- Consumes: `createTaxQuestionnaireSession`/`getActiveTaxQuestionnaireSession`/`updateTaxQuestionnaireSession`/`QaPair` from `./tax-questionnaire-session.js` (PR-3, unchanged), `getTaxQuestionnairePack`/`listSupportedJurisdictions` from `@agentbook/jurisdictions/tax-questionnaire-loader` (PR-3, unchanged), `listPastFilingsForTenant` from `./past-filing-context.js`, `buildPersonalProfileContext` from `./personal-profile-context.js`.

- [ ] **Step 1: Write `tax-questionnaire-core.ts`**

```ts
import { db } from './db/client.js';
import { listPastFilingsForTenant } from './past-filing-context.js';
import {
  createTaxQuestionnaireSession,
  updateTaxQuestionnaireSession,
  type QaPair,
} from './tax-questionnaire-session.js';
import { getTaxQuestionnairePack, listSupportedJurisdictions } from '@agentbook/jurisdictions/tax-questionnaire-loader';
import type { StandardTaxExtract, TaxQuestionnairePack } from '@agentbook/jurisdictions/interfaces';
import { buildPersonalProfileContext } from './personal-profile-context.js';

/**
 * Extracted from PR-3's chat-only code (server.ts's `start-tax-fast-track`
 * INTERNAL handler + agent-brain.ts's "Step 1b" session-recovery branch) so
 * the same state machine can be driven by chat AND by plain UI-facing HTTP
 * routes (PR-4, Task 6) without duplicating cancel-keyword handling,
 * pending-question recovery, the consecutive-failure cap, or version-guarded
 * updates in two places. See docs/superpowers/specs/2026-07-13-tax-fast-
 * track-filing-draft-design.md ("Shared core: extracting PR-3's state
 * machine").
 *
 * No chat-specific concerns here — no `skillUsed`, no `AgentResponse`
 * shape, no `confidence`. Callers (agent-brain.ts's Step 1b, server.ts's
 * start-tax-fast-track handler, and PR-4's new UI routes) translate
 * `CoreResult` into whatever their own response shape needs.
 */
export type CoreResult =
  | { status: 'question'; question: string; sessionId: string }
  | { status: 'done'; sessionId: string }
  | { status: 'blocked'; message: string }
  | { status: 'failed'; message: string; sessionId?: string }
  | { status: 'cancelled'; sessionId: string };

/**
 * callGemini() has the real signature (systemPrompt, userMessage, maxTokens?)
 * => Promise<string | null> and NEVER throws — a missing key, HTTP error, or
 * empty response are all a `null` return, not an exception. Passed in by
 * every caller (never imported from server.ts) to avoid a circular import:
 * server.ts already imports from agent-brain.ts, and agent-brain.ts imports
 * this module, so this module importing callGemini FROM server.ts would
 * close the cycle.
 */
export type CallGeminiFn = (systemPrompt: string, userMessage: string, maxTokens?: number) => Promise<string | null>;

/**
 * Strip markdown code-fence wrapping from an LLM's raw JSON string before
 * JSON.parse'ing it. This is the single copy of a helper that used to be
 * duplicated three ways (server.ts's `cleanJsonForTaxFastTrack`,
 * agent-brain.ts's `cleanJson`, and tax-past-filings.ts's private
 * `cleanJson`) — the first two collapse into this one now that their only
 * callers live in the same file. Exported so Task 4's `generateFilingDraft`
 * orchestrator can reuse it too, rather than adding a fourth copy.
 */
export function cleanJson(raw: string): string {
  let s = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first > 0 || (last >= 0 && last < s.length - 1)) {
    if (first >= 0 && last > first) s = s.slice(first, last + 1);
  }
  return s;
}

/**
 * Shared failure-turn handling, used both when callGemini() returns falsy
 * and when the fence-strip/JSON.parse/parseNextQuestionResponse() step
 * throws on malformed content. Deliberately does NOT touch qaHistory/
 * askedCount/expiresAt — only consecutiveFailures advances, so the next
 * answer re-attempts the SAME pending question. At consecutiveFailures >= 3
 * the session is marked 'abandoned' instead (a small safety cap distinct
 * from the 8-question content cap).
 */
async function handleFailureTurn(tqSession: any): Promise<CoreResult> {
  const nextFailures = (tqSession.consecutiveFailures || 0) + 1;
  const abandon = nextFailures >= 3;

  const ok = await updateTaxQuestionnaireSession(tqSession.id, tqSession.version, {
    consecutiveFailures: nextFailures,
    ...(abandon ? { status: 'abandoned' } : {}),
  });

  if (!ok) {
    // No sessionId here — matches the original handleTaxQuestionnaireFailure
    // exactly (agent-brain.ts:501-511 omits it on the version-conflict path
    // specifically, while the two "real" failure messages below DO carry
    // it). Preserve this asymmetry; it is deliberate in the original, not
    // an inconsistency to "fix."
    return { status: 'failed', message: 'Session was modified by another process. Please try again.' };
  }

  return {
    status: 'failed',
    message: abandon
      ? "I'm having trouble processing your answers right now, so I've paused the tax questionnaire. Feel free to start it again in a bit."
      : "Sorry, something went wrong on my end — could you try answering that again?",
    sessionId: tqSession.id,
  };
}

/**
 * Turn 1: find a confirmed prior-year filing, create the session, get the
 * first question. `params.triggerText` is the exact user message that
 * triggered this (chat) or '' (UI's plain Start button) — passed through to
 * callGemini as extra context, matching the original chat behavior exactly.
 */
export async function startTaxQuestionnaire(
  tenantId: string,
  params: { taxYear?: number; jurisdiction?: string; region?: string | null; triggerText?: string },
  callGemini: CallGeminiFn,
): Promise<CoreResult> {
  const allFilings: any[] = await listPastFilingsForTenant(tenantId);
  const confirmedFilings = allFilings.filter((f: any) => f.status === 'confirmed');

  if (confirmedFilings.length === 0) {
    return {
      status: 'blocked',
      message: "I don't have a confirmed prior-year return to fast-track from yet. Upload last year's return on the **Tax Package** page → Past Filings tab, confirm it, and then just ask me again.",
    };
  }

  const filing = confirmedFilings.reduce((latest: any, f: any) => (f.taxYear > latest.taxYear ? f : latest));

  const taxYear = params.taxYear || 2025;
  const jurisdiction = (params.jurisdiction || 'us').toLowerCase();
  const region = params.region ?? null;

  if (!listSupportedJurisdictions().includes(jurisdiction)) {
    return {
      status: 'blocked',
      message: "Tax fast-track isn't available for your jurisdiction yet — I can still help with the regular tax filing flow, just ask.",
    };
  }

  const session = await createTaxQuestionnaireSession(tenantId, taxYear, jurisdiction, region, 'fast_track', filing.id);

  const pack = getTaxQuestionnairePack(jurisdiction);
  const profile = await buildPersonalProfileContext(tenantId).catch(() => '');
  const prompt = pack.nextQuestionPrompt({ qaHistory: [], priorFiling: filing.extractedData, profile });

  const raw = await callGemini(prompt, params.triggerText || 'Start the tax fast-track questionnaire.', 300);

  let outcome: { question: string } | { done: true } | null = null;
  if (raw) {
    try {
      outcome = pack.parseNextQuestionResponse(JSON.parse(cleanJson(raw)));
    } catch {
      outcome = null;
    }
  }

  if (!outcome) {
    await updateTaxQuestionnaireSession(session.id, session.version, { status: 'abandoned' }).catch(() => {});
    // No sessionId surfaced here — matches the original chat behavior
    // exactly (server.ts's turn-1-failure branch never included one).
    return { status: 'failed', message: 'Something went wrong setting up your tax questionnaire — could you try asking again?' };
  }

  if ('done' in outcome) {
    await updateTaxQuestionnaireSession(session.id, session.version, { status: 'completed' });
    return { status: 'done', sessionId: session.id };
  }

  const ok = await updateTaxQuestionnaireSession(session.id, session.version, {
    qaHistory: [{ question: outcome.question, answer: '' }],
    askedCount: 1,
  });
  if (!ok) {
    // Also no sessionId here — matches the original exactly.
    return { status: 'failed', message: 'Something went wrong setting up your tax questionnaire — could you try asking again?' };
  }

  return { status: 'question', question: outcome.question, sessionId: session.id };
}

/**
 * Turn 2+: recover the pending question from qaHistory's last entry,
 * finalize it with the user's answer, get the next question (or complete).
 * `tqSession` must already have been fetched by the caller via
 * `getActiveTaxQuestionnaireSession(tenantId)` — this function does not
 * re-fetch it, matching PR-3's original code exactly (Step 1b always
 * operated on an already-fetched session).
 */
export async function answerTaxQuestionnaire(
  tqSession: any,
  text: string,
  callGemini: CallGeminiFn,
): Promise<CoreResult> {
  const trimmedText = text.trim();

  const qaHistory = ((tqSession.qaHistory as QaPair[]) || []).slice();
  const lastEntry = qaHistory.length > 0 ? qaHistory[qaHistory.length - 1] : null;
  const pending = lastEntry && lastEntry.answer === '' ? lastEntry : null;

  if (!pending) {
    // Data-invariant violation — should never happen once
    // startTaxQuestionnaire always seeds a pending entry at creation.
    return handleFailureTurn(tqSession);
  }

  const answeredHistory: QaPair[] = [
    ...qaHistory.slice(0, -1),
    { question: pending.question, answer: trimmedText || text },
  ];

  let priorFiling: StandardTaxExtract | undefined;
  if (tqSession.sourceFilingId) {
    const filing = await db.abPastTaxFiling.findUnique({ where: { id: tqSession.sourceFilingId } }).catch(() => null);
    priorFiling = (filing?.extractedData as StandardTaxExtract | undefined) || undefined;
  }
  const profile = await buildPersonalProfileContext(tqSession.tenantId).catch(() => '');

  let pack: TaxQuestionnairePack;
  try {
    pack = getTaxQuestionnairePack(tqSession.jurisdiction);
  } catch {
    return handleFailureTurn(tqSession);
  }
  const prompt = pack.nextQuestionPrompt({ qaHistory: answeredHistory, priorFiling, profile });

  const raw = await callGemini(prompt, text, 300);

  let outcome: { question: string } | { done: true } | null = null;
  if (raw) {
    try {
      const parsed = JSON.parse(cleanJson(raw));
      outcome = pack.parseNextQuestionResponse(parsed);
    } catch {
      outcome = null;
    }
  }

  if (!outcome) {
    return handleFailureTurn(tqSession);
  }

  const isDone = 'done' in outcome || tqSession.askedCount >= 8;

  const finalQaHistory: QaPair[] = isDone
    ? answeredHistory
    : [...answeredHistory, { question: (outcome as { question: string }).question, answer: '' }];

  const ok = await updateTaxQuestionnaireSession(tqSession.id, tqSession.version, {
    qaHistory: finalQaHistory,
    consecutiveFailures: 0,
    expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    status: isDone ? 'completed' : 'in_progress',
    ...(isDone ? {} : { askedCount: tqSession.askedCount + 1 }),
  });

  if (!ok) {
    // No sessionId — matches agent-brain.ts:1009-1017's version-conflict
    // return exactly (unlike the cancel/done/question paths below, which
    // all carry it).
    return { status: 'failed', message: 'Session was modified by another process. Please try again.' };
  }

  if (isDone) {
    return { status: 'done', sessionId: tqSession.id };
  }
  return { status: 'question', question: (outcome as { question: string }).question, sessionId: tqSession.id };
}

/** `tqSession` must already have been fetched by the caller, same as `answerTaxQuestionnaire`. */
export async function cancelTaxQuestionnaire(tqSession: any): Promise<CoreResult> {
  const ok = await updateTaxQuestionnaireSession(tqSession.id, tqSession.version, { status: 'abandoned' });
  if (!ok) {
    // No sessionId — matches agent-brain.ts:899-906's version-conflict
    // return exactly.
    return { status: 'failed', message: 'Session was modified by another process. Please try again.' };
  }
  return { status: 'cancelled', sessionId: tqSession.id };
}
```

- [ ] **Step 2: Rewire `agent-brain.ts`'s Step 1b as a thin wrapper**

First, add the import (near the existing `getActiveTaxQuestionnaireSession` import at `agent-brain.ts:16`):

```ts
import { getActiveTaxQuestionnaireSession } from './tax-questionnaire-session.js';
import { answerTaxQuestionnaire, cancelTaxQuestionnaire, type CoreResult } from './tax-questionnaire-core.js';
```

(Note: `updateTaxQuestionnaireSession` is dropped from this import — it's no longer called directly in this file. `QaPair` is ALSO dropped entirely — every reference to it in this file lives inside the Step 1b block being deleted (lines 929, 941, 997); keeping the import after deleting its only uses would fail the backend package's `tsc` build under `noUnusedLocals` (`tsconfig.base.json`). Verify with `grep -n "QaPair" plugins/agentbook-core/backend/src/agent-brain.ts` after Step 2 — it must return zero matches. The old `getTaxQuestionnairePack`, `StandardTaxExtract`, `TaxQuestionnairePack` imports at lines 17-18 are also dropped — they're now only used inside `tax-questionnaire-core.ts`.)

Delete `cleanJson` (`agent-brain.ts:464-472`) and `handleTaxQuestionnaireFailure` (`agent-brain.ts:474-522`) entirely — both are now dead code, their logic lives in `tax-questionnaire-core.ts`.

Add a small translation helper in their place:

```ts
/** Maps a CoreResult (tax-questionnaire-core.ts) into this file's chat AgentResponse shape. */
function translateTaxCoreResult(result: CoreResult, startTime: number): AgentResponse {
  if (result.status === 'cancelled') {
    return buildResponse({
      message: "No problem — I've cancelled the tax questionnaire. Just say the word if you want to start it again later.",
      skillUsed: 'tax-questionnaire', confidence: 1, sessionId: result.sessionId, latencyMs: Date.now() - startTime,
    });
  }
  if (result.status === 'question') {
    return buildResponse({
      message: result.question, skillUsed: 'tax-questionnaire', confidence: 1, sessionId: result.sessionId, latencyMs: Date.now() - startTime,
    });
  }
  if (result.status === 'done') {
    return buildResponse({
      message: "Got everything I need — I'll have your filing draft ready shortly.",
      skillUsed: 'tax-questionnaire', confidence: 1, sessionId: result.sessionId, latencyMs: Date.now() - startTime,
    });
  }
  // 'failed' and 'blocked' both just carry a message; 'blocked' never
  // actually occurs from answer/cancel (only startTaxQuestionnaire returns
  // it), included for type exhaustiveness.
  return buildResponse({
    message: result.message, skillUsed: 'tax-questionnaire', confidence: 1, sessionId: (result as { sessionId?: string }).sessionId, latencyMs: Date.now() - startTime,
  });
}
```

Now replace the whole Step 1b block (`agent-brain.ts:874-1029`) with:

```ts
  // ── Step 1b: Tax-questionnaire session recovery ───────────────────────
  // Parallel to (not inside) the AbAgentSession branch above. Mutual
  // exclusion (createSession() in agent-planner.ts and
  // createTaxQuestionnaireSession() in tax-questionnaire-session.ts each
  // expire the OTHER session type for the tenant on creation) guarantees at
  // most one of the two session types is ever active for a given tenant, so
  // this check and the one above never both need to claim the same reply.
  //
  // Expiry note: getActiveTaxQuestionnaireSession() already filters
  // `expiresAt: { gt: now }` in its own query (tax-questionnaire-session.ts),
  // so an expired session simply isn't returned here — there is no separate
  // expiry check needed in this branch. A lapsed session falls through to
  // normal message classification below with zero extra code, exactly like
  // it never existed.
  //
  // The state-machine logic itself (cancel-keyword handling aside) lives in
  // tax-questionnaire-core.ts (PR-4, Task 2) so the same functions can be
  // driven from plain UI-facing HTTP routes, not just chat. This branch is
  // now a thin translation layer: fetch the session, decide cancel vs
  // answer, call the shared core function, translate its CoreResult into
  // this file's chat AgentResponse shape.
  const tqSession = await getActiveTaxQuestionnaireSession(tenantId);

  if (tqSession) {
    const trimmedText = text.trim();

    if (TAX_QUESTIONNAIRE_CANCEL_RE.test(trimmedText)) {
      const result = await cancelTaxQuestionnaire(tqSession);
      return translateTaxCoreResult(result, startTime);
    }

    const result = await answerTaxQuestionnaire(tqSession, text, ctx.callGemini);
    return translateTaxCoreResult(result, startTime);
  }
```

- [ ] **Step 3: Rewire `server.ts`'s `start-tax-fast-track` handler as a thin wrapper**

Add the import near the existing `createTaxQuestionnaireSession`/`updateTaxQuestionnaireSession` import (`server.ts:20`):

```ts
import { startTaxQuestionnaire } from './tax-questionnaire-core.js';
```

(The old `createTaxQuestionnaireSession`/`updateTaxQuestionnaireSession` import at that line, and the `getTaxQuestionnairePack`/`listSupportedJurisdictions` import at line 21, can both be dropped from `server.ts` if nothing else in the file uses them — check with `grep -n "createTaxQuestionnaireSession\|updateTaxQuestionnaireSession\|getTaxQuestionnairePack\|listSupportedJurisdictions" plugins/agentbook-core/backend/src/server.ts` after this step; if any other handler in the file still calls them, keep the import.)

Delete `cleanJsonForTaxFastTrack` (`server.ts:1149-1167`) — dead code, its only caller moves into `tax-questionnaire-core.ts`.

Replace the whole handler body (`server.ts:4274-4424`, i.e. everything inside `if (selectedSkill.name === 'start-tax-fast-track') { ... }`) with:

```ts
  if (selectedSkill.name === 'start-tax-fast-track') {
    try {
      const jurisdiction = (classification.tenantConfig?.jurisdiction || 'us').toLowerCase();
      const region = classification.tenantConfig?.region || null;
      const result = await startTaxQuestionnaire(
        tenantId,
        { taxYear: extractedParams.taxYear, jurisdiction, region, triggerText: text },
        callGemini,
      );

      let message: string;
      let sessionId: string | undefined;
      if (result.status === 'blocked' || result.status === 'failed') {
        message = result.message;
        sessionId = result.status === 'failed' ? result.sessionId : undefined;
      } else if (result.status === 'done') {
        message = "Got everything I need from your last return — I'll have your filing draft ready shortly.";
        sessionId = result.sessionId;
      } else {
        // 'question' — the only remaining case ('cancelled' never occurs
        // from startTaxQuestionnaire).
        message = result.question;
        sessionId = result.sessionId;
      }

      await db.abConversation.create({ data: { tenantId, question: text || '[tax fast track]', answer: message, queryType: 'agent', channel, skillUsed: 'start-tax-fast-track' } }).catch(() => {});
      return {
        selectedSkill, extractedParams, confidence: 1, skillUsed: 'start-tax-fast-track',
        skillResponse: sessionId ? { data: { sessionId } } : null,
        responseData: { message, actions: [], chartData: null, skillUsed: 'start-tax-fast-track', confidence: 1, ...(sessionId ? { sessionId } : {}), latencyMs: Date.now() - startTime },
      };
    } catch (err) {
      console.error('[start-tax-fast-track] error:', err);
      return {
        selectedSkill, extractedParams, confidence: 0, skillUsed: 'start-tax-fast-track', skillResponse: null,
        responseData: { message: "I couldn't start the fast-track questionnaire. Please try again.", actions: [], chartData: null, skillUsed: 'start-tax-fast-track', confidence: 0, latencyMs: Date.now() - startTime },
      };
    }
  }
```

- [ ] **Step 4: Run the regression gate — both existing test files, unchanged**

```bash
cd plugins/agentbook-core/backend
npx vitest run src/__tests__/tax-questionnaire-recovery.test.ts src/__tests__/start-tax-fast-track-skill.test.ts
```
Expected: all tests in both files pass, with zero edits made to either test file. If anything fails, the cause is almost certainly a mismatched literal (an exact message string, or which fields are present in a response object) between the original code and the new wrapper — compare the failing assertion against this task's Step 2/3 code line by line before touching the test file itself.

- [ ] **Step 5: Run the full backend suite to confirm no other regressions**

```bash
npx vitest run
```
Expected: the same pass/fail counts as PR-3's final state (253 passed / 12 failed, all 12 pre-existing and unrelated — 11 from the `abConvThread` mock gap in `agent-brain-confirm-gate.test.ts`/`agent-brain-confidence-escalation.test.ts`/`agent-brain-confirm-flow.test.ts`, 1 the known `"invoice Acme..."` routing case). Any NEW failure beyond that set must be fixed before continuing.

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-core/backend/src/tax-questionnaire-core.ts plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/server.ts
git commit -m "refactor(tax): extract questionnaire state machine into shared core (PR-4, Task 2)"
```

---

## Task 3: `FilingDraftPack` interface + us/ca implementations + loader

Independent of Task 2 — can be worked on in parallel. No LLM call happens inside the pack; it only builds prompt strings and parses already-parsed JSON, exactly matching `TaxQuestionnairePack`'s convention.

**Files:**
- Modify: `packages/agentbook-jurisdictions/src/interfaces.ts` (add `FilingDraftDeltas`, `FilingDraftSummary`, `FilingDraftPack` after the existing `TaxQuestionnairePack` block, which ends at line 207)
- Create: `packages/agentbook-jurisdictions/src/us/filing-draft-pack.ts`
- Create: `packages/agentbook-jurisdictions/src/ca/filing-draft-pack.ts`
- Create: `packages/agentbook-jurisdictions/src/filing-draft-loader.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/us-filing-draft-pack.test.ts`
- Test: `packages/agentbook-jurisdictions/src/__tests__/ca-filing-draft-pack.test.ts`

**Interfaces:**
- Produces: `FilingDraftDeltas`, `FilingDraftSummary` (both exported from `interfaces.ts`), `FilingDraftPack` interface, `UsFilingDraftPack`/`CaFilingDraftPack` classes, `getFilingDraftPack(jurisdiction)`/`listSupportedJurisdictions()` from `filing-draft-loader.ts` — all consumed by Task 4's orchestrator.
- Consumes: `QaPair` shape (`{question, answer}` — matches PR-3's `QaPair` structurally, but this package can't import from the `agentbook-core` plugin, so the interface inlines the same shape rather than importing PR-3's type), `StandardTaxExtract` from this same file.

- [ ] **Step 1: Add the interfaces**

Insert into `packages/agentbook-jurisdictions/src/interfaces.ts`, immediately after `TaxQuestionnairePack`'s closing `}` (currently line 207):

```ts
// ─── Tax Fast-Track Filing Draft + Client Letter ─────────────────────────────
// Generates the two artifacts a completed TaxQuestionnairePack session
// produces (PR-4). Two pure/synchronous prompt-builder+parser pairs, same
// convention as TaxQuestionnairePack — the pack never calls an LLM and never
// sees a raw string. The numeric estimate does NOT come from the LLM: the
// caller (generateFilingDraft) feeds extractDeltasPrompt's STRUCTURED delta
// output into the existing, tested {us,ca}TaxBrackets.calculateTax() for the
// real number, then clientLetterPrompt narrates using that real number. See
// docs/superpowers/specs/2026-07-13-tax-fast-track-filing-draft-design.md
// ("Numbers come from the real bracket calculator, not the LLM's
// imagination.").

export interface FilingDraftDeltas {
  /** This year vs. last year, signed (e.g. +5 for "roughly the same, maybe a little higher"); omitted if qaHistory gave no usable signal. */
  incomeDeltaPercent?: number
  filingStatusChanged?: boolean
  newFilingStatus?: string
  /** Net change in dependent count. */
  dependentsDelta?: number
  /** Plain-language bullets, for direct display on the review screen and in the PDF. */
  changesFromLastYear: string[]
  /** Things the accountant should double check. */
  openQuestions: string[]
}

export interface FilingDraftSummary {
  /** Omitted (never guessed) if priorFiling lacked a usable baseline number. */
  estimatedTotalIncomeCents?: number
  estimatedTaxableIncomeCents?: number
  /** From calculateTax(), never LLM-invented. */
  estimatedTaxPayableCents?: number
  /**
   * estimatedTaxPayableCents minus priorFiling.taxPayableCents — how this
   * year's estimated liability compares to what was actually owed last
   * year. Deliberately NOT a "refund or balance owing" figure: that would
   * require this year's withholding/estimated-payments data, which this
   * fast-track flow never collects. A liability comparison is the most
   * honest number computable from what's actually on hand.
   */
  taxPayableDeltaVsLastYearCents?: number
  changesFromLastYear: string[]
  openQuestions: string[]
  /** Always present: "this is an estimate, not a filed return." */
  caveat: string
}

export interface FilingDraftPack {
  jurisdiction: string
  extractDeltasPrompt(input: {
    qaHistory: { question: string; answer: string }[]
    priorFiling: StandardTaxExtract
  }): string
  parseDeltas(parsed: unknown): FilingDraftDeltas
  clientLetterPrompt(input: {
    qaHistory: { question: string; answer: string }[]
    priorFiling: StandardTaxExtract
    summary: FilingDraftSummary
  }): string
  parseClientLetter(parsed: unknown): { letterBody: string }
}
```

- [ ] **Step 2: Write `us/filing-draft-pack.ts`**

```ts
import type { FilingDraftPack, FilingDraftDeltas, FilingDraftSummary, StandardTaxExtract } from '../interfaces.js';

export class UsFilingDraftPack implements FilingDraftPack {
  jurisdiction = 'us';

  extractDeltasPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
  }): string {
    const { qaHistory, priorFiling } = input;
    const qaBlock = qaHistory.map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`).join('\n');
    const priorFilingBlock = `- Form type: ${priorFiling.formType} (tax year ${priorFiling.taxYear})
- State: ${priorFiling.region || 'unknown'}
- Prior-year total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-US')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-US')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`;

    return `You are an experienced US tax preparer reviewing a completed client intake interview to identify what's DIFFERENT about this year's filing compared to last year's confirmed return. You do NOT calculate any tax figures yourself — that happens separately from real bracket tables. Your only job is to extract structured signal from the interview answers below.

--- Prior year's confirmed filing (baseline) ---
${priorFilingBlock}

--- This year's intake interview ---
${qaBlock}

From the interview, determine:
- Roughly how this year's total income compares to last year's, as a signed percentage (e.g. +5 for "a little higher", -10 for "noticeably lower", omit entirely if the client gave no usable signal on income).
- Whether filing status changed, and if so what it changed to.
- The net change in number of dependents (a signed integer; 0 if explicitly unchanged, omit if not discussed).
- A short list of plain-language bullets describing what's materially different from last year (skip this if nothing changed).
- A short list of open questions this client's accountant should double-check before filing (things the interview didn't fully resolve, or that need professional judgment).

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"incomeDeltaPercent": <number, optional>, "filingStatusChanged": <boolean, optional>, "newFilingStatus": "<string, optional>", "dependentsDelta": <number, optional>, "changesFromLastYear": ["<bullet>", ...], "openQuestions": ["<bullet>", ...]}`;
  }

  parseDeltas(parsed: unknown): FilingDraftDeltas {
    const r = parsed as any;
    if (!r || typeof r !== 'object') {
      throw new Error('Unexpected delta-extraction response shape: ' + JSON.stringify(parsed));
    }
    return {
      incomeDeltaPercent: typeof r.incomeDeltaPercent === 'number' ? r.incomeDeltaPercent : undefined,
      filingStatusChanged: typeof r.filingStatusChanged === 'boolean' ? r.filingStatusChanged : undefined,
      newFilingStatus: typeof r.newFilingStatus === 'string' ? r.newFilingStatus : undefined,
      dependentsDelta: typeof r.dependentsDelta === 'number' ? r.dependentsDelta : undefined,
      changesFromLastYear: Array.isArray(r.changesFromLastYear) ? r.changesFromLastYear.filter((x: unknown) => typeof x === 'string') : [],
      openQuestions: Array.isArray(r.openQuestions) ? r.openQuestions.filter((x: unknown) => typeof x === 'string') : [],
    };
  }

  clientLetterPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
    summary: FilingDraftSummary;
  }): string {
    const { summary } = input;
    const numbersBlock = summary.estimatedTaxPayableCents != null
      ? `- Estimated total income: ${summary.estimatedTotalIncomeCents != null ? `$${(summary.estimatedTotalIncomeCents / 100).toLocaleString('en-US')}` : 'not estimated'}
- Estimated taxable income: ${summary.estimatedTaxableIncomeCents != null ? `$${(summary.estimatedTaxableIncomeCents / 100).toLocaleString('en-US')}` : 'not estimated'}
- Estimated tax payable: $${(summary.estimatedTaxPayableCents / 100).toLocaleString('en-US')}
- Compared to last year's actual tax payable: ${summary.taxPayableDeltaVsLastYearCents != null ? `${summary.taxPayableDeltaVsLastYearCents >= 0 ? 'up' : 'down'} $${Math.abs(summary.taxPayableDeltaVsLastYearCents / 100).toLocaleString('en-US')}` : 'not available (no prior-year tax payable on file to compare against)'}
(Note: this does NOT account for withholding or estimated payments made this year, so it is not a refund-or-balance-owing figure — just how the underlying tax liability compares to last year.)`
      : '(no numeric estimate available — the prior filing on file did not have enough baseline data to compute one)';

    return `Write a short, professional cover letter from a freelance/self-employed taxpayer to their own accountant or bookkeeper, to accompany this year's tax documents. The letter should:
- Be addressed generically ("Dear [Accountant's name]," is fine as a placeholder)
- State plainly that this is a fast-tracked estimate prepared with the help of an AI assistant, based on last year's confirmed return plus this year's changes — not a final calculation
- Summarize what changed this year (below)
- Include the estimated figures (below), clearly labeled as estimates
- List the open questions the accountant should double-check
- Close politely, offering to answer any follow-up questions

--- What changed this year ---
${summary.changesFromLastYear.length ? summary.changesFromLastYear.map((c) => `- ${c}`).join('\n') : '- No material changes identified'}

--- Estimated figures ---
${numbersBlock}

--- Open questions for the accountant ---
${summary.openQuestions.length ? summary.openQuestions.map((q) => `- ${q}`).join('\n') : '- None identified'}

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"letterBody": "<the full letter text, with \\n for paragraph breaks>"}`;
  }

  parseClientLetter(parsed: unknown): { letterBody: string } {
    const r = parsed as any;
    if (r && typeof r.letterBody === 'string' && r.letterBody.trim().length > 0) {
      return { letterBody: r.letterBody };
    }
    throw new Error('Unexpected client-letter response shape: ' + JSON.stringify(parsed));
  }
}
```

- [ ] **Step 3: Write `ca/filing-draft-pack.ts`**

Same structure as `us/filing-draft-pack.ts`, with CA terminology:

```ts
import type { FilingDraftPack, FilingDraftDeltas, FilingDraftSummary, StandardTaxExtract } from '../interfaces.js';

export class CaFilingDraftPack implements FilingDraftPack {
  jurisdiction = 'ca';

  extractDeltasPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
  }): string {
    const { qaHistory, priorFiling } = input;
    const qaBlock = qaHistory.map((qa, i) => `${i + 1}. Q: ${qa.question}\n   A: ${qa.answer}`).join('\n');
    const priorFilingBlock = `- Form type: ${priorFiling.formType} (tax year ${priorFiling.taxYear})
- Province: ${priorFiling.region || 'unknown'}
- Prior-year total income: ${priorFiling.totalIncomeCents != null ? `$${(priorFiling.totalIncomeCents / 100).toLocaleString('en-CA')}` : 'unknown'}
- Prior-year taxable income: ${priorFiling.taxableIncomeCents != null ? `$${(priorFiling.taxableIncomeCents / 100).toLocaleString('en-CA')}` : 'unknown'}
- Other fields on file: ${JSON.stringify(priorFiling.formFields || {})}`;

    return `You are an experienced Canadian tax preparer reviewing a completed client intake interview to identify what's DIFFERENT about this year's T1 filing compared to last year's confirmed return. You do NOT calculate any tax figures yourself — that happens separately from real federal/provincial bracket tables. Your only job is to extract structured signal from the interview answers below.

--- Prior year's confirmed filing (baseline) ---
${priorFilingBlock}

--- This year's intake interview ---
${qaBlock}

From the interview, determine:
- Roughly how this year's total income compares to last year's, as a signed percentage (e.g. +5 for "a little higher", -10 for "noticeably lower", omit entirely if the client gave no usable signal on income).
- Whether marital status changed (which affects Canada Child Benefit and certain credits), and if so what it changed to.
- The net change in number of dependents (a signed integer; 0 if explicitly unchanged, omit if not discussed).
- A short list of plain-language bullets describing what's materially different from last year (new self-employment income, a move to a different province, RRSP/FHSA/TFSA contribution changes, GST/HST registration threshold crossed, etc. — skip this if nothing changed).
- A short list of open questions this client's accountant should double-check before filing.

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"incomeDeltaPercent": <number, optional>, "filingStatusChanged": <boolean, optional>, "newFilingStatus": "<string, optional>", "dependentsDelta": <number, optional>, "changesFromLastYear": ["<bullet>", ...], "openQuestions": ["<bullet>", ...]}`;
  }

  parseDeltas(parsed: unknown): FilingDraftDeltas {
    const r = parsed as any;
    if (!r || typeof r !== 'object') {
      throw new Error('Unexpected delta-extraction response shape: ' + JSON.stringify(parsed));
    }
    return {
      incomeDeltaPercent: typeof r.incomeDeltaPercent === 'number' ? r.incomeDeltaPercent : undefined,
      filingStatusChanged: typeof r.filingStatusChanged === 'boolean' ? r.filingStatusChanged : undefined,
      newFilingStatus: typeof r.newFilingStatus === 'string' ? r.newFilingStatus : undefined,
      dependentsDelta: typeof r.dependentsDelta === 'number' ? r.dependentsDelta : undefined,
      changesFromLastYear: Array.isArray(r.changesFromLastYear) ? r.changesFromLastYear.filter((x: unknown) => typeof x === 'string') : [],
      openQuestions: Array.isArray(r.openQuestions) ? r.openQuestions.filter((x: unknown) => typeof x === 'string') : [],
    };
  }

  clientLetterPrompt(input: {
    qaHistory: { question: string; answer: string }[];
    priorFiling: StandardTaxExtract;
    summary: FilingDraftSummary;
  }): string {
    const { summary } = input;
    const numbersBlock = summary.estimatedTaxPayableCents != null
      ? `- Estimated total income: ${summary.estimatedTotalIncomeCents != null ? `$${(summary.estimatedTotalIncomeCents / 100).toLocaleString('en-CA')}` : 'not estimated'}
- Estimated taxable income: ${summary.estimatedTaxableIncomeCents != null ? `$${(summary.estimatedTaxableIncomeCents / 100).toLocaleString('en-CA')}` : 'not estimated'}
- Estimated tax payable: $${(summary.estimatedTaxPayableCents / 100).toLocaleString('en-CA')}
- Compared to last year's actual tax payable: ${summary.taxPayableDeltaVsLastYearCents != null ? `${summary.taxPayableDeltaVsLastYearCents >= 0 ? 'up' : 'down'} $${Math.abs(summary.taxPayableDeltaVsLastYearCents / 100).toLocaleString('en-CA')}` : 'not available (no prior-year tax payable on file to compare against)'}
(Note: this does NOT account for withholding or estimated payments made this year, so it is not a refund-or-balance-owing figure — just how the underlying tax liability compares to last year.)`
      : '(no numeric estimate available — the prior filing on file did not have enough baseline data to compute one)';

    return `Write a short, professional cover letter from a freelance/self-employed taxpayer to their own accountant or bookkeeper, to accompany this year's T1 tax documents. The letter should:
- Be addressed generically ("Dear [Accountant's name]," is fine as a placeholder)
- State plainly that this is a fast-tracked estimate prepared with the help of an AI assistant, based on last year's confirmed return plus this year's changes — not a final calculation
- Summarize what changed this year (below)
- Include the estimated figures (below), clearly labeled as estimates
- List the open questions the accountant should double-check
- Close politely, offering to answer any follow-up questions

--- What changed this year ---
${summary.changesFromLastYear.length ? summary.changesFromLastYear.map((c) => `- ${c}`).join('\n') : '- No material changes identified'}

--- Estimated figures ---
${numbersBlock}

--- Open questions for the accountant ---
${summary.openQuestions.length ? summary.openQuestions.map((q) => `- ${q}`).join('\n') : '- None identified'}

Respond with EXACTLY one JSON object and nothing else — no markdown code fences, no explanation. Shape it as:
{"letterBody": "<the full letter text, with \\n for paragraph breaks>"}`;
  }

  parseClientLetter(parsed: unknown): { letterBody: string } {
    const r = parsed as any;
    if (r && typeof r.letterBody === 'string' && r.letterBody.trim().length > 0) {
      return { letterBody: r.letterBody };
    }
    throw new Error('Unexpected client-letter response shape: ' + JSON.stringify(parsed));
  }
}
```

- [ ] **Step 4: Write `filing-draft-loader.ts`**

Mirrors `tax-questionnaire-loader.ts` exactly:

```ts
import type { FilingDraftPack } from './interfaces.js';
import { CaFilingDraftPack } from './ca/filing-draft-pack.js';
import { UsFilingDraftPack } from './us/filing-draft-pack.js';
// au/uk deliberately NOT registered — matching tax-questionnaire-loader.ts's
// scope (the questionnaire itself only supports us/ca, so a filing draft
// can never be generated for any other jurisdiction).

const PACKS: Record<string, FilingDraftPack> = {
  ca: new CaFilingDraftPack(),
  us: new UsFilingDraftPack(),
};

export function registerFilingDraftPack(pack: FilingDraftPack): void {
  PACKS[pack.jurisdiction] = pack;
}

export function getFilingDraftPack(jurisdiction: string): FilingDraftPack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No FilingDraftPack for jurisdiction: ${jurisdiction}`);
  return pack;
}

export function listSupportedJurisdictions(): string[] {
  return Object.keys(PACKS);
}
```

- [ ] **Step 5: Write the failing tests, then the packs make them pass (they already do — write tests to confirm)**

Create `packages/agentbook-jurisdictions/src/__tests__/us-filing-draft-pack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { UsFilingDraftPack } from '../us/filing-draft-pack.js';
import type { StandardTaxExtract } from '../interfaces.js';

const priorFiling: StandardTaxExtract = {
  formType: '1040', taxYear: 2024, jurisdiction: 'us', region: 'CA',
  totalIncomeCents: 8500000, taxableIncomeCents: 7200000,
  formFields: { filingStatus: 'single' }, attachedForms: {}, confidence: 0.9,
};

describe('UsFilingDraftPack', () => {
  const pack = new UsFilingDraftPack();

  it('extractDeltasPrompt includes the prior filing baseline and qa history', () => {
    const prompt = pack.extractDeltasPrompt({
      qaHistory: [{ question: 'Filing status this year?', answer: 'Still single' }],
      priorFiling,
    });
    expect(prompt).toContain('$85,000');
    expect(prompt).toContain('Filing status this year?');
    expect(prompt).toContain('Still single');
  });

  it('parseDeltas extracts a full response', () => {
    const deltas = pack.parseDeltas({
      incomeDeltaPercent: 5, filingStatusChanged: false, dependentsDelta: 0,
      changesFromLastYear: ['Income up slightly'], openQuestions: ['Confirm no new 1099s'],
    });
    expect(deltas.incomeDeltaPercent).toBe(5);
    expect(deltas.changesFromLastYear).toEqual(['Income up slightly']);
  });

  it('parseDeltas defaults missing arrays to empty rather than throwing', () => {
    const deltas = pack.parseDeltas({});
    expect(deltas.changesFromLastYear).toEqual([]);
    expect(deltas.openQuestions).toEqual([]);
    expect(deltas.incomeDeltaPercent).toBeUndefined();
  });

  it('parseDeltas throws on a non-object response', () => {
    expect(() => pack.parseDeltas('not an object')).toThrow('Unexpected delta-extraction response shape');
  });

  it('clientLetterPrompt includes the estimated figures when present', () => {
    const prompt = pack.clientLetterPrompt({
      qaHistory: [],
      priorFiling,
      summary: {
        estimatedTotalIncomeCents: 8900000, estimatedTaxableIncomeCents: 7500000,
        estimatedTaxPayableCents: 1200000, taxPayableDeltaVsLastYearCents: 50000,
        changesFromLastYear: ['Income up slightly'], openQuestions: [], caveat: 'This is an estimate.',
      },
    });
    expect(prompt).toContain('$12,000.00');
    expect(prompt).toContain('up $500.00');
  });

  it('clientLetterPrompt degrades gracefully when no numeric estimate is available', () => {
    const prompt = pack.clientLetterPrompt({
      qaHistory: [], priorFiling,
      summary: { changesFromLastYear: [], openQuestions: [], caveat: 'This is an estimate.' },
    });
    expect(prompt).toContain('no numeric estimate available');
  });

  it('parseClientLetter extracts letterBody', () => {
    const result = pack.parseClientLetter({ letterBody: 'Dear Accountant,\n\nHere is my summary.' });
    expect(result.letterBody).toContain('Dear Accountant');
  });

  it('parseClientLetter throws on a missing letterBody', () => {
    expect(() => pack.parseClientLetter({})).toThrow('Unexpected client-letter response shape');
  });
});
```

Create `packages/agentbook-jurisdictions/src/__tests__/ca-filing-draft-pack.test.ts` with the identical test structure, importing `CaFilingDraftPack` from `../ca/filing-draft-pack.js`, `jurisdiction: 'ca'` in the fixture, and asserting on CA-specific prompt text (`'T1'`, `'province'`) instead of US-specific text.

Run:
```bash
cd packages/agentbook-jurisdictions && npx vitest run src/__tests__/us-filing-draft-pack.test.ts src/__tests__/ca-filing-draft-pack.test.ts
```
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/agentbook-jurisdictions/src/interfaces.ts packages/agentbook-jurisdictions/src/us/filing-draft-pack.ts packages/agentbook-jurisdictions/src/ca/filing-draft-pack.ts packages/agentbook-jurisdictions/src/filing-draft-loader.ts packages/agentbook-jurisdictions/src/__tests__/us-filing-draft-pack.test.ts packages/agentbook-jurisdictions/src/__tests__/ca-filing-draft-pack.test.ts
git commit -m "feat(tax): FilingDraftPack interface + us/ca implementations + loader (PR-4, Task 3)"
```

---

## Task 4: `computeFilingDraftSummaryAndLetter` (backend) + `generateFilingDraft` orchestrator + PDF renderers (web app)

**Architecture correction vs. the design spec**: the spec put the whole `generateFilingDraft` orchestrator in `plugins/agentbook-core/backend/src/`. That's wrong given how this monorepo is actually wired — `generatePackage`, `renderPackagePdf`, and `uploadBlob` (the only existing precedent for this exact kind of orchestrator) all live in `apps/web-next/src/lib/`, and the dependency direction in this codebase is always `apps/web-next` → backend plugin packages, never the reverse (`apps/web-next`'s routes import `@agentbook-core/*`-aliased backend source; nothing goes the other way). `@react-pdf/renderer` and `uploadBlob` are `apps/web-next`-side concerns. So this task splits the work at that exact seam:
- The LLM calls + deterministic bracket calculation (needs `db`, `callGemini`, `@agentbook/jurisdictions/*` — all importable from the backend package) live in a new backend-package function, `computeFilingDraftSummaryAndLetter`.
- The PDF rendering + blob upload + `AbTaxFastTrackDraft` row lifecycle (needs `@react-pdf/renderer`, `uploadBlob`) live in `apps/web-next`, calling the backend function via the existing `@agentbook-core/*` alias — exactly how `apps/web-next`'s `/agent/message` route already imports `callGemini`/`classifyAndExecuteV1` from `@agentbook-core/server`.

**Files:**
- Create: `plugins/agentbook-core/backend/src/tax-fast-track-draft-compute.ts`
- Create: `apps/web-next/src/lib/tax-fast-track-pdf.ts`
- Create: `apps/web-next/src/lib/tax-fast-track-draft.ts`
- Test: `plugins/agentbook-core/backend/src/__tests__/tax-fast-track-draft-compute.test.ts`
- Test: `apps/web-next/src/__tests__/lib/tax-fast-track-draft.test.ts`

**Interfaces:**
- Produces: `computeFilingDraftSummaryAndLetter(sessionId, callGemini): Promise<{ summary: FilingDraftSummary; letterBody: string }>` (throws `TaxFastTrackComputeError` with a categorized `.code`) from the backend package; `generateFilingDraft(sessionId, callGemini): Promise<void>` from `apps/web-next/src/lib/tax-fast-track-draft.ts` — consumed by Task 5's route-handler wiring.
- Consumes: `getFilingDraftPack` (Task 3), `usTaxBrackets`/`caTaxBrackets` (existing, unmodified), `cleanJson`/`CallGeminiFn` (Task 2), `uploadBlob` (existing, `apps/web-next/src/lib/agentbook-blob.ts`).

- [ ] **Step 1: Write `tax-fast-track-draft-compute.ts` (backend package)**

```ts
import { db } from './db/client.js';
import { getFilingDraftPack } from '@agentbook/jurisdictions/filing-draft-loader';
import type { StandardTaxExtract, FilingDraftSummary } from '@agentbook/jurisdictions/interfaces';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';
import { cleanJson, type CallGeminiFn } from './tax-questionnaire-core.js';

// Direct imports, NOT getJurisdictionPack()/loadBuiltInPacks() — see this
// plan's Global Constraints for why that loader is unsafe here.
const TAX_BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
};

export type TaxFastTrackComputeErrorCode = 'delta_extraction_failed' | 'letter_generation_failed';

export class TaxFastTrackComputeError extends Error {
  constructor(public code: TaxFastTrackComputeErrorCode, message: string) {
    super(message);
  }
}

/**
 * LLM calls + deterministic bracket calculation for a completed fast-track
 * questionnaire session. No PDF rendering, no blob upload, no
 * AbTaxFastTrackDraft row writes — those are apps/web-next concerns (see
 * generateFilingDraft in apps/web-next/src/lib/tax-fast-track-draft.ts).
 *
 * The numeric estimate comes from the existing, unmodified
 * {us,ca}TaxBrackets.calculateTax() — the LLM's job is turning this year's
 * prose Q&A into structured deltas, never inventing a tax figure directly.
 */
export async function computeFilingDraftSummaryAndLetter(
  sessionId: string,
  callGemini: CallGeminiFn,
): Promise<{ summary: FilingDraftSummary; letterBody: string }> {
  const session = await db.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== 'completed') {
    throw new Error(`computeFilingDraftSummaryAndLetter called for a non-completed session: ${sessionId}`);
  }

  let priorFiling: StandardTaxExtract | undefined;
  if (session.sourceFilingId) {
    const filing = await db.abPastTaxFiling.findUnique({ where: { id: session.sourceFilingId } }).catch(() => null);
    priorFiling = (filing?.extractedData as StandardTaxExtract | undefined) || undefined;
  }
  if (!priorFiling) {
    throw new Error(`computeFilingDraftSummaryAndLetter: session ${sessionId} has no readable prior filing`);
  }

  const pack = getFilingDraftPack(session.jurisdiction);
  const qaHistory = (session.qaHistory as { question: string; answer: string }[]) || [];

  const deltasPrompt = pack.extractDeltasPrompt({ qaHistory, priorFiling });
  const deltasRaw = await callGemini(deltasPrompt, "Extract this year's changes.", 400);
  if (!deltasRaw) throw new TaxFastTrackComputeError('delta_extraction_failed', 'callGemini returned falsy for delta extraction');
  let deltas;
  try {
    deltas = pack.parseDeltas(JSON.parse(cleanJson(deltasRaw)));
  } catch (err) {
    throw new TaxFastTrackComputeError('delta_extraction_failed', `delta parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Deterministic, no LLM call: apply the extracted income delta to last
  // year's real baseline and run it through the existing bracket
  // calculator. Degrades gracefully (all numeric fields omitted, not
  // guessed) if the prior filing lacks a usable baseline.
  const bracketProvider = TAX_BRACKET_PROVIDERS[session.jurisdiction];
  let estimatedTotalIncomeCents: number | undefined;
  let estimatedTaxableIncomeCents: number | undefined;
  let estimatedTaxPayableCents: number | undefined;
  let taxPayableDeltaVsLastYearCents: number | undefined;

  if (bracketProvider && priorFiling.taxableIncomeCents != null) {
    const deltaFactor = 1 + (deltas.incomeDeltaPercent ?? 0) / 100;
    estimatedTaxableIncomeCents = Math.round(priorFiling.taxableIncomeCents * deltaFactor);
    if (priorFiling.totalIncomeCents != null) {
      estimatedTotalIncomeCents = Math.round(priorFiling.totalIncomeCents * deltaFactor);
    }
    const calc = bracketProvider.calculateTax(estimatedTaxableIncomeCents, session.taxYear);
    estimatedTaxPayableCents = calc.taxCents;
    if (priorFiling.taxPayableCents != null) {
      taxPayableDeltaVsLastYearCents = estimatedTaxPayableCents - priorFiling.taxPayableCents;
    }
  }

  const summary: FilingDraftSummary = {
    estimatedTotalIncomeCents,
    estimatedTaxableIncomeCents,
    estimatedTaxPayableCents,
    taxPayableDeltaVsLastYearCents,
    changesFromLastYear: deltas.changesFromLastYear,
    openQuestions: deltas.openQuestions,
    caveat: 'This is an AI-generated estimate to help you and your accountant get started — not a filed return, and not tax advice.',
  };

  const letterPrompt = pack.clientLetterPrompt({ qaHistory, priorFiling, summary });
  const letterRaw = await callGemini(letterPrompt, 'Write the client letter.', 500);
  if (!letterRaw) throw new TaxFastTrackComputeError('letter_generation_failed', 'callGemini returned falsy for client letter');
  let letter;
  try {
    letter = pack.parseClientLetter(JSON.parse(cleanJson(letterRaw)));
  } catch (err) {
    throw new TaxFastTrackComputeError('letter_generation_failed', `letter parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { summary, letterBody: letter.letterBody };
}
```

- [ ] **Step 2: Write the backend-package test**

Create `plugins/agentbook-core/backend/src/__tests__/tax-fast-track-draft-compute.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = {
  abTaxQuestionnaireSession: { findUnique: vi.fn(async () => null as any) },
  abPastTaxFiling: { findUnique: vi.fn(async () => null as any) },
};
vi.mock('../db/client.js', () => ({ db: dbMock }));

const packMock = {
  jurisdiction: 'us',
  extractDeltasPrompt: vi.fn(() => 'DELTA PROMPT'),
  parseDeltas: vi.fn((parsed: unknown) => parsed as any),
  clientLetterPrompt: vi.fn(() => 'LETTER PROMPT'),
  parseClientLetter: vi.fn((parsed: unknown) => parsed as any),
};
const jurisdictionsLoader = { getFilingDraftPack: vi.fn(() => packMock) };
vi.mock('@agentbook/jurisdictions/filing-draft-loader', () => jurisdictionsLoader);

function makeSession(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'tqs-1', tenantId: 'tenant-A', taxYear: 2025, jurisdiction: 'us',
    sourceFilingId: 'filing-1', status: 'completed',
    qaHistory: [{ question: 'Filing status?', answer: 'Same as last year' }],
    ...overrides,
  };
}

function makeFiling(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'filing-1',
    extractedData: {
      formType: '1040', taxYear: 2024, jurisdiction: 'us',
      totalIncomeCents: 8500000, taxableIncomeCents: 7200000, taxPayableCents: 1150000,
      formFields: {}, attachedForms: {}, confidence: 0.9,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue(makeSession());
  dbMock.abPastTaxFiling.findUnique.mockResolvedValue(makeFiling());
  jurisdictionsLoader.getFilingDraftPack.mockReturnValue(packMock);
});

describe('computeFilingDraftSummaryAndLetter', () => {
  it('computes a real tax figure via calculateTax, not an LLM-invented one', async () => {
    const { computeFilingDraftSummaryAndLetter } = await import('../tax-fast-track-draft-compute');
    const callGemini = vi.fn(async (prompt: string) => {
      if (prompt === 'DELTA PROMPT') return JSON.stringify({ incomeDeltaPercent: 0, changesFromLastYear: [], openQuestions: [] });
      return JSON.stringify({ letterBody: 'Dear Accountant, ...' });
    });

    const { summary, letterBody } = await computeFilingDraftSummaryAndLetter('tqs-1', callGemini);

    // 0% delta on $72,000 taxable income — verify against the real
    // usTaxBrackets.calculateTax() output for tax year 2025, not a guess.
    const { usTaxBrackets } = await import('@agentbook/jurisdictions/us/tax-brackets');
    const expected = usTaxBrackets.calculateTax(7200000, 2025);
    expect(summary.estimatedTaxPayableCents).toBe(expected.taxCents);
    expect(summary.taxPayableDeltaVsLastYearCents).toBe(expected.taxCents - 1150000);
    expect(letterBody).toContain('Dear Accountant');
  });

  it('degrades gracefully (omits numeric fields) when the prior filing has no taxable income on file', async () => {
    dbMock.abPastTaxFiling.findUnique.mockResolvedValue(makeFiling({
      extractedData: { formType: '1040', taxYear: 2024, jurisdiction: 'us', formFields: {}, attachedForms: {}, confidence: 0.3 },
    }));
    const callGemini = vi.fn(async () => JSON.stringify({ changesFromLastYear: [], openQuestions: [] }));

    const { computeFilingDraftSummaryAndLetter } = await import('../tax-fast-track-draft-compute');
    const { summary } = await computeFilingDraftSummaryAndLetter('tqs-1', callGemini);

    expect(summary.estimatedTaxPayableCents).toBeUndefined();
    expect(summary.estimatedTotalIncomeCents).toBeUndefined();
  });

  it('throws a categorized TaxFastTrackComputeError when callGemini returns falsy for delta extraction', async () => {
    const { computeFilingDraftSummaryAndLetter, TaxFastTrackComputeError } = await import('../tax-fast-track-draft-compute');
    const callGemini = vi.fn(async () => null);

    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toThrow(TaxFastTrackComputeError);
    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toMatchObject({ code: 'delta_extraction_failed' });
  });

  it('throws a categorized TaxFastTrackComputeError when callGemini returns falsy for the letter', async () => {
    const callGemini = vi.fn(async (prompt: string) => (prompt === 'DELTA PROMPT' ? JSON.stringify({ changesFromLastYear: [], openQuestions: [] }) : null));
    const { computeFilingDraftSummaryAndLetter, TaxFastTrackComputeError } = await import('../tax-fast-track-draft-compute');

    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toThrow(TaxFastTrackComputeError);
    await expect(computeFilingDraftSummaryAndLetter('tqs-1', callGemini)).rejects.toMatchObject({ code: 'letter_generation_failed' });
  });
});
```

Run:
```bash
cd plugins/agentbook-core/backend && npx vitest run src/__tests__/tax-fast-track-draft-compute.test.ts
```
Expected: all tests pass.

- [ ] **Step 3: Commit the backend-package half**

```bash
git add plugins/agentbook-core/backend/src/tax-fast-track-draft-compute.ts plugins/agentbook-core/backend/src/__tests__/tax-fast-track-draft-compute.test.ts
git commit -m "feat(tax): computeFilingDraftSummaryAndLetter — real bracket calc, not LLM-guessed (PR-4, Task 4a)"
```

- [ ] **Step 4: Write the PDF renderers (`apps/web-next/src/lib/tax-fast-track-pdf.ts`)**

One file, two exported functions — two small related documents, following `renderPackagePdf`'s exact visual vocabulary (10pt Helvetica body, 18pt header, bordered section titles):

```ts
import 'server-only';
import React from 'react';
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer';
import type { FilingDraftSummary } from '@agentbook/jurisdictions/interfaces';

const styles = StyleSheet.create({
  page: { paddingTop: 36, paddingBottom: 48, paddingHorizontal: 36, fontSize: 10, fontFamily: 'Helvetica', color: '#111' },
  header: { fontSize: 18, fontWeight: 700, marginBottom: 4 },
  subheader: { fontSize: 11, color: '#444', marginBottom: 12 },
  sectionTitle: { fontSize: 12, fontWeight: 700, marginTop: 14, marginBottom: 4, paddingBottom: 2, borderBottomWidth: 1, borderBottomColor: '#888' },
  row: { flexDirection: 'row', paddingVertical: 2 },
  cellLabel: { flexGrow: 1, flexShrink: 1, paddingRight: 8 },
  cellAmount: { width: 110, minWidth: 110, flexShrink: 0, textAlign: 'right' },
  bullet: { paddingVertical: 2 },
  small: { fontSize: 9, color: '#555' },
  caveat: { fontSize: 9, color: '#900', marginTop: 14, fontStyle: 'italic' },
  paragraph: { fontSize: 10, marginBottom: 8, lineHeight: 1.4 },
});

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

interface DraftDocProps { summary: FilingDraftSummary; taxYear: number; jurisdiction: string; }

const DraftDoc: React.FC<DraftDocProps> = ({ summary, taxYear, jurisdiction }) => {
  return React.createElement(
    Document,
    { title: `Tax fast-track draft ${taxYear}`, author: 'AgentBook' },
    React.createElement(
      Page,
      { size: 'LETTER', style: styles.page },
      React.createElement(Text, { style: styles.header }, `Tax Filing Draft — ${taxYear}`),
      React.createElement(Text, { style: styles.subheader }, `Fast-tracked estimate • ${jurisdiction.toUpperCase()}`),

      React.createElement(Text, { style: styles.sectionTitle }, 'Estimated figures'),
      ...(summary.estimatedTaxPayableCents != null
        ? [
          React.createElement(View, { key: 'row-income', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, 'Estimated total income'),
            React.createElement(Text, { style: styles.cellAmount }, summary.estimatedTotalIncomeCents != null ? dollars(summary.estimatedTotalIncomeCents) : 'n/a')),
          React.createElement(View, { key: 'row-taxable', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, 'Estimated taxable income'),
            React.createElement(Text, { style: styles.cellAmount }, summary.estimatedTaxableIncomeCents != null ? dollars(summary.estimatedTaxableIncomeCents) : 'n/a')),
          React.createElement(View, { key: 'row-payable', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, 'Estimated tax payable'),
            React.createElement(Text, { style: styles.cellAmount }, dollars(summary.estimatedTaxPayableCents))),
          React.createElement(View, { key: 'row-delta', style: styles.row },
            React.createElement(Text, { style: styles.cellLabel }, "Vs. last year's actual tax payable"),
            React.createElement(Text, { style: styles.cellAmount },
              summary.taxPayableDeltaVsLastYearCents != null
                ? `${summary.taxPayableDeltaVsLastYearCents >= 0 ? '+' : '-'}${dollars(Math.abs(summary.taxPayableDeltaVsLastYearCents))}`
                : 'n/a')),
        ]
        : [React.createElement(Text, { key: 'no-numbers', style: styles.paragraph }, 'No numeric estimate available — the prior filing on file did not have enough baseline data to compute one.')]),

      React.createElement(Text, { style: styles.sectionTitle }, 'What changed this year'),
      ...(summary.changesFromLastYear.length
        ? summary.changesFromLastYear.map((c, i) => React.createElement(Text, { key: `change-${i}`, style: styles.bullet }, `• ${c}`))
        : [React.createElement(Text, { key: 'no-changes', style: styles.small }, 'No material changes identified.')]),

      React.createElement(Text, { style: styles.sectionTitle }, 'Open questions for your accountant'),
      ...(summary.openQuestions.length
        ? summary.openQuestions.map((q, i) => React.createElement(Text, { key: `q-${i}`, style: styles.bullet }, `• ${q}`))
        : [React.createElement(Text, { key: 'no-questions', style: styles.small }, 'None identified.')]),

      React.createElement(Text, { style: styles.caveat }, summary.caveat),
    ),
  );
};

interface LetterDocProps { letterBody: string; taxYear: number; }

const LetterDoc: React.FC<LetterDocProps> = ({ letterBody, taxYear }) => {
  const paragraphs = letterBody.split(/\n{2,}/).filter((p) => p.trim().length > 0);
  return React.createElement(
    Document,
    { title: `Tax fast-track client letter ${taxYear}`, author: 'AgentBook' },
    React.createElement(
      Page,
      { size: 'LETTER', style: styles.page },
      React.createElement(Text, { style: styles.header }, `Client Letter — ${taxYear}`),
      ...paragraphs.map((p, i) => React.createElement(Text, { key: `p-${i}`, style: styles.paragraph }, p.trim())),
    ),
  );
};

export async function renderFilingDraftPdf(summary: FilingDraftSummary, taxYear: number, jurisdiction: string): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const element = React.createElement(DraftDoc, { summary, taxYear, jurisdiction }) as any;
  return (await renderToBuffer(element)) as Buffer;
}

export async function renderClientLetterPdf(letterBody: string, taxYear: number): Promise<Buffer> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const element = React.createElement(LetterDoc, { letterBody, taxYear }) as any;
  return (await renderToBuffer(element)) as Buffer;
}
```

- [ ] **Step 5: Write `generateFilingDraft` (`apps/web-next/src/lib/tax-fast-track-draft.ts`)**

Mirrors `generatePackage`'s idempotent-upsert + categorized-failure-phase pattern exactly:

```ts
import 'server-only';
import { prisma as db } from '@naap/database';
import { computeFilingDraftSummaryAndLetter, TaxFastTrackComputeError } from '@agentbook-core/tax-fast-track-draft-compute';
import type { CallGeminiFn } from '@agentbook-core/tax-questionnaire-core';

export type TaxFastTrackDraftFailureCode =
  | 'delta_extraction_failed'
  | 'letter_generation_failed'
  | 'pdf_render_failed'
  | 'upload_failed';

/**
 * Generates the filing-draft PDF + client-letter PDF for a completed
 * AbTaxQuestionnaireSession and persists them on its AbTaxFastTrackDraft
 * row. Safe to call again after a failure (upserts to 'pending' first) —
 * NOT safe to call concurrently with itself for the same sessionId (two
 * simultaneous calls both redo the LLM/render/upload work; wasteful but
 * not corrupting, since both end in a valid 'ready' state). Callers
 * (Task 5) guard against this at the UI level (disable the retry button
 * while a request is in flight), not here.
 */
export async function generateFilingDraft(sessionId: string, callGemini: CallGeminiFn): Promise<void> {
  const session = await db.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
  if (!session) {
    throw new Error(`generateFilingDraft: no session found for ${sessionId}`);
  }

  const draft = await db.abTaxFastTrackDraft.upsert({
    where: { sessionId },
    update: { status: 'pending', errorMsg: null },
    create: {
      tenantId: session.tenantId, sessionId, taxYear: session.taxYear,
      jurisdiction: session.jurisdiction, status: 'pending',
    },
    select: { id: true },
  });

  let failurePhase: TaxFastTrackDraftFailureCode = 'delta_extraction_failed';

  try {
    const { summary, letterBody } = await computeFilingDraftSummaryAndLetter(sessionId, callGemini).catch((err) => {
      if (err instanceof TaxFastTrackComputeError) {
        failurePhase = err.code;
      }
      throw err;
    });

    failurePhase = 'pdf_render_failed';
    const { renderFilingDraftPdf, renderClientLetterPdf } = await import('./tax-fast-track-pdf');
    const [draftPdfBuf, letterPdfBuf] = await Promise.all([
      renderFilingDraftPdf(summary, session.taxYear, session.jurisdiction),
      renderClientLetterPdf(letterBody, session.taxYear),
    ]);

    failurePhase = 'upload_failed';
    const { uploadBlob } = await import('./agentbook-blob');
    const namePrefix = `tax-fast-track/${session.tenantId}/${sessionId}`;
    const [draftUp, letterUp] = await Promise.all([
      uploadBlob(`${namePrefix}/draft.pdf`, draftPdfBuf, 'application/pdf'),
      uploadBlob(`${namePrefix}/letter.pdf`, letterPdfBuf, 'application/pdf'),
    ]);

    await db.abTaxFastTrackDraft.update({
      where: { id: draft.id },
      data: {
        draftPdfUrl: draftUp.url,
        letterPdfUrl: letterUp.url,
        draftSummary: summary as object,
        status: 'ready',
        errorMsg: null,
      },
    });
  } catch (err) {
    console.error(`[tax-fast-track-draft] failed phase=${failurePhase} session=${sessionId}:`, err);
    await db.abTaxFastTrackDraft.update({
      where: { id: draft.id },
      data: { status: 'failed', errorMsg: failurePhase },
    }).catch(() => {});
  }
}
```

Note this function deliberately swallows its own errors (unlike `generatePackage`, which re-throws) — `generateFilingDraft` is always invoked fire-and-forget from a completed request/response cycle (Task 5), so there is no caller left to receive a thrown exception; the categorized `errorMsg` on the row is the only observable outcome, surfaced later via `/status`.

- [ ] **Step 6: Write the `apps/web-next` test**

Create `apps/web-next/src/__tests__/lib/tax-fast-track-draft.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const dbMock = {
  abTaxQuestionnaireSession: { findUnique: vi.fn(async () => null as any) },
  abTaxFastTrackDraft: {
    upsert: vi.fn(async () => ({ id: 'draft-1' })),
    update: vi.fn(async () => ({})),
  },
};
vi.mock('@naap/database', () => ({ prisma: dbMock }));

const computeMock = vi.fn();
class FakeComputeError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
vi.mock('@agentbook-core/tax-fast-track-draft-compute', () => ({
  computeFilingDraftSummaryAndLetter: (...args: any[]) => computeMock(...args),
  TaxFastTrackComputeError: FakeComputeError,
}));

const renderDraftMock = vi.fn(async () => Buffer.from('draft-pdf'));
const renderLetterMock = vi.fn(async () => Buffer.from('letter-pdf'));
vi.mock('@/lib/tax-fast-track-pdf', () => ({
  renderFilingDraftPdf: (...args: any[]) => renderDraftMock(...args),
  renderClientLetterPdf: (...args: any[]) => renderLetterMock(...args),
}));

const uploadBlobMock = vi.fn(async (name: string) => ({ url: `https://blob.test/${name}`, size: 100 }));
vi.mock('@/lib/agentbook-blob', () => ({ uploadBlob: (...args: any[]) => uploadBlobMock(...args) }));

function makeSession(overrides: Partial<Record<string, any>> = {}) {
  return { id: 'tqs-1', tenantId: 'tenant-A', taxYear: 2025, jurisdiction: 'us', status: 'completed', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue(makeSession());
  dbMock.abTaxFastTrackDraft.upsert.mockResolvedValue({ id: 'draft-1' });
});

describe('generateFilingDraft', () => {
  it('happy path: computes, renders both PDFs, uploads both, marks ready', async () => {
    computeMock.mockResolvedValue({ summary: { changesFromLastYear: [], openQuestions: [], caveat: 'est.' }, letterBody: 'Dear Accountant' });
    const { generateFilingDraft } = await import('../../../lib/tax-fast-track-draft');

    await generateFilingDraft('tqs-1', vi.fn());

    expect(renderDraftMock).toHaveBeenCalledTimes(1);
    expect(renderLetterMock).toHaveBeenCalledTimes(1);
    expect(uploadBlobMock).toHaveBeenCalledTimes(2);
    const [, updateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[0];
    expect(updateArgs.data.status).toBe('ready');
    expect(updateArgs.data.draftPdfUrl).toContain('draft.pdf');
    expect(updateArgs.data.letterPdfUrl).toContain('letter.pdf');
  });

  it('marks failed with the categorized code when delta extraction fails', async () => {
    computeMock.mockRejectedValue(new FakeComputeError('delta_extraction_failed', 'callGemini returned falsy'));
    const { generateFilingDraft } = await import('../../../lib/tax-fast-track-draft');

    await generateFilingDraft('tqs-1', vi.fn());

    const [, updateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[0];
    expect(updateArgs.data.status).toBe('failed');
    expect(updateArgs.data.errorMsg).toBe('delta_extraction_failed');
  });

  it('marks failed with pdf_render_failed when a PDF render throws', async () => {
    computeMock.mockResolvedValue({ summary: { changesFromLastYear: [], openQuestions: [], caveat: 'est.' }, letterBody: 'Dear Accountant' });
    renderDraftMock.mockRejectedValueOnce(new Error('renderToBuffer exploded'));
    const { generateFilingDraft } = await import('../../../lib/tax-fast-track-draft');

    await generateFilingDraft('tqs-1', vi.fn());

    const [, updateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[0];
    expect(updateArgs.data.status).toBe('failed');
    expect(updateArgs.data.errorMsg).toBe('pdf_render_failed');
  });

  it('is safe to call again after a failure (re-upserts the same row, does not create a duplicate)', async () => {
    computeMock.mockRejectedValueOnce(new FakeComputeError('delta_extraction_failed', 'first attempt fails'));
    const { generateFilingDraft } = await import('../../../lib/tax-fast-track-draft');
    await generateFilingDraft('tqs-1', vi.fn());

    computeMock.mockResolvedValueOnce({ summary: { changesFromLastYear: [], openQuestions: [], caveat: 'est.' }, letterBody: 'Dear Accountant' });
    await generateFilingDraft('tqs-1', vi.fn());

    expect(dbMock.abTaxFastTrackDraft.upsert).toHaveBeenCalledTimes(2);
    expect(dbMock.abTaxFastTrackDraft.upsert.mock.calls[1][0].where).toEqual({ sessionId: 'tqs-1' });
    const [, secondUpdateArgs] = dbMock.abTaxFastTrackDraft.update.mock.calls[1];
    expect(secondUpdateArgs.data.status).toBe('ready');
  });
});
```

Run:
```bash
cd apps/web-next && npx vitest run src/__tests__/lib/tax-fast-track-draft.test.ts
```
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/lib/tax-fast-track-pdf.ts apps/web-next/src/lib/tax-fast-track-draft.ts apps/web-next/src/__tests__/lib/tax-fast-track-draft.test.ts
git commit -m "feat(tax): filing-draft/client-letter PDF renderers + orchestrator (PR-4, Task 4b)"
```

---

## Task 5: Wire `generateFilingDraft` into the three chat-channel completion points

**Architecture note**: `handleAgentMessage` has exactly three real callers in production — `apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts` (web chat; MCP's `ask_agentbook` tool reuses this same route via an internal HTTP `fetch`, so it needs no separate wiring), the Telegram webhook route's local `callAgentBrain`, and the WhatsApp webhook route's local `callAgentBrain`. Each already imports `callGemini` directly (it's passed as part of the `ctx`/ad-hoc dependency object every caller builds for `handleAgentMessage`), so no new import of `callGemini` is needed at any of these three sites.

`generateFilingDraft` must run via Next.js's `after()` API (`next/server`) — NOT awaited inline before the response returns. This codebase already uses exactly this pattern for the same class of problem: `apps/web-next/src/app/api/v1/agentbook-tax/past-filings/[id]/parse/route.ts` calls `after(async () => { try { await parsePastFiling(...) } catch (e) { console.error(...) } })` immediately before returning a `{status:'parsing'}` response, letting the real work continue after the client already has its answer. `generateFilingDraft` needs a few seconds (two LLM round-trips + two PDF renders + two blob uploads) — `after()` lets each response return immediately (matching the chat reply's own wording, "I'll have your filing draft ready shortly" — never "ready now") while the work actually completes within the same invocation's extended lifetime, up to the route's `maxDuration`.

**Files:**
- Modify: `plugins/agentbook-core/backend/src/agent-brain.ts` (add `taxDraftReady?: boolean` to the `AgentResponse['data']` interface at line 164-onward; set it in `translateTaxCoreResult`'s `'done'` branch, from Task 2)
- Modify: `plugins/agentbook-core/backend/src/server.ts` (set `taxDraftReady: true` in the `start-tax-fast-track` wrapper's `'done'` case, from Task 2)
- Modify: `apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts` (add the `after()` trigger; bump `maxDuration` from 30 to 90)
- Modify: `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` (same trigger in `callAgentBrain`; bump `maxDuration` from 60 to 90)
- Modify: `apps/web-next/src/app/api/v1/agentbook/whatsapp/webhook/route.ts` (same trigger in `callAgentBrain`; bump `maxDuration` from 30 to 90)
- Modify: `plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-recovery.test.ts` (add one assertion: the `'done'` case's response carries `taxDraftReady: true`)
- Modify: `plugins/agentbook-core/backend/src/__tests__/start-tax-fast-track-skill.test.ts` (same assertion, for the turn-1 `'done'` case)

**Interfaces:**
- Consumes: `generateFilingDraft(sessionId, callGemini)` (Task 4b, `apps/web-next/src/lib/tax-fast-track-draft.ts`).

- [ ] **Step 1: Add `taxDraftReady` to `AgentResponse['data']`**

In `agent-brain.ts`, add one field to the interface (near the existing `sessionId?: string;` at line 175):

```ts
    sessionId?: string;
    /** True only on the exact turn a fast-track questionnaire session transitions to 'completed' — the signal for the caller to trigger generateFilingDraft(sessionId) via after(). */
    taxDraftReady?: boolean;
```

- [ ] **Step 2: Set it in `translateTaxCoreResult`'s `'done'` branch (Task 2's helper)**

```ts
  if (result.status === 'done') {
    return buildResponse({
      message: "Got everything I need — I'll have your filing draft ready shortly.",
      skillUsed: 'tax-questionnaire', confidence: 1, sessionId: result.sessionId, taxDraftReady: true, latencyMs: Date.now() - startTime,
    });
  }
```

- [ ] **Step 3: Set it in `server.ts`'s `start-tax-fast-track` wrapper's `'done'` case (Task 2's rewiring)**

```ts
      } else if (result.status === 'done') {
        message = "Got everything I need from your last return — I'll have your filing draft ready shortly.";
        sessionId = result.sessionId;
      } else {
```
becomes (adding the flag to the final `responseData` object built a few lines below — find the `responseData: { message, actions: [], chartData: null, skillUsed: 'start-tax-fast-track', confidence: 1, ...(sessionId ? { sessionId } : {}), latencyMs: Date.now() - startTime }` line from Task 2 Step 3 and change it to):

```ts
      let taxDraftReady = false;
      if (result.status === 'blocked' || result.status === 'failed') {
        message = result.message;
        sessionId = result.status === 'failed' ? result.sessionId : undefined;
      } else if (result.status === 'done') {
        message = "Got everything I need from your last return — I'll have your filing draft ready shortly.";
        sessionId = result.sessionId;
        taxDraftReady = true;
      } else {
        message = result.question;
        sessionId = result.sessionId;
      }

      await db.abConversation.create({ data: { tenantId, question: text || '[tax fast track]', answer: message, queryType: 'agent', channel, skillUsed: 'start-tax-fast-track' } }).catch(() => {});
      return {
        selectedSkill, extractedParams, confidence: 1, skillUsed: 'start-tax-fast-track',
        skillResponse: sessionId ? { data: { sessionId } } : null,
        responseData: { message, actions: [], chartData: null, skillUsed: 'start-tax-fast-track', confidence: 1, ...(sessionId ? { sessionId } : {}), ...(taxDraftReady ? { taxDraftReady: true } : {}), latencyMs: Date.now() - startTime },
      };
```

**Accepted, deliberate delta** (not a bug to fix): the original `server.ts:4401-4409` — the qaHistory-seed version-conflict, one of two distinct code paths that both produce the identical message `"Something went wrong setting up your tax questionnaire — could you try asking again?"` — returns WITHOUT calling `db.abConversation.create`, while the other (the turn-1 outcome-null failure, `server.ts:4368-4374`) DOES call it. Because both paths now collapse into the same `{status:'failed', message: 'Something went wrong...'}` `CoreResult` shape, this wrapper cannot distinguish them and always logs. Precisely preserving this would require adding a field to `CoreResult` solely to disambiguate two code paths that already produce byte-identical output, for a version conflict on a session that is microseconds old and not yet known to any other caller — not worth the complexity for a race condition inside a race condition. The only observable effect is one extra best-effort (`.catch()`-guarded) conversation-log row on an already-near-unreachable path.
```

- [ ] **Step 4: Wire the trigger into `/agent/message/route.ts`**

Add the import (near the existing imports) and bump `maxDuration`:

```ts
import { after } from 'next/server';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';
```

```ts
export const maxDuration = 90; // was 30 — after() work (tax fast-track draft generation) needs headroom past the response
```

After the existing `const brainResult = await handleAgentMessage(...)` call and before `return NextResponse.json(brainResult, { status: 200 });`, add:

```ts
    if (brainResult?.data?.taxDraftReady && brainResult.data?.sessionId) {
      const completedSessionId = brainResult.data.sessionId;
      after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
        console.error('[agent/message] generateFilingDraft failed:', err);
      }));
    }
```

- [ ] **Step 5: Wire the trigger into the Telegram webhook's `callAgentBrain`**

Add the import at the top of `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts`:

```ts
import { after } from 'next/server';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';
```

Bump `export const maxDuration = 60;` to `export const maxDuration = 90;` (line 74).

Inside `callAgentBrain`, right after the existing `const brainResult = await handleAgentMessage(...)` call and before the `if (brainResult?.success && brainResult.data?.message) {` check:

```ts
    if (brainResult?.data?.taxDraftReady && brainResult.data?.sessionId) {
      const completedSessionId = brainResult.data.sessionId;
      after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
        console.error('[telegram/agent-brain] generateFilingDraft failed:', err);
      }));
    }
```

- [ ] **Step 6: Wire the trigger into the WhatsApp webhook's `callAgentBrain`**

Add the same two imports to `apps/web-next/src/app/api/v1/agentbook/whatsapp/webhook/route.ts`. Bump `export const maxDuration = 30;` (line 30) to `90`.

Inside `callAgentBrain`, right after `const result = await handleAgentMessage(...)` and before `if (result?.success && result.data?.message) {`:

```ts
    if (result?.data?.taxDraftReady && result.data?.sessionId) {
      const completedSessionId = result.data.sessionId;
      after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
        console.error('[whatsapp/agent-brain] generateFilingDraft failed:', err);
      }));
    }
```

- [ ] **Step 7: Forward `sessionId`/`taxDraftReady` through `agent-brain.ts`'s generic response-building step**

**This step is required, not optional — without it, the trigger silently never fires for one real (if rare) path.** `start-tax-fast-track`'s turn-1 response reaches the chat client through `handleAgentMessage`'s "Step 5: Simple execution" block, which rebuilds the final response from a fixed field list rather than forwarding `responseData` verbatim. Verify this yourself before editing: `grep -n "sessionId" plugins/agentbook-core/backend/src/agent-brain.ts` — the `buildResponse({...})` call inside Step 5 (search for `citations: responseData.citations` to find it) does NOT include `sessionId` or `taxDraftReady` among the fields it forwards, even though `responseData` (assigned two lines above from `v1Result.responseData`) carries both. This means the *normal* turn-1 "question" response has never carried `sessionId` to the chat client either (confirmed by directly curling production during PR-3's live verification: turn 1's response had no `sessionId`; turn 2+, which returns via Step 1b's own direct `buildResponse` call — a different code path — did). This plan's turn-1 `{done:true}` edge case (the pack judges zero questions are needed) depends on this field surviving to trigger `generateFilingDraft`, so fix the gap:

```ts
  return buildResponse({
    message: responseData.message,
    actions: responseData.actions,
    chartData: responseData.chartData,
    skillUsed: responseData.skillUsed || v1Result.skillUsed,
    confidence: responseData.confidence ?? v1Result.confidence,
    sessionId: responseData.sessionId,
    taxDraftReady: responseData.taxDraftReady,
    latencyMs: Date.now() - startTime,
    // PR 43: forward citations from the skill response to the chat UI.
    citations: responseData.citations,
  });
```

This is a small, generically-useful fix (any current or future skill that sets `sessionId` on its `responseData` now correctly reaches the chat client through this path too, not just tax-questionnaire's), not tax-fast-track-specific plumbing — but scope it to exactly these two added lines; do not restructure this function further.

- [ ] **Step 8: Extend the two existing regression tests with one assertion each**

In `plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-recovery.test.ts`, inside the existing `it('done:true from the pack marks the session completed', ...)` test (from Task 2's regression-gate run), add after the existing assertions:

```ts
    expect(resp.data.taxDraftReady).toBe(true);
```

And in the existing `it('happy path: a real answer grows qaHistory, ...')` test in the same file, add:

```ts
    expect(resp.data.taxDraftReady).toBeUndefined();
```

(confirming the flag is present ONLY on the exact completing turn, not on every turn). In `plugins/agentbook-core/backend/src/__tests__/start-tax-fast-track-skill.test.ts`, find the existing test covering the turn-1 `done:true` case (`'handles a done:true response on the very first question as a legitimate zero-question completion, not a failure'`) and add:

```ts
    expect(result.responseData.taxDraftReady).toBe(true);
```

This assertion checks `executeClassification`'s own return value directly (this test file calls `executeClassification`, not `handleAgentMessage` — see its file header) — it proves `startTaxQuestionnaire`'s wrapper sets the flag correctly, but does NOT by itself prove the flag survives `handleAgentMessage`'s Step 5 response-rebuilding (that's what Step 7 above fixes and is proven by re-running this same suite once Step 7's two-line addition is in place — no separate integration test needed for this narrow, already-rare edge case).

- [ ] **Step 9: Run the regression suite**

```bash
cd plugins/agentbook-core/backend
npx vitest run src/__tests__/tax-questionnaire-recovery.test.ts src/__tests__/start-tax-fast-track-skill.test.ts
```
Expected: all pass, including the three new assertions.

- [ ] **Step 10: Commit**

```bash
git add plugins/agentbook-core/backend/src/agent-brain.ts plugins/agentbook-core/backend/src/server.ts plugins/agentbook-core/backend/src/__tests__/tax-questionnaire-recovery.test.ts plugins/agentbook-core/backend/src/__tests__/start-tax-fast-track-skill.test.ts apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts apps/web-next/src/app/api/v1/agentbook/whatsapp/webhook/route.ts
git commit -m "feat(tax): trigger generateFilingDraft via after() on questionnaire completion (PR-4, Task 5)"
```

---

## Task 6: UI-facing API routes (start/answer/cancel/status/regenerate)

These are the first callers of `startTaxQuestionnaire`/`answerTaxQuestionnaire`/`cancelTaxQuestionnaire` (Task 2) that bypass `handleAgentMessage`/chat classification entirely — the UI already knows it's driving a tax questionnaire, no intent classification needed.

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/start/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/answer/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/cancel/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/status/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/regenerate/route.ts`
- Test: `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`

**Interfaces:**
- Consumes: `startTaxQuestionnaire`/`answerTaxQuestionnaire`/`cancelTaxQuestionnaire`/`CoreResult` (Task 2, `@agentbook-core/tax-questionnaire-core`), `getActiveTaxQuestionnaireSession` (PR-3, `@agentbook-core/tax-questionnaire-session`), `generateFilingDraft` (Task 4b), `callGemini` (`@agentbook-core/server`), `safeResolveAgentbookTenant` (`@/lib/agentbook-tenant`).
- Produces: the 5 HTTP endpoints Task 7's UI consumes.

- [ ] **Step 1: `POST /tax-fast-track/start`**

```ts
import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { startTaxQuestionnaire } from '@agentbook-core/tax-questionnaire-core';
import { callGemini } from '@agentbook-core/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const body = await request.json().catch(() => ({}));

  // Same lookup classifyOnly() uses in server.ts to resolve a tenant's
  // configured jurisdiction/region — note the column is `userId`, not
  // `tenantId`, on this particular model.
  const tenantConfig = await db.abTenantConfig.findFirst({ where: { userId: tenantId } });
  const jurisdiction = (tenantConfig?.jurisdiction || 'us').toLowerCase();
  const region = tenantConfig?.region || null;

  const result = await startTaxQuestionnaire(tenantId, { taxYear: body.taxYear, jurisdiction, region }, callGemini);

  if (result.status === 'done') {
    const completedSessionId = result.sessionId;
    after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
      console.error('[tax-fast-track/start] generateFilingDraft failed:', err);
    }));
  }

  return NextResponse.json({ success: true, data: result });
}
```

- [ ] **Step 2: `POST /tax-fast-track/answer`**

```ts
import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { answerTaxQuestionnaire } from '@agentbook-core/tax-questionnaire-core';
import { getActiveTaxQuestionnaireSession } from '@agentbook-core/tax-questionnaire-session';
import { callGemini } from '@agentbook-core/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const body = await request.json().catch(() => ({}));
  const text = String(body.text ?? '').trim();
  if (!text) {
    return NextResponse.json({ success: false, error: 'text required' }, { status: 400 });
  }

  const tqSession = await getActiveTaxQuestionnaireSession(tenantId);
  if (!tqSession) {
    return NextResponse.json({ success: false, error: 'no_active_session' }, { status: 400 });
  }

  const result = await answerTaxQuestionnaire(tqSession, text, callGemini);

  if (result.status === 'done') {
    const completedSessionId = result.sessionId;
    after(() => generateFilingDraft(completedSessionId, callGemini).catch((err) => {
      console.error('[tax-fast-track/answer] generateFilingDraft failed:', err);
    }));
  }

  return NextResponse.json({ success: true, data: result });
}
```

- [ ] **Step 3: `POST /tax-fast-track/cancel`**

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { cancelTaxQuestionnaire } from '@agentbook-core/tax-questionnaire-core';
import { getActiveTaxQuestionnaireSession } from '@agentbook-core/tax-questionnaire-session';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const tqSession = await getActiveTaxQuestionnaireSession(tenantId);
  if (!tqSession) {
    return NextResponse.json({ success: false, error: 'no_active_session' }, { status: 400 });
  }

  const result = await cancelTaxQuestionnaire(tqSession);
  return NextResponse.json({ success: true, data: result });
}
```

- [ ] **Step 4: `GET /tax-fast-track/status`**

The `/status` lookup is deliberately NOT `getActiveTaxQuestionnaireSession` (which filters `status: 'in_progress'` — a `completed` session, the exact state with a draft worth showing, would never match). This route needs the tenant's most recent session regardless of status:

```ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STALE_PENDING_MS = 2 * 60 * 1000;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const session = await db.abTaxQuestionnaireSession.findFirst({
    where: { tenantId },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) {
    return NextResponse.json({ success: true, data: { session: null, draft: null } });
  }

  const draftRow = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId: session.id } });
  const draft = draftRow
    ? {
      status: draftRow.status,
      draftPdfUrl: draftRow.draftPdfUrl,
      letterPdfUrl: draftRow.letterPdfUrl,
      draftSummary: draftRow.draftSummary,
      errorMsg: draftRow.errorMsg,
      // A killed after() invocation (e.g. the function was frozen before
      // generateFilingDraft finished) leaves the row 'pending' forever with
      // nothing to flip it to 'failed' — flag it as stale past a fixed
      // timeout so the UI can offer a retry rather than polling forever.
      stale: draftRow.status === 'pending' && Date.now() - draftRow.updatedAt.getTime() > STALE_PENDING_MS,
    }
    : null;

  return NextResponse.json({
    success: true,
    data: {
      session: {
        id: session.id, status: session.status, qaHistory: session.qaHistory, askedCount: session.askedCount,
      },
      draft,
    },
  });
}
```

- [ ] **Step 5: `POST /tax-fast-track/regenerate`**

```ts
import 'server-only';
import { after, NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { callGemini } from '@agentbook-core/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { generateFilingDraft } from '@/lib/tax-fast-track-draft';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 90;

const STALE_PENDING_MS = 2 * 60 * 1000;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const __resolved = await safeResolveAgentbookTenant(request);
  if ('response' in __resolved) return __resolved.response;
  const { tenantId } = __resolved;

  const body = await request.json().catch(() => ({}));
  const sessionId = String(body.sessionId ?? '');
  if (!sessionId) {
    return NextResponse.json({ success: false, error: 'sessionId required' }, { status: 400 });
  }

  const session = await db.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
  if (!session || session.tenantId !== tenantId || session.status !== 'completed') {
    return NextResponse.json({ success: false, error: 'session not eligible for regeneration' }, { status: 400 });
  }

  const draft = await db.abTaxFastTrackDraft.findUnique({ where: { sessionId } });
  const isStale = !!draft && draft.status === 'pending' && Date.now() - draft.updatedAt.getTime() > STALE_PENDING_MS;
  if (draft && draft.status !== 'failed' && !isStale) {
    return NextResponse.json({ success: false, error: `draft is '${draft.status}', not eligible for regeneration` }, { status: 400 });
  }

  after(() => generateFilingDraft(sessionId, callGemini).catch((err) => {
    console.error('[tax-fast-track/regenerate] generateFilingDraft failed:', err);
  }));

  return NextResponse.json({ success: true, data: { status: 'pending' } });
}
```

- [ ] **Step 6: Write the route tests**

Create `apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: vi.fn(async () => ({ tenantId: 'tenant-A' })),
}));

const coreMock = {
  startTaxQuestionnaire: vi.fn(),
  answerTaxQuestionnaire: vi.fn(),
  cancelTaxQuestionnaire: vi.fn(),
};
vi.mock('@agentbook-core/tax-questionnaire-core', () => coreMock);

const sessionHelpersMock = { getActiveTaxQuestionnaireSession: vi.fn() };
vi.mock('@agentbook-core/tax-questionnaire-session', () => sessionHelpersMock);

vi.mock('@agentbook-core/server', () => ({ callGemini: vi.fn() }));

const generateFilingDraftMock = vi.fn(async () => {});
vi.mock('@/lib/tax-fast-track-draft', () => ({ generateFilingDraft: (...args: any[]) => generateFilingDraftMock(...args) }));

const afterMock = vi.fn((cb: () => void) => cb());
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server');
  return { ...actual, after: (...args: any[]) => afterMock(...args) };
});

const dbMock = {
  abTenantConfig: { findFirst: vi.fn(async () => null as any) },
  abTaxQuestionnaireSession: { findFirst: vi.fn(async () => null as any), findUnique: vi.fn(async () => null as any) },
  abTaxFastTrackDraft: { findUnique: vi.fn(async () => null as any) },
};
vi.mock('@naap/database', () => ({ prisma: dbMock }));

function makeRequest(body: unknown) {
  return new NextRequest('http://localhost/api/v1/agentbook-core/tax-fast-track/start', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('POST /tax-fast-track/start', () => {
  it('resolves jurisdiction via abTenantConfig.findFirst({where:{userId}}) and triggers generateFilingDraft on done', async () => {
    dbMock.abTenantConfig.findFirst.mockResolvedValue({ jurisdiction: 'ca', region: 'ON' });
    coreMock.startTaxQuestionnaire.mockResolvedValue({ status: 'done', sessionId: 'tqs-1' });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/start/route');

    const res = await POST(makeRequest({ taxYear: 2025 }));
    const json = await res.json();

    expect(dbMock.abTenantConfig.findFirst).toHaveBeenCalledWith({ where: { userId: 'tenant-A' } });
    expect(coreMock.startTaxQuestionnaire).toHaveBeenCalledWith('tenant-A', { taxYear: 2025, jurisdiction: 'ca', region: 'ON' }, expect.anything());
    expect(json.data.status).toBe('done');
    expect(generateFilingDraftMock).toHaveBeenCalledWith('tqs-1', expect.anything());
  });

  it('does not trigger generateFilingDraft when the result is a question, not done', async () => {
    coreMock.startTaxQuestionnaire.mockResolvedValue({ status: 'question', question: 'Filing status?', sessionId: 'tqs-2' });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/start/route');

    await POST(makeRequest({}));

    expect(generateFilingDraftMock).not.toHaveBeenCalled();
  });
});

describe('POST /tax-fast-track/answer', () => {
  it('returns 400 when there is no active session', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue(null);
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/answer/route');

    const res = await POST(makeRequest({ text: 'Single, no changes' }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('no_active_session');
  });

  it('happy path: answers via the core function and triggers generation on done', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue({ id: 'tqs-3' });
    coreMock.answerTaxQuestionnaire.mockResolvedValue({ status: 'done', sessionId: 'tqs-3' });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/answer/route');

    const res = await POST(makeRequest({ text: 'Still single' }));
    const json = await res.json();

    expect(json.data.status).toBe('done');
    expect(generateFilingDraftMock).toHaveBeenCalledWith('tqs-3', expect.anything());
  });
});

describe('POST /tax-fast-track/cancel', () => {
  it('returns 400 when there is no active session', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue(null);
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/cancel/route');

    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('happy path: cancels via the core function', async () => {
    sessionHelpersMock.getActiveTaxQuestionnaireSession.mockResolvedValue({ id: 'tqs-4' });
    coreMock.cancelTaxQuestionnaire.mockResolvedValue({ status: 'cancelled', sessionId: 'tqs-4' });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/cancel/route');

    const res = await POST(makeRequest({}));
    const json = await res.json();
    expect(json.data.status).toBe('cancelled');
  });
});

describe('GET /tax-fast-track/status', () => {
  it('returns {session:null, draft:null} when the tenant has never started a session', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue(null);
    const { GET } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data).toEqual({ session: null, draft: null });
  });

  it('finds a COMPLETED session (not just in_progress) and its linked draft', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({
      id: 'tqs-5', status: 'completed', qaHistory: [{ question: 'Q', answer: 'A' }], askedCount: 3,
    });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'ready', draftPdfUrl: 'https://x/draft.pdf', letterPdfUrl: 'https://x/letter.pdf',
      draftSummary: { caveat: 'est.' }, errorMsg: null, updatedAt: new Date(),
    });
    const { GET } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data.session.status).toBe('completed');
    expect(json.data.draft.status).toBe('ready');
    expect(json.data.draft.stale).toBe(false);
  });

  it('flags a draft as stale when pending for more than 2 minutes', async () => {
    dbMock.abTaxQuestionnaireSession.findFirst.mockResolvedValue({ id: 'tqs-6', status: 'completed', qaHistory: [], askedCount: 3 });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({
      status: 'pending', draftPdfUrl: null, letterPdfUrl: null, draftSummary: null, errorMsg: null,
      updatedAt: new Date(Date.now() - 3 * 60 * 1000),
    });
    const { GET } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/status/route');

    const res = await GET(makeRequest({}));
    const json = await res.json();
    expect(json.data.draft.stale).toBe(true);
  });
});

describe('POST /tax-fast-track/regenerate', () => {
  it('rejects when the session is not completed', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-7', tenantId: 'tenant-A', status: 'in_progress' });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-7' }));
    expect(res.status).toBe(400);
  });

  it('rejects when the draft is still ready (not a retry target)', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-8', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'ready', updatedAt: new Date() });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-8' }));
    expect(res.status).toBe(400);
    expect(generateFilingDraftMock).not.toHaveBeenCalled();
  });

  it('accepts a failed draft and triggers regeneration', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-9', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'failed', updatedAt: new Date() });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-9' }));
    expect(res.status).toBe(200);
    expect(generateFilingDraftMock).toHaveBeenCalledWith('tqs-9', expect.anything());
  });

  it('accepts a stale-pending draft and triggers regeneration', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-10', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'pending', updatedAt: new Date(Date.now() - 3 * 60 * 1000) });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-10' }));
    expect(res.status).toBe(200);
    expect(generateFilingDraftMock).toHaveBeenCalled();
  });

  it('rejects a fresh-pending draft (still genuinely in flight)', async () => {
    dbMock.abTaxQuestionnaireSession.findUnique.mockResolvedValue({ id: 'tqs-11', tenantId: 'tenant-A', status: 'completed' });
    dbMock.abTaxFastTrackDraft.findUnique.mockResolvedValue({ status: 'pending', updatedAt: new Date() });
    const { POST } = await import('../../../../../../app/api/v1/agentbook-core/tax-fast-track/regenerate/route');

    const res = await POST(makeRequest({ sessionId: 'tqs-11' }));
    expect(res.status).toBe(400);
    expect(generateFilingDraftMock).not.toHaveBeenCalled();
  });
});
```

Run:
```bash
cd apps/web-next && npx vitest run src/__tests__/api/v1/agentbook-core/tax-fast-track/routes.test.ts
```
Expected: all tests pass. (Adjust the relative `../../../../../../app/...` import depth to match the test file's actual final location if it differs.)

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track apps/web-next/src/__tests__/api/v1/agentbook-core/tax-fast-track
git commit -m "feat(tax): UI-facing start/answer/cancel/status/regenerate routes (PR-4, Task 6)"
```

---

## Task 7: `FastTrackTab.tsx` — the UI question + review/download screens

**Files:**
- Create: `plugins/agentbook-tax/frontend/src/pages/FastTrackTab.tsx`
- Modify: `plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx` (add the third tab)

**Interfaces:**
- Consumes: the 5 routes from Task 6, all under `/api/v1/agentbook-core/tax-fast-track/*` (note: a DIFFERENT API base than this plugin's own `/api/v1/agentbook-tax/*` — `TaxPackage.tsx`'s `PastFilingsPage`/`TaxPackageContent` call `/api/v1/agentbook-tax/*`; this new tab calls `/api/v1/agentbook-core/*` instead, since the questionnaire/draft models live in the `agentbook-core` plugin, not `agentbook-tax`).

- [ ] **Step 1: Write `FastTrackTab.tsx`**

```tsx
/**
 * Tax fast-track questionnaire tab (PR-4) — a UI-native path to answer the
 * same adaptive questionnaire chat already drives (PR-3), plus a review/
 * download screen for the generated filing draft + client letter.
 *
 * Same plain useState + useEffect + relative fetch() pattern as
 * TaxPackageContent/PastFilingsPage in this same plugin — no new state
 * library. Polls GET /status while a session is mid-conversation or a
 * draft is 'pending', mirroring PastFilings.tsx's poll-while-processing
 * pattern exactly.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileText, Loader2, Send, XCircle } from 'lucide-react';

const API = '/api/v1/agentbook-core/tax-fast-track';

interface QaPair { question: string; answer: string; }

interface StatusResponse {
  session: { id: string; status: string; qaHistory: QaPair[]; askedCount: number } | null;
  draft: {
    status: string;
    draftPdfUrl: string | null;
    letterPdfUrl: string | null;
    draftSummary: {
      estimatedTotalIncomeCents?: number;
      estimatedTaxableIncomeCents?: number;
      estimatedTaxPayableCents?: number;
      taxPayableDeltaVsLastYearCents?: number;
      changesFromLastYear: string[];
      openQuestions: string[];
      caveat: string;
    } | null;
    errorMsg: string | null;
    stale: boolean;
  } | null;
}

const fmtMoney = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const FastTrackTab: React.FC = () => {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [sending, setSending] = useState(false);
  const [answerText, setAnswerText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/status`);
      const j = await res.json();
      if (j.success) setData(j.data);
    } catch { /* silent, matches PastFilingsPage's own load() */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => {
      setData((prev) => {
        const shouldPoll = prev?.session?.status === 'in_progress' || prev?.draft?.status === 'pending';
        if (shouldPoll) load();
        return prev;
      });
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      const res = await fetch(`${API}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) });
      const j = await res.json();
      if (!j.success) { setError(j.error || 'Failed to start.'); return; }
      if (j.data.status === 'blocked') { setError(j.data.message); return; }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const sendAnswer = async () => {
    if (!answerText.trim()) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`${API}/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: answerText }) });
      const j = await res.json();
      if (!j.success) { setError(j.error || 'Failed to send answer.'); return; }
      setAnswerText('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const cancel = async () => {
    if (!confirm('Cancel the tax fast-track questionnaire?')) return;
    await fetch(`${API}/cancel`, { method: 'POST' });
    await load();
  };

  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    if (!data?.session?.id || retrying) return; // guard against a double-click firing two concurrent generations
    setRetrying(true);
    try {
      await fetch(`${API}/regenerate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: data.session.id }) });
      await load();
    } finally {
      setRetrying(false);
    }
  };

  if (loading) {
    return <div className="px-4 py-5 sm:p-6 max-w-3xl mx-auto text-sm text-muted-foreground">Loading…</div>;
  }

  const { session, draft } = data || { session: null, draft: null };

  return (
    <div className="px-4 py-5 sm:p-6 max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <FileText className="w-6 h-6 text-primary" />
        <h1 className="text-2xl font-bold">Tax Fast-Track</h1>
      </div>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      {/* Screen 1: no active session, no draft */}
      {!session && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-muted-foreground mb-4">
            Answer a short, adaptive set of questions based on your confirmed prior-year return, and get an estimated filing draft plus a cover letter for your accountant.
          </p>
          <button
            onClick={start}
            disabled={starting}
            className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50 inline-flex items-center gap-2"
          >
            {starting ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</> : 'Start'}
          </button>
        </div>
      )}

      {/* Screen 2: active session, incomplete — the transcript + answer box */}
      {session && session.status === 'in_progress' && (
        <div className="bg-card border border-border rounded-xl p-4">
          <div className="space-y-3 mb-4">
            {session.qaHistory.map((qa, i) => (
              <div key={i} className="border-b border-border/50 pb-2 last:border-0">
                <p className="text-sm font-medium">{qa.question}</p>
                {qa.answer ? <p className="text-sm text-muted-foreground mt-1">{qa.answer}</p> : <p className="text-xs text-primary mt-1">Waiting for your answer…</p>}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={answerText}
              onChange={(e) => setAnswerText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') sendAnswer(); }}
              placeholder="Type your answer…"
              className="flex-1 p-2 border border-border rounded-lg bg-background text-sm"
              disabled={sending}
            />
            <button onClick={sendAnswer} disabled={sending || !answerText.trim()} className="px-3 py-2 bg-primary text-primary-foreground rounded-lg disabled:opacity-50">
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </button>
            <button onClick={cancel} className="px-3 py-2 border border-border rounded-lg text-muted-foreground hover:bg-muted/50">
              <XCircle className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Screen 3: completed, draft pending */}
      {session && session.status === 'completed' && draft && draft.status === 'pending' && !draft.stale && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <Loader2 className="w-5 h-5 animate-spin mx-auto mb-2 text-primary" />
          <p className="text-sm text-muted-foreground">Generating your draft…</p>
        </div>
      )}

      {/* Screen 4: draft ready — review + download */}
      {draft && draft.status === 'ready' && draft.draftSummary && (
        <div className="bg-card border border-border rounded-xl p-4 space-y-4">
          {draft.draftSummary.estimatedTaxPayableCents != null && (
            <div>
              <h2 className="text-sm font-medium text-muted-foreground mb-2">Estimated figures</h2>
              <div className="text-sm space-y-1">
                <div className="flex justify-between"><span>Estimated tax payable</span><span>{fmtMoney(draft.draftSummary.estimatedTaxPayableCents)}</span></div>
                {draft.draftSummary.taxPayableDeltaVsLastYearCents != null && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>Vs. last year's actual tax payable</span>
                    <span>{draft.draftSummary.taxPayableDeltaVsLastYearCents >= 0 ? '+' : '-'}{fmtMoney(Math.abs(draft.draftSummary.taxPayableDeltaVsLastYearCents))}</span>
                  </div>
                )}
              </div>
            </div>
          )}
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-2">What changed this year</h2>
            {draft.draftSummary.changesFromLastYear.length
              ? <ul className="text-sm list-disc pl-4 space-y-1">{draft.draftSummary.changesFromLastYear.map((c, i) => <li key={i}>{c}</li>)}</ul>
              : <p className="text-sm text-muted-foreground">No material changes identified.</p>}
          </div>
          <div>
            <h2 className="text-sm font-medium text-muted-foreground mb-2">Open questions for your accountant</h2>
            {draft.draftSummary.openQuestions.length
              ? <ul className="text-sm list-disc pl-4 space-y-1">{draft.draftSummary.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
              : <p className="text-sm text-muted-foreground">None identified.</p>}
          </div>
          <p className="text-xs italic text-red-700">{draft.draftSummary.caveat}</p>
          <div className="flex gap-2 pt-2 border-t border-border">
            {draft.draftPdfUrl && (
              <a href={draft.draftPdfUrl} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1">
                <Download className="w-3.5 h-3.5" /> Filing draft
              </a>
            )}
            {draft.letterPdfUrl && (
              <a href={draft.letterPdfUrl} target="_blank" rel="noreferrer" className="px-3 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1">
                <Download className="w-3.5 h-3.5" /> Client letter
              </a>
            )}
          </div>
        </div>
      )}

      {/* Screen 5: failed, or stuck pending past the staleness timeout */}
      {draft && (draft.status === 'failed' || draft.stale) && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-red-500 mb-3">
            {draft.status === 'failed' ? `Something went wrong (${draft.errorMsg}).` : 'This is taking longer than expected.'}
          </p>
          <button onClick={retry} disabled={retrying} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50 inline-flex items-center gap-2">
            {retrying ? <><Loader2 className="w-4 h-4 animate-spin" /> Retrying…</> : 'Try again'}
          </button>
        </div>
      )}

      {/* A cancelled/abandoned session with no draft falls back to screen 1's copy on next load (session is not null but status isn't in_progress/completed) */}
      {session && session.status !== 'in_progress' && session.status !== 'completed' && !draft && (
        <div className="bg-card border border-border rounded-xl p-6 text-center">
          <p className="text-sm text-muted-foreground mb-4">Your last fast-track session was cancelled. Start a new one whenever you're ready.</p>
          <button onClick={start} disabled={starting} className="px-4 py-2 bg-primary text-primary-foreground rounded-lg font-medium disabled:opacity-50 inline-flex items-center gap-2">
            {starting ? <><Loader2 className="w-4 h-4 animate-spin" /> Starting…</> : 'Start'}
          </button>
        </div>
      )}
    </div>
  );
};
```

- [ ] **Step 2: Wire the third tab into `TaxPackage.tsx`**

Change the tab union and button bar (`TaxPackage.tsx:14-70`):

```tsx
import { PastFilingsPage } from './PastFilings';
import { FastTrackTab } from './FastTrackTab';
```

```tsx
  const [tab, setTab] = useState<'package' | 'past' | 'fast-track'>(
    typeof window !== 'undefined' &&
      new URLSearchParams(window.location.search).get('tab') === 'past'
      ? 'past'
      : 'package',
  );

  return (
    <div>
      {/* Tab bar */}
      <div className="border-b border-border px-4 sm:px-6 flex gap-0">
        {(['package', 'past', 'fast-track'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              'px-4 py-3 text-sm font-medium border-b-2 transition-colors',
              tab === t
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            ].join(' ')}
          >
            {t === 'package' ? 'Year-end Package' : t === 'past' ? 'Prior-year returns' : 'Tax Fast-Track'}
          </button>
        ))}
      </div>

      {tab === 'package' ? <TaxPackageContent /> : tab === 'past' ? <PastFilingsPage /> : <FastTrackTab />}
    </div>
  );
```

- [ ] **Step 3: Build the plugin frontend and copy the bundle**

```bash
cd plugins/agentbook-tax/frontend && npm run build
cp dist/production/agentbook-tax.js ../../../apps/web-next/public/cdn/plugins/agentbook-tax/agentbook-tax.js
cp dist/production/agentbook-tax.js ../../../apps/web-next/public/cdn/plugins/agentbook-tax/1.0.0/agentbook-tax.js
```
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 4: Manual verification against a local dev server**

Start the local stack per `CLAUDE.md`'s Quick Start (database + all 4 backend servers + `apps/web-next`), log in as `maya@agentbook.test` (a CA persona with existing data), navigate to the Tax Package page, click the new "Tax Fast-Track" tab. If Maya has no confirmed past filing yet, confirm the blocked-path copy renders with a working "Start" button that's correctly disabled/blocked; if she does (or after uploading+confirming one via the Prior-year returns tab), click Start and confirm a real question appears, answer it, confirm the transcript grows and a new question appears, and confirm Cancel works. This is a real Gemini-backed flow — expect a few seconds of latency per turn, not an error.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-tax/frontend/src/pages/FastTrackTab.tsx plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx apps/web-next/public/cdn/plugins/agentbook-tax/agentbook-tax.js apps/web-next/public/cdn/plugins/agentbook-tax/1.0.0/agentbook-tax.js
git commit -m "feat(tax): UI question + review/download screens for tax fast-track (PR-4, Task 7)"
```

---

## Task 8: e2e coverage for the UI-native path + full verification

**Files:**
- Create: `tests/e2e/tax-fast-track-ui.spec.ts` (new file — keeps PR-3's existing `tests/e2e/tax-fast-track.spec.ts`, which covers the chat path, untouched)

**Interfaces:**
- Consumes: the 5 routes from Task 6, following `tax-fast-track.spec.ts`'s own established conventions (register a fresh throwaway tenant per test, log in via the real UI so the httpOnly session cookie is set, seed a confirmed `AbPastTaxFiling` directly via `prisma`, drive the API via in-page `fetch()`).

- [ ] **Step 1: Write the e2e spec**

```ts
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
```

- [ ] **Step 2: Verify the spec parses**

```bash
cd tests/e2e && npx playwright test --list tax-fast-track-ui.spec.ts
```
Expected: 3 tests listed, no parse errors.

- [ ] **Step 3: Run the FULL backend + web-next test suites one more time**

```bash
cd plugins/agentbook-core/backend && npx vitest run
cd ../../../agentbook-jurisdictions && npx vitest run  # from packages/, adjust path if run from repo root
cd ../../apps/web-next && npx vitest run
```
Expected: no new failures beyond the already-established pre-existing/unrelated set (the 11 `abConvThread` mock-gap tests + the 1 `"invoice Acme..."` routing case, both confirmed pre-existing on `origin/main` before this branch).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/tax-fast-track-ui.spec.ts
git commit -m "test(tax): e2e coverage for the UI-native fast-track path (PR-4, Task 8)"
```

- [ ] **Step 5: Final whole-branch review**

Before opening the PR, dispatch an adversarial review (opus) over the full `git diff origin/main...HEAD`, matching the process used for PR-3 — this plan's own accuracy has NOT been independently verified against the real, current state of every file it touches beyond what was checked while writing it. Specifically ask the reviewer to confirm:
- The `tax-questionnaire-core.ts` extraction is behavior-preserving (re-run `tax-questionnaire-recovery.test.ts`/`start-tax-fast-track-skill.test.ts` and confirm they pass unchanged).
- No circular import was introduced (`server.ts` → `agent-brain.ts` → `tax-questionnaire-core.ts`, and separately `apps/web-next` → `@agentbook-core/*`, never the reverse).
- `computeFilingDraftSummaryAndLetter`'s bracket-calculation math is correct (spot-check against `calculateTax()`'s real output for a known input).
- The `after()` trigger fires on exactly the turn a session completes, across all 5 call sites (3 chat channels + 2 UI routes), and never double-fires on a version-conflict race.
- The `/status`/`/regenerate` staleness logic is sound (a genuinely-in-flight `pending` draft is never treated as retriable; a killed one is).

---
