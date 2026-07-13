# Personal Finance — Transactions/Budgets UI + Chat Write-Skill Parity (PR-1 of the personal-finance/tax-filing launch program)

## Context

Two research passes (see `docs/superpowers/specs/` companion review artifacts shared with the user 2026-07-12) established:

- The personal-finance plugin (`AbPersonalAccount`/`AbPersonalTransaction`/`AbPersonalBudget`, merged on `main` since PR #135) has full CRUD API support for accounts, transactions, and budgets, but the `/personal` dashboard page only has an "Add account" form — there is no UI anywhere to record a transaction or view/set a budget. Confirmed via repo-wide grep: zero `.tsx` references to `/api/v1/agentbook-personal/transactions` or `/budget`.
- The only chat skill touching this data, `personal-snapshot` (`built-in-skills.ts`), is read-only. There is no way to record a personal transaction via chat, Telegram, or MCP.
- MCP (`feat/mcp`, merged as of `b7e7a264`) exposes exactly one tool, `ask_agentbook`, which forwards free text to `/agent/message` — any new skill reachable by chat text is automatically reachable over MCP with no separate wiring.

This is PR-1 of a 7-PR program (personal finance + tax fast-track) the user approved after reviewing two ranked-gap review documents. It was chosen to go first because it requires **no new schema** and is the cheapest, most self-contained way to establish the write-skill + MCP(free) + UI parity pattern the rest of the program reuses.

## Goal

Close the UI gap (ship transactions + budgets screens) and the chat/MCP gap (a write skill) for the personal-finance plugin that already has full API support — achieving chatbot/MCP/UI parity for personal-finance CRUD.

## Scope

**In scope:**
1. **Transactions UI** on `/personal`: a form to record a transaction (account picker, description, signed amount, category, date, business-flag checkbox) + a transaction list/table for the selected account (or all accounts), each following the existing page's visual conventions (same card/stat styling already in `page.tsx`).
2. **Budgets UI** on `/personal`: a form to set/update a monthly category limit + a budget list showing spent/remaining/percent (the route already computes this — `GET /api/v1/agentbook-personal/budget`).
3. **Chat write-skill**: `record-personal-transaction` — an HTTP-backed skill (matches the pattern of `record-expense`) that extracts `{description, amountCents, category, accountId|accountName, businessFlag}` from free text (e.g. "I got paid $5,000 salary" / "spent $80 on groceries from checking") and calls `POST /api/v1/agentbook-personal/transactions`. Triggers must not collide with the existing `record-expense`/`personal-snapshot` skills — personal transactions are explicitly "personal account" scoped (mirrors `personal-snapshot`'s existing exclude-"business" pattern).
4. Currency/locale formatting in all new UI stays consistent with the tenant's configured jurisdiction via the existing `apps/web-next/src/lib/jurisdiction-currency.ts` module (not a new hardcoded `$` — this is the "multi-jurisdiction parity" bar applied here, since personal-finance amounts are jurisdiction/currency-aware even though the underlying feature isn't tax-specific).

**Out of scope (explicitly deferred to later PRs):** proactive nudges, net-worth trend charts, billing gate (PR-2), bank sync (PR-6). This PR ships the missing plumbing for what already has API support — nothing net-new in scope beyond that.

## Design decisions

- **A user can have more than one personal account** — the transaction form needs an account picker (`<select>` sourced from `GET /accounts`), not an implicit single-account assumption.
- **The chat skill resolves `accountId` from free text the same way `save-scholarship`'s candidate-resolution helper works** for ordinal/fuzzy matching (e.g. "the checking one") — reuse `plugins/agentbook-core/backend/src/candidate-resolution.ts`'s `resolveOrdinalOrFuzzyCandidate` rather than inventing new matching logic, matching this session's established "shared helper over new one-off logic" precedent. If the tenant has exactly one account, skip disambiguation entirely and use it.
- **`businessFlag` extraction is conservative** — only set `true` when the message explicitly says something like "for the business" / "that's a business expense," default `false` otherwise. Getting this wrong mislabels real personal spend as business spend, which the existing plugin's snapshot math depends on (`month.businessFlaggedCents`).
- **The transaction skill does NOT auto-create an account.** If the tenant has zero personal accounts, the skill replies pointing them at the `/personal` page's "Add account" flow first — mirrors `student-chat-skills`' eligibility-gate-style "point them to the app" precedent rather than silently creating an account with guessed values.

## Test plan

- Unit tests for the new skill's routing (`skill-routing-canonical.test.ts`-style: correct trigger phrases route to `record-personal-transaction`, don't collide with `record-expense`/`personal-snapshot`).
- Unit tests for the skill handler itself (mocked `db`/`fetch`, mirroring `student-chat-skills.test.ts`'s pattern): single-account auto-resolve, multi-account disambiguation, zero-account message, businessFlag extraction cases.
- Extend `tests/e2e/personal-finance.spec.ts` with: UI-driven transaction creation (fill the new form, assert it appears in the list and the snapshot updates), UI-driven budget creation, and a chat round-trip ("I spent $50 on my personal account" → `skillUsed: 'record-personal-transaction'` → transaction persisted).

## Rollout

No schema changes — build → unit tests → task-scoped review per task → final whole-branch review → merge to `main` → build + deploy (prebuilt, per this repo's standing Vercel practice) → live e2e verification against production, matching every prior feature this session.
