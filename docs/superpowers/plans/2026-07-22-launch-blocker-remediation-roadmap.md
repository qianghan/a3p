# AgentBook Launch-Blocker Remediation Roadmap (PR Cycle Plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute each PR. Each PR gets its own bite-sized implementation plan (via superpowers:writing-plans) generated immediately before it is executed — this document sequences and scopes those per-PR plans, matching the process used for `2026-07-16-launch-gap-closure-roadmap.md` and `2026-07-18-agentbook-us-ca-au-launch-ready-roadmap.md`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every open Critical/High/Medium launch blocker from the 2026-07-22 launch-readiness re-audit (artifact `6d58fd76`) so AgentBook is genuinely launch-ready in the US, Canada, and Australia — building the three large product/compliance features fully (STP, BAS/GST-HST returns, French UI), and deferring only the external activation/accreditation steps to a how-to guide.

**Architecture:** Three execution waves against the existing plugin/jurisdiction architecture (`packages/agentbook-jurisdictions`, `plugins/agentbook-*`, `apps/web-next`). No new abstraction layer. Wave 1 = fast code-correctness fixes; Wave 2 = the three built-fully product features; Wave 3 = the external activation guide (user-owned). Every code fix wires or extends an existing engine; every feature reuses the established per-jurisdiction pack + Next.js route + Vitest test pattern.

**Tech Stack:** Next.js 15 (`apps/web-next`), Express plugin backends, Prisma/Supabase Postgres, Stripe, Plaid + Basiq, Gemini LLM, Vitest, Playwright.

## Global Constraints

- **Decisions locked with the user (2026-07-22):** build STP / BAS+GST-HST / French **fully in code**; **merge + deploy each PR to prod**. Production DB migrations, live Stripe/Basiq/ATO/CRA credentials, and customer comms remain **separate, explicitly-confirmed steps** (Wave 3 how-to guide).
- **The code half of STP/BAS is buildable; the transmission half is not.** Real lodgment to the ATO (SBR2/AS4 + software-provider accreditation) and CRA (NETFILE/myTax annual certification) requires external accreditation that only the business can obtain. Every such feature ships with a working computation + prep/export + a `LodgmentTransport` interface whose real transport is gated behind a credential/accreditation flag; the accreditation steps live in Wave 3, alongside Stripe and Basiq.
- **Never mutate the shared main checkout** ([[feedback_never_mutate_main_checkout]]). All work in dedicated worktrees; new worktrees need `npm install` (no `--workspaces=false`) before symlinks resolve ([[feedback_worktree_npm_install_needed]]).
- **Never push directly to `main`** ([[feedback_never_direct_push_main]]). Every PR — even one-line fixes — goes through a real PR + full CI, then merge (never `--admin`).
- **Verify against `origin/main`, not the local checkout** (it drifts hundreds of commits — [[feedback_never_mutate_main_checkout]]).
- **Test the API client / route logic, not just pages** ([[feedback_test_the_api_client_not_just_pages]]); prod uses Next.js route handlers, not the Express backends ([[project_agentbook_phase_workflow]]) — every user-facing fix must land in the Next.js path.
- **Deploy prebuilt** ([[feedback_vercel_prebuilt]]); verify `.vercel/project.json` says `a3p-plugin-build` before deploy ([[feedback_vercel_project_link_check]]); rebuild + **commit** plugin UMD bundles when a plugin frontend changes ([[feedback_plugin_frontend_deploy]]).
- **Each PR: worktree → per-PR plan → SDD (implementer + reviewer per task) → whole-branch review on the most capable model → PR → CI → merge → build + deploy → live verification** (e2e against agentbook.brainliber.com per [[project_agentbook_e2e_prod]]).

## Severity / Gate Taxonomy

Reuses the 2026-07-18 roadmap's taxonomy: **Critical** (wrong money / broken flow / structural absence), **High** (materially incomplete or misleading real output), **Medium** (real quality/competitiveness gap) all block a phase; **Low** is logged. After each wave, a **GATE** re-audit re-reads the touched code in `origin/main` to confirm each fix is live and actually closes its gap.

---

# Wave 1 — Fast Code-Correctness Fixes

**Why first:** these are the smallest-blast-radius, highest-confidence fixes; they wire existing engines into paths that bypass them and unblock CA payroll correctness + CA/AU chat/email truth without any external dependency. Landing them first also de-risks Wave 2 (French/BAS build on correct currency + jurisdiction plumbing).

### PR-1 (Critical → CA): CA/Quebec payroll provincial income-tax withholding

**Closes:** C2. **Files:** Modify `apps/web-next/src/lib/payroll-engine.ts:155-161` (`calcCA`); `apps/web-next/src/lib/year-end-forms.ts:57,77` (T4 box 22 / withheld). Reuse `packages/agentbook-jurisdictions/src/ca/tax-brackets.ts` (`getCaTax(income, {region})` already combines federal + provincial). Test: `apps/web-next/src/__tests__/lib/payroll-engine.test.ts` (create if absent).

**Approach:** `calcCA` must compute provincial income tax for the pay-run's province (annualize gross → `getCaTax` federal+provincial → subtract the federal-only figure to isolate the provincial portion, or return the combined figure directly and stop double-subtracting) and populate `stateTaxCents` with the provincial withholding (per-period). T4 `box22IncomeTaxDeductedCents` = federal + provincial; `stateTaxWithheldCents` = provincial.

**Acceptance:** ON employee at a realistic salary shows non-zero provincial tax in net pay and T4 box 22 = fed+prov; QC uses QC brackets; a unit test asserts the provincial component for ON and QC against hand-computed values; net-pay never exceeds gross minus (fed+prov+CPP/EI).

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-2 (Critical + High + Medium → AU): Telegram jurisdiction & currency correctness

**Closes:** C3, H5, M3. **Files:** Modify `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts` — `callMinimalAgent` tax math (:1288-1294), `renderTaxPackageStepResult` form name + money (:1971-1974), mileage `rateLabel` (:1826), `fmtUsd`/tax-estimate currency (:128-129,1294). Reuse `packages/agentbook-jurisdictions` bracket/SE providers and `apps/web-next/src/lib/jurisdiction-currency.ts` (`formatCurrencyCents`).

**Approach:** replace the hardcoded US SE/FICA math in the fallback path with the same per-jurisdiction bracket + SE calculators the web/chat scenario paths now use (mirror `scenario/route.ts`); derive form name from a jurisdiction→form map (`us:Schedule C, ca:T2125, au:individual tax return / business schedule, uk:Self Assessment`); replace `fmtUsd` with `formatCurrencyCents(cents, tenantCurrency)`; label mileage rate by jurisdiction agency (`us:IRS, ca:CRA, au:ATO`).

**Acceptance:** AU/UK tenant tax estimate in Telegram shows correct SE/income math and currency; tax package titled with the correct form; mileage labeled ATO/CRA appropriately; no bare `$` for CAD/AUD/GBP. Unit tests over the render helpers per jurisdiction.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-3 (High + Medium → CA/AU): Jurisdiction-aware digest tax tips + currency

**Closes:** H6, M4. **Files:** Modify `apps/web-next/src/lib/agentbook-digest-tips.ts:300-322` (`generateTaxTipDeterministic`), `:211` (`fmtUsd`); `apps/web-next/src/lib/agentbook-digest-builder.ts:372` (`fmtMoney`). Reuse jurisdiction packs for per-country tip copy + `formatCurrencyCents`.

**Approach:** branch tip content on tenant jurisdiction — US (Schedule C / IRS / SE-tax), CA (T2125 / CRA / GST-HST set-aside), AU (business schedule / ATO / GST + super), with a neutral fallback; thread real currency into all money helpers.

**Acceptance:** a CA and an AU tenant receive jurisdiction-correct tax tips and native-currency amounts in the morning digest; unit tests assert no US-specific string leaks to CA/AU and no bare `$`.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-4 (High + Medium → CA/AU): Core chat inline currency formatters

**Closes:** H7, M7. **Files:** Modify `plugins/agentbook-core/backend/src/server.ts:5124` (expense-query block), `:5276` (cashflow-report), and the `/ask` handler `:1315-1452`; use the existing currency-aware `fmtCurrency(cents, data.currency)` at `:229`. First **confirm `/ask` prod reachability** (resolve M7's uncertainty) — check whether `AGENTBOOK_CORE_URL` self-call renders in prod; if reachable, fix; if dead, remove/deprecate the dead path and note it.

**Approach:** replace every hardcoded `` `$${…}` `` / `toLocaleString('en-US')` in these handlers with `fmtCurrency(cents, data.currency)`. Rebuild is Express-backend only, but the prod chat path imports `executeClassification` from this file — verify via the `agent/message/route.ts` path.

**Acceptance:** "how much did I spend" and 30/60/90-day cashflow replies show native currency for CA/AU tenants; unit test over the two handlers with a CAD tenant fixture.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-5 (High → AU): Gate the contractor-reporting route to supported jurisdictions

**Closes:** H1. **Files:** Modify `apps/web-next/src/app/api/v1/agentbook-tax/reports/contractor-1099/route.ts:29` (JSON route — currently ungated); align with the CA-gated PDF sibling. Optionally harden `packages/agentbook-framework/.../contractor-reporting/handler.ts:24-25` to throw on unsupported jurisdiction rather than silently defaulting to US.

**Approach:** the JSON route returns 422 `unsupported_jurisdiction` for anything other than US (1099-NEC) and CA (T4A), mirroring the PDF route; the handler no longer emits a US form for AU/UK.

**Acceptance:** an AU/UK tenant hitting the contractor-1099 route gets a clear 422, not a US 1099-NEC; US and CA behavior unchanged; unit test per jurisdiction.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-6 (Medium → all): Add-on subscribe derives region from tenant, not client

**Closes:** M1. **Files:** Modify `apps/web-next/src/app/api/v1/agentbook-billing/me/addons/[code]/subscribe/route.ts:11,26` — read region from `AbTenantConfig.jurisdiction` (as the add-ons GET route does), ignore/validate the body `region`.

**Acceptance:** a request that passes a mismatched `region` is priced off the tenant's real jurisdiction (or 422s); unit test with a crafted cross-region body.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-7 (Medium → US/CA): Normalize + validate tenant region to a 2-letter code

**Closes:** M2. **Files:** Modify `apps/web-next/src/app/api/v1/agentbook-core/tenant-config/route.ts:113,206` — normalize `region` (full-name → code map for US states + CA provinces, uppercase) and reject unknown values with 422. Add a shared `normalizeRegionCode(jurisdiction, region)` helper in `apps/web-next/src/lib/jurisdiction-currency.ts` (or a sibling).

**Acceptance:** storing "Ontario"/"California" persists "ON"/"CA" and taxes correctly; an unrecognized region 422s; unit tests over the normalizer.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-8 (Medium → AU): AU tax-invoice ABN / GST-registration fields

**Closes:** M5. **Files:** Modify invoice settings (business profile: add `abn` / `gstRegistrationNumber` fields — schema `AbTenantConfig` or business-profile model), the invoice PDF (`apps/web-next/src/lib/agentbook-invoice-pdf.ts`) and on-screen invoice to render "ABN: …" and "Tax Invoice" header for AU when GST applies. **Requires a schema field** → prod migration deferred to a confirmed step.

**Acceptance:** an AU invoice above threshold renders "Tax Invoice" + supplier ABN; non-AU unaffected; unit/render test.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-9 (Medium → all, infra): Un-mask CI test failures + raise audit gate

**Closes:** M6. **Files:** Modify `.github/workflows/ci.yml:423-425` (remove `|| echo` masking on backend-tests; same on `plugin-tests:319`, `sdk-compat-matrix:283`), `:151` (`--audit-level=critical` → `high`). Fix or explicitly quarantine any suite that then legitimately fails (fix the test, don't re-skip).

**Acceptance:** a deliberately-failing backend test fails CI; the audit gate trips on a high vuln; document any triaged-and-accepted vulns with justification.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR W1-GATE: Wave-1 re-audit
Re-read every Wave-1-touched file in `origin/main`; confirm each of C2, C3, H1, H5, H6, H7, M1–M7 is closed by current code (not just "PR merged"). Any residual Critical/High/Medium → append a remediation PR and re-run.

---

# Wave 2 — Product / Compliance Features (Built Fully)

**Why second:** these are large, depend on the correct currency/jurisdiction plumbing landed in Wave 1, and each is independently shippable. Each builds the **full computation + prep/export + UI + a transport interface**; the accredited transmission is switched on in Wave 3.

### PR-10 (High → CA/QC): Full French internationalization (Bill 96)

**Closes:** H4. **Scope:** replace the single-key `t()` scaffold with a real i18n system covering the entire consumer-facing app — navigation, dashboard, expense/invoice/tax/payroll UI, settings, emails, error/toast copy — with a complete `fr` catalog and a locale switch honoring tenant/browser locale; Quebec tenants default to `fr`. **Files:** `apps/web-next/src/lib/i18n/*`, `messages/{en,fr}.json`, every page/component using literal copy, plugin frontends (rebuild + commit UMD bundles). **Approach:** adopt a proven i18n lib compatible with the Next.js App Router (evaluate `next-intl`); extract strings to keys programmatically; professional-quality FR translation reviewed for Quebec French + tax terminology (TPS/TVQ). Large — decompose into sub-PRs by surface (10a nav+dashboard, 10b expense+invoice, 10c tax+payroll, 10d settings+emails) if the single PR is unwieldy.

**Acceptance:** a Quebec tenant sees a fully French UI across all core flows; language toggle works; no untranslated key leaks; existing English behavior unchanged; e2e in both locales.

- [ ] Per-PR plan (likely split 10a–10d) → SDD → review → PR → CI → merge → deploy → verify

### PR-11 (High → CA): GST/HST net-payable return — computation + prep + transport interface

**Closes:** H3 (CA half). **Scope:** compute the GST/HST return (line 101 sales, 103/105 collected, 106/108 ITCs, 109 net tax) from ledger data for the filing period; render a return summary + downloadable working papers; a `CraLodgmentTransport` interface with a `manual` implementation (export + CRA portal deep-link) and a `netfile` implementation stubbed behind an accreditation flag. **Files:** `packages/agentbook-jurisdictions/src/ca/gst-hst-return.ts` (new), `apps/web-next/src/app/api/v1/agentbook-tax/ca/gst-hst-return/route.ts` (new), UI in the tax plugin, tests. **Approach:** reuse invoice/expense tax data already captured; no new tax math beyond aggregation.

**Acceptance:** a CA tenant with invoices+expenses gets a correct net-tax figure and working papers for a chosen period; NETFILE transport present but inert until Wave 3; unit tests over the aggregation against fixtures.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-12 (High → AU): BAS worksheet — computation + prep + transport interface

**Closes:** H3 (AU half). **Scope:** compute BAS labels (G1 total sales, 1A GST on sales, 1B GST on purchases, PAYG-W W1/W2 where payroll exists) for the reporting period; render the BAS summary + working papers; an `AtoLodgmentTransport` interface with `manual` (export + ATO portal link) and `sbr` (stubbed behind accreditation). **Files:** `packages/agentbook-jurisdictions/src/au/bas-return.ts` (new), `apps/web-next/src/app/api/v1/agentbook-tax/au/bas-return/route.ts` (new), tax-plugin UI, tests.

**Acceptance:** an AU tenant gets correct G1/1A/1B (and W1/W2 if payroll) for a quarter; SBR transport inert until Wave 3; unit tests against fixtures.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR-13 (High → AU): Single Touch Payroll pay-event — payload builder + transport interface + UI

**Closes:** H2. **Scope:** build the STP Phase 2 pay-event data model from each pay run (employee YTD gross, PAYG-W, super, disaggregated components), a pay-event payload builder, an `StpTransport` interface (`manual`/`export` now, `sbr` stubbed behind accreditation), and a payroll UI action "Prepare STP pay event." Replace the "we don't lodge STP" disclosure with an accurate capability + a clear "lodgment requires ATO accreditation (see setup)" state. **Files:** `packages/agentbook-jurisdictions/src/au/stp-pay-event.ts` (new), `apps/web-next/src/app/api/v1/agentbook-payroll/au/stp/route.ts` (new), payroll UI, update `plugins/agentbook-core/backend/src/server.ts:4318-4321` disclosure, tests.

**Acceptance:** an AU pay run produces a valid STP pay-event structure + export; UI reflects prepared-but-not-lodged state honestly; SBR transport inert until Wave 3; unit tests over the payload builder.

- [ ] Per-PR plan → SDD → review → PR → CI → merge → deploy → verify

### PR W2-GATE: Wave-2 re-audit
Re-read Wave-2 features in `origin/main`; confirm H2, H3, H4 are code-complete and honestly disclosed (transport-gated, not silently broken). Competitive refresh + SWOT per market.

---

# Wave 3 — External Activation (User-Owned — see the How-To Guide)

**Not code** — these are the deferred activation/accreditation steps. Each is documented step-by-step in `docs/LAUNCH-ACTIVATION-GUIDE.md` (written as the final deliverable). Nothing here is merged as a code PR; each is an explicit, separately-confirmed operational action:

1. **Stripe (C1):** create live Products/Prices for all plans + add-ons in USD/CAD/AUD; backfill `stripePriceId`; run the `BillPlan.region` prod migration; verify checkout end-to-end.
2. **Basiq (H8):** provision `BASIQ_API_KEY`, complete CDR production accreditation, verify AU bank sync end-to-end.
3. **ATO STP + BAS (H2/H3-AU):** obtain SBR2 software-provider accreditation + AS4 gateway credentials; enable the `sbr` transport flag.
4. **CRA GST/HST (H3-CA):** complete NETFILE/myTax certification (annual); enable the `netfile` transport flag.
5. **Prod DB migrations:** for PR-8 (ABN fields) and any Wave-2 schema additions — run `prisma db push` against production as a confirmed step.

### Final Sign-off
Once Waves 1–2 are merged+deployed and all three GATEs are clean, re-run the full US/CA/AU launch-readiness assessment (reuse the HTML-artifact pattern) and update [[project_agentbook_launch_readiness_2026_07_22]]. Launch remains gated on the Wave-3 activation steps, which are the user's to execute with the guide.

## Self-Review

- **Coverage:** C1→Wave 3 guide; C2→PR-1; C3→PR-2; H1→PR-5; H2→PR-13+Wave3; H3→PR-11/12+Wave3; H4→PR-10; H5→PR-2; H6→PR-3; H7→PR-4; H8→Wave 3; M1→PR-6; M2→PR-7; M3→PR-2; M4→PR-3; M5→PR-8; M6→PR-9; M7→PR-4. All 3 Critical + 8 High + 7 Medium mapped.
- **No placeholders:** each PR names concrete files + acceptance; per-PR TDD-granular plans are generated at execution per this repo's documented pattern.
- **Consistency:** currency fixes all route through `formatCurrencyCents`/`fmtCurrency`; jurisdiction logic reuses `packages/agentbook-jurisdictions`; transports share the `*LodgmentTransport` shape.
