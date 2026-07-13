# Tax Fast-Track Filing Draft + Client Letter — Design

**PR-4 of the tax-fast-track/personal-finance roadmap.** Follows PR-3 (foundation: `AbTaxQuestionnaireSession`, the adaptive multi-turn questionnaire engine, and the chat-only `start-tax-fast-track` skill). This PR turns a completed questionnaire into two downloadable artifacts — a filing-draft PDF and a client letter PDF — and adds a UI-native way to answer the questionnaire (not just chat).

## Goals

1. When a fast-track questionnaire session completes (chat or UI), automatically generate:
   - A **filing draft**: a projection of this year's filing, combining last year's `StandardTaxExtract` (real baseline numbers) with this year's `qaHistory` (prose deltas, turned into structured deltas by the LLM) — the actual estimated-tax figures come from the existing, tested `calculateTax()` bracket calculator, not an LLM guess; the LLM's job is turning prose into structured signal and narrating the result, never inventing the numbers themselves. Always an estimate with explicit caveats, not a filed return.
   - A **client letter**: a cover letter the freelancer/small-business owner can hand to their own accountant/bookkeeper, summarizing what changed this year and flagging open questions — written *to* the accountant, *from* the tenant, not written by AgentBook to the tenant.
2. Add a UI-native path to answer the questionnaire from `TaxPackage.tsx` (a new tab), so users who don't use chat can still use the feature — driving the *same* `AbTaxQuestionnaireSession` chat already uses, not a parallel session type.
3. Do this without duplicating PR-3's already-shipped, already-tested state-machine logic (cancel-keyword handling, pending-question recovery, consecutive-failure cap, version-guarded updates) between chat and the new UI routes.

## Non-goals

- No *new* tax-calculation engine — the numeric estimate reuses the existing `{us,ca}/tax-brackets.ts` `calculateTax()`, which this PR does not modify. This PR is not building bracket logic, filing-status rules, or anything jurisdiction-specific beyond wiring existing calculators into a new pipeline. Every rendered draft still carries a plain-language "this is an estimate, not a filed return" caveat regardless of whether the numeric fields were computable.
- No billing gate in this PR. Ships ungated, same as PR-3 — PR-5 adds the gate once this PR gives the feature area an actual deliverable to gate.
- No AU/UK support — scoped to us/ca, matching PR-3's `TaxQuestionnairePack` scope (there is no `FilingDraftPack` for au/uk either).
- No editing of `qaHistory` answers after the fact, and no editing of the generated draft/letter content — review-and-download only. A failed generation gets a retry button; a completed one does not get an "edit and regenerate" flow.
- No email/send-to-accountant delivery mechanism — the letter is a PDF the tenant downloads and sends themselves.

## Architecture overview

Three layers:

1. **Shared core state machine** — PR-3's questionnaire logic (start/answer/cancel), extracted out of chat-only code into plain async functions that both the chat skill and new UI-facing HTTP routes call as thin wrappers.
2. **Generation on completion** — the moment an answer causes a session to reach `completed` (via either caller), synchronously kick off filing-draft + client-letter generation and persist the result.
3. **UI** — a new tab in `TaxPackage.tsx` with a question screen (mirrors the chat conversation) and a review/download screen (shows the generated draft, offers both PDFs for download).

## Data model

New model, `packages/database/prisma/schema.prisma`:

```prisma
model AbTaxFastTrackDraft {
  id              String   @id @default(uuid())
  tenantId        String
  sessionId       String   @unique  // 1:1 with AbTaxQuestionnaireSession
  taxYear         Int
  jurisdiction    String
  status          String   @default("pending")  // pending | ready | failed
  draftPdfUrl     String?
  letterPdfUrl    String?
  draftSummary    Json?    // structured LLM output (FilingDraftSummary) — the review screen renders from this, not just a PDF link
  errorMsg        String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  @@index([tenantId])
  @@schema("plugin_agentbook_core")
}
```

Keyed by `sessionId` (unique, not `tenantId+taxYear`) — a session is the source of truth for what was actually asked and answered. A tenant who cancels and restarts gets a brand-new session, and therefore a brand-new draft row, rather than an ambiguous overwrite of a stale one. This is a separate table from `AbTaxQuestionnaireSession` (not extra columns on it) so conversation state (PR-3's contract: version-guarded, no-retry updates) stays untouched, and the draft gets its own independent pending/ready/failed lifecycle with a clean regenerate/retry story — mirrors `AbTaxPackage`'s existing precedent (`packages/database/prisma/schema.prisma:2355-2372`) exactly.

**Migration-ordering note**: `generateFilingDraft` depends unconditionally on this table existing the moment any session first completes — the same deploy-ordering class of risk PR-3 hit with `AbTaxQuestionnaireSession` (there, mitigated only because the build pipeline's automatic `prisma db push --accept-data-loss` happened to run before the code needing the table went live). Same expectation applies here: the additive migration lands as part of the normal build/deploy flow, not as a separately-sequenced step, but this should be explicitly re-verified at deploy time rather than assumed a second time.

## Shared core: extracting PR-3's state machine

New module `plugins/agentbook-core/backend/src/tax-questionnaire-core.ts`, exporting three functions with **no chat-specific concerns** (no `skillUsed`, no `AgentResponse` shape, no `confidence` field):

```ts
type CoreResult =
  | { status: 'question'; question: string; sessionId: string }
  | { status: 'done'; sessionId: string }
  | { status: 'blocked'; message: string }   // e.g. no confirmed filing
  | { status: 'failed'; message: string }    // callGemini/parse failure, or data-invariant violation
  | { status: 'cancelled'; sessionId: string }
  | { status: 'no_session' };                // answer/cancel called with nothing active

async function startTaxQuestionnaire(tenantId: string, params: { taxYear?: number }): Promise<CoreResult>
async function answerTaxQuestionnaire(tenantId: string, text: string): Promise<CoreResult>
async function cancelTaxQuestionnaire(tenantId: string): Promise<CoreResult>
```

- `startTaxQuestionnaire` is `server.ts`'s current `start-tax-fast-track` INTERNAL handler body, with the HTTP/chat response wrapping stripped out — same confirmed-filing filter, same jurisdiction-support check (PR-3's post-deploy hotfix), same seed-`qaHistory`-with-pending-entry contract.
- `answerTaxQuestionnaire` is `agent-brain.ts`'s Step 1b "otherwise, treat as an answer" branch, verbatim logic (pending-question recovery, `callGemini` falsy-check before any try/catch, `consecutiveFailures` cap, 8-question hard cap, `expiresAt` refresh-on-success-only). When it detects `isDone`, it calls `updateTaxQuestionnaireSession(..., {status:'completed', ...})` exactly as today; **`generateFilingDraft(sessionId)` is called only if that version-guarded update returns `true`** (i.e., this call actually won the race to complete the session). If it returns `false` (another concurrent call — chat and UI racing, or a double-submit — already completed it), this call returns PR-3's existing `{status: 'failed', message: 'Session was modified by another process...'}` and does **not** also call `generateFilingDraft` — generation fires exactly once per session, never per completing-call.
- `cancelTaxQuestionnaire` is Step 1b's cancel branch, verbatim.

**Chat callers become thin wrappers**, ported verbatim so existing behavior (exact message text, `skillUsed`/`confidence` values) is unchanged:
- `server.ts`'s `start-tax-fast-track` handler calls `startTaxQuestionnaire`, translates each `CoreResult` variant into today's exact chat response.
- `agent-brain.ts`'s Step 1b calls `answerTaxQuestionnaire`/`cancelTaxQuestionnaire` (cancel-keyword detection itself stays in Step 1b, since "is this message a cancel keyword" is a chat-input-parsing question, not core state-machine logic — the UI has an explicit Cancel button instead, so it calls `cancelTaxQuestionnaire` directly without needing keyword detection).

**Regression gate**: PR-3's existing `tax-questionnaire-recovery.test.ts` and `start-tax-fast-track-skill.test.ts` must pass unchanged (not rewritten) against the refactored chat wrappers. This is a target, not a guarantee taken on faith — the plan's first implementation task must confirm those tests exercise the moved logic through its public entrypoints (`handleAgentMessage`, `executeClassification`), not through internal function names that the extraction would relocate; if any assertion turns out to depend on internal structure rather than observable behavior, that's a real regression risk to fix before proceeding, not a test to loosen.

## Generation: `FilingDraftPack` + orchestrator

**Numbers come from the real bracket calculator, not the LLM's imagination.** `packages/agentbook-jurisdictions/src/{us,ca}/tax-brackets.ts` already export a tested `calculateTax(taxableIncomeCents, taxYear): TaxCalculation` — since the client letter's entire purpose is credibility with a professional accountant, an LLM-invented number undermines the point when a real calculator already exists. The pipeline below keeps the same 2-LLM-call budget as a naive "ask the LLM for numbers" design, just restructured: the LLM's job is to turn prose into *structured deltas*, a deterministic step turns those deltas + last year's real baseline into a *real* number, and the second LLM call narrates using that real number.

New interface, `packages/agentbook-jurisdictions/src/interfaces.ts`, following `TaxQuestionnairePack`'s convention (pure prompt-builders and parsers; the pack never calls an LLM or touches a raw string):

```ts
export interface FilingDraftDeltas {
  incomeDeltaPercent?: number       // this year vs. last year, signed; omitted if qaHistory gave no usable signal
  filingStatusChanged?: boolean
  newFilingStatus?: string
  dependentsDelta?: number          // net change in dependent count
  changesFromLastYear: string[]     // plain-language bullets, for direct display
  openQuestions: string[]           // things the accountant should double check
}

export interface FilingDraftSummary {
  estimatedTotalIncomeCents?: number      // omitted (not guessed) if priorFiling lacked usable baseline numbers
  estimatedTaxableIncomeCents?: number
  estimatedTaxPayableCents?: number       // from calculateTax(), never LLM-invented
  estimatedRefundOrBalanceCents?: number  // positive = refund, negative = balance owing
  changesFromLastYear: string[]
  openQuestions: string[]
  caveat: string                          // required: "this is an estimate, not a filed return"
}

export interface FilingDraftPack {
  jurisdiction: string
  extractDeltasPrompt(input: { qaHistory: QaPair[]; priorFiling: StandardTaxExtract }): string
  parseDeltas(parsed: unknown): FilingDraftDeltas
  clientLetterPrompt(input: { qaHistory: QaPair[]; priorFiling: StandardTaxExtract; summary: FilingDraftSummary }): string
  parseClientLetter(parsed: unknown): { letterBody: string }
}
```

`us/filing-draft-pack.ts` and `ca/filing-draft-pack.ts` implementations, plus a `filing-draft-loader.ts` (`getFilingDraftPack`/`registerFilingDraftPack`/`listSupportedJurisdictions`), all mirroring `tax-questionnaire-pack.ts`/`tax-questionnaire-loader.ts` exactly.

New orchestrator, `generateFilingDraft(sessionId: string): Promise<void>` in `plugins/agentbook-core/backend/src/tax-fast-track-draft.ts`:

1. Load the `AbTaxQuestionnaireSession` (must be `completed`) and its `sourceFilingId`'s `AbPastTaxFiling.extractedData`.
2. Upsert `AbTaxFastTrackDraft{sessionId}` to `status:'pending'` (a retry re-upserts the same row, not a new one — see the concurrency note below on what "idempotent" does and doesn't cover here).
3. Get the pack for the session's jurisdiction. `extractDeltasPrompt` → `callGemini` → falsy-check (never assume it throws, per the standing convention from PR-3) → parse/`parseDeltas`. Any failure at this step → `status:'failed'`, `errorMsg: 'delta_extraction_failed'`, return.
4. **Deterministic, no LLM call**: if `priorFiling.taxableIncomeCents` is present, apply `deltas.incomeDeltaPercent` to it and call the jurisdiction's `calculateTax(adjustedIncomeCents, taxYear)` for the real `estimatedTaxPayableCents`/refund-or-balance figures. If `priorFiling` lacks a usable baseline (low-confidence extraction, missing fields — `extractedData` is untyped JSON, this does happen), skip the numeric fields entirely rather than guessing — the resulting `FilingDraftSummary` degrades gracefully to a qualitative-only draft (`changesFromLastYear`/`openQuestions`/`caveat`, no numbers), which is safer than a number with no real basis.
5. `clientLetterPrompt` (using step 4's `FilingDraftSummary`, numbers included when available) → `callGemini` → falsy-check → parse/`parseClientLetter`. Any failure → `status:'failed'`, `errorMsg: 'letter_generation_failed'`, return.
6. Render both to PDF via `@react-pdf/renderer` — one new file, `tax-fast-track-pdf.ts`, exporting `renderFilingDraftPdf(summary)` and `renderClientLetterPdf(letterBody, summary)` (two small, related documents; one file, following `renderPackagePdf`'s buffer-return pattern and its established visual vocabulary — 10pt Helvetica body, 18pt header, bordered section titles — rather than splitting into two files for no functional reason).
7. Upload both buffers via `uploadBlob()`, update the row to `status:'ready'` with both URLs and the `draftSummary` JSON.

Failure codes (`TaxFastTrackDraftFailureCode`, mirroring `TaxPackageFailureCode`): `delta_extraction_failed`, `letter_generation_failed`, `pdf_render_failed`, `upload_failed`. Never a raw stack trace persisted or surfaced.

**Concurrency note**: "idempotent" above means *safe to call again after a failure*, not *safe to call concurrently with itself*. Two simultaneous calls for the same `sessionId` (e.g., a double-clicked "Try again") would both upsert to `pending` and both do the LLM/render/upload work redundantly — wasteful (2x LLM cost) but not corrupting, since both end in a valid `ready` state with the last write winning. The plan should add a simple UI-level guard (disable the retry button while a request is in flight) rather than a backend locking mechanism — the failure mode is double LLM spend on a rare double-click, not data corruption, so a heavier fix isn't justified.

## API routes (UI-facing)

New routes under `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/`, each resolving `tenantId` via `safeResolveAgentbookTenant` (no header trust, matching every other route in this codebase):

- `POST /start` — body `{taxYear?: number}` → `startTaxQuestionnaire(tenantId, {taxYear})`, JSON `CoreResult`.
- `POST /answer` — body `{text: string}` → `answerTaxQuestionnaire(tenantId, text)`, JSON `CoreResult`.
- `POST /cancel` → `cancelTaxQuestionnaire(tenantId)`, JSON `CoreResult`.
- `GET /status` → **not** a reuse of PR-3's `getActiveTaxQuestionnaireSession` (which filters `status:'in_progress'` — a `completed` session, the exact state that has a draft worth showing, would never match that query). This route needs its own lookup: the tenant's most recent `AbTaxQuestionnaireSession` regardless of status, ordered by `createdAt` desc, plus its linked `AbTaxFastTrackDraft` if one exists. Returns `{session: {qaHistory, askedCount, status} | null, draft: {status, draftPdfUrl, letterPdfUrl, draftSummary, errorMsg} | null}`. This is what the UI polls while generation is `pending`, and what it reads on page load both to resume an in-progress conversation and to show a completed one's review screen.
- `POST /regenerate` — body `{sessionId: string}` → re-invokes `generateFilingDraft(sessionId)` for an existing `completed` session whose draft is `failed`, **or `pending` for longer than the staleness timeout** (see below — a killed mid-flight request looks identical to a slow-but-alive one from the outside, so treat both as retriable once the timeout elapses). Rejects (400) if the session isn't `completed`, or the draft is `ready`, or the draft is `pending` and still within the timeout — this is a retry path, not a way to regenerate a `ready` draft or interrupt a genuinely in-flight one.

**Latency / timeout risk (verified, not speculative)**: `apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts` sets `export const maxDuration = 30`. The "automatically on completion" decision means the *final* answer in a questionnaire triggers, inline in the same request: 1 `callGemini` call (delta extraction) + 1 deterministic calculation + 1 `callGemini` call (letter) + 2 PDF renders + 2 blob uploads — all before the response returns. Two sequential LLM round-trips alone can approach 30s under tail latency; a timeout here isn't a graceful failure, it's a session left `completed` with the draft stuck `pending` forever and nothing to re-trigger it (the `/regenerate` route above only accepts a `failed` draft, not a `pending` one stuck by an aborted request). Two concrete mitigations, both required, not optional:
1. Raise `maxDuration` on `/agent/message`, the new `/answer` route, and the Telegram webhook route to a value with real headroom (e.g. 120s — well under Vercel's current 300s ceiling) for this code path specifically.
2. `generateFilingDraft` must be resilient to being killed mid-flight: since it's called synchronously today per the "generate on completion" decision, a request timeout that kills the function leaves the draft row `pending` indefinitely with no owner. The plan should add a cheap staleness check to `/status` and `/regenerate`: a draft `pending` for longer than a fixed timeout (e.g. 2 minutes) is treated as failed for retry purposes, even though nothing explicitly wrote `status:'failed'` to it — otherwise a single killed request produces a permanently stuck row with no way for the user to retry.

## UI

New third tab value in `TaxPackage.tsx`'s existing `useState<'package'|'past'>` → `'package'|'past'|'fast-track'`, rendering a new `FastTrackTab.tsx` (co-located with `PastFilings.tsx`, same plain `useState`+`useEffect`+relative-`fetch` pattern used throughout this plugin — no new state library). Screen states, driven by `GET /status`:

1. **No active session, no draft** — explanatory copy + a "Start" button. Disabled with the blocked-path message if there's no confirmed past filing (same wording as chat's blocked-path reply, so the two surfaces agree).
2. **Active session, incomplete** — the `qaHistory` transcript (question/answer pairs, most recent question highlighted), a text input + Send button (`POST /answer`), a Cancel button (`POST /cancel`).
3. **Session completed, draft `pending`** — "Generating your draft…" with a `setInterval` poll on `GET /status` (matches `PastFilings.tsx`'s existing poll-while-processing pattern).
4. **Draft `ready`** — review screen: `draftSummary` rendered as readable sections (estimated figures, changes-from-last-year bullets, open-questions bullets, the caveat), two Download buttons linking directly to `draftPdfUrl`/`letterPdfUrl`.
5. **Draft `failed`, or `pending` past the staleness timeout** — the categorized error message (or a generic "this is taking too long" message for the stale-pending case, which has no `errorMsg` to show) + a "Try again" button, disabled immediately on click to avoid a double-submit firing two concurrent generations (see the concurrency note above), that calls `POST /regenerate`.

## Error handling summary

- `callGemini` returning falsy is checked explicitly before any parse attempt, at every step — never assumed to throw (the one recurring bug class from PR-3's review rounds).
- Every `AbTaxFastTrackDraft` failure is categorized, never a raw exception surfaced to the UI or persisted as `errorMsg`.
- `generateFilingDraft` is safe to call again after a failure (upsert-then-update), but not safe to call concurrently with itself for the same session — see the concurrency note under Generation. The UI mitigates this by disabling the retry button while a request is in flight, not by adding backend locking.
- No interaction with PR-3's `AbAgentSession` mutual exclusion or version-guarded update contract — this PR only adds a new, independently-lifecycled table and reads from the existing session, never writes `qaHistory`/`askedCount`/`expiresAt` outside the already-shipped core functions.

## Billing

Ungated, matching PR-3's explicit decision. This PR is what gives PR-5's billing gate something real to gate — shipping it gated here would mean gating a feature nobody can evaluate yet.

## Testing plan

- Unit tests: `FilingDraftPack` us/ca implementations (`extractDeltasPrompt`/`parseDeltas`/`clientLetterPrompt`/`parseClientLetter`, mirroring the density of PR-3's `us/ca-tax-questionnaire-pack.test.ts`).
- Unit tests: `generateFilingDraft` orchestrator (mocked `callGemini`, mocked blob upload) — happy path with a real `calculateTax()` call verified against a known input/output pair, the graceful-degradation path when `priorFiling` lacks usable baseline numbers, each of the 4 categorized failure codes, safe-retry-after-failure.
- Unit tests: `answerTaxQuestionnaire`'s generation trigger — confirms `generateFilingDraft` fires exactly once when the version-guarded completion update succeeds, and not at all when it returns `false` (simulated version conflict).
- Unit tests: the 5 new UI-facing routes (mocked core functions — these routes are thin wrappers, so their tests assert correct translation/auth, not questionnaire logic), including `/status`'s "most recent session regardless of status" query and `/regenerate`'s stale-`pending`-vs-still-fresh-`pending` branching.
- **Regression**: PR-3's `tax-questionnaire-recovery.test.ts` and `start-tax-fast-track-skill.test.ts` must pass unchanged against the refactored chat wrappers — the plan's first task confirms these tests exercise `handleAgentMessage`/`executeClassification` as black boxes before the extraction, so "unchanged" is a meaningful regression gate rather than an assumption.
- e2e: extend `tests/e2e/tax-fast-track.spec.ts` (or a new sibling file) with a UI-native path — start via `POST /start`, answer via `POST /answer` until completion, poll `/status` until the draft is `ready`, assert both download URLs are present and resolve to a PDF content-type.
