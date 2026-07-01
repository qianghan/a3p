# Pre-Launch Comprehensive Quality Audit — Plan (v2)

**Date:** 2026-07-01 (v2 — expanded per follow-up request)
**Status:** Approved plan, ready to execute
**Scope:** agentbook.brainliber.com (production), user POV, medium+ severity issues
**Supersedes:** v1 of this doc (same file, same commit history) — v2 adds dual-tooling (Chrome MCP + Playwright), a full chatbot use-case matrix with an actionability rubric, and an explicit QA-gap taxonomy + closure workflow, all triggered by a real bug found live in this session (§Phase 4, worked example).

## Why this is different from existing e2e coverage

The repo already has ~77 Playwright specs under `tests/e2e/`, almost all **functional/regression** tests: "does this endpoint return the right JSON," "does this feature work when driven correctly." They do not catch what a real, first-time user — or a real chat conversation — actually hits: confusing copy, dead ends, contradictory bot answers, non-actionable responses, accessibility gaps, mobile breakage. This audit is a **user-POV quality sweep**, not more feature tests.

## Tooling: Playwright vs. Chrome MCP — use both, deliberately

Two different tools for two different jobs. Don't default to one for everything.

| | **Playwright** (`tests/e2e/*.spec.ts`) | **Chrome MCP** (`claude-in-chrome` tools: `navigate`, `computer`, `read_page`, `find`, `form_input`, `read_console_messages`, `read_network_requests`, `javascript_tool`, `gif_creator`) |
|---|---|---|
| Best for | Scripted, repeatable, assertion-based phases (0, 1, 2, 3, 5, 6, 7) | Interactive exploration and **judgment calls** a script can't make — is this copy confusing? Does this chat response feel evasive? Does this layout look broken? |
| Runs in CI / re-runs later | Yes — this is the regression suite | No — one-off audit sessions; findings become Playwright regressions *after* a bug is confirmed |
| Chatbot phase (4) | Drives the API directly (`fetch` to `/api/v1/agentbook-core/agent/message`) with a curated prompt list, asserts non-error/on-topic | **Primary tool for judging conversational quality** — read the actual rendered conversation like a user would, screenshot multi-turn exchanges, use `read_network_requests` to see exactly what the classifier/skill received and returned |
| Console/network capture | Playwright's own APIs (`page.on('console')`, route interception) | `read_console_messages` / `read_network_requests` — useful for live debugging *why* a response was wrong, not just *that* it was |

**Rule of thumb:** use Chrome MCP first to *find* and *understand* a quality issue (especially chatbot UX, which is inherently a judgment call), then write a Playwright regression test to *lock in* the fix once it's confirmed as a real bug. Phase 4 in this plan is Chrome-MCP-led; Phases 0/1/2/3/5/6/7 are Playwright-led with Chrome MCP as a spot-check tool for anything a script flags as ambiguous.

## Severity rubric (used to decide what gets fixed before launch)

| Severity | Definition | Launch gate |
|---|---|---|
| **Critical** | Data loss/corruption, security/auth bypass, payment double-charge, can't sign up/log in, chatbot states something **factually false about the user's own money** | Blocks launch |
| **High** | Core workflow broken or misleading, chatbot response is confidently wrong (not just unhelpful), multi-turn conversation loops without ever reaching an actionable outcome | Blocks launch |
| **Medium** | Confusing/inconsistent UX, broken secondary flow, a11y violation on a primary path, chatbot response is *unhelpful but not wrong* (vague, no next step), slow page (>3s TTI) | Fix before or immediately after launch; tracked |
| **Low** | Cosmetic, copy nit, edge-case rarely hit | Backlog |

**This audit's mandate: capture Medium and above.**

## QA-gap taxonomy — every finding gets bucketed, not just severity-rated

Severity says how bad; the taxonomy says *why it happened*, which determines the right fix and whether it's a one-off or a pattern to hunt for elsewhere:

1. **Definition mismatch** — the same concept (e.g. "uncategorized expense") is computed by more than one code path with different logic. One diverges from what the UI shows, producing contradictions the user notices immediately. *High-value to find: if one instance exists, grep for the others.*
2. **Non-actionable response** — the system correctly detects a state but hands the user nothing to act on (no list, no specific items, no button/link, just a re-statement of the problem). Every "couldn't do X, check the Y page" response is a candidate.
3. **Context-blind multi-turn** — a follow-up message that's an obvious continuation of the prior turn ("list them", "the second one", "yes do that") isn't resolved using conversation history, so the bot asks a clarifying question it should already know the answer to.
4. **Stale-data-presented-as-live** — a cron-computed alert or cached count is shown later without indicating when it was computed or re-verifying it's still true.
5. **Aggregate-instead-of-detail** — a user asks to "list" or "show" items and gets a sum/count instead of the actual rows.
6. **Accessibility / mobile / cross-browser gap** — layout, contrast, keyboard-nav, or touch-target issues.
7. **Error-state gap** — a failed network request or backend error surfaces as a silent hang, a raw error string, or a stuck spinner instead of a clear, human message.

## Closure workflow

1. Log every finding: `{ id, phase, severity, taxonomy bucket(s), surface, repro steps, expected, actual, evidence (screenshot/console/network) }` in `docs/superpowers/plans/2026-07-01-prelaunch-qa-findings.md` (created at execution time).
2. **Critical/High** → fix immediately, same session: root-cause, patch, self-review, deploy, prod e2e, merge (the standard PR cycle already established this session) — *before* moving to the next phase.
3. **Medium** → fix now if cheap (<30 min); otherwise a tracked backlog item with an owner and target (default: next session).
4. **Pattern check**: whenever a finding is a *definition mismatch* or shows up in more than one phase, grep the codebase for sibling occurrences of the same logic before considering it closed — closing one instance while three others remain is a false sense of closure.
5. Add a **regression test** (Playwright) only for confirmed Medium+ bugs — keeps the suite lean, and per the lesson from PR #174/#175, that regression test must assert *rendered content/behavior*, not just "a link exists" or "the URL changed."
6. Re-run the specific failing scenario against prod after the fix ships, not just "trust the code review."

## Personas used

- **Maya** (`maya@agentbook.test`) — CA consultant, real seeded data; also the persona in the worked chatbot example below
- **Jordan** (`jordan@agentbook.test`) — side-hustle, thinner data (sparse/empty-state journey)
- **A brand-new throwaway signup** (`qa-audit+<timestamp>@example.com`) — true first-run/zero-data journey
- **Admin** (`qiang.han@gmail.com`) — admin console coverage
- **The chatbot itself**, driven via the web chat surface *and* Telegram-style natural language through the API, as its own persona — this is the surface most likely to hide unpolished UX because it's generative, not templated

## Phases

### Phase 0 — Setup & instrumentation
- Confirm prod-safe test accounts (established pattern this session).
- Playwright helpers: console-error collector, network-failure collector, page-load timer.
- Chrome MCP: confirm `navigate`/`read_console_messages`/`read_network_requests` reach `agentbook.brainliber.com` cleanly (no auth/CSP surprises) before relying on it for Phase 4.

### Phase 1 — Unauthenticated / marketing surface
- Landing page: CTAs resolve, responsive at mobile/tablet/desktop, brand consistency (post-rebrand).
- `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`: every error state shows a clear, non-technical message.
- OAuth entry points (Google; Microsoft once wired).
- `/docs` nav.

### Phase 2 — First-run onboarding (zero-data journey)
- Fresh signup → first login → is there any indication of what to do first? Empty states with clear next actions on every plugin page.
- Email verification end-to-end.
- Connect-bank (Plaid sandbox) from zero.
- Scan first receipt from zero.
- Referral banner + Referrals tab deep-link (regression-check).

### Phase 3 — Core workflows per plugin (Maya, real data)
- **Core**: dashboard accuracy, ledger, activity feed, agents page.
- **Expense**: list/filter/search, categorize, split, receipt OCR accuracy, recurring detection, budgets. **Specifically cross-check the "uncategorized" count shown on the Expenses page against what the proactive-alert cron and the chatbot report — this is the exact seam that broke in the Phase 4 worked example below, so verify all three agree.**
- **Invoice**: create → send → mark paid → recurring; PDF; client portal link.
- **Tax**: dashboard estimate sanity, quarterly reminders, deductions, past-filings upload, tax package export, **the Dashboard ↔ Tax Package nav (regression-check PR #174/#175's fix)**.
- **Payroll**: run payroll happy path, year-end forms.
- **Personal finance / Accountant (CPA portal)**: read-only CPA link works without an account.

### Phase 4 — Chatbot / agent-brain conversational quality (Chrome-MCP-led)

**The actionability rubric.** Every bot response is judged against one question: *after reading this, does the user know exactly what to do next, or do they have to ask again?* A response passes only if it does at least one of:
- (a) gives the user the **specific data** they asked for (an actual list, not a sum),
- (b) offers a **concrete action** they can take right now (a button, a specific next message to send, a specific page+field),
- (c) asks **one** precise clarifying question that, once answered, resolves the request.

A response that restates the problem, apologizes, or points to "the X page" without narrowing further **fails** the rubric — that's a Medium+ finding regardless of whether the underlying data was correct.

**Worked example (found live this session, Maya persona, Telegram):**

| Turn | User | Bot | Rubric verdict |
|---|---|---|---|
| 1 | *(proactive)* | "You have 4 uncategorized expenses — I couldn't auto-categorize them..." | **Fails — and is factually wrong**: Maya has zero uncategorized expenses. Definition-mismatch bucket. |
| 2 | "Categorize expenses" | "I reviewed 4 expenses but couldn't categorize them confidently. Check the Expenses page..." | Fails (b)/(a) — no list, no specific items, just a pointer to go elsewhere |
| 3 | "List them here so I can do it" | "What would you like me to list for you?" | Fails (c) — context-blind; the referent ("them") was the immediately preceding topic |
| 4 | "List the non categorized expenses" | "You have $2069.98 in uncategorized expenses between Jan 1–Jul 1, 2026. To help you categorize these, please provide more details..." | Fails (a) — an aggregate, not a list; also inverts the burden (asks the user for "more details" about transactions the *system* already has) |

Four turns, zero actionable outcomes. This is the canonical failure mode Phase 4 hunts for. Root cause is being diagnosed in parallel (categorize-expenses skill + proactive-alerts cron + query-expenses skill — likely 2–3 divergent "uncategorized" implementations plus a context-blind intent classifier); fix ships as its own PR before this plan's Phase 4 is considered executed for the expense-categorization use case specifically.

**Use-case matrix to drive Phase 4** (each row: try 2–3 natural phrasings per persona, judge every bot turn against the rubric above):

| Category | Example prompts | What "actionable" looks like |
|---|---|---|
| Record an expense | "spent 40 on lunch", "paid $120 for office supplies at Staples yesterday" | Confirms amount/vendor/category and either books it or asks the *one* missing field |
| Query/list data | "how much did I spend on travel", "list my uncategorized expenses", "show unpaid invoices" | Returns actual rows/amounts, not just a total, when the user says "list"/"show" |
| Correction / follow-up | "no that was actually travel", "list them here", "the second one" | Resolves using the immediately preceding turn's context, no re-asking |
| Ambiguous input | "categorize expenses" (with zero uncategorized), "what about it" | Detects the true state (nothing to do) and says so plainly, or asks one precise question |
| Out-of-scope | "should I incorporate in Delaware", "what's the market going to do" | Declines gracefully, redirects to what it *can* help with — never hallucinates advice |
| Casual/typo phrasing | "hows my taxes lookin", "wut do i owe" | Understood as intended without the user rephrasing |
| Multi-step task | "split this expense 60/40 between client A and B" | Either completes it or asks the one blocking question |
| Long/rambling or empty input | a 3-sentence rambling message; an empty/whitespace message | Extracts the actual ask, or asks for clarification without being condescending |
| Proactive/cron-sourced messages | any proactive alert (uncategorized count, tax deadline, budget overage) | **Must be re-verified live at send time, not just computed once and cached** — this is the taxonomy's "stale-data" bucket and is exactly what broke in the worked example |

Drive this via Chrome MCP against the live Telegram bot and/or the web chat surface; capture screenshots of any multi-turn exchange that fails the rubric (`gif_creator` for the full sequence is ideal evidence). Log every failure with taxonomy bucket + rubric-failure reason, not just "bot was unhelpful."

### Phase 5 — Cross-cutting quality
- Accessibility: keyboard-only pass, screen-reader labels, contrast on the new brand teal.
- Mobile: 375px viewport pass through Phases 1–3's primary flows.
- Performance: flag any primary page >3s load or visible layout jump.
- Error states: kill a network request mid-flow on 3–4 critical actions — sane message, not a hang.
- Cross-browser: Chromium + one WebKit pass on the top 5 journeys.

### Phase 6 — Money paths (billing, referral, Stripe)
- Referral: joined → paid → referrer credited, visible on the Referrals tab (now unblocked — Stripe is live per this session).
- Subscribe/cancel/reactivate/proration — every state transition, no stuck loading states.
- A deliberately failing payment — is the failure message clear? (Needs the still-open publishable-key gap resolved first.)

### Phase 7 — Admin console
- Skills install/uninstall, feature flags, LLM provider config, payroll providers, user actions — click-through.

### Phase 8 — Triage & fix
Per the Closure Workflow above: Critical/High fixed same-session; Medium fixed-if-cheap or backlogged with owner+target; pattern-check every definition-mismatch/non-actionable finding for siblings; regression tests only for confirmed bugs, asserting real content/behavior.

## Execution notes

- Each Playwright-led phase is its own spec file under `tests/e2e/qa-audit-<phase>.spec.ts`, run against production.
- Phase 4 output is a mix of Chrome-MCP session findings (logged in the findings doc) and, for any confirmed bug, a Playwright regression + a real code fix through the standard PR cycle.
- This is a **separate execution effort** from this plan doc. Sizing: Phases 0–3 and 5 ~1 session; Phase 4 (chatbot) deserves its own focused session given the use-case matrix above; Phase 6 is quick now that Stripe is live; Phase 7 is quick.
