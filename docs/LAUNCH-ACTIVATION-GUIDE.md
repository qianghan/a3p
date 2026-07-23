# AgentBook Launch Activation Guide (The Last Step)

**Run this only after every code PR in `docs/superpowers/plans/2026-07-22-launch-blocker-remediation-roadmap.md` (Waves 1–2) is merged and deployed to production.** These are the external activation and accreditation steps that no code change can complete — they need live third-party credentials, government accreditation, or a production database migration, and each is an action **you** take (or explicitly authorize), not something the codebase can switch on for you.

Do them in the order below. Each step lists: what it unblocks, the prerequisite, the exact action, the environment variable(s) to set in Vercel, and how to verify it worked.

> **Security note:** never paste live secret keys into chat, commit them, or store them in the repo. Set them only in the Vercel project (`a3p-plugin-build`) environment settings. This guide names the variables; it never contains their values.

---

## Step 1 — Turn on Stripe billing (unblocks C1: all plan + add-on revenue, all markets)

**Why:** the billing UI, region-aware pricing, and endpoints are all built and deployed, but no live Stripe Price IDs are attached (`stripePriceId` is null everywhere), so every real subscribe attempt fails at the final step.

**Prerequisite:** a live-mode Stripe account with your business + tax details completed, and a live secret key (`sk_live_…`) or restricted key (`rk_live_…`) with Products/Prices write scope.

**Actions:**
1. In the Vercel project `a3p-plugin-build`, set (Production scope): `STRIPE_SECRET_KEY` = your `sk_live_…`, `STRIPE_WEBHOOK_SECRET` = the signing secret of the live webhook endpoint, and the publishable key `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` = `pk_live_…`.
2. Register the live webhook endpoint in Stripe → Developers → Webhooks, pointing at `https://agentbook.brainliber.com/api/v1/agentbook-billing/webhook`, subscribed to `customer.subscription.*`, `invoice.*`, and `checkout.session.*`. Copy its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Run the CAD core-plan activation script with the live key (creates Products/Prices and backfills `stripePriceId`):
   ```bash
   STRIPE_SECRET_KEY=<sk_live_...> npx tsx agentbook/activate-ca4-cad-pricing.ts
   ```
4. Create the **USD** and **AUD** core-plan Products/Prices. A USD activation script exists only for `pro_yearly` (`agentbook/create-pro-yearly-plan.ts`); for the rest, either run the equivalent activation for `region:'us'` and `region:'au'` (mirror the CA-4 script — the roadmap's PR-4a source-of-truth already has the amounts in `packages/agentbook-pricing/src/index.ts`), or create them once via the admin route `POST /api/v1/agentbook-billing/plans`.
5. Create Products/Prices for **every add-on** in every region+tier, then backfill each with:
   ```
   POST /api/v1/agentbook-billing/addons/{code}/prices/{priceId}
   ```
   (There is one row per region×tier — e.g. the startup add-on alone has 12. If this is tedious, script it against `ADDON_PRICES` in `packages/agentbook-pricing/src/index.ts`.)
6. Run the `BillPlan.region` production migration if it hasn't run yet (see Step 5).

**Verify:** `GET https://agentbook.brainliber.com/api/v1/agentbook-billing/addons` shows non-null `stripePriceId` on every price row; a real (or test-clock) subscribe to a Pro plan and to one add-on completes without the 400 "no Stripe price" error, in USD, CAD, and AUD.

---

## Step 2 — Turn on Basiq AU bank sync (unblocks H8: AU bank feeds)

**Why:** the full read-only Basiq flow (consent, callback, sync, disconnect, daily crons) is built and deployed as production routes, but with no API key it returns HTTP 500.

**Prerequisite:** a Basiq account. For production (real consumer bank data) Basiq requires **CDR (Consumer Data Right) accreditation** or use of Basiq as a CDR Representative/intermediary — confirm your model with Basiq before going live. The sandbox works immediately for end-to-end testing.

**Actions:**
1. In Basiq's dashboard, create an application and obtain the server API key.
2. In Vercel (`a3p-plugin-build`, Production), set `BASIQ_API_KEY` = your Basiq key. (Confirm the exact variable name against `apps/web-next/src/lib/agentbook-basiq.ts` `requireApiKey` at deploy time.)
3. Confirm the two daily sync crons are enabled in `apps/web-next/vercel.json` (business 06:15, personal 06:20) and that `CRON_SECRET` is set.
4. Redeploy so the new env var is picked up.

**Verify:** in the app, Settings → Bank connection → Connect (AU tenant) reaches the Basiq hosted-consent screen; after linking a sandbox bank, transactions appear and the matcher links them; the `status` route returns connected.

---

## Step 3 — Accredit ATO lodgment for STP + BAS (unblocks the transmission half of H2 & H3-AU)

**Why:** PR-13 (STP) and PR-12 (BAS) build the full pay-event / BAS computation, export, and a transport interface — but real lodgment to the ATO goes over Standard Business Reporting (SBR2) via an AS4/ebMS3 gateway and requires you to be (or use) an accredited software provider. Until then, the app produces correct, exportable returns and deep-links to the ATO portal for manual lodgment.

**Prerequisite:** ATO software-provider onboarding — a registered Software ID, machine credentials (Machine-to-Machine / cloud software authentication notification), and an SBR2 AS4 gateway (self-hosted or via a sending service provider such as Ozedi/SuperChoice for STP).

**Actions:**
1. Register as a Digital Service Provider with the ATO and complete the STP Phase 2 product onboarding / whitelisting for your Software ID.
2. Obtain machine credentials and configure the AS4 gateway endpoint + certificates.
3. Set the gateway credentials in Vercel as the variables the `sbr` transport reads (defined in `packages/agentbook-jurisdictions/src/au/*` transport config at build time), and flip the accreditation feature flag (e.g. `AU_STP_LODGMENT_ENABLED` / `AU_BAS_LODGMENT_ENABLED`) to `true`.
4. Run the ATO's conformance/whitelisting tests in their test environment before enabling in production.

**Verify:** a test pay run lodges an STP pay event successfully in the ATO test environment and returns a receipt; the app's payroll UI shows a "lodged" state with the ATO receipt ID instead of "prepared, lodgment requires setup."

---

## Step 4 — Certify CRA lodgment for GST/HST (unblocks the transmission half of H3-CA)

**Why:** PR-11 computes the GST/HST net-payable return and working papers and exposes a transport interface; actual electronic filing requires CRA certification.

**Prerequisite:** CRA software certification for the relevant service (GST/HST NETFILE, or My Business Account / Represent a Client integration). NETFILE certification is renewed each tax year.

**Actions:**
1. Enrol in the CRA's software certification program for GST/HST and pass the annual certification test suite.
2. Configure the CRA transmitter credentials in Vercel as the variables the `netfile` transport reads, and flip the flag (e.g. `CA_GSTHST_LODGMENT_ENABLED`) to `true`.
3. Re-certify each tax year.

**Verify:** a test GST/HST return transmits in the CRA test environment and returns a confirmation number; the CA tax UI shows a filed state with that number.

---

## Step 5 — Run production database migrations (supports PR-8 and any Wave-2 schema additions)

**Why:** PR-8 adds ABN / GST-registration fields; Wave-2 features may add tables/columns. These must exist in the production Supabase schema.

**Prerequisite:** confirm `.vercel/project.json` links to `a3p-plugin-build`, and that the `DATABASE_URL`/`DATABASE_URL_UNPOOLED` in scope point at the production Supabase instance (`vefoeskvxthrcnggjtlf`), **never** a legacy/naap endpoint.

**Action (explicitly confirm before running — this is a production write):**
```bash
cd packages/database
DATABASE_URL="<prod>" DATABASE_URL_UNPOOLED="<prod>" npx --no prisma db push --skip-generate
```
Review the diff prisma prints **before** accepting; never pass `--accept-data-loss` against production. Beware the deploy race that can drop new columns ([[feedback_vercel_deploy_race_and_db_push]]) — merge + deploy the schema change, then push, and re-verify columns exist after.

**Verify:** the new fields/tables are present in the production schema and the corresponding UI (AU invoice ABN, etc.) reads/writes them correctly.

---

## Final check — re-run the launch-readiness assessment

After Steps 1–5, re-run the full US/CA/AU launch-readiness assessment (the same HTML-artifact process as the 2026-07-22 audit). With all code PRs merged+deployed and all activations live, every Critical/High/Medium blocker should be closed. Record the clean gate and the go/no-go per market.
