# Expense Auto-Categorization Design

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this spec task-by-task.

**Goal:** Keep uncategorized expenses below 10% of total at all times. AI auto-applies high-confidence categories silently, surfaces medium-confidence ones for user confirmation (web + chat), and a watchdog cron + post-save trigger ensure the threshold is enforced proactively.

**Architecture:** Reuses the existing `autoCategorizeForTenant` function in `apps/web-next/src/lib/agentbook-auto-categorize.ts` (LLM-based, confidence-thresholded). Three new pieces: (1) post-save threshold check in the expense backend, (2) watchdog cron, (3) web confirmation panel on the Expenses page.

**Affected areas:**
- `plugins/agentbook-expense/backend/src/server.ts` — post-save trigger
- `apps/web-next/src/app/api/v1/agentbook/cron/auto-categorize-watchdog/route.ts` — new cron
- `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/pending/route.ts` — new API route
- `apps/web-next/vercel.json` — add cron schedule
- `plugins/agentbook-expense/frontend/src/pages/Expenses.tsx` (or equivalent) — add `CategorizationReviewBanner`
- `plugins/agentbook-core/backend/src/server.ts` — upgrade `categorize-expenses` skill handler

---

## 1. Confidence Thresholds (existing, unchanged)

The existing `autoCategorizeForTenant` in `agentbook-auto-categorize.ts` already implements:

| Confidence | Action |
|---|---|
| ≥ 0.85 | Apply silently — no user input needed |
| 0.55 – 0.84 | Queue in `AbUserMemory[telegram:ai_categorize_pending]` for user confirmation |
| < 0.55 | Leave uncategorized — user must handle manually |

No changes to this logic.

---

## 2. Post-Save Threshold Trigger

**File:** `plugins/agentbook-expense/backend/src/server.ts`

After every successful expense save (record-expense and Plaid sync batch), add a non-blocking threshold check:

```typescript
// Best-effort — never blocks the save response
void checkAndAutoCategorize(tenantId);
```

```typescript
async function checkAndAutoCategorize(tenantId: string): Promise<void> {
  try {
    const [total, uncategorized] = await Promise.all([
      db.abExpense.count({ where: { tenantId } }),
      db.abExpense.count({ where: { tenantId, categoryId: null } }),
    ]);
    if (total === 0 || uncategorized / total <= 0.10) return;
    // Import autoCategorizeForTenant via HTTP to the Next.js auto-categorize endpoint
    // (Express backend cannot import server-only Next.js modules directly)
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    await fetch(`${baseUrl}/api/v1/agentbook-core/auto-categorize/run`, {
      method: 'POST',
      headers: { 'x-tenant-id': tenantId, 'x-internal-cron': process.env.CRON_SECRET || '' },
    });
  } catch {
    // Best-effort — log and continue
  }
}
```

**Alternative (simpler):** Since the Express backend has Prisma access, inline the high-confidence keyword categorization as an immediate fallback, and let the cron handle LLM for medium confidence. This avoids the HTTP round-trip between Express and Next.js.

**Decision:** Use the inline approach for the trigger. The LLM-based `autoCategorizeForTenant` is called by the watchdog cron. The trigger only applies keyword-based high-confidence matches immediately, keeping latency low for the user's save response.

---

## 3. Watchdog Cron

**File:** `apps/web-next/src/app/api/v1/agentbook/cron/auto-categorize-watchdog/route.ts`

**Schedule:** `0 */6 * * *` (every 6 hours)

```
For each active tenant:
  1. Count total expenses and uncategorized expenses
  2. If uncategorized / total <= 0.10 → skip
  3. Call autoCategorizeForTenant(tenantId)
  4. Re-check ratio after run
  5. If still > 10% (remaining are all low-confidence):
     - Send Telegram nudge via sendToAllChannels:
       "You have {n} uncategorized expenses — I couldn't auto-categorize them.
        Type 'categorize' or visit the Expenses page to review."
     - Dedupe: skip if already nudged within 24h (check AbEvent)
```

Auth: Bearer-gated with `CRON_SECRET` (same pattern as existing crons).

Add to `vercel.json` crons array:
```json
{ "path": "/api/v1/agentbook/cron/auto-categorize-watchdog", "schedule": "0 */6 * * *" }
```

---

## 4. Pending Suggestions API

**File:** `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/pending/route.ts`

```
GET /api/v1/agentbook-core/auto-categorize/pending
```

Reads `AbUserMemory[telegram:ai_categorize_pending]` for the authenticated tenant. Returns:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "expenseId": "...",
        "vendorName": "Figma",
        "amountCents": 1500,
        "date": "2026-06-15",
        "description": "Figma Pro",
        "suggestedCategoryId": "...",
        "suggestedCategoryName": "Software & Subscriptions",
        "confidence": 0.73,
        "reason": "Figma is a design SaaS tool"
      }
    ],
    "uncategorizedCount": 5,
    "totalCount": 48,
    "uncategorizedPct": 10.4
  }
}
```

Also expose:
```
POST /api/v1/agentbook-core/auto-categorize/run
```
Calls `autoCategorizeForTenant` for the tenant. Used by the post-save trigger. Bearer-gated.

---

## 5. Web Confirmation Panel

**Component:** `CategorizationReviewBanner`

Shown above the expense list on the Expenses page when `pending.items.length > 0` or `uncategorizedPct > 10`.

**Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ 🤖  AI suggested categories for 3 expenses                   │
│                                                             │
│  $15.00  Figma Pro           → Software & Subscriptions  73% │
│  [✓ Approve]  [↩ Different]                                  │
│                                                             │
│  $45.00  AWS Invoice         → Software & Subscriptions  81% │
│  [✓ Approve]  [↩ Different]                                  │
│                                                             │
│  [Approve all]              [Dismiss for 24h]  ×            │
└─────────────────────────────────────────────────────────────┘
```

- **Approve**: `POST /api/v1/agentbook-expense/expenses/:id/categorize` with `{ categoryId, source: 'agent_confirmed' }` → calls `dropPendingSuggestion(tenantId, expenseId)` (existing helper)
- **Different**: Opens category picker dropdown (existing category list from accounts)
- **Approve all**: Batch approves all items in the list
- **Dismiss for 24h**: Sets `localStorage['ab_cat_review_dismissed'] = Date.now()`, hidden for 24h
- Confidence badge: green ≥ 0.80, yellow 0.65–0.79, orange < 0.65

---

## 6. Upgrade `categorize-expenses` Chat Skill

**File:** `plugins/agentbook-core/backend/src/server.ts`

Replace the keyword-matching loop in the `categorize-expenses` INTERNAL handler with a call to the `/auto-categorize/run` endpoint (which calls `autoCategorizeForTenant`).

Response format:
- `"Applied 8 categories automatically. 3 need your input — check the Expenses page or type 'review' here to walk through them."`
- If pending > 0, include the first 2 pending items inline for Telegram users

---

## 7. Error Handling

| Scenario | Behaviour |
|---|---|
| Gemini unavailable during post-save trigger | Keyword-only fallback; LLM runs at next watchdog cycle |
| Watchdog: tenant has 0 expenses | Skip |
| Watchdog: tenant already ≤ 10% | No-op |
| Approve in web panel (expense already categorized manually) | `POST /categorize` is idempotent; stale entry filtered on next `/pending` read |
| All remaining uncategorized are low-confidence (<0.55) | Watchdog sends nudge; system cannot go below those items automatically |
| `CRON_SECRET` not set | Fall back to no-auth (dev mode) with warning log |
| Post-save trigger HTTP call fails | Log warn, continue — watchdog catches it within 6h |

---

## 8. What Is NOT In Scope

- Bulk manual re-categorization UI (exists in the expense detail page)
- Training a custom model per tenant (uses shared Gemini)
- Category creation from this flow (users pick from existing chart of accounts)
- WhatsApp confirmation flow (Telegram + web only)
