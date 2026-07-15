# Tax Fast-Track AU Jurisdiction Support — Design Spec

## Goal

Add Australia as a third supported jurisdiction for the "tax fast-track" feature (questionnaire + auto-generated filing draft + client letter), alongside the existing `us` and `ca` support. **UK is explicitly out of scope** (per direct instruction) — and, as confirmed by exploration, there is no existing UK code anywhere in this feature to accidentally disturb.

## Background

Tax fast-track lets a user answer a short conversational questionnaire (chat or UI) and receive an AI-drafted filing summary + accountant cover letter, using last year's confirmed filing as a baseline. It was built jurisdiction-pluggable from the start (PR-3/PR-4): two small interfaces —`TaxQuestionnairePack` and `FilingDraftPack` — are implemented once per jurisdiction and looked up by two loader modules. `us` and `ca` are implemented; `au`/`uk` are currently explicitly excluded with a comment in both loaders.

AU already has substantial tax-domain groundwork elsewhere in the codebase (from earlier PRs): ATO 2024-25 individual tax brackets (`au/tax-brackets.ts`), Medicare Levy (`au/self-employment-tax.ts`), GST (`au/sales-tax.ts`), BAS/PAYG/super deadlines (`au/calendar-deadlines.ts`), and an `AuPastFilingPack` (income-statement/notice-of-assessment/PAYG-instalment forms) that fast-track's "prior filing" baseline already reads from. This PR is purely about plugging AU into the two fast-track-specific interfaces — it does not touch any of that existing AU groundwork.

Jurisdiction is never separately picked inside this feature: both entry points (chat and the UI's `/tax-fast-track/start` route) read `AbTenantConfig.jurisdiction` (the tenant's one configured jurisdiction, set on the Business Profile settings page) and gate on `listSupportedJurisdictions().includes(jurisdiction)`. So this PR needs no UI changes — once `au` is registered, any AU tenant's fast-track requests are simply no longer blocked.

## Non-Goals

- No UK support (explicit instruction).
- No changes to `us`/`ca` packs, to `AuPastFilingPack`, or to any of the existing AU jurisdiction-pack modules (brackets, Medicare Levy, GST, deadlines) — this PR only *consumes* `auTaxBrackets`, it does not modify it.
- No jurisdiction-picker UI — none exists today for this feature, and none is needed (confirmed: `FastTrackTab.tsx` has no jurisdiction selector; it just displays whatever the backend allows or blocks).
- No changes to PDF rendering (`tax-fast-track-pdf.ts` is already jurisdiction-agnostic — it just uppercases the jurisdiction string for display).
- No changes to the questionnaire *engine* (`tax-questionnaire-core.ts`, `agent-brain.ts`'s Step 1c, the HTTP routes) — they are already fully jurisdiction-generic; they call `getTaxQuestionnairePack(jurisdiction)`/`getFilingDraftPack(jurisdiction)` and work for any registered jurisdiction with zero changes.

## Design

### New files

- `packages/agentbook-jurisdictions/src/au/tax-questionnaire-pack.ts` — `AuTaxQuestionnairePack implements TaxQuestionnairePack`, mirroring `CaTaxQuestionnairePack`'s structure (same method signatures, same "one question at a time" prompt-engineering approach, same `{"question": ...}` / `{"done": true}` JSON contract and parse logic) but with AU-specific topic list and terminology.
- `packages/agentbook-jurisdictions/src/au/filing-draft-pack.ts` — `AuFilingDraftPack implements FilingDraftPack`, mirroring `CaFilingDraftPack`'s structure (same delta-extraction JSON shape, same "LLM never invents the tax number" discipline) with AU-specific delta topics and letter narration.
- Test files mirroring `ca-tax-questionnaire-pack.test.ts` / `ca-filing-draft-pack.test.ts`'s exact structure and assertion density, adapted for AU content.

### AU-specific questionnaire topics

Reusing terminology already established by the existing AU jurisdiction-pack modules (so the questionnaire "sounds like" the same AU domain expertise the rest of the app already has):

- Business structure changes (sole trader vs. company/partnership/trust) — since this changes which return type applies.
- Income sources: same employer(s) issuing an income statement via myGov, any new business/self-employment income, investment income (dividends, interest).
- GST registration status — whether turnover crossed the **$75,000** compulsory-registration threshold this year (AU's actual threshold — distinct from the $30,000 CAD/GST-HST threshold the CA pack asks about; getting this number right matters, since it's a real, checkable fact a reviewing accountant would notice if wrong).
- Superannuation — extra voluntary super contributions made this year (concessional/non-concessional), on top of employer Super Guarantee.
- Private health insurance status changes — since this affects Medicare Levy Surcharge liability.
- Any other material change from last year (property sale/purchase, HECS-HELP balance changes, work-related deduction changes).

### AU-specific filing-draft deltas + letter

`extractDeltasPrompt` asks for the same JSON shape as `CaFilingDraftPack` (`incomeDeltaPercent`, `dependentsDelta`, `changesFromLastYear`, `openQuestions`). AU has no per-individual marital-status-driven filing status the way some jurisdictions do, so `filingStatusChanged`/`newFilingStatus` are simply left unused/omitted for AU (they're optional fields on the shared `FilingDraftDeltas` interface) — business-structure changes (sole trader → company, etc.), GST threshold crossings, and super contribution changes are instead captured as plain-language bullets in `changesFromLastYear`, the same way the CA pack already reports its own GST/HST threshold crossing as a bullet rather than a dedicated field.

`clientLetterPrompt` narrates using ATO/myGov terminology ("this year's myGov income statement," "Medicare Levy," "your accountant will lodge via the ATO"), and flags quarterly BAS lodgment as an open item if the interview indicated the client is newly GST-registered.

The real tax number: `tax-fast-track-draft-compute.ts`'s hardcoded `TAX_BRACKET_PROVIDERS` map gains `au: auTaxBrackets` (one-line addition, using the already-implemented, unmodified provider) — so the LLM still never invents the tax figure, exactly matching the existing us/ca discipline.

### Registration

Both loaders (`tax-questionnaire-loader.ts`, `filing-draft-loader.ts`) gain an `au: new AuTaxQuestionnairePack()` / `au: new AuFilingDraftPack()` entry, and their "au/uk deliberately NOT registered" comments are updated to say uk-only (since au now *is* registered).

## Testing

- Unit tests for both new packs, mirroring the existing `ca-tax-questionnaire-pack.test.ts` / `ca-filing-draft-pack.test.ts` files' exact structure (jurisdiction field, qaHistory reflection, priorFiling reflection with `en-AU` currency formatting, profile block, "skip already-answered" instruction, JSON-contract instruction, AU-specific-content assertions e.g. "myGov"/"Medicare Levy"/"$75,000"/"superannuation", parse-response success/failure cases).
- Update the one existing test that hardcodes `listSupportedJurisdictions: () => ['us', 'ca']` (`start-tax-fast-track-skill.test.ts`) if adding `au` to that mock is warranted for a new AU-specific assertion, or leave it as-is if it's testing something jurisdiction-independent and doesn't need AU coverage (to be confirmed during planning by reading the actual test).
- No new e2e spec needed — this is a backend-only jurisdiction registration change with no new routes, no new UI, and the existing `tax-fast-track-ui.spec.ts` / MCP e2e specs already exercise the full flow generically for whichever jurisdiction a test tenant is configured with; AU-specific correctness is a unit-test concern (the prompts/parsing), not an e2e concern.

## Verification

- `npx vitest run` in `packages/agentbook-jurisdictions` — new tests pass, no regressions.
- `npx vitest run` in `plugins/agentbook-core/backend` — no regressions from the loader/compute changes (the loader lookup and bracket-provider map are both purely additive).
- Manual/local check: set a test tenant's `jurisdiction` to `au` and confirm `POST /tax-fast-track/start` no longer returns the "isn't available for your jurisdiction yet" blocked response.
