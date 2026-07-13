# Tax Fast-Track — Foundation: Schema, Adaptive Questionnaire Engine, Chat Skill (PR-3 of the personal-finance/tax-filing launch program)

## Context

This is the foundational PR for the fast-track tax filing feature, previously scoped and ranked in `docs/superpowers/specs/2026-07-12-fast-track-tax-filing-plan.html` (shared with the user as an artifact): a user uploads last year's tax return, asks the agent to "help me do this year's filing," and the agent generates a short, jurisdiction-specific, accountant-style questionnaire before eventually producing a filing draft and client letter (filing draft + client letter generation is PR-4's scope, not this one — this PR ends at "questionnaire complete, answers captured").

The core gap this PR closes: nothing in this codebase today supports a genuinely multi-turn, stateful, free-form Q&A conversation. `AbAgentSession` (the existing session model) supports exactly two patterns — a single yes/no confirmation gate, or a pre-computed list of HTTP-callable plan steps — and neither fits "ask a dynamically generated question, wait for a free-text reply possibly several turns later, decide whether to ask another." This PR builds that third pattern as its own dedicated, narrow model rather than overloading the existing one.

Decisions made with the user before writing this spec:
1. **Adaptive question generation** — one LLM call per turn, generating the *next* question from the accumulated answer history so far (not a fixed question list generated upfront). This lets the questionnaire skip redundant questions and follow up on what the user just said, at the cost of an LLM call per turn instead of one call total.
2. **Stopping condition**: each generation call can return either a next question or a `done: true` signal once the pack judges it has enough information — but hard-capped at 8 questions regardless, so a confused or overly-thorough LLM can't loop indefinitely.
3. **Session lifetime**: 72 hours of inactivity before a session expires (longer than `AbAgentSession`'s 24h, since a user may need to go find a document or check with a spouse mid-questionnaire — this is a slower-paced conversation than a quick expense-confirmation).

## Goal

A tenant with a confirmed prior-year `AbPastTaxFiling` can say "help me do this year's filing" in chat, get asked a short, jurisdiction-aware, adaptive sequence of questions (skipping anything already known from the parsed return), answer them one at a time across as many messages as needed, and have the session end in a `completed` state with a full `qaHistory` ready for PR-4 to turn into a filing draft and client letter. Chat and MCP parity are both delivered by this PR without extra work (see "MCP" below); UI is explicitly PR-4's scope.

## Scope

**In scope:**

1. **New model** `AbTaxQuestionnaireSession` (schema per the architecture already agreed with the user):
   ```prisma
   model AbTaxQuestionnaireSession {
     id             String   @id @default(uuid())
     tenantId       String
     taxYear        Int
     jurisdiction   String
     region         String?
     trigger        String   // 'fast_track' | 'deadline' — 'deadline' is PR-5's normal-flow trigger, not used by this PR but included now so PR-5 doesn't need a migration
     sourceFilingId String?  // AbPastTaxFiling.id, when seeded from an upload
     status         String   @default("in_progress") // in_progress | completed | abandoned
     qaHistory      Json     @default("[]")           // [{question, answer}, ...] — grows one pair per turn
     askedCount     Int      @default(0)
     createdAt      DateTime @default(now())
     updatedAt      DateTime @updatedAt
     expiresAt      DateTime  // now + 72h, refreshed on every answer
     @@index([tenantId, status])
   }
   ```
   `trigger`/`sourceFilingId` nullable-appropriate fields are included now (even though only `'fast_track'` is exercised by this PR) so PR-5's deadline-driven "normal flow" doesn't require a second migration — this is the one deliberate above-minimum addition in this PR, justified by avoiding a second schema change for a field the design already knows PR-5 needs, not speculative scope creep.

2. **`TaxQuestionnairePack` interface**, one new capability added to `packages/agentbook-jurisdictions/src/interfaces.ts`, following the exact same "one interface, one file per jurisdiction, one loader" shape as the proven `PastFilingPack`/`past-filing-loader.ts` pattern:
   ```ts
   interface TaxQuestionnairePack {
     jurisdiction: string;
     generateNextQuestion(input: {
       qaHistory: { question: string; answer: string }[];
       priorFiling?: StandardTaxExtract;
       profile?: string; // pre-built PersonalProfileContext markdown block, reused as-is
     }): Promise<{ question: string } | { done: true }>;
   }
   ```
   New `packages/agentbook-jurisdictions/src/{us,ca}/tax-questionnaire-pack.ts` implementations (au/uk stay unregistered, matching `past-filing-loader.ts`'s existing us/ca/au-only coverage — au was already added since the original plan doc was written, per `past-filing-loader.ts`; uk remains a future placeholder either way) and a new `tax-questionnaire-loader.ts` mirroring `past-filing-loader.ts` exactly (`registerTaxQuestionnairePack`/`getTaxQuestionnairePack`/`listSupportedJurisdictions`).

3. **New session-recovery branch in `agent-brain.ts`**, parallel to (not inside) the existing `AbAgentSession` check: if a tenant has an `in_progress` `AbTaxQuestionnaireSession`, the next message is treated as the answer to the question implied by the last entry pushed onto `qaHistory` before `generateNextQuestion()` was last called — append `{question, answer}`, refresh `expiresAt` to now+72h, increment `askedCount`, call `generateNextQuestion()` again. If it returns `{done: true}` or `askedCount >= 8`, set `status: 'completed'` and reply with a short "got everything I need — I'll have your filing draft ready shortly" style message (PR-4 picks up from a `completed` session; this PR does not generate anything after that point). Otherwise ask the next question and stay `in_progress`.

4. **New skill** `start-tax-fast-track` (INTERNAL, chat-only per this PR — no HTTP endpoint, no UI): triggers on phrases like "help me do this year's filing" / "fast track my taxes" / "do my taxes this year". Requires at least one confirmed `AbPastTaxFiling` to exist for the tenant (reusing `listPastFilings` from `tax-past-filings.ts`) — the *most recent* confirmed filing by `taxYear` is the one used as the seed (there is no requirement that it be exactly `currentYear - 1`; a tenant who last uploaded a return from two years ago still gets fast-tracked from that one, since it's still better seed data than nothing — the questionnaire's job is precisely to fill the gaps a stale prior filing leaves). If no confirmed filing exists at all, replies pointing the user at the existing upload flow instead of guessing, at `confidence: 1` (the documented blocked-path gotcha from this session's earlier incidents applies here too — any early return in this handler must stay at `confidence: 1`, never dropped for "cosmetic consistency"). If a confirmed filing exists: creates the `AbTaxQuestionnaireSession` (`trigger: 'fast_track'`, `sourceFilingId` set), calls `generateNextQuestion()` with the parsed filing's `StandardTaxExtract` and `buildPersonalProfileContext()`'s markdown block (both already-built, reused as-is — no new context-building logic), and asks the first question.

**Out of scope (explicitly deferred):**
- Filing draft generation, client letter generation (PR-4).
- UI (PR-4) — any question screen, review screen.
- MCP-specific elicitation-loop code (see "MCP" below — not needed for this PR specifically, but flagging now since PR-5 will need it for a *different* reason: MCP's single-shot confirmation elicitation, not this session-recovery mechanism, which works identically over MCP with zero extra code).
- The deadline-driven "normal flow" trigger and its `gatherPackageData()`-based seeding (PR-5).
- AU/UK questionnaire packs (PR-7, matching the existing `PastFilingPack` coverage gap for those two jurisdictions).
- Consolidating the two existing, independently-implemented "past filing → LLM context" code paths (`buildAdvisorContext()` in `tax-past-filings.ts` vs. `buildPastFilingContext()` in `plugins/agentbook-core/backend/src/past-filing-context.ts`) — a pre-existing duplication-risk flagged in the original design pass, real but unrelated to this PR's own scope; this PR calls whichever one is already used for chat-context injection elsewhere (confirm during implementation) rather than picking a side in that pre-existing duplication.

## MCP and chat parity (why this PR needs no MCP-specific code)

AgentBook's MCP server exposes exactly one tool, `ask_agentbook`, which forwards free text to the same `/agent/message` endpoint and skill router that chat/Telegram use, tagged `channel: 'mcp'`. Because `start-tax-fast-track` and the new session-recovery branch both live inside the shared agent-brain pipeline (not a separate HTTP endpoint), a user driving the questionnaire entirely through an MCP client works identically to chat with zero new code in this PR. The one MCP-specific gap — its confirmation flow only supports a single yes/no round-trip today, not a repeated per-question elicitation loop — is real, but it only matters if an MCP client wants to be *prompted* each turn the way Claude Desktop's elicitation UI would; a client just sending free-text answers (the same as any other message) works today, and building the fancier per-question elicitation experience is explicitly PR-5's job, not this one's.

## Design decisions

- **Adaptive generation is one LLM call per turn** (up to 8), not one call total — a real cost/latency trade-off accepted explicitly for the "feels like an accountant" quality bar, not an oversight.
- **The safety cap (8) is a hard ceiling, not a target** — most real conversations should finish well under 8 given the pack is instructed to skip anything already known from the prior filing; 8 exists purely to bound a misbehaving generation call, not as an expected typical length.
- **`qaHistory` as a single growing JSON array**, not a normalized child table — this data is small per session (at most 8 pairs), read/written as a whole every turn, and never queried independently of its parent session; a JSON column is the proportionate choice here, matching how `AbAgentSession.stepResults` already stores comparable per-turn accumulation.
- **The prior-filing requirement is a hard gate, not a soft nudge** — `start-tax-fast-track` only exists to fast-track *from* an uploaded return; a tenant with no confirmed filing should be pointed at the upload flow, not asked to start a questionnaire with no seed data (which would just be the same thing PR-5's "normal flow" is for, a different trigger surface, not this skill's job).
- **`profile` is passed as the already-built markdown block from `buildPersonalProfileContext()`**, not raw structured fields — this matches how personal-profile context is already injected everywhere else in the agent-brain pipeline (a plain string block, not a typed object crossing the plugin-backend/Next.js boundary), avoiding the exact cross-package-import problem PR-2 hit and fixed by duplicating math instead.

## Test plan

- Unit: `generateNextQuestion()` for both us/ca packs (mocked LLM call) — returns a question when history is short, returns `done: true` when the pack judges completeness, respects the `priorFiling`/`profile` inputs by not asking about fields already present in `priorFiling`.
- Unit: the session-recovery branch in `agent-brain.ts` — first message creates a session and asks question 1; a reply appends to `qaHistory` and asks question 2; a session that hits `done: true` or `askedCount: 8` marks `completed` and stops asking; an expired (`expiresAt` in the past) session is treated as if inactive, not resumed.
- Unit: `start-tax-fast-track`'s blocked path (no confirmed filing) stays at `confidence: 1`; routing collision check against other tax-related skills (`tax-filing-start`, `query-past-filings`) using the same shuffled-evaluation-order verification method established in PR-1/PR-2, not a declaration-order-biased test.
- E2E: a tenant with a confirmed prior-year filing says "help me do this year's filing," answers 2-3 questions across separate messages, session reaches `completed`; a tenant with no confirmed filing gets pointed at the upload flow instead of a questionnaire starting; regression check that unrelated existing tax skills (`tax-filing-start`, `query-past-filings`) still route correctly.

## Rollout

Additive schema only (`AbTaxQuestionnaireSession`) — no destructive migration. Build → unit tests → task-scoped review per task → final whole-branch review → merge to `main` → build + prebuilt deploy → run the production schema migration → live e2e verification, matching PR-1/PR-2's process.
