# Tax Fast-Track Filing Draft + Client Letter — Design

**PR-4 of the tax-fast-track/personal-finance roadmap.** Follows PR-3 (foundation: `AbTaxQuestionnaireSession`, the adaptive multi-turn questionnaire engine, and the chat-only `start-tax-fast-track` skill). This PR turns a completed questionnaire into two downloadable artifacts — a filing-draft PDF and a client letter PDF — and adds a UI-native way to answer the questionnaire (not just chat).

## Goals

1. When a fast-track questionnaire session completes (chat or UI), automatically generate:
   - A **filing draft**: an LLM-narrated projection of this year's filing, combining last year's `StandardTaxExtract` (numbers) with this year's `qaHistory` (prose deltas) — an estimate with explicit caveats, not a computed/filed return.
   - A **client letter**: a cover letter the freelancer/small-business owner can hand to their own accountant/bookkeeper, summarizing what changed this year and flagging open questions — written *to* the accountant, *from* the tenant, not written by AgentBook to the tenant.
2. Add a UI-native path to answer the questionnaire from `TaxPackage.tsx` (a new tab), so users who don't use chat can still use the feature — driving the *same* `AbTaxQuestionnaireSession` chat already uses, not a parallel session type.
3. Do this without duplicating PR-3's already-shipped, already-tested state-machine logic (cancel-keyword handling, pending-question recovery, consecutive-failure cap, version-guarded updates) between chat and the new UI routes.

## Non-goals

- No tax-calculation engine. The "filing draft" is an LLM-narrated estimate, not a computed return — the spec is explicit that every rendered draft carries a plain-language "this is an estimate, not a filed return" caveat.
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
- `answerTaxQuestionnaire` is `agent-brain.ts`'s Step 1b "otherwise, treat as an answer" branch, verbatim logic (pending-question recovery, `callGemini` falsy-check before any try/catch, `consecutiveFailures` cap, 8-question hard cap, `expiresAt` refresh-on-success-only). When it detects `isDone`, it calls `generateFilingDraft(sessionId)` (fire-and-await, not fire-and-forget — the caller's `'done'` result implies generation was attempted) before returning `{status:'done', sessionId}`.
- `cancelTaxQuestionnaire` is Step 1b's cancel branch, verbatim.

**Chat callers become thin wrappers**, ported verbatim so existing behavior (exact message text, `skillUsed`/`confidence` values) is unchanged:
- `server.ts`'s `start-tax-fast-track` handler calls `startTaxQuestionnaire`, translates each `CoreResult` variant into today's exact chat response.
- `agent-brain.ts`'s Step 1b calls `answerTaxQuestionnaire`/`cancelTaxQuestionnaire` (cancel-keyword detection itself stays in Step 1b, since "is this message a cancel keyword" is a chat-input-parsing question, not core state-machine logic — the UI has an explicit Cancel button instead, so it calls `cancelTaxQuestionnaire` directly without needing keyword detection).

**Regression gate**: PR-3's existing `tax-questionnaire-recovery.test.ts` and `start-tax-fast-track-skill.test.ts` must pass unchanged (not rewritten) against the refactored chat wrappers — proving the extraction preserved exact behavior rather than just "seems equivalent."

## Generation: `FilingDraftPack` + orchestrator

New interface, `packages/agentbook-jurisdictions/src/interfaces.ts`, following `TaxQuestionnairePack`'s convention (pure prompt-builders and parsers; the pack never calls an LLM or touches a raw string):

```ts
export interface FilingDraftSummary {
  estimatedTotalIncomeCents?: number
  estimatedTaxableIncomeCents?: number
  estimatedRefundOrBalanceCents?: number  // positive = refund, negative = balance owing
  changesFromLastYear: string[]           // plain-language bullet list
  openQuestions: string[]                 // things the accountant should double check
  caveat: string                          // required: "this is an estimate, not a filed return"
}

export interface FilingDraftPack {
  jurisdiction: string
  draftPrompt(input: { qaHistory: QaPair[]; priorFiling: StandardTaxExtract }): string
  parseDraft(parsed: unknown): FilingDraftSummary
  clientLetterPrompt(input: { qaHistory: QaPair[]; priorFiling: StandardTaxExtract; draft: FilingDraftSummary }): string
  parseClientLetter(parsed: unknown): { letterBody: string }
}
```

Two separate LLM calls (draft, then letter using the draft's actual numbers as context) rather than one combined call — keeps each prompt focused and lets the letter reference concrete figures instead of re-deriving them. `us/filing-draft-pack.ts` and `ca/filing-draft-pack.ts` implementations, plus a `filing-draft-loader.ts` (`getFilingDraftPack`/`registerFilingDraftPack`/`listSupportedJurisdictions`), all mirroring `tax-questionnaire-pack.ts`/`tax-questionnaire-loader.ts` exactly.

New orchestrator, `generateFilingDraft(sessionId: string): Promise<void>` in `plugins/agentbook-core/backend/src/tax-fast-track-draft.ts`:

1. Load the `AbTaxQuestionnaireSession` (must be `completed`) and its `sourceFilingId`'s `AbPastTaxFiling.extractedData`.
2. Upsert `AbTaxFastTrackDraft{sessionId}` to `status:'pending'` (idempotent — a retry re-upserts the same row, not a new one).
3. Get the pack for the session's jurisdiction. `draftPrompt` → `callGemini` → falsy-check (never assume it throws, per the standing convention from PR-3) → parse/`parseDraft`. Any failure at this step → `status:'failed'`, categorized `errorMsg`, return.
4. `clientLetterPrompt` (using step 3's parsed draft) → `callGemini` → falsy-check → parse/`parseClientLetter`. Any failure → `status:'failed'`, return.
5. Render both to PDF via `@react-pdf/renderer` (new `tax-fast-track-draft-pdf.ts` / `tax-fast-track-letter-pdf.ts`, following `renderPackagePdf`'s buffer-then-upload pattern and its established visual vocabulary — 10pt Helvetica body, 18pt header, bordered section titles).
6. Upload both buffers via `uploadBlob()`, update the row to `status:'ready'` with both URLs and the `draftSummary` JSON.

Failure codes (`TaxFastTrackDraftFailureCode`, mirroring `TaxPackageFailureCode`): `draft_generation_failed`, `letter_generation_failed`, `pdf_render_failed`, `upload_failed`. Never a raw stack trace persisted or surfaced.

## API routes (UI-facing)

New routes under `apps/web-next/src/app/api/v1/agentbook-core/tax-fast-track/`, each resolving `tenantId` via `safeResolveAgentbookTenant` (no header trust, matching every other route in this codebase):

- `POST /start` — body `{taxYear?: number}` → `startTaxQuestionnaire(tenantId, {taxYear})`, JSON `CoreResult`.
- `POST /answer` — body `{text: string}` → `answerTaxQuestionnaire(tenantId, text)`, JSON `CoreResult`.
- `POST /cancel` → `cancelTaxQuestionnaire(tenantId)`, JSON `CoreResult`.
- `GET /status` → the active session (if any: `qaHistory`, `askedCount`, `status`) plus the linked `AbTaxFastTrackDraft` (if any: `status`, `draftPdfUrl`, `letterPdfUrl`, `draftSummary`) for a given tenant. This is what the UI polls while generation is `pending` and what it reads on page load to resume mid-flow.
- `POST /regenerate` — body `{sessionId: string}` → re-invokes `generateFilingDraft(sessionId)` for an existing `completed` session whose draft is `failed`; the UI's "Try again" button on the failed-draft screen. Rejects (400) if the session isn't `completed` or the draft isn't `failed` — this is a retry path, not a way to regenerate a `ready` draft.

**Latency trade-off**: because generation is triggered synchronously inside `answerTaxQuestionnaire` (per the "automatically on completion" decision), the *final* answer in a questionnaire — the one that pushes `askedCount`/LLM output to `isDone` — takes noticeably longer to respond than every prior turn: two sequential `callGemini` calls plus two PDF renders plus two blob uploads, all before the response returns. Every other turn is a single `callGemini` call, unaffected. Accepted explicitly in exchange for the chat completion message being truthfully able to say "ready now" rather than "check back later" — the alternative (a manual generate button) was the other option presented and not chosen.

## UI

New third tab value in `TaxPackage.tsx`'s existing `useState<'package'|'past'>` → `'package'|'past'|'fast-track'`, rendering a new `FastTrackTab.tsx` (co-located with `PastFilings.tsx`, same plain `useState`+`useEffect`+relative-`fetch` pattern used throughout this plugin — no new state library). Screen states, driven by `GET /status`:

1. **No active session, no draft** — explanatory copy + a "Start" button. Disabled with the blocked-path message if there's no confirmed past filing (same wording as chat's blocked-path reply, so the two surfaces agree).
2. **Active session, incomplete** — the `qaHistory` transcript (question/answer pairs, most recent question highlighted), a text input + Send button (`POST /answer`), a Cancel button (`POST /cancel`).
3. **Session completed, draft `pending`** — "Generating your draft…" with a `setInterval` poll on `GET /status` (matches `PastFilings.tsx`'s existing poll-while-processing pattern).
4. **Draft `ready`** — review screen: `draftSummary` rendered as readable sections (estimated figures, changes-from-last-year bullets, open-questions bullets, the caveat), two Download buttons linking directly to `draftPdfUrl`/`letterPdfUrl`.
5. **Draft `failed`** — the categorized error message + a "Try again" button that calls a new `POST /regenerate` (thin wrapper re-invoking `generateFilingDraft` for the existing session).

## Error handling summary

- `callGemini` returning falsy is checked explicitly before any parse attempt, at every step — never assumed to throw (the one recurring bug class from PR-3's review rounds).
- Every `AbTaxFastTrackDraft` failure is categorized, never a raw exception surfaced to the UI or persisted as `errorMsg`.
- `generateFilingDraft` is idempotent (upsert-then-update), so the UI's retry button and a hypothetical future automatic-retry cron would both be safe to call repeatedly.
- No interaction with PR-3's `AbAgentSession` mutual exclusion or version-guarded update contract — this PR only adds a new, independently-lifecycled table and reads from the existing session, never writes `qaHistory`/`askedCount`/`expiresAt` outside the already-shipped core functions.

## Billing

Ungated, matching PR-3's explicit decision. This PR is what gives PR-5's billing gate something real to gate — shipping it gated here would mean gating a feature nobody can evaluate yet.

## Testing plan

- Unit tests: `FilingDraftPack` us/ca implementations (`draftPrompt`/`parseDraft`/`clientLetterPrompt`/`parseClientLetter`, mirroring the density of PR-3's `us/ca-tax-questionnaire-pack.test.ts`).
- Unit tests: `generateFilingDraft` orchestrator (mocked `callGemini`, mocked blob upload) — happy path, each of the 4 categorized failure codes, idempotent-retry-after-failure.
- Unit tests: the 4 new UI-facing routes (mocked core functions — these routes are thin wrappers, so their tests assert correct translation/auth, not questionnaire logic).
- **Regression**: PR-3's `tax-questionnaire-recovery.test.ts` and `start-tax-fast-track-skill.test.ts` must pass unchanged against the refactored chat wrappers.
- e2e: extend `tests/e2e/tax-fast-track.spec.ts` (or a new sibling file) with a UI-native path — start via `POST /start`, answer via `POST /answer` until completion, poll `/status` until the draft is `ready`, assert both download URLs are present and resolve to a PDF content-type.
