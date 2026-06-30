# Expense Auto-Categorization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep uncategorized expenses below 10% of total at all times. AI auto-applies high-confidence categories silently, surfaces medium-confidence ones for user confirmation in a web banner, and a watchdog cron enforces the threshold proactively.

**Architecture:** Three additions to existing infrastructure: (1) POST/GET API routes in Next.js that wrap the existing `autoCategorizeForTenant` lib, (2) post-save HTTP trigger in the Express expense backend, (3) `CategorizationReviewBanner` React component in the expense plugin frontend. No schema changes — existing `AbUserMemory[telegram:ai_categorize_pending]` and `AbPattern` cover everything.

**Tech Stack:** Next.js App Router API routes, Express (port 4051), React (expense plugin frontend), Prisma, Gemini LLM (via existing `autoCategorizeForTenant`)

**Spec:** `docs/superpowers/specs/2026-06-27-expense-auto-categorization-design.md`

---

## File Map

| File | Action | Purpose |
|---|---|---|
| `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/run/route.ts` | Create | POST — runs autoCategorizeForTenant for authenticated tenant |
| `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/pending/route.ts` | Create | GET — reads pending suggestions from AbUserMemory |
| `apps/web-next/src/app/api/v1/agentbook/cron/auto-categorize-watchdog/route.ts` | Create | Cron every 6h — enforces < 10% threshold across all tenants |
| `plugins/agentbook-expense/backend/src/server.ts` | Modify | Add `checkAndAutoCategorize` call after each expense save |
| `plugins/agentbook-expense/frontend/src/pages/ExpenseList.tsx` | Modify | Add `CategorizationReviewBanner` above expense list |
| `plugins/agentbook-core/backend/src/server.ts` | Modify | Replace keyword-loop in `categorize-expenses` handler with LLM endpoint call |
| `vercel.json` | Modify | Add `auto-categorize-watchdog` cron schedule |

---

### Task 1: POST /auto-categorize/run and GET /auto-categorize/pending routes

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/run/route.ts`
- Create: `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/pending/route.ts`

These are Next.js App Router API routes. Both are gated: `run` accepts either a user Bearer token (web callers) OR `x-internal-cron: <CRON_SECRET>` (Express backends and crons). `pending` only accepts user tokens.

Context: `autoCategorizeForTenant` lives at `apps/web-next/src/lib/agentbook-auto-categorize.ts`. It's `server-only`. It has a 20h dedupe keyed by `telegram:last_auto_categorize` in `AbUserMemory`. Pass `{ force: true }` to bypass the dedupe (needed for the watchdog). `getPendingSuggestions` reads `AbUserMemory[telegram:ai_categorize_pending]`.

Auth helper to copy from any existing route: `import { safeResolveAgentbookTenant } from '@/lib/agentbook-server-auth';`

- [ ] **Step 1: Write failing test for POST /run**

Create `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/run/route.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/agentbook-auto-categorize', () => ({
  autoCategorizeForTenant: vi.fn().mockResolvedValue({ appliedCount: 3, pending: [], skippedCount: 1 }),
}));
vi.mock('@/lib/agentbook-server-auth', () => ({
  safeResolveAgentbookTenant: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
}));

describe('POST /auto-categorize/run', () => {
  it('returns 200 with appliedCount on success', async () => {
    const { POST } = await import('./route');
    const req = new NextRequest('http://localhost/api/v1/agentbook-core/auto-categorize/run', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    });
    const res = await POST(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.appliedCount).toBe(3);
  });

  it('accepts internal cron header instead of bearer', async () => {
    const { safeResolveAgentbookTenant } = await import('@/lib/agentbook-server-auth');
    (safeResolveAgentbookTenant as any).mockResolvedValueOnce({ response: new Response('', { status: 401 }) });
    const { POST } = await import('./route');
    process.env.CRON_SECRET = 'secret';
    const req = new NextRequest('http://localhost/api/v1/agentbook-core/auto-categorize/run', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant-1', 'x-internal-cron': 'secret' },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    delete process.env.CRON_SECRET;
  });
});
```

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-core/auto-categorize/run/route.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 2: Implement POST /auto-categorize/run**

Create `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/run/route.ts`:

```typescript
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { autoCategorizeForTenant } from '@/lib/agentbook-auto-categorize';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-server-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isCronRequest(request: NextRequest): { ok: boolean; tenantId?: string } {
  const cronSecret = process.env.CRON_SECRET;
  const provided = request.headers.get('x-internal-cron');
  const tenantId = request.headers.get('x-tenant-id');
  if (!cronSecret || !provided || !tenantId) return { ok: false };
  const a = Buffer.from(provided);
  const b = Buffer.from(cronSecret);
  if (a.length !== b.length) return { ok: false };
  return timingSafeEqual(a, b) ? { ok: true, tenantId } : { ok: false };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Allow either user auth or internal cron header
  const cron = isCronRequest(request);
  let tenantId: string;

  if (cron.ok && cron.tenantId) {
    tenantId = cron.tenantId;
  } else {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    tenantId = resolved.tenantId;
  }

  // force=true bypasses the 20h dedupe when called from the watchdog
  const force = cron.ok;
  const result = await autoCategorizeForTenant(tenantId, { force });

  return NextResponse.json({
    success: true,
    data: {
      appliedCount: result.appliedCount,
      pendingCount: result.pending.length,
      skippedCount: result.skippedCount,
    },
  });
}
```

- [ ] **Step 3: Run test — expect pass**

`cd apps/web-next && npx vitest run src/app/api/v1/agentbook-core/auto-categorize/run/route.test.ts`
Expected: PASS

- [ ] **Step 4: Write failing test for GET /pending**

Create `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/pending/route.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/agentbook-auto-categorize', () => ({
  getPendingSuggestions: vi.fn().mockResolvedValue([
    {
      expenseId: 'exp-1', vendorName: 'Figma', amountCents: 1500, date: new Date('2026-06-15'),
      description: 'Figma Pro', suggestedCategoryId: 'cat-1',
      suggestedCategoryName: 'Software & Subscriptions', confidence: 0.73, reason: 'SaaS tool',
    },
  ]),
}));
vi.mock('@naap/database', () => ({ prisma: { abExpense: { count: vi.fn().mockResolvedValue(48) } } }));
vi.mock('@/lib/agentbook-server-auth', () => ({
  safeResolveAgentbookTenant: vi.fn().mockResolvedValue({ tenantId: 'tenant-1' }),
}));

describe('GET /auto-categorize/pending', () => {
  it('returns pending items with uncategorized counts', async () => {
    const { GET } = await import('./route');
    const req = new NextRequest('http://localhost/api/v1/agentbook-core/auto-categorize/pending', {
      headers: { Authorization: 'Bearer test-token' },
    });
    const res = await GET(req);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.items).toHaveLength(1);
    expect(body.data.items[0].vendorName).toBe('Figma');
    expect(body.data.totalCount).toBe(48);
  });
});
```

Run: `cd apps/web-next && npx vitest run src/app/api/v1/agentbook-core/auto-categorize/pending/route.test.ts`
Expected: FAIL

- [ ] **Step 5: Implement GET /auto-categorize/pending**

Create `apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/pending/route.ts`:

```typescript
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { getPendingSuggestions } from '@/lib/agentbook-auto-categorize';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-server-auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const resolved = await safeResolveAgentbookTenant(request);
  if ('response' in resolved) return resolved.response;
  const { tenantId } = resolved;

  const [items, totalCount, uncategorizedCount] = await Promise.all([
    getPendingSuggestions(tenantId),
    db.abExpense.count({ where: { tenantId, isPersonal: false } }),
    db.abExpense.count({ where: { tenantId, isPersonal: false, categoryId: null } }),
  ]);

  // Filter out items whose expense was already categorized (stale suggestions)
  const expenseIds = items.map((i) => i.expenseId);
  const stillUncategorized = expenseIds.length > 0
    ? await db.abExpense.findMany({
        where: { id: { in: expenseIds }, categoryId: null, tenantId },
        select: { id: true },
      })
    : [];
  const stillUncatSet = new Set(stillUncategorized.map((e) => e.id));
  const freshItems = items.filter((i) => stillUncatSet.has(i.expenseId));

  const uncategorizedPct = totalCount > 0 ? (uncategorizedCount / totalCount) * 100 : 0;

  return NextResponse.json({
    success: true,
    data: { items: freshItems, uncategorizedCount, totalCount, uncategorizedPct },
  });
}
```

- [ ] **Step 6: Run test — expect pass**

`cd apps/web-next && npx vitest run src/app/api/v1/agentbook-core/auto-categorize/pending/route.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-core/auto-categorize/
git commit -m "feat(auto-cat): add /auto-categorize/run and /pending API routes"
```

---

### Task 2: Post-save trigger in expense backend

**File:** `plugins/agentbook-expense/backend/src/server.ts` (modify 3 call sites)

The Express backend (port 4051) cannot import `server-only` Next.js modules. It makes a non-blocking HTTP call to `POST /api/v1/agentbook-core/auto-categorize/run` after expense saves that result in uncategorized items.

- [ ] **Step 1: Add `checkAndAutoCategorize` helper function**

Find the start of the exports section in `plugins/agentbook-expense/backend/src/server.ts` (around line 3, where `const app = express()` starts, or in the utilities section). Add the function before the first route handler, after the imports block:

```typescript
async function checkAndAutoCategorize(tenantId: string): Promise<void> {
  try {
    const [total, uncategorized] = await Promise.all([
      db.abExpense.count({ where: { tenantId, isPersonal: false } }),
      db.abExpense.count({ where: { tenantId, isPersonal: false, categoryId: null } }),
    ]);
    if (total === 0 || uncategorized / total <= 0.10) return;
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
    await fetch(`${baseUrl}/api/v1/agentbook-core/auto-categorize/run`, {
      method: 'POST',
      headers: {
        'x-tenant-id': tenantId,
        'x-internal-cron': process.env.CRON_SECRET || '',
      },
    });
  } catch (err) {
    console.warn('[expense] checkAndAutoCategorize failed (best-effort):', err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 2: Add trigger after record-expense**

At line ~251 in `server.ts`, the record-expense handler ends with:
```typescript
    res.status(201).json({
      success: true,
      data: expense,
```

After `res.status(201).json(...)` closes (after the `});` for `meta`), add:
```typescript
    // Non-blocking — fire and forget. Watchdog catches within 6h if this fails.
    void checkAndAutoCategorize(tenantId);
```

- [ ] **Step 3: Add trigger after Plaid/CSV import batch**

In the CSV import handler (around line 1614), after:
```typescript
    res.json({ success: true, data: { imported: imported.length, ... } });
```
Add:
```typescript
    void checkAndAutoCategorize(tenantId);
```

In the CC statement import handler (around line 2451), after:
```typescript
    res.json({ success: true, data: results });
```
Add:
```typescript
    void checkAndAutoCategorize(tenantId);
```

- [ ] **Step 4: Smoke test locally**

Start the expense backend: `DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" PORT=4051 npx tsx plugins/agentbook-expense/backend/src/server.ts`

```bash
curl -s -X POST http://localhost:4051/api/v1/agentbook-expense/expenses \
  -H "Content-Type: application/json" \
  -H "x-tenant-id: $(cat agentbook/users.md | grep maya | head -1)" \
  -d '{"amountCents":1500,"vendor":"Figma","date":"2026-06-27","description":"Figma Pro"}' \
  | jq .success
```

Expected: `true` — and no crash. The `checkAndAutoCategorize` call will fail silently if Next.js is not running (that's expected).

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-expense/backend/src/server.ts
git commit -m "feat(auto-cat): add post-save threshold trigger to expense backend"
```

---

### Task 3: Watchdog cron + vercel.json

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook/cron/auto-categorize-watchdog/route.ts`
- Modify: `vercel.json`

Pattern to follow: `apps/web-next/src/app/api/v1/agentbook/cron/proactive-alerts/route.ts` — same bearer gate, same Prisma-direct pattern, same `sendToAllChannels` import.

- [ ] **Step 1: Create the watchdog cron route**

```typescript
// apps/web-next/src/app/api/v1/agentbook/cron/auto-categorize-watchdog/route.ts
import 'server-only';
import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { autoCategorizeForTenant } from '@/lib/agentbook-auto-categorize';
import { sendToAllChannels } from '@/lib/agentbook-chat-adapter';
import { reportError } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const NUDGE_KEY = 'auto_cat_watchdog_nudge';
const NUDGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function isBearerValid(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true; // dev mode
  const auth = request.headers.get('authorization');
  if (!auth) return false;
  const a = Buffer.from(auth);
  const b = Buffer.from(`Bearer ${cronSecret}`);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!isBearerValid(request)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  // Find all tenants with at least 1 expense
  const tenants = await db.abExpense.groupBy({
    by: ['tenantId'],
    _count: { id: true },
    having: { id: { _count: { gt: 0 } } },
  });

  const results: { tenantId: string; action: string }[] = [];

  for (const { tenantId } of tenants) {
    try {
      const [total, uncategorized] = await Promise.all([
        db.abExpense.count({ where: { tenantId, isPersonal: false } }),
        db.abExpense.count({ where: { tenantId, isPersonal: false, categoryId: null } }),
      ]);

      if (total === 0 || uncategorized / total <= 0.10) {
        results.push({ tenantId, action: 'skip' });
        continue;
      }

      // Run LLM categorizer (force=true bypasses 20h dedupe)
      await autoCategorizeForTenant(tenantId, { force: true });

      // Re-check after run
      const [total2, uncategorized2] = await Promise.all([
        db.abExpense.count({ where: { tenantId, isPersonal: false } }),
        db.abExpense.count({ where: { tenantId, isPersonal: false, categoryId: null } }),
      ]);

      if (total2 === 0 || uncategorized2 / total2 <= 0.10) {
        results.push({ tenantId, action: 'categorized' });
        continue;
      }

      // Still above threshold — remaining items are low-confidence. Send nudge (24h dedupe).
      const nudgeEvent = await db.abEvent.findFirst({
        where: { tenantId, eventType: 'auto_cat.watchdog_nudge' },
        orderBy: { createdAt: 'desc' },
      });
      const nudgedRecently = nudgeEvent && Date.now() - nudgeEvent.createdAt.getTime() < NUDGE_COOLDOWN_MS;

      if (!nudgedRecently) {
        const msg = `You have ${uncategorized2} uncategorized expenses — I couldn't auto-categorize them. Type 'categorize' or visit the Expenses page to review.`;
        await sendToAllChannels(tenantId, msg, { channel: 'telegram' });
        await db.abEvent.create({
          data: { tenantId, eventType: 'auto_cat.watchdog_nudge', actor: 'system', action: { uncategorized: uncategorized2, total: total2 } },
        });
        results.push({ tenantId, action: 'nudged' });
      } else {
        results.push({ tenantId, action: 'nudge_skipped_cooldown' });
      }
    } catch (err) {
      reportError(`[auto-cat-watchdog] tenant ${tenantId} failed`, err);
      results.push({ tenantId, action: 'error' });
    }
  }

  return NextResponse.json({ success: true, data: { processed: results.length, results } });
}
```

- [ ] **Step 2: Add cron to vercel.json**

The file is at `/Users/qianghan/Documents/mycodespace/a3p/vercel.json`. In the `crons` array, add:

```json
{ "path": "/api/v1/agentbook/cron/auto-categorize-watchdog", "schedule": "0 */6 * * *" }
```

Place it after the existing `skill-error-budget` entry (which also runs every 6 hours).

- [ ] **Step 3: Verify the file parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8')); console.log('OK')"
```

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook/cron/auto-categorize-watchdog/route.ts vercel.json
git commit -m "feat(auto-cat): add watchdog cron (every 6h) + vercel.json schedule"
```

---

### Task 4: CategorizationReviewBanner component + ExpenseList integration

**File:** `plugins/agentbook-expense/frontend/src/pages/ExpenseList.tsx`

The component is added inline in `ExpenseList.tsx` (no separate file needed — it's small enough). The banner:
- Polls `GET /api/v1/agentbook-core/auto-categorize/pending` on mount
- Shows if `items.length > 0` or `uncategorizedPct > 10`
- Per-item: Approve (calls `POST /expenses/:id/categorize`) or Different (dropdown)
- Approve all: batch approves all items
- Dismiss 24h: localStorage flag

The `POST /expenses/:id/categorize` endpoint already exists at port 4051. The banner calls it directly.

Note: The `categories` list for the "Different" picker already loads in `ExpenseList.tsx` via `fetch(\`${API}/category-summary\`)`. Reuse that data.

Note: The API base for the expense backend is set via the plugin SDK. Inspect how `ExpenseList.tsx` currently calls expense endpoints — it uses a pattern like:
```typescript
const API = window.__NAAP_CONFIG__?.expenseApiBase || 'http://localhost:4051/api/v1/agentbook-expense';
```
Look for the actual pattern in the file and use it. The auto-cat API lives in the Next.js app — use `window.location.origin + '/api/v1/agentbook-core/auto-categorize'` as the base.

- [ ] **Step 1: Add pending state and fetch to ExpenseList**

At the top of `ExpenseListPage` component (after the existing state declarations), add:

```typescript
// Auto-categorization pending suggestions
const [catPending, setCatPending] = useState<{
  items: Array<{
    expenseId: string; vendorName: string | null; amountCents: number;
    date: string; description: string | null; suggestedCategoryId: string;
    suggestedCategoryName: string; confidence: number; reason: string;
  }>;
  uncategorizedPct: number;
} | null>(null);
const [catDismissed, setCatDismissed] = useState(false);
```

In the `useEffect` that loads expenses, add a parallel fetch:

```typescript
const DISMISS_KEY = 'ab_cat_review_dismissed';
const dismissed = localStorage.getItem(DISMISS_KEY);
const isDismissed = dismissed && Date.now() - Number(dismissed) < 24 * 60 * 60 * 1000;
setCatDismissed(!!isDismissed);
if (!isDismissed) {
  fetch(`${window.location.origin}/api/v1/agentbook-core/auto-categorize/pending`, {
    headers: { Authorization: `Bearer ${window.__NAAP_AUTH_TOKEN__ || ''}` },
  })
    .then(r => r.json())
    .then(d => { if (d.success) setCatPending(d.data); })
    .catch(() => {});
}
```

Note: Check how `ExpenseList.tsx` currently attaches the auth token to fetch calls. It may use a helper from `@naap/plugin-sdk`. Match that pattern exactly.

- [ ] **Step 2: Add `CategorizationReviewBanner` inline component**

Add before the `ExpenseListPage` function declaration:

```typescript
function confidenceColor(c: number): string {
  if (c >= 0.80) return 'text-green-600 bg-green-50 border-green-200';
  if (c >= 0.65) return 'text-yellow-600 bg-yellow-50 border-yellow-200';
  return 'text-orange-600 bg-orange-50 border-orange-200';
}

interface CatItem {
  expenseId: string; vendorName: string | null; amountCents: number;
  suggestedCategoryId: string; suggestedCategoryName: string;
  confidence: number; reason: string;
  description: string | null;
}

function CategorizationReviewBanner({
  items, expenseApiBase, autoCatBase, token,
  onApproved, onDismiss,
  categories,
}: {
  items: CatItem[];
  expenseApiBase: string;
  autoCatBase: string;
  token: string;
  onApproved: (expenseId: string) => void;
  onDismiss: () => void;
  categories: Array<{ id: string; name: string }>;
}) {
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [approving, setApproving] = useState<Set<string>>(new Set());

  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const approve = async (item: CatItem) => {
    setApproving(prev => new Set(prev).add(item.expenseId));
    const catId = overrides[item.expenseId] ?? item.suggestedCategoryId;
    try {
      await fetch(`${expenseApiBase}/expenses/${item.expenseId}/categorize`, {
        method: 'POST', headers,
        body: JSON.stringify({ categoryId: catId, source: 'agent_confirmed' }),
      });
      onApproved(item.expenseId);
    } finally {
      setApproving(prev => { const s = new Set(prev); s.delete(item.expenseId); return s; });
    }
  };

  const approveAll = async () => {
    for (const item of items) await approve(item);
  };

  if (items.length === 0) return null;

  return (
    <div className="mb-4 rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-semibold">
          AI suggested categories for {items.length} expense{items.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground"
          aria-label="Dismiss for 24 hours"
        >
          Dismiss for 24h ×
        </button>
      </div>

      <div className="space-y-3">
        {items.map(item => {
          const amt = (item.amountCents / 100).toFixed(2);
          const isApproving = approving.has(item.expenseId);
          const selectedCat = overrides[item.expenseId] ?? item.suggestedCategoryId;
          const selectedCatName = categories.find(c => c.id === selectedCat)?.name ?? item.suggestedCategoryName;
          return (
            <div key={item.expenseId} className="flex items-center gap-3 flex-wrap">
              <span className="text-sm font-medium w-20 shrink-0">${amt}</span>
              <span className="text-sm text-muted-foreground flex-1 min-w-0 truncate">
                {item.description || item.vendorName || 'Expense'}
              </span>
              <span className="text-sm">→ {selectedCatName}</span>
              <span className={`text-xs border rounded px-1.5 py-0.5 font-medium ${confidenceColor(item.confidence)}`}>
                {Math.round(item.confidence * 100)}%
              </span>
              <button
                onClick={() => approve(item)}
                disabled={isApproving}
                className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {isApproving ? '...' : '✓ Approve'}
              </button>
              <select
                value={selectedCat}
                onChange={e => setOverrides(prev => ({ ...prev, [item.expenseId]: e.target.value }))}
                className="text-xs border rounded px-1 py-1"
              >
                {categories.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="flex gap-2 mt-3 pt-3 border-t border-border">
        <button
          onClick={approveAll}
          className="text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground hover:bg-primary/90"
        >
          Approve all
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Wire banner into render**

In the JSX of `ExpenseListPage`, find the expense list section. Add the banner above the expense table:

```typescript
{catPending && !catDismissed && catPending.items.length > 0 && (
  <CategorizationReviewBanner
    items={catPending.items}
    expenseApiBase={/* same API base used elsewhere in this file */}
    autoCatBase={`${window.location.origin}/api/v1/agentbook-core/auto-categorize`}
    token={/* same auth token used elsewhere in this file */}
    categories={/* map categorySummary to { id, name } or load separately */}
    onApproved={(expenseId) => {
      setCatPending(prev =>
        prev ? { ...prev, items: prev.items.filter(i => i.expenseId !== expenseId) } : prev
      );
    }}
    onDismiss={() => {
      localStorage.setItem('ab_cat_review_dismissed', String(Date.now()));
      setCatDismissed(true);
    }}
  />
)}
```

Note: `categories` — the existing `categorySummary` state has `{ categoryId, categoryName }`. Map it:
```typescript
categories={categorySummary.map(c => ({ id: c.categoryId!, name: c.categoryName }))}
```

- [ ] **Step 4: Build the expense frontend**

```bash
cd plugins/agentbook-expense/frontend && npm run build
cp dist/production/agentbook-expense.js ../../apps/web-next/public/cdn/plugins/agentbook-expense/agentbook-expense.js
cp dist/production/agentbook-expense.js ../../apps/web-next/public/cdn/plugins/agentbook-expense/1.0.0/agentbook-expense.js
```

- [ ] **Step 5: Start Next.js locally and verify banner renders**

Start the dev server if not running: `cd apps/web-next && NODE_OPTIONS="--max-old-space-size=4096" npm run dev`

Log in as maya (`maya@agentbook.test` / `agentbook123`), navigate to Expenses. The banner should appear if there are pending suggestions (run `POST /api/v1/agentbook-core/auto-categorize/run` first to generate them). Verify:
- Banner shows items with vendor name, amount, suggested category, confidence %
- Approve button calls `/expenses/:id/categorize` and removes the item from the banner
- "Different" dropdown lets you pick another category
- "Approve all" approves all remaining items
- "Dismiss for 24h" hides the banner and re-shows after 24 hours

- [ ] **Step 6: Commit**

```bash
git add plugins/agentbook-expense/frontend/src/pages/ExpenseList.tsx \
        plugins/agentbook-expense/frontend/dist/ \
        apps/web-next/public/cdn/plugins/agentbook-expense/
git commit -m "feat(auto-cat): add CategorizationReviewBanner to Expenses page"
```

---

### Task 5: Upgrade `categorize-expenses` chat skill

**File:** `plugins/agentbook-core/backend/src/server.ts`

Replace the keyword-matching loop in the `categorize-expenses` inline handler (lines ~3724–3819) with a call to the `/auto-categorize/run` Next.js endpoint, then reads the pending suggestions to build the response.

- [ ] **Step 1: Replace the categorize-expenses handler body**

Find the handler at line 3725. Replace the entire try block contents (lines 3726–3818) with:

```typescript
    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const H = brainHeaders(tenantId);

      // Run the LLM auto-categorizer via Next.js route (force=true bypasses dedupe)
      const runRes = await fetch(`${baseUrl}/api/v1/agentbook-core/auto-categorize/run`, {
        method: 'POST',
        headers: { 'x-tenant-id': tenantId, 'x-internal-cron': process.env.CRON_SECRET || '' },
      });
      const runData = await runRes.json() as { success: boolean; data?: { appliedCount: number; pendingCount: number; skippedCount: number } };

      const applied = runData.data?.appliedCount ?? 0;
      const pendingCount = runData.data?.pendingCount ?? 0;
      const skipped = runData.data?.skippedCount ?? 0;

      let message: string;
      if (applied === 0 && pendingCount === 0 && skipped === 0) {
        message = 'All your expenses are already categorized!';
      } else if (pendingCount === 0) {
        message = `Applied **${applied}** categories automatically. All expenses are now categorized!`;
      } else {
        message = `Applied **${applied}** categories automatically. **${pendingCount}** expense${pendingCount !== 1 ? 's' : ''} need your input — check the Expenses page or type 'review expenses' here to walk through them.`;
      }

      // For Telegram: include the first 2 pending items inline
      if (pendingCount > 0 && channel === 'telegram') {
        const pendingRes = await fetch(`${baseUrl}/api/v1/agentbook-core/auto-categorize/pending`, {
          headers: { 'x-tenant-id': tenantId, 'x-internal-cron': process.env.CRON_SECRET || '' },
        });
        if (pendingRes.ok) {
          const pendingData = await pendingRes.json() as { success: boolean; data?: { items: Array<{ vendorName: string | null; amountCents: number; suggestedCategoryName: string; confidence: number }> } };
          const previewItems = pendingData.data?.items?.slice(0, 2) ?? [];
          if (previewItems.length > 0) {
            const preview = previewItems.map(i =>
              `• $${(i.amountCents / 100).toFixed(2)} ${i.vendorName || 'expense'} → ${i.suggestedCategoryName} (${Math.round(i.confidence * 100)}%)`
            ).join('\n');
            message += '\n\n' + preview;
            if (pendingCount > 2) message += `\n...and ${pendingCount - 2} more.`;
          }
        }
      }

      await db.abConversation.create({
        data: { tenantId, question: text || '[categorize]', answer: message, queryType: 'agent', channel, skillUsed: 'categorize-expenses' },
      });
      await db.abEvent.create({
        data: { tenantId, eventType: 'agent.message', actor: 'user', action: { skillUsed: 'categorize-expenses', applied, pendingCount, skipped, channel } },
      });

      return {
        selectedSkill, extractedParams, confidence, skillUsed: selectedSkill.name, skillResponse: null,
        responseData: { message, skillUsed: 'categorize-expenses', confidence, latencyMs: Date.now() - startTime },
      };
```

Keep the `} catch (err) {` block unchanged.

Note: The `GET /pending` route only accepts user Bearer tokens (not internal cron header). You need to pass the Bearer token for that call. Look at how other INTERNAL handlers call Next.js endpoints in the same file — if there's no established pattern, pass the tenant's Bearer token from `H` (the `brainHeaders` object, which includes the Authorization header).

Actually, modify the `/pending` call to use `H` headers directly:
```typescript
        const pendingRes = await fetch(`${baseUrl}/api/v1/agentbook-core/auto-categorize/pending`, {
          headers: H,
        });
```

- [ ] **Step 2: Restart agentbook-core backend and seed skills**

```bash
# Kill existing backend if running
pkill -f "npx tsx plugins/agentbook-core" || true

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/naap" PORT=4050 npx tsx plugins/agentbook-core/backend/src/server.ts &

# Wait 3 seconds for startup
sleep 3

# Re-seed skills
curl -s -X POST http://localhost:4050/api/v1/agentbook-core/agent/seed-skills \
  -H "Content-Type: application/json" | jq .success
```

Expected: `true`

- [ ] **Step 3: Test via chat**

Send "categorize my expenses" via the web chat or Telegram. Verify response mentions how many were applied and how many need input.

- [ ] **Step 4: Commit**

```bash
git add plugins/agentbook-core/backend/src/server.ts
git commit -m "feat(auto-cat): replace keyword-loop in categorize-expenses with LLM auto-categorizer"
```

---

### Task 6: Build core frontend + deploy

- [ ] **Step 1: Build agentbook-core frontend**

```bash
cd plugins/agentbook-core/frontend && npm run build
cp dist/production/agentbook-core.js ../../apps/web-next/public/cdn/plugins/agentbook-core/agentbook-core.js
cp dist/production/agentbook-core.js ../../apps/web-next/public/cdn/plugins/agentbook-core/1.0.0/agentbook-core.js
```

- [ ] **Step 2: Run vercel build locally**

```bash
cd apps/web-next && npx vercel build --prod 2>&1 | tail -20
```

Expected: build completes with no errors.

- [ ] **Step 3: Deploy**

```bash
cd apps/web-next && npx vercel deploy --prebuilt --prod
```

- [ ] **Step 4: Smoke test production**

1. Log in as maya on the production URL
2. Navigate to Expenses — verify banner appears if there are pending suggestions
3. Approve one item — verify it disappears from banner
4. Open Telegram bot, type "categorize my expenses" — verify LLM response
5. Wait for or manually trigger the watchdog cron: `curl -s -H "Authorization: Bearer $CRON_SECRET" https://<prod-url>/api/v1/agentbook/cron/auto-categorize-watchdog`

- [ ] **Step 5: Commit any build artifacts**

```bash
git add apps/web-next/public/cdn/plugins/
git commit -m "chore: rebuild plugin bundles for auto-cat release"
```
