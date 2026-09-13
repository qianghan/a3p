# Chat workflow quality review — 2026-09-13

Scope: the conversational pipeline shared by Telegram, web chat and MCP
(`handleAgentMessage` → `classifyAndExecuteV1` → inline skill handlers), plus the
Telegram adapter. Evidence is Maya's production conversation log
(`AbConversation`, tenant `maya-consultant`, 2026-09-11 → 09-13) and her live
expense rows, read through the prod API.

Severity: **High** = the reply is wrong or misleading about money/state, or the
conversation dead-ends. **Medium** = the reply is right but confusing, slow, or
inconsistent enough that a user loses trust.

## What the user saw (prod, 2026-09-13 11:56–11:57 ET)

| Turn | User | Bot | Wrong because |
| --- | --- | --- | --- |
| 1 | "Give me more details" (after the morning briefing) | "More details about what?" | The previous bot turn was never shown to the model. |
| 2 | "Expenses" | English YTD summary, fr-CA number format `42 014,79 CA$`, literal `*   ` bullets, `_Period: …_` underscores, then a second "📊 Breakdown" listing the same categories | Mixed locale inside one sentence, markdown leaked, same data twice. |
| 3 | "Categorize them" (+ Proceed) | **French**: "**2** catégories appliquées automatiquement. Toutes les dépenses sont maintenant catégorisées !" after 32.5 s | 24 expenses ($14,999.71) are still uncategorized. No detail on what was categorized. Language flipped mid-conversation. |

Nightly e2e turns on the same tenant show the same pattern class: "what if I hire
someone at $5K/mo?" → clarifying question → "yes" → "Could you tell me what you'd
like me to do?" → "cancel" → "Are you trying to cancel a subscription, an
invoice, or something else?".

## Findings

### F1 — categorize-expenses claims success it did not achieve · **High** (accuracy)

`server.ts` categorize handler: the reply branch is `applied===0 && pending===0` →
"unsure", `pending===0` → **"All expenses are now categorized!"**, else partial.
`skipped` (low confidence, Gemini error, unmatched name) is never consulted, so
2 applied + 24 skipped reads as "all done". Root cause: message logic keyed on
two of three outcome buckets.

### F2 — two definitions of "uncategorized" · **Medium** (accuracy)

The handler and `wantsUncategorizedOnly` in query-expenses only look at
`categoryId: null`. Expenses parked in the `6999 Uncategorized Expenses`
suspense account (the ledger fix in #426 routes there) are invisible to
"categorize", yet the breakdown shows them as a category. A user is told "all
categorized" while a line called "Uncategorized Expenses" sits in their report.

### F3 — categorize reply has no substance · **High** (UX)

Neither the applied items (vendor → category) nor the skipped items (and why)
are listed. The user cannot verify what the bot did to their books or act on
what it could not do. The existing "unsure" branch already lists items — only
the success/partial branches omit them.

### F4 — 32 s to categorize 26 rows · **Medium** (UX / reliability)

One Gemini round trip per expense, sequential, `take: 50`. Telegram shows
nothing for half a minute; at 50 rows this brushes the 90 s route budget. One
batched prompt per 25 rows is the same accuracy at ~2 calls.

### F5 — reply language follows tenant config, not the user · **High** (UX)

Template strings (`replyT`, `botT`) resolve from `AbTenantConfig.locale`
(fr-CA for Maya). LLM-generated prose follows `languageDirective`, i.e. the
user's language. Result: English question, English summary, French categorize
result, all in one thread. Number formatting has the same split: `fmtCurrency`
uses the tenant locale, so an English sentence carries `42 014,79 CA$`, and the
LLM sometimes "fixes" it to `CA$1,657.00` — the same query renders two ways on
consecutive days.

Rule that should hold: **a turn is answered in the language the user wrote it
in; short/ambiguous turns continue the thread's language; only then the tenant
locale.** Templates and number/date formatting must use that same resolved
locale. The LLM directive already says exactly this; the deterministic half of
the reply ignores it.

### F6 — follow-ups have no memory, and two skills point at endpoints that do not exist in prod · **High** (UX / accuracy)

`general-question` → `POST /api/v1/agentbook-core/ask` and `simulate-scenario` →
`POST …/simulate` are Express routes that were never ported to Next. In prod
every such turn returns `NOT_IMPLEMENTED`, lands in the error branch, and is
answered by `accountantEngagement`, which is called **without `recentConvo`**
(the parameter exists; the catch-all call site does not pass it). Consequences:

- "Give me more details" → "More details about what?"
- "what if I hire someone at $5K/mo?" never runs the simulator that exists in
  `server.ts` (`calcScenarioTax`, 12-month projection); it asks a clarifying
  question instead. The nightly e2e asserts only that *a* reply came back.
- Every `general-question` row in the log carries the NOT_IMPLEMENTED payload.

### F7 — "yes" / "cancel" / "undo" with nothing pending go to the LLM · **Medium** (UX)

The Telegram adapter maps bare `yes|cancel|undo|skip|status` to `sessionAction`.
The brain only honours it when an `AbAgentSession` is active; otherwise the
bare word is classified as a new request and the fallback invents a question
("cancel a subscription, an invoice, or something else?"). Two cases need
different handling: a "yes" that answers the bot's own clarifying question
(continue the thread, F6), and a "cancel" with nothing to cancel ("Nothing is
waiting on you right now").

### F8 — the planner cannot run INTERNAL skills · **Medium** (accuracy)

`agent-planner.executeStep` returns `Skill "X" is internal and cannot be
executed via HTTP` for every `method: 'INTERNAL'` manifest (categorize-expenses,
daily-briefing, personal-snapshot, …). Any multi-step plan that includes one
fails at that step. The single-step confirm path works only because it bypasses
the planner (`pendingClassification`).

### F9 — Telegram rendering · **Medium** (UX)

`mdToHtml` handles `**bold**`, `*italic*` and backticks only. Markdown list
bullets (`*   item`, `- item`), `_italic_` and `###` headings reach the user as
literal characters. `formatResponse` then appends "📊 Breakdown" from
`chartData` even when the LLM answer already enumerated the same categories.

### F10 — the briefing narrates internal failures · **Medium** (UX)

daily-briefing feeds "Financial snapshot: unavailable." / "Alerts:
unavailable." into the prompt when a sub-fetch fails, so the user reads "The
financial snapshot and next quarterly tax deadline are unavailable." A
briefing should say what it knows and stay silent about plumbing.

### F11 — nightly e2e writes into Maya's real books · **Medium** (data / trust)

`resolveTenantId` binds **any** chat that reaches a bot token to that bot's
tenant before consulting `CHAT_TO_TENANT_FALLBACK`, so the e2e capture chat
(555555555) resolves to `maya-consultant`, not the e2e tenant. Every night adds
"Spent $25 at Uber…" and an Acme invoice attempt; 20 of the 24 uncategorized
rows are e2e/QA residue ("E2E Offline", "QA-Probe-Direct", "category label
verification test"). The categorize demo is graded against junk.

### F12 — every turn is logged twice · **Low/Medium**

Inline handlers `abConversation.create` (35 sites) and the brain logs again in
Step 5 / confirm path. The persona style-adaptation reads the last 12 rows, so
its window is effectively 6 turns; the web "Recent conversations" panel shows
duplicates.

### F13 — evaluator's categorize check never fires · **Low**

`assessStepQuality` regexes for "Categorized N of M", a string no handler emits.
Fixed for free once the handler returns structured counts (F1/F3).

### Flagged, out of scope for this plan

- **Security — any Telegram chat auto-binds to the bot's tenant.** Same code
  path as F11. A stranger who finds the bot username can read and write that
  tenant's books; there is no pairing step. Needs its own PR (one-time link
  code shown in Settings, verified on first message). Not a chat-quality change,
  so kept out of this plan, but it should ship before the bot is promoted.
- Expenses on this tenant are stored in USD while the tenant books in CAD
  (seed/e2e data), so "CA$" labels on USD rows. Data hygiene, not chat logic.
- `formatPlan` is English-only ("Here's my plan" / "Proceed? (yes/no)"). Falls
  out of F5 for fr-CA/zh-CN tenants; low value until those users appear.

## Why five previous rounds did not land it

Each round fixed the layer it looked at: number formatting in the adapter,
period stamping in query-expenses, language directive for the LLM, referent
rewriting before classification. None of them touched the three properties
that make a conversation feel competent: **(a) the reply tells the truth about
what changed, (b) the reply is in the user's language end to end, (c) the next
turn remembers the last one.** F1–F3 break (a), F5 breaks (b), F6–F7 break (c).
The plan below is organised around those three, not around files.
