# AgentBook — Stripe + Plaid Sandbox Setup

Concrete steps to get billing (Stripe) and bank sync (Plaid) working against test sandboxes for local development and CI.

---

## Stripe — test mode

### 1. Create or use a Stripe account

1. Sign up at https://dashboard.stripe.com/register if you don't have an account.
2. After signup, the dashboard opens in **Test mode** (toggle top-right). Stay in test mode for the entire setup.

### 2. Get API keys

1. Go to https://dashboard.stripe.com/test/apikeys
2. Copy **Publishable key** (`pk_test_...`) and **Secret key** (`sk_test_...`).
3. Add to `apps/web-next/.env.local`:

    STRIPE_PUBLISHABLE_KEY=pk_test_xxxxx
    STRIPE_SECRET_KEY=sk_test_xxxxx

### 3. Webhook setup (local development)

Install the Stripe CLI:

    brew install stripe/stripe-cli/stripe   # macOS
    stripe login                             # opens browser, links CLI to test mode

Forward webhook events to your local server:

    stripe listen --forward-to localhost:3000/api/v1/agentbook/stripe-webhook

The CLI prints a **webhook signing secret** like `whsec_xxxxx`. Copy it:

    # in apps/web-next/.env.local
    STRIPE_WEBHOOK_SECRET=whsec_xxxxx

Keep `stripe listen` running in a separate terminal during development.

### 4. Create test plans

Option A — via dashboard:
1. Go to https://dashboard.stripe.com/test/products
2. Create a product (e.g., "AgentBook Pro"), add a recurring price ($19/mo), copy the `price_id` (starts with `price_`).
3. Repeat for any other tiers.
4. In AgentBook admin (`/admin/billing/plans`), create a plan that references the `price_id`.

Option B — via API (faster for CI):

    stripe products create --name "AgentBook Pro" --description "Pro plan"
    # Note the product ID, then:
    stripe prices create --product prod_xxx --currency usd --unit-amount 1900 --recurring interval=month

### 5. Test card numbers

| Card | Behavior |
|------|----------|
| `4242 4242 4242 4242` | Always succeeds |
| `4000 0000 0000 0002` | Always declined (`card_declined`) |
| `4000 0025 0000 3155` | Requires 3DS authentication |
| `4000 0000 0000 9995` | Insufficient funds |
| `4000 0000 0000 0341` | Attaches to customer but charge fails |

Use any future expiry (`12/34`), any 3-digit CVC, any postal code.

### 6. Smoke test — subscription flow

Start dev server (in one terminal), `stripe listen` (in another):

    cd apps/web-next && NODE_OPTIONS="--max-old-space-size=4096" npm run dev

In a third terminal:

    # Login as Maya
    TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
      -H "Content-Type: application/json" \
      -d '{"email":"maya@agentbook.test","password":"agentbook123"}' | jq -r .token)

    # Hit a billing endpoint
    curl -s http://localhost:3000/api/v1/agentbook-billing/plans \
      -H "Authorization: Bearer $TOKEN" | jq .

Then open `/billing` in the browser, pick a plan, use card `4242 4242 4242 4242`. Watch `stripe listen` for the event sequence (`invoice.created` → `payment_intent.succeeded` → `customer.subscription.created`).

Verify `BillSub` row exists:

    docker compose exec database psql -U postgres -d naap -c "SELECT id, status, planId FROM \"BillSub\" WHERE userId = (SELECT id FROM \"User\" WHERE email='maya@agentbook.test');"

### 7. Invoice + refund test

    # Trigger a one-off invoice
    stripe invoiceitems create --customer cus_xxx --amount 5000 --currency usd
    stripe invoices create --customer cus_xxx --auto-advance
    # Note the invoice id (in_xxx), then:
    stripe invoices pay in_xxx
    # To refund:
    stripe charges list --limit 1
    stripe refunds create --charge ch_xxx

Verify webhook handler updated `BillEvent` rows.

### 8. Common errors and fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `No signatures found matching the expected signature` | Wrong `STRIPE_WEBHOOK_SECRET`, or middleware consumed raw body | Copy fresh secret from `stripe listen` output. Verify webhook route reads `req.body` as raw, not parsed. |
| `Invalid API Key provided` | Using live key in test mode (or vice versa) | Confirm key starts with `sk_test_`. |
| `Idempotency key was already used` | Replaying webhook | Webhook handler should be idempotent — check `BillEvent` for prior write before processing. |
| `Cannot apply mode_id...` | Created test data in different account | Use only one Stripe test account; if switched, recreate plans. |

---

## Plaid — sandbox mode

### 1. Credentials

Existing sandbox credentials (in `CLAUDE.md`):

    # apps/web-next/.env.local
    PLAID_CLIENT_ID=69d02fa4f1949b000dbfc51e
    PLAID_SECRET=59be40029c47288c4db4acfd79ae56
    PLAID_ENV=sandbox

> **Security note:** these are test credentials but they are checked into the repo's CLAUDE.md. Before any production / live integration, generate fresh credentials and store in a secret manager.

### 2. Test institutions

Plaid sandbox accepts these institution IDs:

| ID | Name | Use case |
|----|------|----------|
| `ins_109508` | First Platypus Bank | Happy path |
| `ins_109509` | Tartan Bank | OAuth flow |
| `ins_109511` | Houndstooth Bank | Returns `ITEM_LOGIN_REQUIRED` |
| `ins_43` | Tattersall Federal Credit Union | Microdeposit verification |

Test credentials for all sandbox institutions: username `user_good`, password `pass_good`.

For error simulations: username `user_custom` + a JSON config in password field — see https://plaid.com/docs/sandbox/test-credentials/

### 3. Smoke test — link + transactions

Start backend + frontend, login as Maya.

    TOKEN=$(curl -s -X POST http://localhost:3000/api/v1/auth/login \
      -H "Content-Type: application/json" \
      -d '{"email":"maya@agentbook.test","password":"agentbook123"}' | jq -r .token)

    curl -s -X POST http://localhost:3000/api/v1/agentbook-expense/plaid/link-token \
      -H "Authorization: Bearer $TOKEN" | jq .

Open Plaid Link in the browser flow at `/agentbook/expenses` → "Connect bank" → pick First Platypus Bank → use `user_good` / `pass_good` → select accounts → confirm.

Verify transactions sync:

    docker compose exec database psql -U postgres -d naap -c "SELECT COUNT(*) FROM \"Expense\" WHERE source='plaid';"

### 4. Simulating webhooks

Trigger a webhook manually via Plaid API:

    curl -X POST https://sandbox.plaid.com/sandbox/item/fire_webhook \
      -H "Content-Type: application/json" \
      -d "{
        \"client_id\": \"$PLAID_CLIENT_ID\",
        \"secret\": \"$PLAID_SECRET\",
        \"access_token\": \"<get from your linked item>\",
        \"webhook_code\": \"DEFAULT_UPDATE\"
      }"

Other useful webhook codes:
- `INITIAL_UPDATE` — fired after first transaction pull
- `HISTORICAL_UPDATE` — fired after backfill
- `TRANSACTIONS_REMOVED` — when a transaction is reversed
- `ITEM_LOGIN_REQUIRED` — when credentials need refresh
- `PENDING_EXPIRATION` — 7 days before access token expires

### 5. Reconnection flow (`ITEM_LOGIN_REQUIRED`)

When this fires, the user must re-authenticate:

1. Backend receives webhook, sets `Item.requiresReauth = true`.
2. Frontend on next `/agentbook/expenses` load sees flag, prompts "Reconnect your bank" → opens Plaid Link in **update mode** with the same `link_token`.
3. User re-enters credentials. Plaid issues a new access token (or refreshes the existing one).
4. Backend clears `requiresReauth`.

To simulate: link an item, then `sandbox/item/fire_webhook` with code `ITEM_LOGIN_REQUIRED`.

### 6. Multi-account handling

Sandbox banks return 5 accounts by default (checking, savings, credit card, IRA, 401k). Verify your reconciliation:
- Each `PlaidAccount` row has correct `type` (depository, credit, loan, investment)
- Only `depository` and `credit` accounts surface transactions for expense reconciliation
- Investment accounts surface in a separate tab (or excluded — depending on product scope)

### 7. Common errors and fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `INVALID_API_KEYS` | Wrong env (`production` vs `sandbox`) | Confirm `PLAID_ENV=sandbox`. |
| `ITEM_LOGIN_REQUIRED` arrives but user never sees prompt | Frontend not subscribed to item status | Poll `Item.requiresReauth` on dashboard load, OR push via WebSocket. |
| Transactions duplicated after re-sync | Reconciliation logic not idempotent | Use `transaction_id` (Plaid's stable ID) as upsert key. |
| Sandbox transactions look generic | Plaid sandbox returns canned data | Use `sandbox/transactions/fire_webhook` with custom transactions endpoint to inject specific test data. |

---

## CI integration

Add to your CI workflow (after Postgres is up):

    - name: Stripe webhook listener (background)
      run: |
        stripe listen --forward-to http://localhost:3000/api/v1/agentbook/stripe-webhook &
        echo "STRIPE_WEBHOOK_SECRET=$(stripe listen --print-secret)" >> $GITHUB_ENV

    - name: Run GTM tests
      env:
        STRIPE_SECRET_KEY: ${{ secrets.STRIPE_TEST_KEY }}
        PLAID_CLIENT_ID: ${{ secrets.PLAID_SANDBOX_CLIENT_ID }}
        PLAID_SECRET: ${{ secrets.PLAID_SANDBOX_SECRET }}
        PLAID_ENV: sandbox
      run: cd tests/e2e && npx playwright test gtm/ --config=playwright.config.ts

---

## Pre-production checklist

Before flipping to live mode:

- [ ] Rotate Stripe webhook signing secret
- [ ] Rotate Plaid sandbox credentials → production credentials
- [ ] Move secrets out of `.env.local` into Vercel env vars / secret manager
- [ ] Add IP allowlist on webhook endpoints (Stripe publishes ranges; Plaid does not — use signature verification)
- [ ] Set up Stripe Tax / regional VAT handling
- [ ] Configure Plaid OAuth redirect URI for production domain
- [ ] Test refund flow end-to-end in live mode with a real $1 charge
- [ ] Set up Stripe billing alerts (failed payments, churning subs)

---

## Known issues to validate during setup (from Phase 1 audit)

Cross-reference with `docs/superpowers/reports/2026-05-21-code-review.md` Stream A.2 and A.3 — the following blockers WILL surface during your smoke test if not fixed first:

1. **Stripe webhook signature verification missing** in `plugins/agentbook-{expense,invoice}/backend/src/server.ts` — these plugin handlers will accept your CLI-replayed events without signature, masking real webhook bugs. Use ONLY the Next.js app handler at `apps/web-next/src/app/api/v1/agentbook/stripe-webhook/route.ts` (verified correct).
2. **Tenant impersonation via `x-tenant-id` header** — if your smoke test scripts send tenant headers, they'll succeed regardless of auth. Validate billing flows with a real authenticated session, not synthetic headers.
3. **Plaid tokens in process-local Map** in expense plugin — a server restart between linking and syncing will fail. Test the full flow without restarting the backend.
