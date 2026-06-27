# Chat Improvements Design

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this spec task-by-task.

**Goal:** Persistent chat history, per-channel session isolation with shared long-term memory, a daily briefing skill, and a sharper accountant persona across all chat surfaces (web, Telegram, WhatsApp).

**Architecture:** Thread-centric — `AbConvThread` becomes the brain's short-term context store per channel. One active row per `[tenantId, channel, chatId]`. `AbUserMemory` stays cross-channel. `AbConversation` is kept for analytics/audit.

**Affected areas:** `packages/database/prisma/schema.prisma`, `plugins/agentbook-core/backend/src/agent-brain.ts`, `plugins/agentbook-core/backend/src/built-in-skills.ts`, `plugins/agentbook-core/backend/src/server.ts`, `plugins/agentbook-core/frontend/src/pages/Chat.tsx`

---

## 1. Schema Change

Add a `@@unique` constraint to `AbConvThread` so upserts are race-safe:

```prisma
@@unique([tenantId, channel, chatId])  // add — currently only @@index
@@index([tenantId, channel, chatId, status])  // keep
```

Run `prisma db push` (non-breaking — adds constraint, no column changes).

**Thread lifecycle:** One thread per `[tenantId, channel, chatId]` forever. Threads are never closed or archived in this implementation — history is compressed via `summary` so the row stays lean. `status` field remains `'active'` permanently; the `@@index` on status is kept for future use.

---

## 2. Agent Brain — Thread-Centric Context

**File:** `plugins/agentbook-core/backend/src/agent-brain.ts`

Replace the `AbConversation` load in Step 2 with an `AbConvThread` lookup:

```
findFirst({ where: { tenantId, channel, chatId, status: 'active' } })
```

- `chatId` = tenantId for `channel='web'`, Telegram `chat.id` (as string) for `channel='telegram'`
- If no active thread: create one (`status: 'active'`, `startedAt: now`)
- Use `thread.turns` (array of `{role, text, at, intent?}`) as conversation context
- Append to `thread.turns` after each exchange: user turn + agent turn
- If `thread.turns.length > 8`: compress oldest 4 turns into `thread.summary` via Gemini (or simple concatenation if LLM unavailable), then drop them from `turns`. Cap fallback at 12 turns if Gemini unreachable.
- Update `thread.lastActiveAt` on every message
- Continue writing `AbConversation` row unchanged (backward compat for analytics)

**Cross-channel memory:** `AbUserMemory` query has no channel filter — leave it unchanged. All channels benefit from learned vendor aliases, shortcuts, and context memories.

---

## 3. New API Endpoint — Thread Inbox

**File:** `plugins/agentbook-core/backend/src/server.ts`

```
GET /api/v1/agentbook-core/threads
```

Optional query params: `?channel=web|telegram|api` (filter by channel), `?status=active` (filter by status). Returns all threads for the tenant ordered by `lastActiveAt desc` when no params supplied:

```json
{
  "success": true,
  "data": [
    {
      "id": "...",
      "channel": "web",
      "chatId": "maya-consultant",
      "status": "active",
      "lastActiveAt": "2026-06-26T...",
      "summary": "...",
      "lastTurn": { "role": "agent", "text": "...", "at": "..." }
    }
  ]
}
```

---

## 4. Daily Briefing Skill

**File:** `plugins/agentbook-core/backend/src/built-in-skills.ts`

Add before `general-question`:

```typescript
{
  name: 'daily-briefing',
  description: 'Morning financial briefing — cash position, alerts, outstanding invoices, what needs attention today',
  category: 'finance',
  triggerPatterns: [
    'briefing', 'daily.*brief', 'morning.*update', 'catch.*me.*up',
    'what.*s.*up', 'update.*me', 'what.*s.*happening', 'quick.*update',
    'daily.*summary', 'morning.*brief',
  ],
  parameters: {},
  endpoint: { method: 'INTERNAL', url: '' },
},
```

**Inline handler** in `classifyAndExecuteV1` (before the HTTP execution block):

```typescript
if (classification.skill === 'daily-briefing') {
  const [snapshot, alerts] = await Promise.allSettled([
    fetch(`${baseUrls['/api/v1/agentbook-core']}/api/v1/agentbook-core/financial-snapshot`, { headers }),
    fetch(`${baseUrls['/api/v1/agentbook-expense']}/api/v1/agentbook-expense/advisor/proactive-alerts`, { headers }),
  ]);
  const snapshotData = snapshot.status === 'fulfilled' ? await snapshot.value.json() : null;
  const alertsData  = alerts.status  === 'fulfilled' ? await alerts.value.json()  : null;

  const briefingPrompt = `You are a friendly small-business accountant giving a morning briefing.
Summarize the financial snapshot and alerts below in 3–5 short sentences.
Be specific with dollar amounts. End with one concrete action item.
If data is missing, say what's unavailable and focus on what you have.`;

  const userMsg = [
    snapshotData?.success ? `Financial snapshot: ${JSON.stringify(snapshotData.data)}` : 'Financial snapshot unavailable.',
    alertsData?.success   ? `Alerts: ${JSON.stringify(alertsData.data)}`               : 'Alerts unavailable.',
  ].join('\n');

  const reply = await callGemini(briefingPrompt, userMsg, 300) 
    ?? "Here's a quick look: I couldn't reach all your financial data right now. Try again in a moment.";
  return { message: reply, skillUsed: 'daily-briefing', confidence: 1.0 };
}
```

---

## 5. Intent Improvements

**File:** `plugins/agentbook-core/backend/src/built-in-skills.ts`

Extend `query-expenses` trigger patterns to catch "expense summary":

```typescript
triggerPatterns: [
  'show.*expense', 'list.*expense', 'last \\d+ expense',
  'how much.*spen', 'recent expense', 'summary.*expense',
  'expense.*summary', 'expense.*overview', 'spending.*summary',  // ADD
],
```

**File:** `plugins/agentbook-core/backend/src/agent-brain.ts`

Add to `brainAccountantFallback` system prompt (append after the `AgentBook can:` line):

```
For summary or report requests (expense summary, monthly report, financial overview,
daily briefing, spending summary), NEVER ask for clarification — always run the report
for the current month as the default and present the results immediately.
```

---

## 6. Web Inbox — Sessions Panel

**File:** `plugins/agentbook-core/frontend/src/pages/Chat.tsx`

Split into two zones:

**Left — `SessionsPanel` (collapsible, 240 px wide on desktop, drawer on mobile)**
- Fetches `GET /api/v1/agentbook-core/threads` on mount
- Groups threads by channel: Web (globe icon), Telegram (paper-plane icon), WhatsApp (phone icon)
- Each thread row: channel icon + last-turn preview (truncated to 60 chars) + relative timestamp
- Active web thread is highlighted; clicking it does nothing (already active)
- Clicking any other thread opens it in read-only view: the right panel shows that thread's `turns` but the input is disabled with a banner: *"Viewing [Telegram] history — type below to chat on Web."*
- Panel toggle button (hamburger / chevron) in header

**Right — chat area (unchanged layout)**
- On mount: fetch active web thread via `GET /api/v1/agentbook-core/threads?channel=web&status=active` and pre-populate `messages` from `thread.turns`
- If no active thread yet: show empty state as today (no change to UX)

---

## 7. Error Handling

| Scenario | Behaviour |
|---|---|
| Thread create race (two concurrent first messages) | Upsert on `@@unique([tenantId, channel, chatId])` — last writer wins safely |
| Gemini compression unavailable | Cap `turns` at 12, skip summary compression, log warning |
| `daily-briefing` partial failure | Present available data; note what's missing |
| Historical thread view | Input disabled; banner explains active channel |
| No thread history (new tenant) | Empty state unchanged — existing welcome screen shown |
| Telegram chatId not in brain call | Passed from webhook as `chatId: String(update.message.chat.id)` — webhook already has it |

---

## 8. Telegram Webhook Update

**File:** `apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts`

Pass `chatId` alongside existing `channel: 'telegram'` to `handleAgentMessage`:

```typescript
// Already sends channel: 'telegram' — add chatId:
await handleAgentMessage({ text, tenantId, channel: 'telegram', chatId: String(message.chat.id), attachments }, ctx);
```

Update `AgentRequest` interface in `agent-brain.ts` to add `chatId?: string`.

---

## 9. Rebuild & Deploy

After backend changes: restart agentbook-core backend (port 4050) and run `POST /api/v1/agentbook-core/agent/seed-skills` to upsert the new `daily-briefing` skill.

After frontend changes: rebuild core plugin bundle and copy to `apps/web-next/public/cdn/plugins/agentbook-core/`.

Run `vercel build --prod && vercel deploy --prebuilt --prod`.
