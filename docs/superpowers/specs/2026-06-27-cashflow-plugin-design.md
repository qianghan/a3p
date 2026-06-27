# Cashflow Plugin Design

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this spec task-by-task.

**Goal:** Add cashflow intelligence to AgentBook — predictive balance analytics, visual dashboard, scenario planning, automated reminders, jurisdiction-aware tax reserves, and 7 chat skills — without duplicating the substantial cashflow infrastructure already in the codebase.

**Architecture:** Cashflow is NOT a 5th plugin server. It is: (a) new frontend pages in `agentbook-core` plugin, (b) new endpoints added to `agentbook-core` Express backend, (c) 1 new Prisma model + 12 extended columns, (d) 7 new chat skills. All reads go through existing `AbFinancialSnapshot`, `AbFxRate`, `AbQuarterlyPayment`, `AbRecurringRule`, and `AbRecurringInvoice`. Scenario planning reuses the existing `/simulate` endpoint.

**Key principle:** Consolidate and extend, not rebuild. ~60% of the data infrastructure already exists.

---

## What Already Exists (do not duplicate)

| Existing asset | Location | Cashflow use |
|---|---|---|
| `AbFinancialSnapshot` | schema:1611 | Daily cash balance, burn, runway — EXTEND this model |
| `GET /agentbook-tax/cashflow/projection` | tax server:892 | 30/60/90-day projection — MOVE handler to core |
| `GET /agentbook-tax/reports/cashflow` | tax server:725 | Monthly in/out — MOVE to core |
| `POST /agentbook-core/simulate` | core server:2298 | Scenario engine (hire, equipment, etc.) — REUSE |
| `AbFxRate` | schema:2603 | FX rates from ECB — READ for multi-currency |
| `AbTaxEstimate` + `AbQuarterlyPayment` | schema:2073/2091 | Quarterly deadlines — READ, don't reimplement |
| `AbRecurringRule` | schema:1745 | Recurring expense projections — READ |
| `AbRecurringInvoice` | schema:2046 | Recurring income projections — READ |
| `cashflow-report` skill | built-in-skills.ts:211 | Rename to `cashflow-projection`, update handler |
| `simulate-scenario` skill | built-in-skills.ts:45 | Extend triggers, add "can I afford" |
| `morning-digest` cashflow fields | cron/morning-digest:34-46 | Already includes cash, AR, burn — extend not replace |

**Known bug to fix:** `getQuarterlyDeadlines` in tax plugin returns `${year}-03-15` for US Q1 — should be April 15. Fix in new `jurisdictions.ts` and update tax plugin to use it.

---

## 1. Schema Changes

### 1a. Extend `AbFinancialSnapshot`

Add 6 cashflow-specific columns to the existing model:

```prisma
model AbFinancialSnapshot {
  // ... all existing fields unchanged ...

  // New cashflow fields
  inflow30dCents         Int     @default(0)   // trailing 30d gross inflow
  outflow30dCents        Int     @default(0)   // trailing 30d gross outflow
  projectedCash30Cents   Int     @default(0)   // base projection +30d
  projectedCash60Cents   Int     @default(0)   // base projection +60d
  projectedCash90Cents   Int     @default(0)   // base projection +90d
  taxReserveBalanceCents Int     @default(0)   // current reserve balance
}
```

### 1b. Extend `AbTenantConfig`

Add alert thresholds and tax reserve settings:

```prisma
model AbTenantConfig {
  // ... all existing fields unchanged ...

  // Cashflow alert thresholds
  cashflowLowBalanceCents    Int?    // alert when projected balance drops below this
  cashflowMinRunwayMonths    Float?  // alert when runway < N months
  cashflowAlertChannel       String  @default("telegram") // telegram | web | both

  // Tax reserve config
  taxReserveAccountId        String?  // optional AbAccount.id for the reserve bucket
  taxReserveMode             String   @default("quarterly_estimate") // quarterly_estimate | percent_of_revenue | fixed
  taxReservePercent          Float?   // when mode = percent_of_revenue (e.g. 0.25 = 25%)
  taxReserveFixedCents       Int?     // when mode = fixed
}
```

### 1c. New Model: `AbCashflowScenario`

The only brand-new table. The existing `/simulate` endpoint is stateless; this persists named scenarios for dashboard overlay and re-running.

```prisma
model AbCashflowScenario {
  id           String    @id @default(uuid())
  tenantId     String
  name         String
  description  String?
  scenarioType String    // add_expense | add_revenue | lose_client | hire | buy_equipment | custom
  params       Json      // mirrors /simulate request body fields
  startMonth   DateTime?
  isActive     Boolean   @default(true)
  lastResult   Json?     // cached last projection output
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  @@index([tenantId, isActive])
  @@schema("plugin_agentbook_core")
}
```

**Net DB change: 1 new table, 12 new columns. No tables dropped.**

---

## 2. Jurisdiction Config Module

**File:** `plugins/agentbook-core/backend/src/lib/jurisdictions.ts`

Data-driven config — adding a new jurisdiction = adding one config object, zero handler changes.

```typescript
export interface JurisdictionConfig {
  code: string;
  name: string;
  defaultCurrency: string;
  fiscalYearStart: number; // month 1–12
  quarterlyDeadlines: (year: number) => Array<{
    quarter: number;
    deadline: Date;
    label: string;
  }>;
  selfEmploymentTaxRate: number;   // effective rate on net income
  incomeBrackets: Array<{ upToCents: number | null; rate: number }>;
  taxReserveRecommendedPercent: number;
  paymentReminderLeadDays: number[]; // e.g. [30, 14, 3]
}

// nextBusinessDay skips weekends (sufficient for Q deadline logic)
function nextBusinessDay(d: Date): Date { ... }

export const JURISDICTIONS: Record<string, JurisdictionConfig> = {
  us: {
    code: 'us', name: 'United States', defaultCurrency: 'USD', fiscalYearStart: 1,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: nextBusinessDay(new Date(`${y}-04-15`)),   label: 'Q1 Estimated Tax (Form 1040-ES)' },
      { quarter: 2, deadline: nextBusinessDay(new Date(`${y}-06-15`)),   label: 'Q2 Estimated Tax' },
      { quarter: 3, deadline: nextBusinessDay(new Date(`${y}-09-15`)),   label: 'Q3 Estimated Tax' },
      { quarter: 4, deadline: nextBusinessDay(new Date(`${y+1}-01-15`)), label: 'Q4 Estimated Tax' },
    ],
    selfEmploymentTaxRate: 0.153 * 0.9235, // SE tax on 92.35% of net
    incomeBrackets: US_FEDERAL_2025_BRACKETS,
    taxReserveRecommendedPercent: 0.30,
    paymentReminderLeadDays: [30, 14, 3],
  },
  ca: {
    code: 'ca', name: 'Canada', defaultCurrency: 'CAD', fiscalYearStart: 1,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y}-03-15`), label: 'March Installment' },
      { quarter: 2, deadline: new Date(`${y}-06-15`), label: 'June Installment' },
      { quarter: 3, deadline: new Date(`${y}-09-15`), label: 'September Installment' },
      { quarter: 4, deadline: new Date(`${y}-12-15`), label: 'December Installment' },
    ],
    selfEmploymentTaxRate: 0.119, // CPP self-employed (both halves)
    incomeBrackets: CA_FEDERAL_2025_BRACKETS,
    taxReserveRecommendedPercent: 0.25,
    paymentReminderLeadDays: [30, 14, 3],
  },
  uk: {
    // Self Assessment: Jan 31 + Jul 31 payments on account
    code: 'uk', name: 'United Kingdom', defaultCurrency: 'GBP', fiscalYearStart: 4,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y+1}-01-31`), label: '1st Payment on Account + Balancing Payment' },
      { quarter: 2, deadline: new Date(`${y+1}-07-31`), label: '2nd Payment on Account' },
    ],
    selfEmploymentTaxRate: 0.092, // Class 4 NI
    incomeBrackets: UK_BRACKETS,
    taxReserveRecommendedPercent: 0.30,
    paymentReminderLeadDays: [60, 30, 7],
  },
  au: {
    // BAS quarters: Oct 28, Feb 28, Apr 28, Jul 28
    code: 'au', name: 'Australia', defaultCurrency: 'AUD', fiscalYearStart: 7,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y}-10-28`), label: 'Q1 BAS (Jul–Sep)' },
      { quarter: 2, deadline: new Date(`${y+1}-02-28`), label: 'Q2 BAS (Oct–Dec)' },
      { quarter: 3, deadline: new Date(`${y+1}-04-28`), label: 'Q3 BAS (Jan–Mar)' },
      { quarter: 4, deadline: new Date(`${y+1}-07-28`), label: 'Q4 BAS (Apr–Jun)' },
    ],
    selfEmploymentTaxRate: 0.0, // income tax only (no separate SE tax)
    incomeBrackets: AU_BRACKETS,
    taxReserveRecommendedPercent: 0.27,
    paymentReminderLeadDays: [30, 14, 3],
  },
  nz: {
    // Provisional tax: Aug 28, Jan 15, May 7
    code: 'nz', name: 'New Zealand', defaultCurrency: 'NZD', fiscalYearStart: 4,
    quarterlyDeadlines: (y) => [
      { quarter: 1, deadline: new Date(`${y}-08-28`), label: '1st Provisional Tax' },
      { quarter: 2, deadline: new Date(`${y+1}-01-15`), label: '2nd Provisional Tax' },
      { quarter: 3, deadline: new Date(`${y+1}-05-07`), label: '3rd Provisional Tax' },
    ],
    selfEmploymentTaxRate: 0.0,
    incomeBrackets: NZ_BRACKETS,
    taxReserveRecommendedPercent: 0.28,
    paymentReminderLeadDays: [30, 14, 3],
  },
};

export function getJurisdiction(code: string): JurisdictionConfig {
  return JURISDICTIONS[code.toLowerCase()] ?? JURISDICTIONS.us;
}
```

Migrate `agentbook-tax` to import from this module. Closes the US Q1 = March 15 bug.

---

## 3. New API Endpoints (all on agentbook-core Express, port 4050)

### Dashboard data
```
GET  /api/v1/agentbook-core/cashflow/dashboard
     → { balance, runway, inflow30d, outflow30d, projections: {d30,d60,d90}, taxReserve, currency }

GET  /api/v1/agentbook-core/cashflow/trend?days=90&currency=USD
     → daily snapshots from AbFinancialSnapshot, FX-normalized to requested currency

GET  /api/v1/agentbook-core/cashflow/runway
     → { runwayMonths, monthlyBurnCents, currentBalanceCents }
```

### Projections (move from tax plugin)
```
GET  /api/v1/agentbook-core/cashflow/projection?days=90&scenarioId=
     → projected balance series; scenarioId overlays AbCashflowScenario.params on base projection
```

### Scenarios
```
GET  /api/v1/agentbook-core/cashflow/scenarios
POST /api/v1/agentbook-core/cashflow/scenarios        → create + run, caches lastResult
GET  /api/v1/agentbook-core/cashflow/scenarios/:id
PUT  /api/v1/agentbook-core/cashflow/scenarios/:id
DELETE /api/v1/agentbook-core/cashflow/scenarios/:id
```

### Tax reserve
```
GET  /api/v1/agentbook-core/cashflow/tax-reserve
     → { reservedCents, targetCents, nextDue: {deadline, amountCents, jurisdiction}, quarterDeadlines[] }

PUT  /api/v1/agentbook-core/cashflow/tax-reserve/config
     → update AbTenantConfig taxReserve* fields
```

### Alert config
```
PUT  /api/v1/agentbook-core/cashflow/alerts
     → update AbTenantConfig cashflow* alert fields
```

---

## 4. Multi-Currency

- All API responses include both `originalCurrency` and `baseCurrency` amounts
- `baseCurrency` = `AbTenantConfig.currency` (default 'USD')
- Conversion: `amountCents × AbFxRate.rate` where rate is for `(originalCurrency → baseCurrency)` on the closest prior date
- Dashboard currency toggle: client sends `?currency=CAD` to override display; endpoint converts on the fly
- Projections: sum across accounts using their `AbBankAccount.currency`, normalize to base currency

---

## 5. Chat Skills (7 total)

All registered in `plugins/agentbook-core/backend/src/built-in-skills.ts` with `endpoint.method: 'INTERNAL'`. Handlers in `_executeClassificationCore` in `server.ts`. Each handler:
1. Reads jurisdiction from `AbTenantConfig.jurisdiction` via `brainHeaders` tenant lookup
2. Calls relevant endpoint(s)
3. Formats a Gemini-narrated 2–4 sentence response
4. Returns `{ message, skillUsed, card: { title, metrics[], actions[] } }`

| Skill | Triggers | LLM behaviour |
|---|---|---|
| `cashflow-summary` | "cash flow", "cash position", "how's my cash", "where is my cash" | 2-sentence summary of balance + trend; flag if runway < 3 months |
| `cashflow-runway` | "runway", "burn rate", "how long can I last", "months of cash" | State runway in months, burn rate/month, what drives burn |
| `cashflow-projection` | "cash forecast", "project my cash", "30 day cash", "next month balance" | Narrate 30/60/90d projections; note biggest uncertainty |
| `cashflow-trend` | "cash trend", "inflow outflow", "cash history", "how has cash changed" | Describe trend over last 90d; call out anomalies |
| `cashflow-scenario` | "what if", "if I hire", "can I afford", "buy equipment", "lose client", "simulate" | Multi-turn: extract assumption → run /simulate → narrate impact on runway |
| `cashflow-alert-setup` | "alert me when cash", "low balance alert", "notify when below", "set cash threshold" | Confirm threshold set; explain what triggers it |
| `tax-reserve-status` | "tax reserve", "set aside for tax", "tax savings", "enough for tax", "tax bucket" | State reserve vs target; give jurisdiction-correct deadline and recommended action |

**Jurisdiction awareness in skills:** each handler reads `AbTenantConfig.jurisdiction`, loads `getJurisdiction(code)`, and uses jurisdiction-specific values in the Gemini prompt:
```
System: "The tenant is in {jurisdiction.name}. Tax quarters are due on {deadlines}. 
Recommended reserve rate: {jurisdiction.taxReserveRecommendedPercent * 100}% of revenue.
Currency: {jurisdiction.defaultCurrency}."
```

---

## 6. Dashboard Frontend Pages

**Files in `plugins/agentbook-core/frontend/src/pages/`:**

### `CashflowDashboard.tsx`
- Running balance line chart (actual last 90d + projected next 90d as dashed)
- Inflow/outflow grouped bar chart (week or month)
- Time range picker: 30d / 90d / 6m / 1y
- Currency selector
- Scenario overlay selector (loads `GET /cashflow/scenarios`, overlays chosen scenario's projection)
- Tax reserve widget: progress bar (reserved / target), next due date countdown

### `ScenarioPlanner.tsx`
- List of saved scenarios with last-run impact summary
- "New scenario" form: name, type selector, parameter inputs
- Impact chart: base projection vs scenario projection overlay
- "Run in chat" button: opens chat panel with "what if [scenario name]?" pre-filled

### Routing
Add routes in `App.tsx` (or wherever the core plugin router lives):
```
/agentbook/cashflow          → CashflowDashboard
/agentbook/cashflow/scenarios → ScenarioPlanner
```

Nav item added to sidebar under "Finance".

---

## 7. New Crons

### `cashflow-snapshot` (daily, 5am UTC)
**File:** `apps/web-next/src/app/api/v1/agentbook/cron/cashflow-snapshot/route.ts`

For each active tenant: compute yesterday's inflow/outflow from `AbJournalLine` (cash account credits = inflow, debits = outflow), run base projection, write/update `AbFinancialSnapshot` row with all new columns. FX-normalize to tenant base currency.

Add to `vercel.json`: `{ "path": "/api/v1/agentbook/cron/cashflow-snapshot", "schedule": "0 5 * * *" }`

### Extend `proactive-alerts` cron
Add two new generators to the existing file:
1. **Low-balance alert**: if projected 30d balance < `cashflowLowBalanceCents` → fire alert (dedupe 48h)
2. **Tax-reserve underfunded**: if `taxReserveBalanceCents < nextQuarterTaxCents × 0.80` within 45d of deadline → fire alert

### Extend `payment-reminders` cron
Read `getJurisdiction(tenant.jurisdiction).quarterlyDeadlines(year)` and send tax payment reminders at `paymentReminderLeadDays` intervals.

---

## 8. Integration Points (explicit, to avoid coupling)

| Cashflow reads | Via | Never writes to |
|---|---|---|
| Cash balance | `AbFinancialSnapshot` (Prisma direct) | `AbExpense`, `AbJournalLine` |
| Invoice AR | `AbInvoice` (Prisma, status IN sent/overdue/viewed) | Invoice plugin |
| Recurring rules | `AbRecurringRule` (Prisma) | Expense plugin |
| FX rates | `AbFxRate` (Prisma) | FX rates cron |
| Tax estimates | `AbTaxEstimate` (Prisma) | Tax plugin |
| Quarterly deadlines | `JURISDICTIONS[code].quarterlyDeadlines` | Tax plugin (reads same config) |
| Scenario execution | `POST /agentbook-core/simulate` (HTTP to self) | Existing simulate handler |

Cashflow plugin never writes to expense, invoice, or tax data. It only writes to: `AbFinancialSnapshot` (new columns), `AbTenantConfig` (cashflow fields), `AbCashflowScenario`.

---

## 9. What Is NOT In Scope (v1)

- Bank account earmarking (real reserve account transfers)
- Multi-entity / multi-company support
- Public API for cashflow data
- CSV/PDF export of cashflow report
- WhatsApp-specific cashflow interactions (Telegram + web only)
- Machine-learning model training per tenant (Gemini LLM only)
- Real-time balance streaming (polling on 60s interval is sufficient)
