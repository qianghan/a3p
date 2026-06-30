# AgentBook — Session Handoff

> **Purpose:** everything a fresh Claude session (new account, same folder) needs to continue this work with zero context loss. Read this top-to-bottom before doing anything.
>
> **Last updated:** 2026-06-30 · **Folder:** `/Users/qianghan/Documents/mycodespace/a3p` · **Work on branch:** `main`

---

## 0. TL;DR — where things stand

AgentBook is an AI accounting product for **micro / sole-proprietor / SMB &lt;$1M + personal-finance** users (NOT startups). It competes with Pilot.com but as **AI self-serve + bring-your-own-accountant**, not a human service.

- A **6-phase competitive roadmap** (Phases 1–6) is **shipped, deployed, e2e-verified**.
- A **6-phase follow-on plan** (F1–F6): **F1–F5 done**, **F6 not done** (the only outstanding plan item).
- Two UX/bug PRs (#144, #145) merged.
- **`main` is the single source of truth** and is what deploys to production (`agentbook.brainliber.com`).
- Production has **Vercel Git auto-deploy ON** for `main`, but we still do a verified prebuilt deploy after each push.

**The plans live in:**
- Roadmap: `docs/superpowers/plans/2026-06-29-agentbook-roadmap.md`
- Follow-ons: `docs/superpowers/plans/2026-06-29-agentbook-followons.md` (F6 is the open phase)
- Competitive analysis context: `agentbook/skills/product.md`

---

## 1. CRITICAL architecture facts (non-obvious — read these first)

1. **Production runs Next.js API routes, NOT the Express plugin servers.** The files in `plugins/*/backend/src/server.ts` are **local-dev only**. The real prod code path for any endpoint is `apps/web-next/src/app/api/v1/<plugin>/.../route.ts`, using `prisma` from `@naap/database`. Always edit the Next route for prod behavior.
   - **Exception — the agent brain:** `plugins/agentbook-core/backend/src/server.ts` exports `classifyAndExecuteV1` / `executeClassification`, which the Next route `apps/web-next/src/app/api/v1/agentbook-core/agent/message/route.ts` imports and runs. So agent INTERNAL skill handlers in that `server.ts` **do** run in prod (as a library). They use direct DB (`db.abFoo`), not HTTP self-calls.

2. **The repo is `qianghan/a3p`**, an independent product (forked from `livepeer/naap`, upstream removed). NEVER add an upstream remote, NEVER use `naap`/Neon DB creds (`neondb_owner`, `ep-hidden-paper`, `ep-frosty-pine`), NEVER restore `a3p_`-prefixed env vars. See `CLAUDE.md`.

3. **Local `tsc --noEmit` gives FALSE "Property 'abFoo' does not exist on PrismaClient" errors** for any model added in a worktree. Reason: a `git worktree` has no `node_modules`, so `@naap/database` resolves to the MAIN checkout's stale generated client. This is a **false alarm** — `vercel build` regenerates the client and `next.config.js` has `typescript.ignoreBuildErrors: true`. **The prod e2e (200 vs 500) is the real proof.** Don't chase these.

4. **The agent loads skills only from the `AbSkillManifest` table** (plus a `BUILT_IN_SKILLS` fallback-merge added in F1). New built-in skills need either the fallback merge (already in the message route) or a DB seed: `bin/seed-skills-prod.ts`. The admin seed route needs `CRON_SECRET` (not available locally).

5. **`main` was reconciled from `pr/wave15-scorecard-v11`** on 2026-06-29 (fast-forward, main now a strict superset). `pr/wave15-scorecard-v11` still exists but is redundant — ignore it, work on `main`.

---

## 2. How to ship a change (the proven cycle)

Every phase/fix went through this exact loop. Follow it.

```bash
# 1. Worktree off main
cd /Users/qianghan/Documents/mycodespace/a3p
git fetch origin -q
git worktree add .worktrees/<name> -b <branch> origin/main

# 2. Link Vercel in the worktree (needed for build/deploy)
cd .worktrees/<name>
mkdir -p .vercel && cp /Users/qianghan/Documents/mycodespace/a3p/.vercel/project.json .vercel/
vercel pull --yes --environment=production

# 3. Code. Pure logic → apps/web-next/src/lib/*.ts with vitest tests
#    (vitest does NOT resolve the @/ alias — use relative imports in tests).
npx vitest run apps/web-next/src/lib/__tests__/<file>.test.ts

# 4. If schema changed: regenerate + migrate PROD (additive only)
cd packages/database && npx prisma generate
#    Get DATABASE_URL_UNPOOLED from repo-root .env.local (Supabase pooler).
DATABASE_URL="$U" DATABASE_URL_UNPOOLED="$U" npx --no prisma db push --skip-generate
cd ../..

# 5. Build + deploy the VERIFIED build (don't rely on auto-deploy alone)
SKIP_DB_PUSH=1 vercel build --prod       # may fail ONCE on the transient db-push step; just re-run
vercel deploy --prebuilt --prod

# 6. e2e against PROD (see §4)
cd tests/e2e && E2E_BASE_URL="https://agentbook.brainliber.com" \
  npx playwright test <file>.spec.ts --config=playwright.config.ts --reporter=line

# 7. PR → squash-merge → clean up
git push -u origin <branch>
gh pr create --base main --head <branch> --title "..." --body "..."
gh pr merge <PR#> --squash --delete-branch=false
cd /Users/qianghan/Documents/mycodespace/a3p
git worktree remove --force .worktrees/<name>
git branch -D <branch>
```

Deploy rules: **never trigger Vercel-side builds** for iteration — always `vercel build` locally + `vercel deploy --prebuilt --prod`. (`agentbook/skills/deployment.md` has the full rationale + the Prisma engine dedup details.)

---

## 3. Database & migrations

- **Prod DB:** Supabase `agentbook-db` (instance `vefoeskvxthrcnggjtlf`). `DATABASE_URL` / `DATABASE_URL_UNPOOLED` are in repo-root `.env.local`. This DB **is** allowed for `prisma db push` (the CLAUDE.md ban is only on naap/Neon creds).
- Single schema file: `packages/database/prisma/schema.prisma` (multiSchema). Each plugin has its own namespace; to add one, add it to the `datasource db { schemas = [...] }` array AND `@@schema("...")` on the model.
- Existing namespaces: `plugin_agentbook_{core,expense,invoice,tax,billing,personal,cpa,payroll}`.
- Migrations must be **additive** (nullable cols / new tables / new namespaces) — no destructive changes. The user has approved this pattern.

---

## 4. E2E against production (the recipe that works)

Examples: `tests/e2e/{personal-finance,cpa-handoff,payroll-complete,cpa-portal,agent-new-skills,push-subscribe,receipt-scan}.spec.ts`.

- `test.use({ baseURL: process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com' })`.
- Log in as **Maya** via the UI: fill `input[type=email]` + `input[type=password]` (`maya@agentbook.test` / `agentbook123`), click `button[type=submit]`, `waitForURL(/agentbook|dashboard/)`.
- **Critical:** `await page.waitForTimeout(2000)` after login — the session cookie needs ~2s to settle or the first API call 401s (race, not auth failure).
- Do API calls via **in-page `fetch`** (`page.evaluate(() => fetch(path))`) so the httpOnly `naap_auth_token` cookie is sent.
- For "no-auth" flows (public review/portal pages), use a **fresh `chromium.launch()` context** and `goto` the page first so relative URLs resolve.
- Maya is a **CA consultant** → tenant jurisdiction is `ca` (matters for tax/payroll form types: t4, not 941). Employee jurisdiction is separate.
- Tenant resolver: `safeResolveAgentbookTenant(request)` in `apps/web-next/src/lib/agentbook-tenant.ts` → `{ tenantId }` or `{ response }`. tenantId == user.id; Maya's is `maya-consultant`.

Test accounts (also in `CLAUDE.md`): Maya `maya@agentbook.test`, Alex `alex@agentbook.test`, Jordan `jordan@agentbook.test`, Admin `admin@a3p.io` — all `agentbook123` except admin `a3p-dev`.

---

## 5. What's been built (feature inventory + key files)

### Roadmap Phases 1–6 (shipped)
| Phase | Feature | Namespace / key location |
|---|---|---|
| 1 | Security hotfix (debug-body auth, billing templates privilege) | — |
| 2a | Combined W-2 + self-employment tax estimate | `agentbook-tax` `tax/estimate` route + `AbTaxConfig.w2*` |
| 2b | Deferred revenue (retainers) | `AbDeferredRevenue` + `cron/recognize-revenue` |
| 2c | Cash vs accrual P&L basis | `AbTenantConfig.accountingBasis` |
| 2d | AP / bill management + aging | `AbBill` in `plugin_agentbook_expense` |
| 3 | **Personal finance** | `plugin_agentbook_personal` — `/personal` page + `lib/personal-snapshot.ts` |
| 4 | **CPA handoff** (token link + AI review + write-toggle apply-fixes + monthly cron) | `plugin_agentbook_cpa` — `lib/cpa-review.ts` + `lib/cpa-run.ts` |
| 5 | **Payroll** (US/CA/UK/AU withholding) | `plugin_agentbook_payroll` — `lib/payroll-engine.ts` |
| 6 | **Mobile PWA** at `/app` (Home/Capture/Docs/Chat) | `apps/web-next/src/app/app/*` |

### Follow-ons F1–F5 (shipped)
- **F1** agent skills wiring (#139): `manage-bills, personal-snapshot, payroll-status, run-payroll, cpa-review` — INTERNAL handlers in `plugins/agentbook-core/backend/src/server.ts`, manifests in `built-in-skills.ts`. Fallback-merge of `BUILT_IN_SKILLS` in the message route. Seed via `bin/seed-skills-prod.ts`.
- **F2** capture OCR (#140): `apps/web-next/src/app/api/v1/agentbook-expense/receipts/scan/route.ts` + `lib/receipt-parse.ts`.
- **F3** web push (#141): `lib/push-payload.ts`, `lib/web-push-send.ts`, `/api/v1/push/subscribe`, `AbTenantConfig.pushSubscription`. **Inert until VAPID env keys are set** (see §7).
- **F4** payroll completeness (#142): `lib/payroll-ledger.ts` (3-line split), `lib/payroll-deposits.ts` (`AbPayrollTaxDeposit`), `lib/year-end-forms.ts`. Routes `/tax-deposits`, `/year-end`.
- **F5** CPA human portal (#143): `AbCpaInvite` + `AbDocumentRequest`, `/invite`, `/cpa-portal/[token]`, `/document-requests`, `resolveActiveInvite` in `lib/cpa-link.ts`.

### UX/bug PRs
- #144: mobile docs crash (use `vendorName` not `vendor`), Telegram HTML briefing fix (`parse_mode=HTML` via `html` option in `lib/agentbook-chat-adapter.ts`), digest tips truncation fix, bills route → `/agentbook/expenses/bills`, sidebar IA, removed Mobile PWA from nav.
- #145: payroll tabbed UI (deposits/year-end), accountant invites + doc-requests UI, **Billing moved to Settings → AgentBook → Billing** (`BillingTab` in `AgentBookSettingsPanel.tsx`; billing plugin hidden from sidebar).

---

## 6. OUTSTANDING WORK

### F6 — Accounting Polish (only open plan item)
Spec in `docs/superpowers/plans/2026-06-29-agentbook-followons.md` (Phase F6). Two tasks:
- **F6.1** Balance sheet AR/AP: in `apps/web-next/src/app/api/v1/agentbook-tax/reports/balance-sheet/route.ts`, when `accountingBasis === 'accrual'`, add an AR line (sum of unpaid invoices) and AP line (sum of open `AbBill`). Extract the sums to a pure helper + unit test. e2e: with an unpaid invoice, AR line is non-zero under accrual.
- **F6.2** Tax estimate respects basis: in `tax/estimate/route.ts`, honor `accountingBasis` (cash → revenue from `AbPayment` received; accrual → invoiced). Add `?basis=` override. e2e: `?basis=cash` vs `?basis=accrual` both 200; cash ≤ accrual when unpaid invoices exist.

### Launch-readiness gaps vs Pilot.com (from the gap analysis)
**Blockers (fix or clearly gate before public launch):**
1. **Payroll doesn't move money or file.** It computes withholding + posts to the ledger only — no direct deposit, no 941/940 e-file/remittance. Either re-label as "Payroll calculator & records" (+ disclaimers) or build real money movement (Gusto/Check partnership). **Highest-priority launch decision.**
2. **PII handling** — personal finances + employee payroll data. Need encryption-at-rest review, retention policy, privacy policy before collecting from real users.
3. **Compliance disclaimers** — every tax/payroll number is an estimate; add visible "consult a professional" disclaimers.

**Important:** data import/onboarding (no CSV/QBO import → cold start), personal bank sync (manual only; Plaid wired for business), F6 accrual gaps, CPA invite email (manual link), push not live (VAPID), plan-quota enforcement (only agent messages rate-limited today).

**Positioning (not gaps):** AI self-serve + invite-your-own-accountant (don't promise humans you don't staff); no startup/R&D-credit tooling (intentional — you skip startups); personal+business under one agent is the moat — make it the headline.

---

## 7. Known config gaps / manual steps

- **Web Push delivery is OFF** until VAPID keys are set in prod env:
  ```bash
  npx web-push generate-vapid-keys
  # add to Vercel production env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY,
  #   NEXT_PUBLIC_VAPID_PUBLIC_KEY (= public key), VAPID_SUBJECT (mailto:...)
  ```
- **CPA invite emails** are not sent (no generic email sender) — the owner copies the `/cpa-portal/<token>` link manually. To wire email, add a sender to `apps/web-next/src/lib/email.ts` (currently only verification/reset/agent-message senders exist).
- **Skill seeding** to prod needs `CRON_SECRET` (sensitive, not pullable). Use `bin/seed-skills-prod.ts` with the prod `DATABASE_URL` from `.env.local` instead.
- `CRON_SECRET` / `INTERNAL_ADMIN_SECRET` / VAPID are **not** in the pulled `.env.production.local` (encrypted) — cron/admin endpoints can't be e2e'd directly; unit-test their pure logic.

---

## 8. Useful commands & locations

- Build a plugin frontend (UMD): `cd plugins/<name>/frontend && npm run build` then copy `dist/production/<name>.js` to `apps/web-next/public/cdn/plugins/<name>/` (and `/1.0.0/`). Note: `bin/vercel-build.sh` rebuilds plugin frontends during deploy, so the prebuilt deploy regenerates them.
- Telegram bot: `@Agentbookdev_bot` → Maya (chat `5336658682`). Mapping in `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts`.
- Plaid sandbox creds + seed instructions: `CLAUDE.md`.
- Domains: agentbook/books/medatlas/www.brainliber.com all live (prod = `agentbook.brainliber.com`).
- The old account's memory (now folded into this doc): roadmap status, phase workflow, e2e recipe. **This HANDOFF.md supersedes them** for a new account.

---

## 9. First move for the new session

1. `cd /Users/qianghan/Documents/mycodespace/a3p && git fetch origin && git log origin/main --oneline | head` — confirm you're current.
2. Read this file + the two plan files in `docs/superpowers/plans/`.
3. Decide with the user: **finish F6**, or **address the payroll-positioning launch blocker** (re-label "Run payroll" → calculator + disclaimers), or pursue the import/onboarding gap. All three are scoped above and ship through the §2 cycle.
4. Sanity-check prod is healthy: `curl -s -o /dev/null -w "%{http_code}" https://agentbook.brainliber.com/api/v1/agentbook-personal/snapshot` should return `401` (deployed + auth-gated).
