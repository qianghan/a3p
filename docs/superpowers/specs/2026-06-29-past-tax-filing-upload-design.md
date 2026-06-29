# Past Tax Filing Upload — Design Spec

**Date:** 2026-06-29  
**Plugin:** agentbook-tax (port 4053)  
**Jurisdictions:** Canada (T1/T4/NOA/T4A/T5/T2125) + United States (1040/W-2/1099-NEC)  
**Extensible to:** NZ, UK, AU via `PastFilingPack` interface  
**Status:** Approved — proceed to implementation plan

---

## 1. Problem

Users have years of historical tax returns (T1, 1040), slips (T4, W-2), and CRA/IRS notices (NOA) as PDFs from their accountant or CRA My Account. The current tax plugin has no way to ingest these, so the AI advisor has no historical context and every year starts from zero. Users also manually re-enter recurring information (home office %, business name, RRSP room) that should carry forward automatically.

---

## 2. Goals

1. Upload completed past tax return PDFs → stored privately in Vercel Blob
2. Parse with Gemini Vision → extract key totals + per-form detail → stored in DB
3. Show past filings in the Tax Plugin UI with blob download links
4. Surface filings in chat: agent can describe and link them when asked
5. Use confirmed past filings to enrich tax advisor context (year-over-year comparisons, RRSP room, instalment guidance)
6. Pre-fill the current year's T1/T2125/1040 draft from last year's extracted data
7. Generate NETFILE XML (CA) and IRS MeF XML (US) from current-year filing for user-submitted e-filing

---

## 3. Non-Goals

- Direct CRA NETFILE / IRS MeF submission (reserved for a future premium tier)
- Automated pre-fill without user confirmation
- Parsing non-PDF formats (scanned images of past returns → use existing `AbTaxSlip` OCR flow)

---

## 4. Architecture

### 4.1 Data Model

**New model: `AbPastTaxFiling`** in `plugin_agentbook_tax` schema.

```prisma
model AbPastTaxFiling {
  id            String   @id @default(uuid())
  tenantId      String
  taxYear       Int
  jurisdiction  String        // 'ca' | 'us'
  region        String?       // province or state
  formType      String        // 'T1' | 'T4' | 'NOA' | 'T2125' | '1040' | 'W-2' | '1099-NEC'
  blobUrl       String        // Vercel Blob permanent URL (private, not direct-access)
  blobKey       String        // pathname for deletion via @vercel/blob del()
  extractedData Json  @default("{}")
  confidence    Float @default(0)
  status        String @default("uploaded")   // uploaded | parsing | confirmed | error
  errorMsg      String?
  notes         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([tenantId, taxYear])
  @@index([tenantId, jurisdiction, formType])
  @@schema("plugin_agentbook_tax")
}
```

**Extension to `AbTaxFiling`:**

```prisma
// Add to existing model:
prefillSourceYear  Int?    // year whose AbPastTaxFiling was used to pre-fill
```

### 4.2 Jurisdiction Extensibility

New interface added to `packages/agentbook-jurisdictions/src/interfaces.ts`:

```typescript
export interface StandardTaxExtract {
  formType: string
  taxYear: number
  jurisdiction: string
  region?: string
  totalIncomeCents?: number
  netIncomeCents?: number
  taxableIncomeCents?: number
  taxPayableCents?: number
  refundOrBalanceCents?: number  // positive = refund, negative = owing
  savingsRoomCents?: number      // RRSP | KiwiSaver credit | ISA | super
  formFields: Record<string, number | string | boolean | null>
  attachedForms: Record<string, Record<string, any>>
  confidence: number
}

export interface PreFillSuggestion {
  fieldId: string
  value: any
  sourceField: string
  confidence: number
}

export interface EFileExport {
  format: 'xml' | 'json' | 'pdf'
  content: string
  filename: string
  instructions: string
}

export interface PastFilingPack {
  jurisdiction: string
  supportedFormTypes(): { formType: string; displayName: string; description: string; typicalPages?: number }[]
  identificationPrompt(): string
  extractionPrompt(formType: string, taxYear: number): string
  parseExtraction(raw: any, formType: string, taxYear: number): StandardTaxExtract
  preFillMap(extract: StandardTaxExtract): PreFillSuggestion[]
  summarize(extract: StandardTaxExtract): string
  generateEFileExport?(forms: Record<string, any>, taxYear: number, region?: string): EFileExport
}
```

**Registry:** `packages/agentbook-jurisdictions/src/past-filing-loader.ts`

```typescript
import { CaPastFilingPack } from './ca/past-filing-pack.js';
import { UsPastFilingPack } from './us/past-filing-pack.js';

const PACKS: Record<string, PastFilingPack> = {
  ca: new CaPastFilingPack(),
  us: new UsPastFilingPack(),
  // nz: new NzPastFilingPack(),  // future — one line
  // uk: new UkPastFilingPack(),
  // au: new AuPastFilingPack(),
};

export function getPastFilingPack(jurisdiction: string): PastFilingPack {
  const pack = PACKS[jurisdiction];
  if (!pack) throw new Error(`No PastFilingPack for jurisdiction: ${jurisdiction}`);
  return pack;
}
```

### 4.3 Upload Pipeline

```
User drops PDF
  → POST /past-filings/upload (multipart, max 20MB, PDF only)
  → Validate MIME type
  → checkQuota() stub (billing hook, no-op now)
  → Vercel Blob put(key, buffer, { access: 'private' })
  → db.abPastTaxFiling.create({ status: 'uploaded', blobUrl, blobKey })
  → triggerParse(id) — deferred (waitUntil on Vercel, fire-and-forget on standalone)
  → Return { id, status: 'uploaded' }  immediately

UI polls GET /past-filings/:id every 3s → status: parsing → confirmed | error
```

**PDF-to-Gemini strategy:** Pass PDF to Gemini 1.5 Pro via `inlineData` with `mimeType: 'application/pdf'`. Gemini handles multi-page PDFs natively. No `graphicsmagick` or `pdftocairo` required.

**Blob key pattern:** `tax-filings/{tenantId}/{taxYear}/{formType}-{timestamp}.pdf`

### 4.4 Parsing Pipeline

Two-step Gemini call per filing:

1. **Identification** (`identificationPrompt()`) — determine `formType`, `taxYear`, `jurisdiction`, `region`
2. **Extraction** (`extractionPrompt(formType, taxYear)`) — deep per-form field extraction

The jurisdiction-specific pack owns both prompts and the `parseExtraction()` logic. Core pipeline calls `getPastFilingPack(jurisdiction)` and delegates.

### 4.5 API Endpoints (all under `/api/v1/agentbook-tax/past-filings`)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/upload` | Upload PDF → Blob → create record → trigger async parse |
| `GET` | `/` | List all past filings for tenant, ordered by year desc |
| `GET` | `/:id` | Single filing detail (for status polling) |
| `POST` | `/:id/parse` | Re-trigger parse (on error, or user-requested re-extract) |
| `POST` | `/:id/confirm` | Mark extracted data as reviewed (status → confirmed) |
| `PATCH` | `/:id` | Manual field correction in extractedData |
| `DELETE` | `/:id` | Delete record + Vercel Blob object |
| `GET` | `/:id/download` | Generate short-lived signed URL → 302 redirect |
| `GET` | `/prefill` | `?year=N` — return pre-fill suggestions from N-1 confirmed filings |
| `GET` | `/advisor-context` | `?years=3` — LLM-ready multi-year summary |

**E-filing export endpoints (separate path):**

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/tax/export/netfile-xml` | `?year=N` — CA NETFILE XML from AbTaxFiling |
| `GET` | `/tax/export/mef-xml` | `?year=N` — US IRS MeF XML from AbTaxFiling |

### 4.6 AI Advisor Context

Injected into all tax advisor Gemini calls when confirmed past filings exist:

```
## Tax History (reference only)

2024 (CA / ON):
  Total income: $92,000 | Net income: $88,000 | Tax payable: $18,200
  Refund: $3,200 | RRSP room for 2025: $14,600
  Business (T2125): Revenue $92K | Expenses $4K | Net $88K
  Source: confirmed T1 upload (confidence 92%)

2023 (CA / ON):
  Total income: $85,000 | Net income: $81,000 | Tax payable: $16,200
  Balance owing: $0 | RRSP room for 2024: $13,800
  Source: confirmed NOA upload (confidence 97%)
```

Context is built by `buildAdvisorContext(tenantId, years)` using `pack.summarize(extract)` per filing.

### 4.7 Current-Year Pre-fill

`GET /past-filings/prefill?year=2025` fetches confirmed filings for 2024, calls `pack.preFillMap(extract)`, and returns `PreFillSuggestion[]` with `fieldId` values matching `AbTaxFormTemplate` field IDs.

- Pre-fill **never overwrites** existing non-empty fields
- Applied only after user reviews and confirms each suggestion in the modal
- `AbTaxFiling.prefillSourceYear` records the source year

### 4.8 Chat Skill: query-past-filings

New built-in skill (17th, inserted before `general-question`) in `agentbook-core/backend/src/server.ts`:

```typescript
{
  name: "query-past-filings",
  description: "Retrieve user's uploaded past tax filings. Use when user asks about previous returns, NOAs, T1 history, or wants a download link.",
  triggers: ["past filing", "last year's return", "my T1 from", "NOA",
             "notice of assessment", "tax return 202", "show my filings",
             "download my", "previous tax"],
}
```

Handler calls `GET /api/v1/agentbook-tax/past-filings` and formats results as a Markdown list with download links (via `/:id/download` proxy). Telegram adapter wraps links as `InlineKeyboardButton` with URL action.

### 4.9 Frontend UI

**New tab "Past Filings"** added to `TaxPackage.tsx` alongside the existing "Year-end Pkg" tab.

New file: `plugins/agentbook-tax/frontend/src/pages/PastFilings.tsx`

Key UI elements:
- Upload dropzone (PDF only, drag-and-drop + file picker)
- Year selector + jurisdiction picker + optional form-type picker (or "auto-detect")
- Filing list: year · formType · jurisdiction · status badge · confidence · key totals preview
- Actions per row: View PDF (→ signed URL redirect), Pre-fill [year+1] return, Re-parse, Delete
- Status polling: confirmed filings show `● confirmed`, parsing shows spinner
- Pre-fill modal: field-by-field accept/reject before applying

---

## 5. E-Filing Plan

### Canada (CA)

| Tier | Approach | Cost | Effort |
|------|----------|------|--------|
| Free MVP | NETFILE XML export → user submits at CRA or imports to StudioTax/CloudTax | $0 | 2–3 days |
| Premium v1 | CRA Represent a Client API (T1013 OAuth flow) — 1-click with CRA My Account | Dev time | +2–3 days |
| Premium v2 | CRA NETFILE Software Certification — direct submission | $0 CRA fee + 6–12 months review | Future |

### United States (US)

| Tier | Approach | Cost | Effort |
|------|----------|------|--------|
| Free MVP | IRS MeF XML export → CPA upload, or Free File Fillable Forms | $0 | 2–3 days |
| Premium v1 | Deep-link to FreeTaxUSA/OLT with pre-filled URL params | Rev share | +1–2 days |
| Premium v2 | IRS EFIN + MeF direct submission | EFIN + IRS process | Future |

### Future Jurisdictions

| Country | Forms | E-filing Path | Pack Effort |
|---------|-------|---------------|-------------|
| NZ | IR3, IR10, IR3NR | myIR XML upload | 1–2 days |
| UK | SA100, SA103, P60 | HMRC MTD API (free, OAuth) | 1–2 days pack + 2–3 days OAuth |
| AU | ITR, BAS, PAYG | ATO SBR (DSP registration) | 1–2 days pack + 3–4 days ATO |

Adding any country = one new `XxPastFilingPack` class + one line in `past-filing-loader.ts`. Core pipeline unchanged.

---

## 6. PR Cycle

| PR | Phase | Deliverables | E2E Suite |
|----|-------|-------------|-----------|
| PR-A | Phase 1 | DB model + migration, upload/list/delete/download endpoints, Blob, interface | `tax-past-filings-upload.spec.ts` |
| PR-B | Phase 2 | CA + US packs, parse endpoint, identification + extraction, confirm | `tax-past-filings-parse.spec.ts` |
| PR-C | Phase 3 | UI tab (PastFilings.tsx), upload dropzone, status polling, `query-past-filings` skill, advisor context | `tax-past-filings-ui.spec.ts`, `tax-past-filings-chat.spec.ts` |
| PR-D | Phase 4 | Pre-fill endpoint + modal, NETFILE XML, MeF XML, `prefillSourceYear` | `tax-past-filings-prefill.spec.ts`, `tax-efiling-export.spec.ts` |

Each PR must pass the full existing E2E suite before merge (including `agent-tax-filing.spec.ts`, `ca-consultant-tax-2026.spec.ts`, `agent-brain.spec.ts`).

---

## 7. Files Created / Modified

### New files

```
packages/agentbook-jurisdictions/src/past-filing-loader.ts
packages/agentbook-jurisdictions/src/ca/past-filing-pack.ts
packages/agentbook-jurisdictions/src/us/past-filing-pack.ts

plugins/agentbook-tax/backend/src/tax-past-filings.ts       ← core pipeline
plugins/agentbook-tax/frontend/src/pages/PastFilings.tsx

tests/e2e/tax-past-filings-upload.spec.ts
tests/e2e/tax-past-filings-parse.spec.ts
tests/e2e/tax-past-filings-ui.spec.ts
tests/e2e/tax-past-filings-chat.spec.ts
tests/e2e/tax-past-filings-prefill.spec.ts
tests/e2e/tax-efiling-export.spec.ts
```

### Modified files

```
packages/agentbook-jurisdictions/src/interfaces.ts          ← add 4 interfaces
packages/database/prisma/schema.prisma                      ← AbPastTaxFiling model + AbTaxFiling.prefillSourceYear
plugins/agentbook-tax/backend/src/server.ts                 ← 10 new routes + e-file export routes
plugins/agentbook-tax/frontend/src/App.tsx                  ← add PastFilings tab routing
plugins/agentbook-tax/frontend/src/pages/TaxPackage.tsx     ← add tab switcher
plugins/agentbook-core/backend/src/server.ts                ← add query-past-filings skill manifest
plugins/agentbook-core/backend/src/agent-brain.ts           ← inject past filing context into advisor calls
apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts  ← InlineKeyboardButton for filing links
```

---

## 8. Key Invariants

- **All monetary values in integer cents** — consistent with rest of codebase
- **Private blobs only** — download endpoint proxies signed URL, never exposes blob URL directly
- **Pre-fill never overwrites** — only populates empty fields, user confirms each suggestion
- **Async parse always** — upload returns immediately, UI polls for status
- **Advisor context is additive** — if no confirmed past filings, advisor falls back to current-year ledger only
- **Pack interface is sealed** — core pipeline calls only `PastFilingPack` methods; jurisdiction logic never leaks into `tax-past-filings.ts`
