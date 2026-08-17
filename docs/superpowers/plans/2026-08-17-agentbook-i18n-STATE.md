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

## Baseline (captured by PR-0, 2026-08-17)

| Metric | Value |
|--------|-------|
| hardcoded-string ratchet count | **464** (`bin/i18n-string-ratchet.baseline`) |
| — core / billing / expense | 130 / 30 / 106 |
| — invoice / startup / tax | 57 / 20 / 52 |
| `npm install` symlinks | OK — `@agentbook/i18n` linked, 49 `@naap/*` |
| UMD bundle sizes (bytes) | core 169893 · billing 83953 · expense 583134 · invoice 125330 · startup 91404 · tax 134603 |
| e2e passing set | **NOT CAPTURED LOCALLY — see below** |
| `.vercel/project.json` | absent in worktree (`.vercel` is gitignored, not inherited). Only matters at deploy time (PR-12); re-check there. |

### e2e baseline — deferred to CI, deliberately

The suite needs `E2E_MAYA_PASSWORD` / `E2E_USER_PASSWORD` / `E2E_RESET_TOKEN`,
which exist **only** as GitHub Actions secrets (`.github/workflows/nightly-e2e.yml`
lines 44-45, 71). No `E2E_*` var is set locally and there is no `.env.local` in
the worktree. This is #403 working as intended — the CI secret is the single
source of truth for the e2e password.

**Do not ask the user for the password, and do not create a local copy.** Both
would undo #403 and neither is necessary.

Consequences, which are contained:
- PRs 1-11 have **no** e2e step in their Definition of Done. Unaffected.
- PR-12 is the only consumer of the D8 comparison, and it is already gated on
  human approval. Take the "before" number from the last `nightly-e2e` run on
  `main` prior to PR-1 merging, and the "after" from the `nightly-e2e` run on
  the PR-12 branch. Record both here before requesting approval.
- If a mid-flight e2e signal is wanted earlier, push a branch and let
  `nightly-e2e` run it — CI has the secrets, this worktree does not.

---

## PR status

| PR | Title | Status | Attempts | PR link | Notes |
|----|-------|--------|----------|---------|-------|
| 0 | Baseline capture | **done** | 1 | (in PR-1) | e2e line deferred to CI — see above |
| 1 | Package foundation + un-mask plugin tests | **done** | 1 | #454 | merged `4ec17c10`; see corrections below |
| 2 | Locale plumbing + language selector | **done** | 1 | #455 | merged `8a62a087` |
| 3 | Locale-safe money + date I/O | **in_progress** | 1 | — | foundation landed; call-site migration remains (see below) |
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

## Corrections to the plan, found during execution

The plan was wrong about three things. Later PRs must use these, not the
plan's original text.

### C1 — `@agentbook/i18n` is NOT orphaned. It has 21 consumers.

The plan claimed "zero consumers". Wrong. `formatMoney` is imported from
`@agentbook/i18n` by **all six plugin frontends and the Telegram webhook** —
21 call sites. The original search matched the *directory* name
(`agentbook-i18n`) rather than the *package* name (`@agentbook/i18n`).

Consequences:
- The package is load-bearing production code, not scaffolding. Its public
  export surface is a hard compatibility boundary.
- PR-1 briefly dropped `formatMoney` from `index.ts` and broke every money
  figure in the product. The newly un-masked plugin tests caught it in
  minutes — the un-mask paid for itself immediately.
- **The ambient API genuinely did have zero consumers** (nothing imported
  `t`/`setLocale`/`getLocale`/`loadLocale`), so deleting it was safe. Only
  the formatter exports were load-bearing.
- Noted for the formatting PR: `formatMoney` infers its display locale from
  the **currency code**, not the user's locale. A fr-CA user with a CAD
  account gets `en-CA` formatting. Reconciling that is the formatting PR's
  job.

### C2 — `npm run typecheck` cannot be a Definition of Done. Use the guard.

The plan's DoD said `npm run typecheck` must exit 0. That is unsatisfiable:
pristine `origin/main` emits **347 errors across 113 files**, and CI's own
TypeScript step carries `continue-on-error: true` ("Pre-existing TS errors —
tracked for separate cleanup"). The `Lint & TypeCheck` job therefore reports
success regardless of what tsc says. ESLint has the same
`continue-on-error: true`.

**Replace that DoD line with `./bin/i18n-typecheck-guard.sh`**, which asserts
zero errors on the i18n surface and that the repo-wide count does not grow.
Same principle as the e2e baseline-superset rule: measure direction of
travel, not an absolute that was never true. Baseline now **343** (PR-1's
deletion removed 4).

### C4 — The language selector already existed, gated to Canada only.

The plan assumed a selector had to be built. One already existed in
`AgentBookSettingsPanel.tsx`, but behind `form.jurisdiction === 'ca'` and
offering only `en-CA`/`fr-CA` — so a Chinese- or French-speaking tenant
anywhere outside Canada could not reach it at all. Its help text also promised
"the rest of the app interface stays in English", which this plan makes false.

PR-2 removed the jurisdiction gate and made the options derive from catalog
readiness via `offerableLocales()`, so:
- a `scaffold` locale (zh-CN today) is never offered — picking 简体中文 and
  getting English would be worse than not offering it;
- the picker grows by itself when a language pack lands, with no second list;
- `isSelectableLocale` stays deliberately WIDER than the picker, so a tenant
  already stored as `en-CA` can still save their settings page.

### C5 — TS6307 is excluded from the typecheck guard.

75 of the repo's 344 tsc errors are TS6307 ("File X is not listed within the
file list of project"), a tsconfig-INCLUDE artifact rather than a type error —
18 on `plugin-sdk/src/hooks/index.ts` alone, one per exported hook, almost all
predating this work. Counting them meant any new SDK export tripped the guard
for a reason unrelated to correctness. The guard now measures the **269 real
type errors**; baseline 269.

### C3 — A pre-existing timezone bug in `formatDate`, owned by the formatting PR.

`formatters.test.ts` passes under `TZ=UTC` and fails in any zone west of it.
Cause: `formatDate('2026-03-22', locale)` builds `new Date(...)` — parsed as
**UTC midnight** — then formats it in the **local** zone. In
`America/Vancouver` that renders "Mar 21, 2026".

This is a live product bug, not a test artifact: any user west of UTC sees
date-only values one day early. On an invoice due date or a filing deadline
that is a material error. CI masks it by running in UTC.

The formatting PR must fix it (format date-only values in a fixed zone, or
carry the tenant timezone explicitly) and add a non-UTC test so the fix
cannot silently regress.

## PR-3 remaining work (foundation landed, migration outstanding)

Landed so far on `i18n-pr3-money-date-io`:
- `packages/agentbook-i18n/src/parse.ts` — `parseAmountToCents`,
  `parseDateInput`. Decides decimal-vs-grouping by trailing-digit COUNT rather
  than by the locale's nominal separator, because keying off the locale breaks
  in both directions (fr-CA typing "45.50" and en-US reading "45,50" are the
  same 100x error mirrored). Reports `ambiguous` instead of guessing.
- `formatDate` date-only UTC fix (correction C3). Verified in
  `America/Vancouver` AND `UTC`, so it cannot regress on a UTC-only CI.
- 102 package tests green in both zones, incl. a round-trip property
  `parse(format(x)) === x` across all three locales.

STILL TO DO in PR-3:
1. **14 comma-stripping call sites.** Full list in the traps section below.
2. **~110 hardcoded `'en-US'` formatting sites** (181 `toLocale*`/`Intl` total).
3. **Golden tests** asserting `en-US` output is byte-identical for each.
4. **D6 echo-back**: surface `ParsedAmount.formatted` in the chat confirmation
   step so an `ambiguous` amount is confirmed before it is booked.

### Dependency discovered — affects sequencing

`plugins/agentbook-core/backend/src/parse-amount.ts` is the shared
natural-language money parser used by chat/Telegram. Two things about it:

- It **already** handles Chinese money words (元 / 块 / 圆) and guards against
  non-money units (小时, 人份). That work exists and must not be undone.
- Its `NUM` regex hardcodes en-US shape:
  `(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)` — comma-thousands,
  period-decimal. Making it locale-aware requires the caller's locale, which is
  only threaded into the agent brain by **PR-9**.

So the NL-parser subset of item 1 is blocked on PR-9's locale threading. The
form/API subset is not. Options: split PR-3 into form-input (now) and
NL-input (after PR-9), or move PR-9 ahead of PR-3. Recommend the split —
reordering would put chat response language before the money-input fix.

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
