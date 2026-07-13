# Tax Fast-Track Foundation — Implementation Plan (PR-3)

Design: `docs/superpowers/specs/2026-07-13-tax-fast-track-foundation-design.md` (post-adversarial-review revision — read the "Revision note" and every "Revised:" subsection before starting; the fixes there are load-bearing, not cosmetic).

## Task 1 — Schema + session data-layer helpers

**Files:**
- `packages/database/prisma/schema.prisma` — add `AbTaxQuestionnaireSession` exactly as specced (`plugin_agentbook_core` schema, `version` field, `consecutiveFailures` field, `@@index([tenantId, status])`).
- `plugins/agentbook-core/backend/src/tax-questionnaire-session.ts` (new) — mirror `agent-planner.ts`'s `createSession()`/`getActiveSession()`/`updateSession()` trio exactly, for the new model:
  - `createTaxQuestionnaireSession(tenantId, taxYear, jurisdiction, region, trigger, sourceFilingId)` — before inserting, **expires any other active `AbTaxQuestionnaireSession` for the tenant** (mirrors `createSession()`'s own behavior) **and expires any active `AbAgentSession` for the tenant** (the mutual-exclusion rule from the spec — read `agent-planner.ts`'s real `createSession()` first to copy its "expire the other active one" query shape, then add the second expiry call for the other model).
  - `getActiveTaxQuestionnaireSession(tenantId)` — `findFirst` where `status:'in_progress', expiresAt: {gt: now}`.
  - `updateTaxQuestionnaireSession(id, version, data)` — raw SQL `UPDATE ... WHERE id=? AND version=?`, returns `false` on mismatch, exactly like `agent-planner.ts`'s `updateSession()`. Callers must re-fetch on `false` (don't invent different semantics from the model this mirrors).
- Also expose a small helper from the same file or an existing shared session-utility spot: `expireAgentSessionForTenant(tenantId)` (or find/reuse whatever `agent-planner.ts` already exposes for expiring an `AbAgentSession` — check before writing a new one) — needed by both this task's `createTaxQuestionnaireSession` and, symmetrically, by wherever `AbAgentSession`'s own `createSession()` would need to expire an active questionnaire (that second half only matters once a plan-session actually gets created while a questionnaire is active — note this as the mutual-exclusion completeness point for Task 3 to wire the reverse direction, since `agent-planner.ts`'s own `createSession()` isn't this task's file to modify carelessly — confirm during implementation whether editing it here is in scope or whether Task 3 should own that half instead, given it's called from `agent-brain.ts`'s complexity-escalation path, not from anything in this task's files).

**Tests:** unit tests for all three CRUD helpers — creating a session expires a prior in-progress one for the same tenant; creating a session expires an active `AbAgentSession` for the same tenant (mock `db.abAgentSession.updateMany` or however the existing expire-others logic is shaped); `updateTaxQuestionnaireSession` succeeds when `version` matches and fails (returns `false`) when it doesn't; `getActiveTaxQuestionnaireSession` respects `expiresAt`.

## Task 2 — `TaxQuestionnairePack` interface + us/ca implementations + loader

**Depends on:** nothing (parallel-safe with Task 1 — different package, `packages/agentbook-jurisdictions`).

**Files:**
- `packages/agentbook-jurisdictions/src/interfaces.ts` — add the `TaxQuestionnairePack` interface exactly as specced (`nextQuestionPrompt()`/`parseNextQuestionResponse()`, both pure/sync — read the spec's "Revised: pack interface" section for why this shape, not the LLM-calling shape an earlier draft had).
- `packages/agentbook-jurisdictions/src/us/tax-questionnaire-pack.ts` and `.../ca/tax-questionnaire-pack.ts` (new) — `nextQuestionPrompt()` builds a jurisdiction-specific, accountant-style prompt instructing the LLM to skip anything already present in `priorFiling`/`profile` and to return either a next question or a `done` signal in a specified format (pick a simple, parseable format — e.g. a one-line JSON object — and have `parseNextQuestionResponse()` parse exactly that format, matching how `parseExtraction()` parses `parsePastFiling()`'s Gemini JSON output today: read that existing parse function for the established JSON-response-parsing convention in this codebase before inventing a new one).
- `packages/agentbook-jurisdictions/src/tax-questionnaire-loader.ts` (new) — mirror `past-filing-loader.ts` exactly: `registerTaxQuestionnairePack`/`getTaxQuestionnairePack`/`listSupportedJurisdictions`, seeded with `us`/`ca` only (au/uk left unregistered, matching the spec's stated scope).

**Tests:** unit tests for both packs' `nextQuestionPrompt()` (prompt string reflects `qaHistory`/`priorFiling`/`profile` content — e.g. asserting a known prior-filing field's value appears in the generated prompt, and instructing the LLM to skip it) and `parseNextQuestionResponse()` (valid question JSON → `{question}`; valid done JSON → `{done:true}`; malformed input → throws or returns a clearly-erroring shape, whichever this codebase's established parse-error convention is — check `parseExtraction()`'s error handling and match it, don't invent a new one).

## Task 3 — `agent-brain.ts` session-recovery branch

**Depends on:** Task 1 (session data-layer helpers), Task 2 (pack loader).

**Files:** `plugins/agentbook-core/backend/src/agent-brain.ts` — new branch, parallel to (not inside) the existing `AbAgentSession` session-recovery step. Read the spec's full "Revised: exit paths and mutual exclusion" section before writing this — it is the single most detailed, most load-bearing part of the spec, covering: cancel-keyword detection (checked first, before treating the message as an answer), the success path (append to `qaHistory`, reset `consecutiveFailures`, refresh `expiresAt`, call the pack, handle `done`/`askedCount>=8`), the failure path (`callGemini`/parse throwing → increment `consecutiveFailures`, no `qaHistory`/`askedCount`/`expiresAt` mutation, `abandoned` at 3 consecutive failures), and using `updateTaxQuestionnaireSession`'s version guard for every write (re-fetch and retry once on a version conflict, mirroring however the existing `AbAgentSession` branch already handles its own version conflicts — read that existing handling and match its retry/user-facing-message convention, don't invent a different one).

Also: complete the mutual-exclusion direction Task 1 flagged as ambiguous — wherever `agent-brain.ts`'s complexity-escalation path calls `createSession()` (the `AbAgentSession` constructor) for a low-confidence/multi-step classification, that call site now also needs to expire any active `AbTaxQuestionnaireSession` for the tenant first. Confirm during implementation whether this belongs in `agent-planner.ts`'s `createSession()` itself (cleanest, one place) or as an explicit extra call at `agent-brain.ts`'s call site — prefer editing `createSession()` directly if it doesn't risk destabilizing its existing, well-tested behavior; fall back to an explicit call site edit if a direct change feels riskier than warranted for this PR.

**Tests:** the full exit-path matrix from the spec's Test plan section — happy path (question 1 → answer → question 2 → ... → done or cap → completed), cancel keyword → abandoned with no `qaHistory`/`expiresAt` mutation, expired session treated as inactive, `callGemini` throw → `consecutiveFailures` increments without other mutations, 3 consecutive failures → abandoned, starting a questionnaire expires an active `AbAgentSession` and vice versa, a version conflict on update is retried (or surfaces the same user-facing message the existing `AbAgentSession` branch already uses for this case).

## Task 4 — `start-tax-fast-track` skill

**Depends on:** Task 3 (the branch this skill's `createTaxQuestionnaireSession` call feeds into must exist and be correct first, so the skill can be tested against real session-recovery behavior, not just a mocked create call).

**Files:**
- `plugins/agentbook-core/backend/src/built-in-skills.ts` — new INTERNAL manifest, no HTTP endpoint. Triggers per the spec's "Revised: trigger design" section — every trigger must combine filing-intent language with an explicit prior-year/past-filing anchor cue (`last year|past filing|past return|previous filing|previous return`); never a bare "do/file my taxes" phrase alone.
- `plugins/agentbook-core/backend/src/server.ts` (or wherever this INTERNAL skill's handler naturally lives, matching the existing convention for other INTERNAL tax skills — check where `tax-filing-start`'s own handler lives and put this alongside it) — filters `listPastFilings()`'s results to `status === 'confirmed'` (do not assume the helper already filters), picks the most recent by `taxYear`; if none, replies pointing at the upload flow at `confidence: 1`; if one exists, calls `createTaxQuestionnaireSession()` (Task 1), builds the first prompt via the jurisdiction pack (Task 2) using the filing's `StandardTaxExtract` and `buildPersonalProfileContext()`'s markdown block, calls `callGemini`, parses the response, and asks the first question.

**Tests:** the routing-collision verification against the *full* tax-skill family named in the spec (not just 2 skills) via the shuffled-evaluation-order `node`/`tsx` script method from PR-1/PR-2; the confirmed-status-filtering test (mixed-status filings, only `confirmed` ever selected); the blocked-path `confidence: 1` test; a happy-path test that a confirmed filing produces a real first question via the mocked pack/LLM.

## Task 5 — Final e2e verification

**Depends on:** Task 4.

**Files:** new `tests/e2e/tax-fast-track.spec.ts` (new file — this is a new feature area, not an extension of an existing spec file like PR-1/PR-2's `personal-finance.spec.ts` was): a tenant with a confirmed prior-year filing triggers fast-track with an anchored phrase, answers 2-3 questions across separate `/agent/message` calls, session reaches `completed`; a tenant with no confirmed filing gets pointed at the upload flow; a mid-questionnaire cancel message ends the session as `abandoned`; a regression check that a bare "start my tax filing" (no anchor) still routes to the pre-existing `tax-filing-start`, not this new skill.

## Process

Subagent-driven development, same discipline as PR-1/PR-2: implementer subagent per task → task-scoped reviewer subagent → fix rounds until approved, with every regex/state-machine/concurrency claim independently re-verified against the real code before accepting a fix → final whole-branch review on the most capable model → commit → PR → merge to `main` → build + prebuilt deploy → run the production schema migration → live e2e verification.
