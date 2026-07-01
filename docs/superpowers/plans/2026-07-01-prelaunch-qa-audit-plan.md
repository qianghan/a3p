# Pre-Launch Comprehensive Quality Audit — Plan

**Date:** 2026-07-01
**Status:** Approved plan, ready to execute
**Scope:** agentbook.brainliber.com (production), user POV, medium+ severity issues

## Why this is different from existing e2e coverage

The repo already has ~77 Playwright specs under `tests/e2e/`, but they are almost
all **functional/regression** tests: "does this endpoint return the right JSON",
"does this feature work when driven correctly". They do not catch what a real,
first-time user or a real chatbot conversation would hit: confusing copy, dead
ends, slow/broken pages, inconsistent states, accessibility gaps, mobile
breakage, or an agent that gives a wrong/unhelpful answer to a *reasonably
phrased* request. This audit is a **user-POV quality sweep**, not more feature
tests. Findings feed a triage list; only new regression tests get added for
confirmed bugs (no blanket new-test sprawl).

## Severity rubric (used to decide what gets fixed before launch)

| Severity | Definition | Launch gate |
|---|---|---|
| **Critical** | Data loss/corruption, security/auth bypass, payment double-charge, can't sign up/log in | Blocks launch |
| **High** | Core workflow broken or misleading (e.g. expense saved with wrong amount, tax estimate visibly wrong, referral reward never applied) | Blocks launch |
| **Medium** | Confusing/inconsistent UX, broken secondary flow, a11y violation on a primary path, chatbot gives a wrong-but-not-dangerous answer, slow page (>3s TTI) on a common action | Fix before or immediately after launch; tracked |
| **Low** | Cosmetic, copy nit, edge-case rarely hit | Backlog |

**This audit's mandate: capture Medium and above.** Low findings may be noted opportunistically but aren't the goal.

## Personas used (existing seeded accounts + roles)

- **Maya** (`maya@agentbook.test`) — CA consultant, has real seeded data (existing user journey)
- **Jordan** (`jordan@agentbook.test`) — side-hustle, thinner data (sparse/empty-state journey)
- **A brand-new throwaway signup** (`qa-audit+<timestamp>@example.com`) — true first-run / zero-data journey, the one existing personas can't cover
- **Admin** (`qiang.han@gmail.com`) — admin console coverage
- **The chatbot**, driven both via the web chat surface and via API calls that simulate Telegram-style natural language, as its own "persona"

## Phases

Each phase produces a findings entry: `{ id, phase, severity, page/surface, repro steps, expected, actual, screenshot/log }`. Findings accumulate in `docs/superpowers/plans/2026-07-01-prelaunch-qa-findings.md` (created at execution time, not now) as the audit runs, then get triaged into GitHub issues or immediate fix-PRs for Medium+.

### Phase 0 — Setup & instrumentation
- Confirm prod-safe test accounts (Maya/Jordan/throwaway signup pattern already established this session).
- Add lightweight Playwright helpers: console-error collector (fail phase if a page throws an uncaught client error), network-failure collector (fail phase on any 5xx / unexpected 4xx on primary flows), rough page-load timer.
- Decide and document the throwaway-account cleanup policy (leave inert, matching existing `admin-users-actions.spec.ts` convention).

### Phase 1 — Unauthenticated / marketing surface (first impression)
- Landing page (`/`): all CTAs resolve, no dead links, responsive at mobile/tablet/desktop, Lighthouse-style quick perf check, brand consistency (post the brand-identity PR).
- `/login`, `/register`, `/forgot-password`, `/reset-password`, `/verify-email`: every error state (wrong password, weak password, expired token, unknown email) shows a **clear, non-technical** message — not a raw error string.
- OAuth entry points (Google, and Microsoft once wired): button appears/disappears correctly, redirects don't leak query params insecurely.
- `/docs` — nav works, no broken internal links, search (if any) returns sane results.

### Phase 2 — First-run onboarding (the true zero-data journey)
- Fresh signup → first login → does the user have ANY idea what to do first? (Check for onboarding hero/chat, empty states with clear next actions on every plugin page — Dashboard, Expenses, Invoices, Tax.)
- Email verification flow end-to-end (does the link work, does it clearly confirm success).
- Connect-bank (Plaid sandbox) flow from zero.
- Scan first receipt from zero.
- Referral banner appears once, dismiss persists, deep-link to Referrals tab works (regression-check the PR-2/PR-3 work from this session).

### Phase 3 — Core workflows per plugin (Maya persona, has real data)
One pass per plugin, user-POV (click through like a real accountant would), not API-only:
- **Core**: dashboard accuracy (numbers match reality), ledger, activity feed, agents page.
- **Expense**: list/filter/search, categorize, split, receipt OCR accuracy on a real-looking receipt, recurring detection, budgets.
- **Invoice**: create → send → mark paid → recurring; PDF looks right; client portal link works.
- **Tax**: dashboard estimate sanity, quarterly reminders, deductions, past-filings upload (already validated this session with a real T1 — re-check after any regressions), tax package export.
- **Payroll**: run payroll happy path, year-end forms.
- **Personal finance / Accountant (CPA portal)**: read-only CPA link works without an account.

For each: note anything that's *functionally correct but confusing* (that's the gap regression tests miss).

### Phase 4 — Chatbot / agent-brain conversational quality
This is the "chat bot" half of the ask — driven via the real `/api/v1/agentbook-core/agent/message` endpoint (web chat surface) and via the Telegram webhook route, using **naturally-phrased, imperfect prompts** a real user would type — not the clean canonical phrasings existing specs use.

- Ambiguous input ("spent 40 on lunch" — does it ask which account/category sensibly, or guess badly).
- Typos / casual phrasing ("hows my taxes lookin").
- Multi-turn correction ("no, that was actually travel" — does the correction stick, per the documented feedback-detection flow).
- Out-of-scope questions (does it fail gracefully, not hallucinate financial advice).
- Long/rambling input, and empty/whitespace input.
- Does it ever say something **factually wrong** about the user's own numbers (High severity if so).
- Response latency for a typical request (Medium if consistently >5s with no "thinking" indicator).

### Phase 5 — Cross-cutting quality
- **Accessibility**: keyboard-only pass through login, dashboard, one full expense-entry flow; screen-reader labels on primary actions; color-contrast spot check on the new brand teal against both light/dark.
- **Mobile responsiveness**: 375px viewport pass through Phases 1–3's primary flows (not everything — the primary path per plugin).
- **Performance**: flag any primary page with a Playwright-measured load >3s or a visible layout jump.
- **Error states**: kill a network request mid-flow (Playwright route interception) on 3–4 critical actions (save expense, send invoice, upload tax filing) — does the UI say something sane, or hang/silently fail?
- **Cross-browser**: Chromium (default) + one WebKit pass on the top 5 user journeys.

### Phase 6 — Money paths (billing, referral, Stripe)
- Referral program end-to-end on a *paying* invitee once Stripe is live (this depends on the Stripe-migration workstream landing first): joined → paid → referrer credited, visible correctly on the Referrals tab.
- Subscribe / cancel / reactivate / proration preview — every state transition shown correctly, no stuck loading states.
- A deliberately failing card (Stripe test card `4000000000000002` equivalent in live-mode test clock, or sandbox before cutover) — is the failure message clear?

### Phase 7 — Admin console
- Skills install/uninstall, feature flags, LLM provider config (this session's env-Gemini fix), payroll providers, user actions (suspend/grant admin) — click-through, not just API.

### Phase 8 — Triage & fix
- Consolidate all findings into the findings log, assign severity per the rubric above.
- Fix all Critical/High immediately (blocks launch).
- For Medium: fix what's cheap now; the rest becomes a tracked, prioritized backlog with a target date.
- Add a **regression test** only for confirmed Medium+ bugs (not for everything probed) — keeps the suite lean.

## Execution notes

- Each phase is its own Playwright spec file (or small group) under `tests/e2e/qa-audit-<phase>.spec.ts`, run against production, following this session's established conventions (real login, `waitForTimeout` settle, throwaway signups left inert).
- The chatbot phase (4) additionally uses direct `fetch`-in-page calls to the agent-brain endpoint (same pattern as `agent-brain.spec.ts`) with a curated list of "messy" prompts, asserting the response is present, on-topic, and non-error — flagged for human read-through rather than exact-string assertions, since conversational quality isn't a simple equality check.
- This is a **separate execution effort** from this plan doc — the plan is committed now so the audit "happens" (per the request); running all 8 phases is subsequent work, sized like its own mini-project (estimate: 1–2 focused sessions for phases 0–5, phase 6 gated on Stripe going live, phase 7 is quick).
