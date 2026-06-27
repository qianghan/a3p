# Billing UI + Invoicing Improvements Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Improve the AgentBook billing UI with richer plan cards, a monthly/annual upgrade toggle, and a polished credit card flow; overhaul the invoicing experience with a detail page, PDF view, payment recording (UI + chatbot), overdue reminders, and a new AgentBook Settings page for business profile and invoice defaults.

**Architecture:** All changes are confined to two plugin frontends (`agentbook-billing`, `agentbook-invoice`) and the `agentbook-core` plugin frontend, with small additions to existing API routes. No new plugins, no new database tables except 4 new fields on `AbTenantConfig` and one new API endpoint for logo upload. The chatbot payment path adds one intent handler to the invoice plugin backend.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Stripe Elements (`@stripe/react-stripe-js`), `@react-pdf/renderer` (already used), Vercel Blob (`@vercel/blob`), Prisma, Next.js App Router API routes.

---

## Scope Decomposition

Two implementation plans, executed in order:

1. **Plan A — Billing UI** (smaller, self-contained): Plan cards, monthly/annual toggle, upgrade timing modal, credit card flow polish.
2. **Plan B — Invoicing + Settings** (larger): Invoice detail page, PDF view, payment recording (UI + chatbot), overdue reminders, status sweep cron step, AgentBook Settings page with logo upload.

---

## Section 1: Billing UI

### 1.1 Plan Cards with Feature Display

**File:** `plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx`

Current state: cards show name, price, description, and a hardcoded 3-feature list. Features are also stored in `BillPlan.features` JSON (`{ telegram_bot, tax_package_generation, multi_user_teams }`) and quotas in `BillPlan.quotas` (`{ expenses_created, ocr_scans, ai_messages, invoices_sent, bank_connections }`).

New rendering:
- Parse `features` and `quotas` from the plan object
- Render a feature checklist inside each card:
  - Telegram bot (if `features.telegram_bot`)
  - Tax package exports (if `features.tax_package_generation`)
  - Multi-user teams (if `features.multi_user_teams`)
  - OCR scans: `quotas.ocr_scans === -1 ? 'Unlimited' : quotas.ocr_scans + '/mo'`
  - AI messages: same pattern
  - Expenses: same pattern
- Current plan card gets a highlighted ring + "Your plan" badge (green pill)
- Upgrade/Downgrade/Current buttons rendered based on price comparison to current plan

### 1.2 Monthly / Annual Toggle

**File:** `plugins/agentbook-billing/frontend/src/user/PlanGrid.tsx`

A pill toggle ("Monthly | Annual") rendered above the plan grid. State: `interval: 'month' | 'year'`, default `'month'`.

- `GET /api/v1/agentbook-billing/plans` returns all active plans. Frontend filters by `plan.interval === selectedInterval`.
- The `free` plan (priceCents = 0) always shows regardless of toggle.
- Annual cards show a savings badge: compute `(monthlyPrice * 12 - annualPrice) / (monthlyPrice * 12) * 100` → display "Save 20%".
- Plans are paired by matching `code` pattern: `pro` ↔ `pro-yearly`. Pairing logic: strip `-yearly` suffix to find the monthly counterpart, compare prices.

### 1.3 Upgrade with Timing Choice

**New API route:** `GET /api/v1/agentbook-billing/me/subscription/proration-preview?planId=xxx`

- Requires auth (uses `safeResolveAgentbookTenant`)
- Fetches the current `BillSubscription.stripeSubscriptionId`
- If no active Stripe subscription (free tier), returns `{ proratedAmount: 0, immediateChargeDate: today }`
- If active: calls `stripe.invoices.retrieveUpcoming({ customer, subscription, subscription_items: [{ id: currentItem, price: newPriceId }] })` → returns `{ proratedAmount: upcoming.amount_due, immediateChargeDate: upcoming.next_payment_attempt, renewalDate: currentPeriodEnd }`

**New component:** `plugins/agentbook-billing/frontend/src/user/UpgradeTimingModal.tsx`

Shown when user clicks Upgrade (annual plan, has existing monthly subscription). Two radio options:
- **Upgrade now** — "Charge $X today, prorated credit for remaining monthly period"
- **Switch at renewal** — "Switch on [date]. No charge until then."

On confirm:
- "Upgrade now": proceeds directly to `SubscribeModal` (or if payment method on file, calls `POST /me/subscription` directly)
- "Switch at renewal": calls a new `POST /me/subscription/schedule` endpoint (or uses Stripe subscription schedules) — **deferred to v2**. For now, "Switch at renewal" calls `POST /me/subscription/cancel` then schedules the new plan. Simplification: only offer "Upgrade now" for the MVP; show "Switch at renewal" as informational text only, not an actionable path.

**Revised decision:** MVP implements "Upgrade now" with proration preview only. "Switch at renewal" shows as disabled with a tooltip "Coming soon" — Stripe subscription schedules add complexity that should be a follow-up.

### 1.4 Credit Card Flow Polish

**File:** `plugins/agentbook-billing/frontend/src/user/SubscribeModal.tsx`

Current state: single-step modal with Stripe `PaymentElement` and a submit button.

Improvements:
- Add step indicator: **1. Select plan → 2. Payment details → 3. Confirm**
- Show 90-day trial callout: "Your 90-day free trial starts today. First charge on [trialEndDate]."
- Show exact charge amount and date
- If `paymentMethodId` already on file (user has saved card), skip step 2 and go straight to step 3 with "Charge [card ending 4242]" summary
- On success: close modal, show toast "Subscribed to Pro — 90-day trial active", refresh `CurrentPlanView`

No changes to the API layer for this step — the existing `POST /me/subscription/intent` + `POST /me/subscription` flow is correct.

---

## Section 2: Invoice Detail Page

### 2.1 Route Setup

**File:** `plugins/agentbook-invoice/frontend/src/App.tsx`

Add route: `<Route path="/invoices/:id" element={<InvoiceDetailPage />} />`

**File:** `plugins/agentbook-invoice/frontend/src/pages/InvoiceList.tsx`

Add `onClick` to each row: `navigate('/invoices/' + invoice.id)`. Remove `cursor-pointer` orphan class warning.

### 2.2 InvoiceDetailPage Component

**New file:** `plugins/agentbook-invoice/frontend/src/pages/InvoiceDetail.tsx`

Data fetching: `GET /api/v1/agentbook-invoice/invoices/:id` → returns invoice + payments array + `totalPaidCents` + `balanceDueCents`.

**Layout — three zones:**

**Header bar:**
- Back arrow → `navigate('/')`
- Invoice number (large, monospace)
- Status badge using accounting-standard labels:

| DB value | Display | Badge color |
|---|---|---|
| `draft` | Draft | gray |
| `sent` | Issued | blue |
| `viewed` | Viewed | indigo |
| `overdue` | Past Due | red |
| `paid` | Paid | green |
| `void` | Void | muted/strikethrough |

- Client name, issued date, due date

**Action bar** (context-sensitive):

| Status | Actions shown |
|---|---|
| `draft` | Send, Edit (future), Delete |
| `sent` / `viewed` | View PDF, Mark as Paid, Record Payment, Send Reminder, Void |
| `overdue` | View PDF, Mark as Paid (highlighted), Record Payment, Send Reminder (red), Void |
| `paid` | View PDF |
| `void` | View PDF |

**View PDF:** fetches `GET /api/v1/agentbook-invoice/invoices/:id/pdf` — the endpoint already returns a signed redirect. Open via `window.open(pdfUrl, '_blank')`. The `pdfUrl` can be retrieved from the invoice detail response if stored, or directly constructed as `/api/v1/agentbook-invoice/invoices/:id/pdf` (the endpoint handles auth via session cookie).

**Body:**
1. **Summary card** — Total Amount, Amount Paid, Balance Due (three large number blocks side by side)
2. **Line items table** — Description, Qty, Rate, Amount columns. Read-only in detail view.
3. **Payment history** — Date, Method (humanized: "Bank Transfer", "Manual", etc.), Reference, Amount. Only rendered when `payments.length > 0`. Shows running balance after each payment.

### 2.3 Status Badge Component

**New file:** `plugins/agentbook-invoice/frontend/src/components/InvoiceStatusBadge.tsx`

Reusable across list and detail. Maps DB status → display label + Tailwind color classes. Also used in `InvoiceList.tsx` to replace current ad-hoc badge rendering.

---

## Section 3: Payment Recording

### 3.1 Quick "Mark as Paid"

Available in two places:

**Invoice detail action bar:** "Mark as Paid" button → `window.confirm('Mark INV-2026-0004 ($1,200.00) as fully paid via manual payment today?')` → on confirm, calls `POST /api/v1/agentbook-invoice/payments` with:
```json
{ "invoiceId": "...", "amount": balanceDueCents, "method": "manual", "paidAt": today }
```
→ invoice detail refetches, status now shows "Paid".

**Invoice list row dropdown:** Three-dot menu on each row. For `sent`/`viewed`/`overdue` rows: "Mark as Paid" option (same flow). This avoids navigating to detail for simple cases.

### 3.2 Record Payment Modal

**New file:** `plugins/agentbook-invoice/frontend/src/components/RecordPaymentModal.tsx`

Triggered by "Record Payment" button on invoice detail.

Fields:
| Field | Type | Default | Validation |
|---|---|---|---|
| Amount | Currency input | `balanceDueCents / 100` | > 0, ≤ balanceDue |
| Payment date | Date picker | today | required |
| Method | Select | `manual` | `manual / bank_transfer / check / cash / stripe / other` |
| Reference | Text | — | optional, max 100 chars |
| Notes | Textarea | — | optional |

On submit: `POST /api/v1/agentbook-invoice/payments`. On success: close modal, show toast "Payment of $X recorded", detail page refetches.

Partial payment handling: if `amount < balanceDue`, invoice stays in current status (`sent`/`overdue`). Summary card updates to show new Amount Paid and Balance Due. "Record Payment" button remains available for additional payments.

### 3.3 Chatbot "Mark as Paid" Intent

**File:** `plugins/agentbook-invoice/backend/src/server.ts`

Add skill manifest entry to `BUILT_IN_SKILLS`:
```typescript
{
  name: 'record-invoice-payment',
  description: 'Record a payment received for an invoice',
  examples: [
    'I got paid for invoice INV-2026-0004',
    'Acme paid the invoice',
    'Mark invoice 0004 as paid',
    'received $1200 from client'
  ],
  parameters: { invoiceRef: 'string', amount: 'number?', clientName: 'string?' }
}
```

Handler in `classifyAndExecuteV1()`:
1. Extract `invoiceRef` (invoice number like `INV-2026-0004`) or `clientName` from LLM classification
2. Look up invoice: by number if ref present, else most recent unpaid invoice for that client
3. If ambiguous (multiple unpaid invoices for client), list them and ask user to confirm which
4. Confirm: *"Recording full payment of $1,200.00 for INV-2026-0004 (Acme Corp). Confirm? (yes/no)"*
5. On confirm: call internal `POST /api/v1/agentbook-invoice/payments` with `method: 'manual'`
6. Reply: *"Done. INV-2026-0004 is now Paid. Balance: $0.00. Journal entry posted."*

---

## Section 4: Overdue Reminders

### 4.1 Overdue Status Sweep

**File:** `apps/web-next/src/app/api/v1/agentbook/cron/recurring-invoices/route.ts`

Add an overdue sweep at the top of the cron handler (runs before recurring invoice generation):
```typescript
// Flip sent/viewed invoices past their due date to overdue
await prisma.abInvoice.updateMany({
  where: {
    status: { in: ['sent', 'viewed'] },
    dueDate: { lt: new Date() },
    deletedAt: null,
  },
  data: { status: 'overdue' },
});
```

This runs daily via the existing Vercel cron schedule. No new cron job needed.

### 4.2 Overdue UI on Invoice List

**File:** `plugins/agentbook-invoice/frontend/src/pages/InvoiceList.tsx`

**Overdue banner** (shown when overdue tab count > 0):
> "3 invoices are past due — $4,800 outstanding. [Send all reminders →]"

"Send all reminders" fires `POST /api/v1/agentbook-invoice/invoices/:id/remind` sequentially for each overdue invoice (with 200ms delay between calls to avoid rate limits). Shows a loading spinner, then "3 reminders sent".

**Per-row Remind button:** Shown on each overdue row (and sent/viewed rows). After sending: button text changes to "Reminded Jun 15" and is disabled. `lastRemindedAt` comes from the invoice list response. Disable for 24h: compare `lastRemindedAt` to `Date.now() - 24*60*60*1000`.

### 4.3 Overdue UI on Invoice Detail

**File:** `plugins/agentbook-invoice/frontend/src/pages/InvoiceDetail.tsx`

When `status === 'overdue'`: amber alert bar below the header:
> ⚠ This invoice is [N] days past due.

"Send Reminder" button in action bar is styled red/prominent. After sending, shows: "Reminder sent [tone] — [date]". Tone displayed as a subtle label: "gentle / firm / urgent" based on days overdue (computed client-side, same thresholds as backend: <7 gentle, 7-30 firm, 31+ urgent).

### 4.4 Telegram Proactive Reminder

**File:** `plugins/agentbook-invoice/backend/src/server.ts`

In the daily catch-up skill handler, add an overdue invoice check:
- Query overdue invoices for the tenant
- If any: include in catch-up summary: *"You have 2 overdue invoices totalling $3,200 (Acme Corp: $1,800, Beta LLC: $1,400). Reply 'remind all' or 'remind Acme' to send reminders."*
- `remind all` / `remind [client]` triggers the reminder flow described in Section 3.3

---

## Section 5: AgentBook Settings Page

### 5.1 Settings Route in agentbook-core

**File:** `plugins/agentbook-core/frontend/src/App.tsx`

Add route: `<Route path="/settings" element={<SettingsPage />} />`

Sidebar nav: add gear icon + "Settings" link. Position: bottom of sidebar, above any logout link.

### 5.2 SettingsPage Component

**New file:** `plugins/agentbook-core/frontend/src/pages/SettingsPage.tsx`

Two tabs: **Business Profile** | **Invoice Defaults**

Data: `GET /api/v1/agentbook-core/tenant-config` on mount. Save: `PATCH /api/v1/agentbook-core/tenant-config`.

**Tab 1 — Business Profile:**

| Field | Input type | Maps to |
|---|---|---|
| Company name | Text | `companyName` |
| Email | Email | `companyEmail` |
| Phone | Tel | `companyPhone` |
| Address | Textarea | `companyAddress` |
| Logo | File upload → Blob | `logoUrl` |
| Accent color | Color picker + hex input | `brandColor` |

Logo upload flow:
1. User picks file (PNG/JPG/SVG, max 2MB)
2. Frontend calls `POST /api/v1/agentbook-core/tenant-config/logo` with `multipart/form-data`
3. Server uploads to Vercel Blob (`put(filename, buffer, { access: 'public' })`) → returns `{ url }`
4. Frontend sets `logoUrl` field value to the returned URL
5. User clicks Save → standard `PATCH /tenant-config`

Live preview panel: a small card on the right side of the form showing the PDF invoice header — logo image, company name in `brandColor`, address below. Updates in real-time as user types (logo preview uses `URL.createObjectURL` for the pending upload).

**Tab 2 — Invoice Defaults:**

| Field | Input type | Maps to (new schema fields) |
|---|---|---|
| Default payment terms | Select (Net 15 / Net 30 / Net 60 / Due on Receipt) | `defaultPaymentTerms` |
| Default currency | Select (USD / EUR / GBP / CAD / JPY + more) | `defaultCurrency` |
| Invoice footer note | Textarea, max 300 chars | `invoiceFooterNote` |
| Thank-you message (paid invoices) | Text, max 150 chars | `invoiceThankYouMessage` |

These 4 fields are consumed by: (a) `NewInvoicePage` which prefills terms + currency from config, and (b) the PDF renderer which appends footer note and thank-you message when status = `paid`.

### 5.3 Schema Migration

**File:** `packages/database/prisma/schema.prisma`

Add to `AbTenantConfig` model:
```prisma
defaultPaymentTerms     String?   // "net-15" | "net-30" | "net-60" | "due-on-receipt"
defaultCurrency         String?   // ISO code, e.g. "USD"
invoiceFooterNote       String?
invoiceThankYouMessage  String?
```

Migration: `npx prisma migrate dev --name add_tenant_config_invoice_defaults`

### 5.4 Logo Upload API Route

**New file:** `apps/web-next/src/app/api/v1/agentbook-core/tenant-config/logo/route.ts`

```typescript
POST /api/v1/agentbook-core/tenant-config/logo
Content-Type: multipart/form-data
Body: { file: File }

Response: { url: string }
```

- Auth via `safeResolveAgentbookTenant`
- Validate: file type (`image/png`, `image/jpeg`, `image/svg+xml`), max 2MB
- Upload via `@vercel/blob`: `put('logos/${tenantId}-${Date.now()}.${ext}', buffer, { access: 'public' })`
- Return `{ url }` — client saves it via PATCH tenant-config

### 5.5 tenant-config PATCH Extension

**File:** `apps/web-next/src/app/api/v1/agentbook-core/tenant-config/route.ts`

Extend the Zod body schema to accept the 4 new fields. The existing PATCH handler already does a `prisma.abTenantConfig.upsert` — no structural change needed, just schema extension.

PDF renderer (`@/lib/agentbook-invoice-pdf`) already reads from `AbTenantConfig`. After this change, it will automatically pick up `invoiceFooterNote` and `invoiceThankYouMessage` — add those to the render template.

---

## Status State Machine (Complete Reference)

```
draft ──[Send]──→ sent ──[auto: dueDate passes]──→ overdue
                   ↓                                    ↓
               [viewed]                           [Mark Paid /
            (client opens PDF)                   Record Payment]
                   ↓                                    ↓
              [Mark Paid /                            paid
           Record Payment]
                   ↓
                 paid

sent / viewed / overdue ──[Void]──→ void
```

Standard accounting term mapping:
- **Draft** — created but not yet sent to client
- **Issued** (sent) — delivered to client, payment expected
- **Viewed** — client has opened the invoice link
- **Past Due** (overdue) — past due date, no payment received
- **Paid** — payment fully received and recorded
- **Void** — cancelled; reversing journal entry posted

---

## API Changes Summary

| Route | Method | Change |
|---|---|---|
| `/agentbook-billing/me/subscription/proration-preview` | GET | **New** — Stripe upcoming invoice preview |
| `/agentbook-core/tenant-config/logo` | POST | **New** — Vercel Blob upload |
| `/agentbook-core/tenant-config` | PATCH | Extend Zod schema with 4 new fields |
| `/agentbook/cron/recurring-invoices` | POST | Extend — add overdue sweep |
| Invoice plugin backend `server.ts` | — | Add `record-invoice-payment` skill manifest + handler |

All invoice CRUD, payment, remind, and PDF endpoints already exist — no new routes needed for the invoicing frontend work.

---

## Implementation Order

Execute as two plans:

**Plan A — Billing UI** (3–4 tasks):
1. Plan card feature display + monthly/annual toggle
2. Proration preview API route
3. Upgrade timing modal + SubscribeModal polish

**Plan B — Invoicing + Settings** (7–8 tasks):
1. Schema migration (4 new `AbTenantConfig` fields)
2. tenant-config PATCH extension + logo upload route
3. AgentBook Settings page (both tabs + live preview)
4. `InvoiceStatusBadge` component + list row `onClick` navigation
5. Invoice detail page (header + action bar + body)
6. Payment recording (Mark as Paid + RecordPaymentModal)
7. Overdue sweep (cron) + list banner + row Remind button + detail alert
8. Chatbot payment intent handler in invoice plugin backend
