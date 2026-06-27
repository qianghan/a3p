# Chatbot Setup UI — Design Spec

**Date:** 2026-06-26
**Status:** Approved
**Feature:** #2 — Core plugin chatbot configuration UI (Telegram, WhatsApp) + chat history viewer

---

## Problem

The Telegram bot setup page exists at `/agentbook/telegram` but is not reachable from any in-app navigation. Users who want to connect their Telegram bot have no path to find it. WhatsApp has no integration yet. Both channels need a discoverable home.

---

## Decision

Add a **"Chatbots" tab** to the existing `SettingsPage` (alongside "Business Profile" and "Invoice Defaults"). The tab shows stacked channel cards — one per supported channel. Telegram is fully functional; WhatsApp is a dimmed "coming soon" placeholder.

---

## UI Design

### Tab structure (SettingsPage)

```
Settings
  ├── Business Profile   (existing)
  ├── Invoice Defaults   (existing)
  └── Chatbots           ← new
```

The tab bar gains a third entry. Active tab is highlighted with the primary green underline, matching existing tab style.

### Chatbots tab — channel cards

Two stacked cards, full width, gap between them.

#### Telegram card — not connected

```
┌─────────────────────────────────────────────┐
│  [✈️ icon]  Telegram                Not connected  │
│             Connect to record expenses via chat   │
├─────────────────────────────────────────────┤
│  Setup steps                                      │
│  1. Open @BotFather in Telegram                   │
│  2. Send /newbot and follow prompts               │
│  3. Copy the API token and paste below            │
│                                                   │
│  [ Paste bot token… _____________ ] [ Connect ]  │
└─────────────────────────────────────────────┘
```

- Token input is `type="password"`, monospace font
- Connect button disabled while input is empty
- Error banner appears inline below input on failure
- On success: card transitions to connected state (no page reload)

#### Telegram card — connected

```
┌─────────────────────────────────────────────┐
│  [✈️ icon]  Telegram    @agentbookdev_bot  ● Connected │
├─────────────────────────────────────────────┤
│  [ Webhook: ● Active ]  [ Linked chats: 1 ]          │
│                                                       │
│  Quick start                                          │
│  Open bot → send /start → type expenses naturally    │
│                                                       │
│  Open in Telegram ↗                    [Disconnect]  │
└─────────────────────────────────────────────┘
```

- Webhook status pulled live from `GET /api/v1/agentbook-core/telegram/status`
- Refresh button (↻) re-fetches status
- Disconnect triggers `DELETE /api/v1/agentbook-core/telegram/disconnect` with confirm dialog

#### WhatsApp card — coming soon

```
┌─────────────────────────────────────────────┐
│  [💬 icon]  WhatsApp    Business API integration  Coming soon  │
└─────────────────────────────────────────────┘
```

- Entire card is dimmed (opacity 0.45), dashed border
- No interactivity — purely informational
- No backend wiring in this phase

---

## Architecture

### What changes

| File | Change |
|------|--------|
| `plugins/agentbook-core/frontend/src/pages/SettingsPage.tsx` | Add `'chatbots'` to tab union type; add Chatbots tab panel |
| `plugins/agentbook-core/frontend/src/components/TelegramCard.tsx` | **New** — extracts logic from `TelegramSettingsPage` into a card component |
| `plugins/agentbook-core/frontend/src/components/WhatsAppCard.tsx` | **New** — static coming-soon card |
| `plugins/agentbook-core/frontend/src/pages/TelegramSettings.tsx` | Route kept; renders `<TelegramCard />` with a back-link header (avoids dead route) |

### What does NOT change

- All backend API routes (`/telegram/setup`, `/telegram/status`, `/telegram/disconnect`) — unchanged
- Database schema — unchanged
- The `/agentbook/telegram` route — kept as-is, now delegates to `TelegramCard`

### TelegramCard component interface

```typescript
// No props needed — card fetches its own status on mount
export function TelegramCard(): JSX.Element
```

Internal state mirrors the existing `TelegramSettingsPage`:
- `status: BotStatus | null`
- `loading: boolean`
- `botToken: string`
- `error: string | null`
- `success: string | null`
- `saving: boolean`
- `disconnecting: boolean`

All API calls identical to the existing page. The only change is layout: card container instead of full-page container, no page-level `<h1>` header.

### SettingsPage tab state

```typescript
type SettingsTab = 'profile' | 'invoice' | 'chatbots';
const [tab, setTab] = useState<SettingsTab>('profile');
```

The `chatbots` tab panel renders `<TelegramCard />` and `<WhatsAppCard />` stacked with a gap.

---

## Routing

`/agentbook/telegram` stays in `App.tsx`. `TelegramSettingsPage` becomes a thin wrapper:

```tsx
export const TelegramSettingsPage = () => (
  <div className="max-w-2xl mx-auto px-4 py-6">
    <div className="mb-4 text-sm text-muted-foreground">
      ← <a href="/agentbook/settings" className="text-primary">Back to Settings</a>
    </div>
    <TelegramCard />
  </div>
);
```

Users who bookmarked the old URL still land on a working page.

---

## Error & Loading States

| State | Telegram card behaviour |
|-------|------------------------|
| Loading | Spinner centered in card body |
| API error on status fetch | Inline error with retry button |
| Token validation error | Red banner below token input |
| Setup success | Card transitions to connected state; green success flash |
| Disconnect confirm | `window.confirm()` before DELETE |
| Webhook error | Red "Error" badge with `lastError` message in a tooltip/collapsible |

---

## Styling

All classes use the shared dark-theme semantic tokens (`bg-card`, `border-border`, `text-foreground`, `bg-primary`, etc.) — same pattern as the billing plugin refactor. No hardcoded color values.

Connected card border: `border-primary/30` with subtle `bg-primary/5` tint to signal active state.
Coming-soon card: `border-dashed border-border/40`, `opacity-50`.

---

---

## Chat History Viewer (addendum)

### Problem

If a user loses access to their Telegram client (new device, account loss), all conversation history is gone from the client. Since `AbConversation` stores every message server-side, the web app can show a full searchable history as a backup.

### UI

Fourth tab added to Settings:

```
Settings
  ├── Business Profile
  ├── Invoice Defaults
  ├── Chatbots
  └── Chat History          ← new
```

**Chat History tab layout:**

```
┌─ Search ──────────────────────────────────────────────────┐
│  🔍  Search messages…                                      │
└────────────────────────────────────────────────────────────┘

[ All ]  [ Web ]  [ Telegram ]  [ API ]          50 messages

┌────────────────────────────────────────────────────────────┐
│  📱 Telegram  ·  record-expense  ·  Jun 26, 2:14 PM        │
│  You: Spent $45 on lunch with client                       │
│  Agent: ✓ Logged $45.00 — Meals & Entertainment            │
├────────────────────────────────────────────────────────────┤
│  💻 Web  ·  query-expenses  ·  Jun 26, 1:02 PM             │
│  You: Show me my expenses this month                       │
│  Agent: Here are your 12 expenses totalling $1,240…        │
├────────────────────────────────────────────────────────────┤
│  …                                                         │
└────────────────────────────────────────────────────────────┘

                        [ Load more ]
```

Each row shows:
- Channel badge (icon + label: Telegram / Web / API)
- Skill used (muted tag)
- Timestamp (relative: "2 hours ago", tooltip shows full date)
- Question (user message, truncated at 120 chars)
- Answer (agent response, truncated at 180 chars)
- Expand chevron → opens full message pair inline

Search highlights matched terms in yellow. Filter chips narrow by channel. Both are client-side on the loaded page; additional pages fetched via "Load more".

### Backend changes

Extend `GET /api/v1/agentbook-core/conversations` with:

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `limit` | number | 20 | Records per page |
| `cursor` | string | — | ISO date of oldest record on current page; returns records older than this |
| `channel` | string | — | Filter: `web`, `telegram`, `api` |
| `q` | string | — | Full-text search on `question` + `answer` (Postgres `ILIKE %q%`) |

Response shape (unchanged envelope):
```json
{
  "success": true,
  "data": {
    "items": [ ...AbConversation[] ],
    "nextCursor": "2026-06-20T10:00:00.000Z",
    "total": 50
  }
}
```

`total` is a `COUNT(*)` with the same `WHERE` clause (no cursor), used to show "50 messages" above the list.

### New route for search

Rather than mutating the existing GET (which returns a flat array and is consumed by other callers), add a dedicated search endpoint:

```
GET /api/v1/agentbook-core/conversations/search
  ?q=lunch
  &channel=telegram
  &cursor=2026-06-20T10:00:00.000Z
  &limit=20
```

The existing `/conversations` GET is left unchanged for backward compatibility.

### Frontend components

| Component | File | Purpose |
|-----------|------|---------|
| `ChatHistoryTab` | `pages/ChatHistoryTab.tsx` | Tab root — search bar, filter chips, list, pagination |
| `ConversationRow` | `components/ConversationRow.tsx` | Single expandable message pair |

`ChatHistoryTab` manages state: `query`, `channel`, `cursor`, `items[]`, `loading`, `hasMore`. Search is debounced 300 ms. Channel filter resets cursor and items.

---

## Out of Scope

- WhatsApp backend integration (no Twilio/Meta API wiring)
- Email/SMS chatbot channels
- Per-channel notification preferences
- Webhook URL display or manual override
- Full-text index (Postgres `tsvector`) — ILIKE is sufficient for current data volumes
