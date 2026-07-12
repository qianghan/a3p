# Personal Finance Parity — Implementation Plan (PR-1)

Design: `docs/superpowers/specs/2026-07-12-personal-finance-parity-design.md`

## Task 1 — Transactions UI on `/personal`

**Files:** `apps/web-next/src/app/(dashboard)/personal/page.tsx`

Add: a "Record transaction" form (account `<select>`, description text input, signed dollar-amount input converted to cents, category text input with a datalist of common categories, date input defaulting to today, "This is a business expense" checkbox → `businessFlag`), posting to `POST /api/v1/agentbook-personal/transactions`, followed by a re-fetch of the snapshot + a per-account transaction list (`GET /transactions?accountId=`) rendered as a table (date, description, category, signed amount styled green/red, business-flag badge). Use the existing page's card/stat visual conventions — no new design system. Route all dollar formatting through `apps/web-next/src/lib/jurisdiction-currency.ts`.

**Tests:** extend `tests/e2e/personal-finance.spec.ts` — fill the new form via `page.fill`/`page.selectOption`, submit, assert the new row renders and the snapshot's `month.incomeCents`/`spendingCents` reflect it.

## Task 2 — Budgets UI on `/personal`

**Files:** same page.

Add: a "Set budget" form (category text input, monthly limit dollar input) posting to `POST /api/v1/agentbook-personal/budget` (upsert), and a budget list from `GET /budget` showing category / limit / spent / remaining / percent (progress bar okay, keep simple — a text percentage is sufficient, no new charting dependency for this task).

**Tests:** extend the same e2e spec — set a budget via the UI, assert it lists with correct spent/remaining after a transaction in that category.

## Task 3 — `record-personal-transaction` chat skill

**Files:** `plugins/agentbook-core/backend/src/built-in-skills.ts`, `plugins/agentbook-core/backend/src/server.ts`

Add an HTTP-backed skill manifest (`endpoint: POST /api/v1/agentbook-personal/transactions`) with triggers covering personal income/spend phrasing ("I got paid", "I spent $X on my personal account", "put $X into savings") and `excludePatterns` to avoid colliding with `record-expense` (business-flagged language: "for the business", "client", "invoice") and `personal-snapshot`'s query phrasing ("what's my net worth", "how much did I spend"). Param extraction: `description`, `amountCents` (signed — infer sign from income vs. spend phrasing), `category`, `accountRef` (raw text for account resolution), `businessFlag`.

Add a pre-processing handler in `server.ts` (same pattern as `save-scholarship`'s handler): fetch the tenant's `AbPersonalAccount` list; if zero, return the "add an account first" message (`confidence: 1` — per this session's established gotcha, any INTERNAL/blocked-path early return must stay at `confidence: 1` or it gets misrouted through the planner); if one, use it directly; if more than one, resolve via `resolveOrdinalOrFuzzyCandidate` from `candidate-resolution.ts` against the account names.

**Tests:** new `plugins/agentbook-core/backend/src/__tests__/personal-transaction-skill.test.ts` — routing-collision checks against `record-expense`/`personal-snapshot`, zero/one/multi-account resolution, businessFlag extraction cases (mirrors `student-chat-skills.test.ts`'s mocking pattern: mock `db.abPersonalAccount.findMany`, `global.fetch`).

## Task 4 — E2E chat round-trip + final verification

**Files:** `tests/e2e/personal-finance.spec.ts`

Add: "I spent $50 on groceries from my checking account" (single-account tenant) → `skillUsed: 'record-personal-transaction'` → re-fetch transactions, confirm it persisted with the right sign/category. Confirm existing personal-finance e2e assertions (net worth math, snapshot fields) are unaffected.

## Process

Subagent-driven development, matching this session's established discipline: implementer subagent per task → task-scoped reviewer subagent → fix rounds until approved → final whole-branch review on the most capable model → commit → PR → merge to `main` → build + prebuilt deploy → live e2e verification against production.
