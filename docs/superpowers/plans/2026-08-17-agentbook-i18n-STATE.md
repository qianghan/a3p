# AgentBook i18n (zh-CN + fr-CA) — execution state

**Plan:** `i18n-plan.html` (repo root, same branch)
**Branch:** `worktree-agentbook-i18n-plan`
**Worktree:** `.claude/worktrees/agentbook-i18n-plan`
**Base commit:** `5dbd7eef`
**Created:** 2026-08-17

This file is the loop's only source of position. Re-read it at the start of
every iteration; do not carry plan position in context. Update and commit it
with each PR.

---

## Iteration algorithm (from plan section 4.2)

1. Read this file.
2. If any row is `halted` → **STOP**. Do not attempt other PRs.
3. Pick the lowest-numbered row that is not `done`.
4. If its Attempts >= 3 → mark `halted`, write the diagnosis in Notes, **STOP**.
5. Execute that PR's recipe from `i18n-plan.html`.
6. Run its Definition of Done commands, in order.
7. All exit 0 → commit, push, open PR, merge (per D1), mark `done`, go to 1.
   Any non-zero → increment Attempts, record the failing command and its
   output **verbatim** in Notes, go to 1 (which retries the same PR).
8. All rows `done` → **STOP** and report.

PRs are strictly sequential. Never skip a non-`done` row.

## Halt conditions — do not guess

- Definition of Done still red after 3 attempts.
- e2e passing set is **not** a superset of the PR-0 baseline (re-run once
  first to rule out flake).
- Any `packages/database/prisma/schema.prisma` change becomes necessary.
  This plan requires none; if one appears, an assumption was wrong.
- A secret, credential, or env var is needed that is not already present.
- A tax, legal, or filing-disclosure string is ambiguous → leave it English
  and halt. Never translate regulated copy on a guess.
- `main` has advanced such that rebase conflicts non-trivially. Re-verify
  against current main rather than forcing.

## Standing prohibitions

- **Never push directly to `main`.** Every change goes through a PR,
  including one-line changes that look inert.
- **Never run `git stash` / `checkout` / `reset` in the main checkout.**
  Other agent streams keep in-progress work there. All work stays in this
  worktree. If a stash is unavoidable, use `git stash push -u -m <tag>`,
  capture the SHA, and `apply` (never `pop`).
- **Do not re-mask plugin tests.** If un-masking (PR-1) reveals red suites,
  fix or delete them and disclose it. Restoring the mask defeats the plan.

---

## Decisions — all resolved 2026-08-17 ("all recommended")

These are authoritative. Do not re-derive or re-ask.

| ID | Decision | Resolution |
|----|----------|-----------|
| **D1** | Merge authority | **(a)** Loop merges PRs 1–11 unattended. **HALT before PR-12** and wait for human approval of the flag flip. |
| **D2** | Feature flag | Key `agentbook_i18n_locales`, default **off** in all environments. Flipped on in PR-12 only. |
| **D3** | Translation authorship | Loop authors fr-CA + zh-CN strings itself. Human spot-review happens at the D1 halt, on **rendered screens**, not on catalog JSON. |
| **D4** | French terminology | **CRA + Revenu Québec official French** is the authority for every tax/accounting noun. Use the official term, or leave the key English and list it in the PR body. Never invent one. |
| **D5** | CJK font for PDFs | **(a)** Commit a subsetted **Noto Sans SC** (SIL OFL 1.1 — permits bundling), registered via `Font.register()`. PR-11 records the subsetted byte size in its PR body. |
| **D6** | Decimal comma | **(a)** Parse by locale AND **always echo the interpreted amount back** in the confirmation step. Non-negotiable for PR-3. |
| **D7** | Non-goals | Confirmed out of scope: OCR/voice input language; marketing + landing pages; `/fr/` locale routes; `es`/`ja` stubs (deleted per Cut 4). |
| **D8** | E2E gating | **Baseline-superset**, not all-green. Record the passing set at PR-0; every later PR must pass a superset. |

---

## Baseline (filled by PR-0)

| Metric | Value |
|--------|-------|
| e2e passing set | _pending PR-0_ |
| e2e total specs | _pending PR-0_ |
| hardcoded-string ratchet count | _pending PR-0_ |
| UMD bundle sizes (6 plugins, bytes) | _pending PR-0_ |
| `npm install` symlinks verified | _pending PR-0_ |
| `.vercel/project.json` = `a3p-plugin-build` | _pending PR-0_ |

---

## PR status

| PR | Title | Status | Attempts | PR link | Notes |
|----|-------|--------|----------|---------|-------|
| 0 | Baseline capture | pending | 0 | — | committed with PR-1 |
| 1 | Package foundation + un-mask plugin tests | pending | 0 | — | inert |
| 2 | Locale plumbing + language selector | pending | 0 | — | selector becomes visible |
| 3 | Locale-safe money + date I/O | pending | 0 | — | **highest risk** — see D6 |
| 4 | Extraction: core + billing | pending | 0 | — | inert |
| 5 | Extraction: expense + invoice | pending | 0 | — | inert |
| 6 | Extraction: tax + startup (+ legal denylist) | pending | 0 | — | inert |
| 7 | Extraction: web-next shell/auth/settings | pending | 0 | — | inert |
| 8 | fr-CA + zh-CN catalog content | pending | 0 | — | dark, flag off |
| 9 | Agent chat response language | pending | 0 | — | dark, flag off |
| 10 | Telegram localization | pending | 0 | — | dark, flag off |
| 11 | Emails, invoices, tax packs + CJK font | pending | 0 | — | dark, flag off |
| 12 | GA — flag flip, trilingual e2e, docs | **blocked: D1 halt** | 0 | — | requires human approval |

Statuses: `pending` → `in_progress` → `done` \| `halted`

---

## Known traps (verified in the repo at `5dbd7eef`)

Each of these has produced a real bug in this repo before. They are not
hypothetical.

- **Decimal comma = 100× money error.** 14 sites do
  `parseFloat(raw.replace(/,/g,''))`. `"45,50"` → `4550` → `$4,550.00`.
  Format and parse must land in the SAME PR (PR-3).
- **Plugin tests cannot fail CI.** Two masks: 3 of 6 plugins lack a `test`
  script, and the CI step is `npm test --if-present || echo ...`. PR-1 must
  remove both or every component test in this plan is decoration.
- **`agentbook-core` has 4 never-executed test files.** Expect them red on
  first un-mask. Fixing them is in PR-1 scope.
- **Prod serves chat via Next routes, not the Express plugin backend.** Both
  carry the logic. A change applied to only one is dead code on the path
  users actually hit.
- **Telegram copy has existed in 3 places.** Grep for duplicates; do not
  assume one home.
- **Locale whitelist must accept `en-US`.** Every existing row holds it. A
  narrower whitelist rejects live data — this exact shape already shipped as
  a hotfix on `businessType`.
- **Plugin frontend changes need the rebuilt UMD bundle COMMITTED** to
  `public/cdn`. Building is not shipping. Verify in a real browser —
  curling the CDN bundle returns a plausible response that does not prove
  the app renders.
- **`bin/regression-guard.sh` guards nothing here.** Its `CORE_PLUGINS` list
  is the pre-fork naap plugins; it builds/tests zero AgentBook plugins. Rely
  on `plugin-tests`, `invariants`, and `backend-tests` instead.
- **Cron/email paths have no request headers.** Locale must come from each
  recipient's tenant config, not the caller's.
