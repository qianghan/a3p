# Nightly E2E Regression Suite — Design

**Status:** Approved (brainstorm complete, awaiting plan)
**Owner:** AgentBook
**Date:** 2026-05-02
**Audience:** AgentBook engineers + on-call rotation

## 1. Goal

A single phased Playwright suite that exercises the full AgentBook product surface — web UI, REST API, and Telegram bot — and runs every night against the production deployment at `https://a3book.brainliber.com`. When something breaks, a GitHub issue auto-opens within an hour of the regression. When the underlying bug is fixed, the issue auto-closes on the next green night.

## 2. Strategic decisions

| Decision | Choice | Why |
|---|---|---|
| Test data | Dedicated user `e2e@agentbook.test`, wiped + re-seeded each run | Production users (Maya/Alex/Jordan) stay clean; assertions stable over months |
| Bot strategy | Mock POST to `/api/v1/agentbook/telegram/webhook` with synthetic Update payloads; capture would-be `sendMessage` body | Webhook is our boundary; downstream of `api.telegram.org` is Telegram's problem |
| Coverage depth | Mid-depth, ~93 tests across 7 phases | A misses too much, C costs more flake than it saves |
| Schedule + notify | GHA cron `0 7 * * *` + auto-create GitHub issue, de-duped by phase | Same surface engineers already use; no separate channel to monitor |

## 3. Architecture

```
tests/e2e/nightly/
├── playwright.config.ts
├── helpers/
│   ├── auth.ts                       loginAsE2eUser(page) → cookied session
│   ├── api.ts                        api(page).get/post/put/delete
│   ├── telegram.ts                   postUpdate(text, chatId) → simulated webhook POST
│   └── data.ts                       deterministic test fixtures
├── phase1-auth.spec.ts               ~6 tests
├── phase2-dashboard.spec.ts          ~12 tests
├── phase3-expenses.spec.ts           ~18 tests
├── phase4-invoicing.spec.ts          ~22 tests
├── phase5-tax-reports.spec.ts        ~15 tests
├── phase6-telegram-bot.spec.ts       ~14 tests
└── phase7-cron-and-cache.spec.ts     ~6 tests

scripts/
└── seed-e2e-user.ts                  one-shot: resets the e2e user

.github/workflows/
└── nightly-e2e.yml                   matrix job per phase + auto-issue notify
```

The `nightly/` directory is **separate** from existing `tests/e2e/*.spec.ts`. The legacy specs stay for ad-hoc dev runs; nightly is purely additive — nothing is moved or rewritten.

Each phase is independently runnable so that on-call can iterate locally on just the failing phase: `npx playwright test --grep @phase3-expenses`.

## 4. The e2e user

```
email:    e2e@agentbook.test
password: e2e-nightly-2026
userId:   <fixed UUID, baked into seed script and CHAT_TO_TENANT_FALLBACK>
chatId:   555555555    (added to CHAT_TO_TENANT_FALLBACK alongside Maya's 5336658682)
```

Fixed UUID is critical — the Telegram chat-id-to-tenant fallback table needs a constant target so bot tests can resolve without DB writes per run.

### 4.1 Seed script (`scripts/seed-e2e-user.ts`)

Idempotent. Operations:

1. Upsert `User` with the fixed UUID.
2. Upsert `AbTenantConfig`: jurisdiction `us`, timezone `America/New_York`, `dailyDigestEnabled: true`.
3. **Wipe** all owned data: `AbExpense`, `AbInvoice`, `AbInvoiceLine`, `AbClient`, `AbPayment`, `AbAccount`, `AbJournalEntry`, `AbJournalLine`, `AbConversation`, `AbAgentSession`, `AbScheduledAlert`, `AbCalendarEvent` where `tenantId == e2e_user_id`.
4. Re-seed deterministic fixtures:
   - 3 clients (Acme, Beta, Gamma)
   - 5 expenses across last 30 days, 1 missing receipt
   - 4 invoices: 1 draft, 1 sent (due 7d), 1 sent-overdue (sent 45d ago), 1 paid
   - Default chart of accounts
   - Opening journal entry: $5,000 cash on hand

The script uses individual upserts (not a single transaction) so partial failure leaves a recoverable state for the next run to clean up.

### 4.2 Internal reset endpoint

`POST /api/v1/__test/reset-e2e-user` is gated by `process.env.E2E_RESET_TOKEN === request.headers['x-e2e-reset-token']`. Returns 404 in any environment where the token is unset, so production-like configs without the secret are safe.

### 4.3 Why nightly hits the production DB

The seed only ever queries/mutates rows scoped to the e2e_user_id UUID. No production user data is touched. This is intentional — running against production exercises the real Vercel runtime, the real Neon DB, and the real Vercel function bundles.

## 5. Test phases

### Phase 1 — Auth & shell (~6 tests)
- Login with valid creds → lands on `/dashboard`, session cookie set
- Login with bad password → error shown, stays on `/login`
- Authenticated visit to `/agentbook` resolves the right tenant (assert `dashboard/overview` returns the e2e user's data, not "default")
- Logout clears cookie
- Direct visit to `/agentbook/tax` while unauthenticated → redirected to `/login`
- Refresh after login keeps session

### Phase 2 — Dashboard (~12 tests)
- `/agentbook` renders ForwardView with non-zero cash (the seeded $5,000)
- Attention panel shows the seeded overdue invoice and missing-receipt callout
- Agent summary line is non-empty (LLM or deterministic fallback — accept either)
- This-month strip shows three numbers, deltas computed
- Activity feed shows ≥3 mixed items
- Sticky bottom bar visible at 375×812 viewport
- Sticky bar hidden at 1280×800 viewport (header buttons visible)
- "New invoice" action routes correctly
- "Snap" action triggers a hidden file input with `capture="environment"`
- Kebab menu opens with Refresh / Share to Telegram / Connect Telegram hint
- Pull-to-refresh fires a refetch (overview endpoint hit twice)
- Brand-new-tenant view *not* shown (proves seed worked)

### Phase 3 — Expenses (~18 tests)
- List, filter by category, filter by date range
- Create via form → appears in list, journal entry posted
- Snap receipt — drive a fake file via `setInputFiles`, assert upload + creation
- Edit (description, amount, category, personal flag)
- Mark personal → disappears from business list
- Missing-receipt expenses surface in attention panel after refresh
- Categorize via auto-suggest endpoint
- Split across two categories
- Delete — gone from list, journal entry reversed
- AI advisor: `POST /agentbook-expense/advisor/ask` returns non-empty answer
- Plaid sandbox link (sandbox creds `user_good`/`pass_good`) → accounts appear
- Auto-record from bank pattern (seed pattern, simulate bank txn, assert auto-categorized)
- Receipt OCR mock — POST a tiny image, assert OCR endpoint returns parsed fields
- Expense report PDF download
- Recurring expenses created on schedule
- Vendor insights aggregate
- Budget tracking: set budget, post expense over threshold, verify alert

### Phase 4 — Invoicing (~22 tests)
- Clients: list, create, edit, delete (4)
- Invoices: list, create single-line, create multi-line, send (4)
- Mark paid → AR balance updates, journal entry recorded
- Void → status updated, reversing entry posted
- Stripe payment link in mock mode (no `STRIPE_SECRET_KEY` → mock URL)
- Aging buckets (current / 30 / 60 / 90+) match seeded data
- Recurring invoice: template + run generator (2)
- Convert estimate → invoice
- Credit note against paid invoice → AR adjusts
- Time entries: start/stop timer (2)
- Unbilled time → invoice generation
- Project profitability report
- Auto payment reminder cron sends, log row created
- Invoice PDF download

### Phase 5 — Tax & reports (~15 tests)
- `tax/estimate` returns non-zero numbers given seeded data
- Quarterly tax estimate (4 quarters listed)
- Record quarterly payment → tax dashboard updates
- Deductions list & toggle deductible flag
- P&L for current month, last month, YTD
- Balance sheet: assets = liabilities + equity (foundational accounting check)
- Cashflow projection (30-day) returns 30 entries
- Trial balance balanced
- AR aging detail
- Earnings projection
- Tax form seeding (Canadian forms): `POST /tax-forms/seed`
- Tax filing: populate, validate, export
- Tax slip OCR (mock image upload)
- WhatIf simulator: `POST /tax/whatif` with hypothetical
- Tax filing PDF generation

### Phase 6 — Telegram bot (~14 tests)
Each test uses the `postUpdate(text)` helper from §6 below:

- `postUpdate('hello')` — webhook returns 200, agent brain replies
- `/start` command → onboarding response
- `record-expense`: "spent $25 at Uber" → expense created, journal entry posted
- `query-finance`: "what's my balance?" → response includes the seeded $5,000
- `query-expenses`: "expenses this month" → returns category breakdown
- `create-invoice`: "send invoice Acme $500 for consulting" → draft created
- `simulate-scenario`: "what if I hire at $5K/mo" → numeric response
- `proactive-alerts`: pending alert exists → bot acknowledges
- Multi-step plan: "review my invoices" → plan with steps + Proceed/Cancel buttons
- Confirm action: send "yes" to a pending plan → executes
- Cancel action: send "cancel" to a pending plan → cleared
- Correction flow: agent miscategorizes → "no, that should be Travel" → memory updated
- Receipt photo: simulate Update with `photo` field → OCR triggers
- Unknown chat ID returns `unmapped:<id>` (asserts no-pollution guarantee)

### Phase 7 — Cron + agent summary cache (~6 tests)
- POST to `/api/v1/agentbook/cron/morning-digest` with `Authorization: Bearer ${CRON_SECRET}` → 200, message composed for the e2e user
- Same endpoint without secret → 401
- Local-hour gate: when test forces non-7am UTC for the e2e tenant timezone, no message sent
- `dashboard/agent-summary` first call hits LLM (or fallback), second call within 15min returns identical `generatedAt` (cache hit)
- Force `Date.now()` past TTL → next call is a cache miss
- Recurring outflow detector returns expected vendors after seed creates 3 monthly Uber expenses

## 6. Telegram bot mock helper

### 6.1 `helpers/telegram.ts`

```ts
const E2E_CHAT_ID = 555555555;

interface UpdateOptions {
  chatId?: number;
  photo?: { fileId: string; caption?: string };
  callbackData?: string;
}

export async function postUpdate(
  text: string,
  options: UpdateOptions = {}
): Promise<{ status: number; reply?: string; data: any }> {
  const update = {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      date: Math.floor(Date.now() / 1000),
      chat: { id: options.chatId ?? E2E_CHAT_ID, type: 'private' },
      from: { id: options.chatId ?? E2E_CHAT_ID, is_bot: false, first_name: 'E2E' },
      ...(options.photo
        ? { photo: [{ file_id: options.photo.fileId, file_size: 1000, width: 100, height: 100 }],
            caption: options.photo.caption }
        : { text }),
    },
    ...(options.callbackData
      ? { callback_query: {
            id: String(Math.random()),
            from: { id: options.chatId ?? E2E_CHAT_ID, is_bot: false, first_name: 'E2E' },
            data: options.callbackData,
            message: { message_id: 0, chat: { id: options.chatId ?? E2E_CHAT_ID, type: 'private' } },
          } }
      : {}),
  };

  const res = await fetch(`${process.env.E2E_BASE_URL}/api/v1/agentbook/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(update),
  });

  const data = await res.json().catch(() => ({}));
  return { status: res.status, reply: data?.botReply, data };
}

export const E2E_CHAT = { id: E2E_CHAT_ID };
```

### 6.2 Telegram outbound stub

When `process.env.E2E_TELEGRAM_CAPTURE === '1'`, the webhook returns the would-be `bot.api.sendMessage` payload in its response body's `botReply` field instead of forwarding to Telegram. Tests inspect `result.reply`. Production behavior unchanged when the env var is unset.

This is a 5-line change in `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` — adds a branch around the final `bot.api.sendMessage(...)` call.

### 6.3 Photo & file uploads

Simulated via Telegram `file_id` in the Update. The webhook's `bot.api.getFile`/`getFileLink` paths are stubbed (when `E2E_TELEGRAM_CAPTURE === '1'`) to return a fixture image URL the OCR pipeline can fetch.

### 6.4 Chat-id mapping

`555555555` is added to `CHAT_TO_TENANT_FALLBACK` in `webhook/route.ts` alongside Maya's existing entry — production behavior unchanged.

## 7. GHA workflow

### 7.1 `.github/workflows/nightly-e2e.yml`

```yaml
name: Nightly E2E

on:
  schedule:
    - cron: '0 7 * * *'           # 07:00 UTC = 02:00 EST / 03:00 EDT
  workflow_dispatch:

concurrency:
  group: nightly-e2e
  cancel-in-progress: false

jobs:
  e2e:
    name: Phase ${{ matrix.phase }}
    runs-on: ubuntu-latest
    timeout-minutes: 25
    strategy:
      fail-fast: false
      matrix:
        phase:
          - phase1-auth
          - phase2-dashboard
          - phase3-expenses
          - phase4-invoicing
          - phase5-tax-reports
          - phase6-telegram-bot
          - phase7-cron-and-cache
    env:
      E2E_BASE_URL: https://a3book.brainliber.com
      E2E_USER_EMAIL: e2e@agentbook.test
      E2E_USER_PASSWORD: ${{ secrets.E2E_USER_PASSWORD }}
      E2E_RESET_TOKEN: ${{ secrets.E2E_RESET_TOKEN }}
      CRON_SECRET: ${{ secrets.CRON_SECRET }}
      E2E_TELEGRAM_CAPTURE: '1'
      DATABASE_URL: ${{ secrets.E2E_DATABASE_URL }}
      DATABASE_URL_UNPOOLED: ${{ secrets.E2E_DATABASE_URL_UNPOOLED }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - run: npm ci --prefer-offline --no-audit
      - run: npx playwright install --with-deps chromium
      - name: Reset E2E user data
        if: matrix.phase == 'phase1-auth'
        run: npx tsx scripts/seed-e2e-user.ts
      - run: npx playwright test --config=tests/e2e/nightly/playwright.config.ts --grep "@${{ matrix.phase }}"
      - if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: trace-${{ matrix.phase }}
          path: tests/e2e/nightly/playwright-report/
          retention-days: 7

  notify:
    name: Triage failures
    runs-on: ubuntu-latest
    needs: e2e
    if: always() && github.event_name == 'schedule'
    steps:
      - uses: actions/github-script@v7
        with:
          script: |
            // 1. List jobs from this run
            const { data: { jobs } } = await github.rest.actions.listJobsForWorkflowRun({
              owner: context.repo.owner, repo: context.repo.repo, run_id: context.runId,
            });

            const phaseJobs = jobs.filter(j => j.name.startsWith('Phase '));
            const failedPhases = phaseJobs.filter(j => j.conclusion === 'failure').map(j => j.name.replace('Phase ', ''));
            const passedPhases = phaseJobs.filter(j => j.conclusion === 'success').map(j => j.name.replace('Phase ', ''));

            // 2. Auto-open / append to issue for each failed phase
            for (const phase of failedPhases) {
              const title = `[nightly-e2e] ${phase} failing`;
              const search = await github.rest.search.issuesAndPullRequests({
                q: `repo:${context.repo.owner}/${context.repo.repo} is:issue is:open label:nightly-fail in:title "${phase}"`,
              });
              const body = [
                `**Phase:** \`${phase}\``,
                `**Run:** ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
                `**Commit:** ${context.sha.slice(0,8)}`,
                `**Date:** ${new Date().toISOString()}`,
                `**Trace artifact:** trace-${phase} (download from run page)`,
              ].join('\n');
              if (search.data.total_count > 0) {
                await github.rest.issues.createComment({
                  owner: context.repo.owner, repo: context.repo.repo,
                  issue_number: search.data.items[0].number,
                  body: `Failure repeated:\n\n${body}`,
                });
              } else {
                await github.rest.issues.create({
                  owner: context.repo.owner, repo: context.repo.repo,
                  title, body, labels: ['nightly-fail', 'phase:' + phase],
                });
              }
            }

            // 3. Auto-close issues for phases that just passed
            for (const phase of passedPhases) {
              const search = await github.rest.search.issuesAndPullRequests({
                q: `repo:${context.repo.owner}/${context.repo.repo} is:issue is:open label:nightly-fail in:title "${phase}"`,
              });
              for (const issue of search.data.items) {
                await github.rest.issues.createComment({
                  owner: context.repo.owner, repo: context.repo.repo,
                  issue_number: issue.number,
                  body: `Auto-closed: phase passed in run ${context.runId}.`,
                });
                await github.rest.issues.update({
                  owner: context.repo.owner, repo: context.repo.repo,
                  issue_number: issue.number, state: 'closed',
                });
              }
            }
```

### 7.2 Required GitHub secrets

Set once in repo settings → Secrets and variables → Actions:

- `E2E_USER_PASSWORD` — `e2e-nightly-2026`
- `E2E_RESET_TOKEN` — random 32-char hex; protects the internal reset endpoint
- `CRON_SECRET` — already exists for the daily-pulse cron; reused
- `E2E_DATABASE_URL` / `E2E_DATABASE_URL_UNPOOLED` — same Neon DB the prod site uses

### 7.3 Required GitHub label

Pre-create once: `gh label create nightly-fail --color B60205 --description "Auto-opened by nightly-e2e workflow"`.

## 8. Failure modes & idempotency

| Failure | Behavior | Action |
|---|---|---|
| Production deploy broke a route | Phase X fails, issue auto-opens | Open trace artifact, fix, push, next night auto-closes |
| Seed script fails | Phase 1 fails on first test, downstream phases also fail | Issue body marks "seed failed" |
| Test flake (LLM/timing) | retries=2 → second run passes, no issue | None |
| LLM provider down | Tests assert "non-empty summary" not specific phrasing → still pass via fallback | None |
| Vercel rate limits | Helper sleeps 100ms between webhook POSTs | None |
| Stripe key set in env | Phase 4 payment-link test gates: skip if `STRIPE_SECRET_KEY` is set | None |
| Missing `nightly-fail` label | Issue creation 422s | Pre-create as one-time setup |

### 8.1 Idempotency rules

1. Read assertions are exact (e.g., "5 expenses exist after seed").
2. Write assertions are relative ("count increased by 1") — never absolute counts after a write.
3. Each mutating test posts a teardown to delete its own creations. Belt and suspenders on top of the per-night seed wipe.
4. No test depends on another test's mutations.

### 8.2 Playwright config

```ts
// tests/e2e/nightly/playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: '**/phase*.spec.ts',
  timeout: 30_000,
  retries: 2,
  workers: 4,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['junit', { outputFile: 'junit.xml' }],
  ],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://a3book.brainliber.com',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
});
```

### 8.3 Tag selection

Each phase file uses tag-based selection rather than file-path matching:

```ts
test.describe('@phase3-expenses', () => {
  test('list expenses', async ({ page }) => { /* ... */ });
});
```

GHA `--grep "@${{ matrix.phase }}"` picks tests by tag. Tests can be moved between files without breaking the matrix.

## 9. On-call runbook

When a `nightly-fail` issue opens:

1. Click the run URL in the issue body → GHA run page.
2. Find the failed matrix job → "Failed test" annotations show which `it()` blocks failed.
3. Download the `trace-${phase}` artifact, open with `npx playwright show-trace trace.zip`.
4. Reproduce locally:
   ```bash
   E2E_BASE_URL=https://a3book.brainliber.com npx playwright test --grep "name of failing test"
   ```
5. Fix forward, push to main, wait for next night (or trigger workflow manually via Actions tab → Nightly E2E → Run workflow).

## 10. Out of scope (V2+)

- Browser cross-version testing (just chromium in V1)
- Visual regression / screenshot diffing
- Performance budgets / Lighthouse runs
- Multi-region testing (just `iad1` Vercel deployment)
- Slack notifications layered on top of GitHub issues
- Generated test report dashboards beyond Playwright HTML report

## 11. Open follow-ups

- The `E2E_TELEGRAM_CAPTURE` env-gated branch in `webhook/route.ts` is mentioned but not yet written; first task in the implementation plan.
- The fixed UUID for the e2e user must be generated and baked into both `seed-e2e-user.ts` and `CHAT_TO_TENANT_FALLBACK`. Generate at plan-time.
- Plaid sandbox in Phase 3: known external dependency; if it becomes a flake source, the test gets `test.skip` until we add a Plaid mock.
