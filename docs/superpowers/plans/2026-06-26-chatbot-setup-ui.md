# Chatbot Setup UI + Chat History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Chatbots" tab and a "Chat History" tab to the Core plugin's Settings page — surfacing the existing Telegram bot setup as discoverable cards, adding a WhatsApp stub, and a searchable conversation log backed by the existing `AbConversation` DB table.

**Architecture:** Extract `TelegramCard` from the existing `TelegramSettingsPage`, compose it alongside a static `WhatsAppCard` inside a new "Chatbots" tab in `SettingsPage`. Add a new `GET /conversations/search` API route with `q`, `channel`, `cursor`, and `limit` params, then build `ChatHistoryTab` + `ConversationRow` components consuming it. The old `/agentbook/telegram` route becomes a thin wrapper around `TelegramCard` so no bookmarks break.

**Tech Stack:** React 19, Tailwind CSS (semantic dark-theme tokens), Vitest + @testing-library/react for tests, Next.js App Router API routes, Prisma (`AbConversation`).

---

## File Map

| Action | Path | Responsibility |
|--------|------|---------------|
| **Create** | `plugins/agentbook-core/frontend/src/components/TelegramCard.tsx` | Telegram bot status + connect/disconnect logic, card layout |
| **Create** | `plugins/agentbook-core/frontend/src/components/WhatsAppCard.tsx` | Static coming-soon card |
| **Create** | `plugins/agentbook-core/frontend/src/components/ConversationRow.tsx` | Single expandable message pair |
| **Create** | `plugins/agentbook-core/frontend/src/components/ChatHistoryTab.tsx` | Search bar, filter chips, list, pagination |
| **Create** | `plugins/agentbook-core/frontend/src/__tests__/TelegramCard.test.tsx` | Unit tests for TelegramCard states |
| **Create** | `plugins/agentbook-core/frontend/src/__tests__/ChatHistoryTab.test.tsx` | Unit tests for ChatHistoryTab search/filter |
| **Create** | `apps/web-next/src/app/api/v1/agentbook-core/conversations/search/route.ts` | GET with q, channel, cursor, limit |
| **Modify** | `plugins/agentbook-core/frontend/src/pages/SettingsPage.tsx` | Add `chatbots` + `chat-history` tabs, dark theme tab classes |
| **Modify** | `plugins/agentbook-core/frontend/src/pages/TelegramSettings.tsx` | Thin wrapper around `<TelegramCard />` |

---

## Task 1: Conversations search API

**Files:**
- Create: `apps/web-next/src/app/api/v1/agentbook-core/conversations/search/route.ts`

- [ ] **Step 1: Write the route**

```typescript
// apps/web-next/src/app/api/v1/agentbook-core/conversations/search/route.ts
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const { searchParams } = request.nextUrl;
    const q = searchParams.get('q')?.trim() ?? '';
    const channel = searchParams.get('channel') ?? '';
    const cursor = searchParams.get('cursor') ?? '';
    const limit = Math.min(parseInt(searchParams.get('limit') ?? '20', 10), 100);

    const where = {
      tenantId,
      ...(channel ? { channel } : {}),
      ...(q ? {
        OR: [
          { question: { contains: q, mode: 'insensitive' as const } },
          { answer:    { contains: q, mode: 'insensitive' as const } },
        ],
      } : {}),
      ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
    };

    const [items, total] = await Promise.all([
      db.abConversation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      db.abConversation.count({ where: { ...where, createdAt: undefined } }),
    ]);

    const nextCursor = items.length === limit
      ? items[items.length - 1].createdAt.toISOString()
      : null;

    return NextResponse.json({ success: true, data: { items, nextCursor, total } });
  } catch (err) {
    console.error('[conversations/search] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Smoke-test the route in the browser**

With the dev server running, navigate to:
```
/api/v1/agentbook-core/conversations/search?limit=5
```
Expected: `{ "success": true, "data": { "items": [...], "nextCursor": "...", "total": N } }`

- [ ] **Step 3: Commit**

```bash
git add apps/web-next/src/app/api/v1/agentbook-core/conversations/search/route.ts
git commit -m "feat(core): conversations/search API — q, channel, cursor, limit"
```

---

## Task 2: TelegramCard component

Extract the existing `TelegramSettingsPage` logic into a reusable card component with no page-level header.

**Files:**
- Create: `plugins/agentbook-core/frontend/src/components/TelegramCard.tsx`
- Create: `plugins/agentbook-core/frontend/src/__tests__/TelegramCard.test.tsx`

- [ ] **Step 1: Write failing tests**

```typescript
// plugins/agentbook-core/frontend/src/__tests__/TelegramCard.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { TelegramCard } from '../components/TelegramCard';

const mockFetch = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

function statusRes(data: object) {
  return Promise.resolve({ json: () => Promise.resolve({ success: true, data }) });
}

describe('TelegramCard', () => {
  it('shows connect form when not configured', async () => {
    mockFetch.mockReturnValue(statusRes({ configured: false }));
    render(<TelegramCard />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    expect(screen.getByPlaceholderText(/Paste bot token/i)).toBeTruthy();
    expect(screen.getByText(/Connect Bot/i)).toBeTruthy();
  });

  it('shows connected state with bot username', async () => {
    mockFetch.mockReturnValue(statusRes({
      configured: true,
      botUsername: 'agentbookdev_bot',
      webhookActive: true,
      chatIds: ['111'],
    }));
    render(<TelegramCard />);
    await waitFor(() => expect(screen.getByText(/@agentbookdev_bot/)).toBeTruthy());
    expect(screen.getByText(/Active/i)).toBeTruthy();
    expect(screen.getByText(/1/)).toBeTruthy(); // linked chats
  });

  it('disables Connect button when token is empty', async () => {
    mockFetch.mockReturnValue(statusRes({ configured: false }));
    render(<TelegramCard />);
    await waitFor(() => expect(screen.queryByText(/Loading/i)).toBeNull());
    const btn = screen.getByRole('button', { name: /Connect Bot/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd plugins/agentbook-core/frontend
npx vitest run src/__tests__/TelegramCard.test.tsx
```
Expected: FAIL — `TelegramCard` not found.

- [ ] **Step 3: Create TelegramCard**

```typescript
// plugins/agentbook-core/frontend/src/components/TelegramCard.tsx
import { useEffect, useState } from 'react';
import {
  Send, Key, Loader2, Trash2, RefreshCw,
  CheckCircle, XCircle, AlertCircle, ExternalLink,
} from 'lucide-react';

const API = '/api/v1/agentbook-core';

interface BotStatus {
  configured: boolean;
  enabled?: boolean;
  botUsername?: string;
  chatIds?: string[];
  webhookUrl?: string;
  webhookActive?: boolean | null;
  lastError?: string | null;
}

interface SetupResult {
  botUsername: string;
  botName: string;
  webhookRegistered: boolean;
  webhookUrl: string;
}

export function TelegramCard(): JSX.Element {
  const [status, setStatus]           = useState<BotStatus | null>(null);
  const [loading, setLoading]         = useState(true);
  const [saving, setSaving]           = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [botToken, setBotToken]       = useState('');
  const [error, setError]             = useState<string | null>(null);
  const [success, setSuccess]         = useState<string | null>(null);

  const fetchStatus = async (): Promise<void> => {
    try {
      const res = await fetch(`${API}/telegram/status`);
      const d = await res.json();
      if (d.success) setStatus(d.data);
    } catch {
      setError('Could not load Telegram status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void fetchStatus(); }, []);

  const handleSetup = async (): Promise<void> => {
    if (!botToken.trim() || !botToken.includes(':')) {
      setError('Enter a valid bot token (format: 123456789:ABCdef...)');
      return;
    }
    setSaving(true); setError(null); setSuccess(null);
    try {
      const res = await fetch(`${API}/telegram/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ botToken: botToken.trim() }),
      });
      const d = await res.json();
      if (d.success) {
        const result = d.data as SetupResult;
        setSuccess(`Connected to @${result.botUsername}!${result.webhookRegistered ? ' Webhook registered.' : ' Webhook needs manual setup.'}`);
        setBotToken('');
        await fetchStatus();
      } else {
        setError(d.error || 'Setup failed');
      }
    } catch {
      setError('Connection failed. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async (): Promise<void> => {
    if (!confirm('Disconnect your Telegram bot? You can reconnect anytime.')) return;
    setDisconnecting(true);
    try {
      await fetch(`${API}/telegram/disconnect`, { method: 'DELETE' });
      setStatus({ configured: false });
      setSuccess('Telegram bot disconnected.');
    } catch {
      setError('Could not disconnect. Please try again.');
    } finally {
      setDisconnecting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      {/* Card header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-blue-500/10 text-lg">✈️</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">Telegram</div>
          <div className="text-xs text-muted-foreground">Record expenses and manage finances via chat</div>
        </div>
        {status?.configured && (
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">
            ● Connected
          </span>
        )}
        {status !== null && !status.configured && (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
            Not connected
          </span>
        )}
      </div>

      <div className="px-4 py-4">
        {/* Alerts */}
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
            {error}
          </div>
        )}
        {success && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/10 p-3 text-sm text-foreground">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            {success}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : status?.configured ? (
          /* Connected state */
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-background px-3 py-2">
                <div className="text-xs text-muted-foreground">Webhook</div>
                <div className={`flex items-center gap-1.5 text-sm font-medium ${
                  status.webhookActive === true ? 'text-primary' :
                  status.webhookActive === false ? 'text-destructive' : 'text-muted-foreground'
                }`}>
                  {status.webhookActive === true ? <CheckCircle className="h-3.5 w-3.5" /> :
                   status.webhookActive === false ? <XCircle className="h-3.5 w-3.5" /> :
                   <AlertCircle className="h-3.5 w-3.5" />}
                  {status.webhookActive === true ? 'Active' :
                   status.webhookActive === false ? 'Error' : 'Unknown'}
                </div>
              </div>
              <div className="rounded-lg bg-background px-3 py-2">
                <div className="text-xs text-muted-foreground">Linked chats</div>
                <div className="text-sm font-medium text-foreground">
                  {(status.chatIds as string[])?.length ?? 0}
                </div>
              </div>
            </div>
            {status.lastError && (
              <div className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
                Last error: {status.lastError}
              </div>
            )}
            <div className="rounded-lg bg-background px-3 py-2">
              <div className="mb-1 text-xs font-medium text-muted-foreground">Quick start</div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                Open{' '}
                {status.botUsername && (
                  <a href={`https://t.me/${status.botUsername}`} target="_blank" rel="noopener noreferrer"
                    className="text-primary hover:underline">
                    @{status.botUsername}
                  </a>
                )}{' '}
                → send <code className="rounded bg-muted px-1 py-0.5">/start</code> → type expenses naturally
              </p>
            </div>
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-3">
                {status.botUsername && (
                  <a href={`https://t.me/${status.botUsername}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1 text-xs text-primary hover:underline">
                    Open in Telegram <ExternalLink className="h-3 w-3" />
                  </a>
                )}
                <button onClick={() => { void fetchStatus(); setError(null); setSuccess(null); }}
                  className="text-xs text-muted-foreground hover:text-foreground">
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              </div>
              <button onClick={() => void handleDisconnect()} disabled={disconnecting}
                className="flex items-center gap-1.5 text-xs text-destructive hover:text-destructive/80">
                {disconnecting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          /* Not connected state */
          <div className="space-y-3">
            <ol className="space-y-1.5 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs">1</span>
                Open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer"
                  className="mx-1 text-primary hover:underline">@BotFather</a> in Telegram
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs">2</span>
                Send <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">/newbot</code> and follow prompts
              </li>
              <li className="flex gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs">3</span>
                Copy the API token and paste below
              </li>
            </ol>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Key className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="password"
                  placeholder="Paste bot token here"
                  value={botToken}
                  onChange={e => { setBotToken(e.target.value); setError(null); }}
                  onKeyDown={e => e.key === 'Enter' && void handleSetup()}
                  className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
                />
              </div>
              <button
                onClick={() => void handleSetup()}
                disabled={saving || !botToken.trim()}
                className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {saving ? 'Connecting…' : 'Connect Bot'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd plugins/agentbook-core/frontend
npx vitest run src/__tests__/TelegramCard.test.tsx
```
Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/frontend/src/components/TelegramCard.tsx \
        plugins/agentbook-core/frontend/src/__tests__/TelegramCard.test.tsx
git commit -m "feat(core): TelegramCard component extracted from TelegramSettingsPage"
```

---

## Task 3: WhatsApp coming-soon card

**Files:**
- Create: `plugins/agentbook-core/frontend/src/components/WhatsAppCard.tsx`

- [ ] **Step 1: Create the component**

```typescript
// plugins/agentbook-core/frontend/src/components/WhatsAppCard.tsx
export function WhatsAppCard(): JSX.Element {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/50 bg-card px-4 py-3 opacity-50">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 text-lg">💬</div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-muted-foreground">WhatsApp</div>
        <div className="text-xs text-muted-foreground">Business API integration</div>
      </div>
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
        Coming soon
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/agentbook-core/frontend/src/components/WhatsAppCard.tsx
git commit -m "feat(core): WhatsAppCard coming-soon stub"
```

---

## Task 4: ConversationRow component

**Files:**
- Create: `plugins/agentbook-core/frontend/src/components/ConversationRow.tsx`

- [ ] **Step 1: Create the component**

```typescript
// plugins/agentbook-core/frontend/src/components/ConversationRow.tsx
import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface ConversationItem {
  id: string;
  question: string;
  answer: string;
  channel: string;        // "web" | "telegram" | "api"
  skillUsed: string | null;
  createdAt: string;      // ISO string
}

const CHANNEL_META: Record<string, { icon: string; label: string }> = {
  telegram: { icon: '✈️', label: 'Telegram' },
  web:      { icon: '💻', label: 'Web' },
  api:      { icon: '⚙️', label: 'API' },
};

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function highlight(text: string, q: string): JSX.Element {
  if (!q.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === q.toLowerCase()
          ? <mark key={i} className="rounded bg-yellow-400/30 text-foreground">{p}</mark>
          : p,
      )}
    </>
  );
}

export function ConversationRow({
  item,
  searchQuery = '',
}: {
  item: ConversationItem;
  searchQuery?: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const ch = CHANNEL_META[item.channel] ?? { icon: '🔗', label: item.channel };

  return (
    <div className="border-b border-border last:border-0">
      <button
        className="w-full px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{ch.icon} {ch.label}</span>
          {item.skillUsed && (
            <>
              <span className="text-border">·</span>
              <span className="rounded bg-muted px-1.5 py-0.5">{item.skillUsed}</span>
            </>
          )}
          <span className="text-border">·</span>
          <span title={new Date(item.createdAt).toLocaleString()}>{relativeTime(item.createdAt)}</span>
          <span className="ml-auto">{expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</span>
        </div>
        <p className="text-sm text-foreground line-clamp-1">
          <span className="mr-1 font-medium text-muted-foreground">You:</span>
          {expanded ? highlight(item.question, searchQuery) : highlight(item.question.slice(0, 120), searchQuery)}
        </p>
        {!expanded && (
          <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">
            <span className="mr-1 font-medium">Agent:</span>
            {item.answer.slice(0, 180)}
          </p>
        )}
      </button>
      {expanded && (
        <div className="mx-4 mb-3 space-y-2 rounded-lg border border-border bg-background p-3 text-sm">
          <div>
            <span className="text-xs font-medium text-muted-foreground">You</span>
            <p className="mt-0.5 text-foreground whitespace-pre-wrap">{highlight(item.question, searchQuery)}</p>
          </div>
          <div className="border-t border-border pt-2">
            <span className="text-xs font-medium text-muted-foreground">Agent</span>
            <p className="mt-0.5 text-foreground whitespace-pre-wrap">{highlight(item.answer, searchQuery)}</p>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add plugins/agentbook-core/frontend/src/components/ConversationRow.tsx
git commit -m "feat(core): ConversationRow — expandable message pair with highlight"
```

---

## Task 5: ChatHistoryTab component

**Files:**
- Create: `plugins/agentbook-core/frontend/src/components/ChatHistoryTab.tsx`
- Create: `plugins/agentbook-core/frontend/src/__tests__/ChatHistoryTab.test.tsx`

- [ ] **Step 1: Write failing tests**

```typescript
// plugins/agentbook-core/frontend/src/__tests__/ChatHistoryTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ChatHistoryTab } from '../components/ChatHistoryTab';

const mockFetch = vi.fn();
beforeEach(() => { vi.stubGlobal('fetch', mockFetch); mockFetch.mockReset(); });

const ITEM = {
  id: '1', question: 'Spent $45 on lunch', answer: 'Logged $45 — Meals',
  channel: 'telegram', skillUsed: 'record-expense', createdAt: new Date().toISOString(),
};

function searchRes(items = [ITEM], total = 1, nextCursor: string | null = null) {
  return Promise.resolve({ json: () => Promise.resolve({ success: true, data: { items, total, nextCursor } }) });
}

describe('ChatHistoryTab', () => {
  it('renders conversation items after load', async () => {
    mockFetch.mockReturnValue(searchRes());
    render(<ChatHistoryTab />);
    await waitFor(() => expect(screen.getByText(/Spent \$45 on lunch/)).toBeTruthy());
  });

  it('shows total count', async () => {
    mockFetch.mockReturnValue(searchRes([ITEM], 42));
    render(<ChatHistoryTab />);
    await waitFor(() => expect(screen.getByText(/42 messages/i)).toBeTruthy());
  });

  it('shows empty state when no results', async () => {
    mockFetch.mockReturnValue(searchRes([], 0, null));
    render(<ChatHistoryTab />);
    await waitFor(() => expect(screen.getByText(/No messages found/i)).toBeTruthy());
  });

  it('hides Load more when nextCursor is null', async () => {
    mockFetch.mockReturnValue(searchRes([ITEM], 1, null));
    render(<ChatHistoryTab />);
    await waitFor(() => expect(screen.queryByText(/Load more/i)).toBeNull());
  });

  it('shows Load more when nextCursor is set', async () => {
    mockFetch.mockReturnValue(searchRes([ITEM], 21, '2026-06-20T00:00:00.000Z'));
    render(<ChatHistoryTab />);
    await waitFor(() => expect(screen.getByText(/Load more/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
cd plugins/agentbook-core/frontend
npx vitest run src/__tests__/ChatHistoryTab.test.tsx
```
Expected: FAIL — `ChatHistoryTab` not found.

- [ ] **Step 3: Create ChatHistoryTab**

```typescript
// plugins/agentbook-core/frontend/src/components/ChatHistoryTab.tsx
import { useEffect, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { ConversationRow, type ConversationItem } from './ConversationRow';

const CHANNELS = ['all', 'web', 'telegram', 'api'] as const;
type Channel = typeof CHANNELS[number];

const CHANNEL_LABELS: Record<Channel, string> = {
  all: 'All', web: 'Web', telegram: 'Telegram', api: 'API',
};

async function fetchConversations(params: {
  q: string; channel: Channel; cursor?: string; limit?: number;
}): Promise<{ items: ConversationItem[]; nextCursor: string | null; total: number }> {
  const sp = new URLSearchParams({ limit: String(params.limit ?? 20) });
  if (params.q) sp.set('q', params.q);
  if (params.channel !== 'all') sp.set('channel', params.channel);
  if (params.cursor) sp.set('cursor', params.cursor);
  const res = await fetch(`/api/v1/agentbook-core/conversations/search?${sp}`);
  const d = await res.json();
  if (!d.success) throw new Error(d.error);
  return d.data;
}

export function ChatHistoryTab(): JSX.Element {
  const [query, setQuery]       = useState('');
  const [channel, setChannel]   = useState<Channel>('all');
  const [items, setItems]       = useState<ConversationItem[]>([]);
  const [total, setTotal]       = useState(0);
  const [cursor, setCursor]     = useState<string | null>(null);
  const [loading, setLoading]   = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = async (q: string, ch: Channel, append = false, cur?: string): Promise<void> => {
    append ? setLoadingMore(true) : setLoading(true);
    setError(null);
    try {
      const result = await fetchConversations({ q, channel: ch, cursor: cur });
      setItems(prev => append ? [...prev, ...result.items] : result.items);
      setTotal(result.total);
      setCursor(result.nextCursor);
    } catch (e) {
      setError(String(e));
    } finally {
      append ? setLoadingMore(false) : setLoading(false);
    }
  };

  // Initial load and when channel changes
  useEffect(() => {
    void load(query, channel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  // Debounced search
  const handleSearch = (q: string): void => {
    setQuery(q);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(q, channel), 300);
  };

  const handleChannelChange = (ch: Channel): void => {
    setChannel(ch);
    setItems([]);
    setCursor(null);
  };

  const handleLoadMore = (): void => {
    if (cursor) void load(query, channel, true, cursor);
  };

  return (
    <div className="space-y-3">
      {/* Search bar */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="text"
          placeholder="Search messages…"
          value={query}
          onChange={e => handleSearch(e.target.value)}
          className="w-full rounded-lg border border-border bg-background py-2.5 pl-9 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
      </div>

      {/* Channel filter chips + count */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {CHANNELS.map(ch => (
            <button
              key={ch}
              onClick={() => handleChannelChange(ch)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                channel === ch
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {CHANNEL_LABELS[ch]}
            </button>
          ))}
        </div>
        {!loading && (
          <span className="text-xs text-muted-foreground">{total} message{total !== 1 ? 's' : ''}</span>
        )}
      </div>

      {/* List */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-destructive">{error}</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">No messages found</p>
            {query && (
              <button onClick={() => handleSearch('')}
                className="mt-2 text-xs text-primary hover:underline">
                Clear search
              </button>
            )}
          </div>
        ) : (
          items.map(item => (
            <ConversationRow key={item.id} item={item} searchQuery={query} />
          ))
        )}
      </div>

      {/* Load more */}
      {cursor && !loading && (
        <button
          onClick={handleLoadMore}
          disabled={loadingMore}
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-border py-2.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          {loadingMore ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
cd plugins/agentbook-core/frontend
npx vitest run src/__tests__/ChatHistoryTab.test.tsx
```
Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/agentbook-core/frontend/src/components/ChatHistoryTab.tsx \
        plugins/agentbook-core/frontend/src/__tests__/ChatHistoryTab.test.tsx
git commit -m "feat(core): ChatHistoryTab — search, channel filter, pagination"
```

---

## Task 6: Update SettingsPage — add Chatbots + Chat History tabs

**Files:**
- Modify: `plugins/agentbook-core/frontend/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Read the current tab section (lines ~99 and ~165–184)**

The relevant code is at the top of the function body and the tabs render block. You need to understand these two locations before editing.

- [ ] **Step 2: Update the tab type and state**

Replace this line:
```typescript
const [tab, setTab] = useState<'profile' | 'invoice'>('profile');
```
With:
```typescript
const [tab, setTab] = useState<'profile' | 'invoice' | 'chatbots' | 'history'>('profile');
```

- [ ] **Step 3: Add imports at the top of the file**

Add after existing imports:
```typescript
import { TelegramCard } from '../components/TelegramCard';
import { WhatsAppCard } from '../components/WhatsAppCard';
import { ChatHistoryTab } from '../components/ChatHistoryTab';
```

- [ ] **Step 4: Replace the tab bar render block**

Find and replace this block (the `{/* Tabs */}` section, approx lines 169–184):

```tsx
{/* Tabs */}
<div className="mb-6 flex border-b border-border">
  {(
    [
      { key: 'profile', label: 'Business Profile' },
      { key: 'invoice', label: 'Invoice Defaults' },
      { key: 'chatbots', label: 'Chatbots' },
      { key: 'history', label: 'Chat History' },
    ] as const
  ).map(({ key, label }) => (
    <button
      key={key}
      onClick={() => setTab(key)}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        tab === key
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {label}
    </button>
  ))}
</div>
```

- [ ] **Step 5: Add the two new tab panels after the existing `{tab === 'invoice' && ...}` block**

Append after the closing `}` of the invoice panel (around line 330):

```tsx
{tab === 'chatbots' && (
  <div className="space-y-4">
    <TelegramCard />
    <WhatsAppCard />
  </div>
)}

{tab === 'history' && (
  <ChatHistoryTab />
)}
```

- [ ] **Step 6: Fix the existing light-theme hardcoded classes in the tab panels**

The existing `profile` and `invoice` tab panels use `text-gray-700`, `border-blue-600` etc. Replace all instances in the panels with semantic equivalents — in the labels:

- `text-gray-700` → `text-foreground`
- `text-gray-500` → `text-muted-foreground`
- `border-blue-600 text-blue-600` (tab active) → already replaced in Step 4
- Inputs: `focus:ring-blue-500` → `focus:ring-primary/30`

Use search & replace across the file for:
- `text-gray-700` → `text-foreground`
- `text-gray-600` → `text-muted-foreground`
- `text-gray-500` → `text-muted-foreground`
- `focus:ring-blue-500` → `focus:ring-primary/30`
- `focus:ring-2` → `focus:ring-1`

- [ ] **Step 7: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/SettingsPage.tsx
git commit -m "feat(core): add Chatbots + Chat History tabs to SettingsPage"
```

---

## Task 7: Update TelegramSettingsPage to thin wrapper

**Files:**
- Modify: `plugins/agentbook-core/frontend/src/pages/TelegramSettings.tsx`

- [ ] **Step 1: Replace the file content**

The existing file can be fully replaced — all logic now lives in `TelegramCard`:

```typescript
// plugins/agentbook-core/frontend/src/pages/TelegramSettings.tsx
import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { TelegramCard } from '../components/TelegramCard';

export const TelegramSettingsPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <button
        onClick={() => navigate('/settings')}
        className="mb-4 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" /> Back to Settings
      </button>
      <TelegramCard />
    </div>
  );
};
```

- [ ] **Step 2: Add missing import**

Add `import React from 'react';` at the top if not already present.

- [ ] **Step 3: Commit**

```bash
git add plugins/agentbook-core/frontend/src/pages/TelegramSettings.tsx
git commit -m "refactor(core): TelegramSettingsPage → thin wrapper around TelegramCard"
```

---

## Task 8: Build and deploy

**Files:**
- Modify: `plugins/agentbook-core/frontend/dist/production/` (generated)
- Modify: `apps/web-next/public/cdn/plugins/agentbook-core/1.0.0/` (copy)

- [ ] **Step 1: Build the core plugin**

```bash
cd plugins/agentbook-core/frontend
npm run build
```
Expected output includes:
```
dist/production/agentbook-core.js   (~XXX KB)
✅ Validated: no bundled React internals
```

- [ ] **Step 2: Copy bundle to CDN directories**

```bash
CORE_DIST="plugins/agentbook-core/frontend/dist/production"
CDN_VER="apps/web-next/public/cdn/plugins/agentbook-core/1.0.0"
CDN_ROOT="apps/web-next/public/cdn/plugins/agentbook-core"

cp "$CORE_DIST/agentbook-core.js"     "$CDN_VER/agentbook-core.js"
cp "$CORE_DIST/agentbook-core.js.map" "$CDN_VER/agentbook-core.js.map"
cp "$CORE_DIST/manifest.json"         "$CDN_VER/manifest.json"
cp "$CORE_DIST/agentbook-core.js"     "$CDN_ROOT/agentbook-core.js"
```
If a CSS file is generated (`plugin-agentbook-core-frontend.css`), copy it too:
```bash
[ -f "$CORE_DIST/plugin-agentbook-core-frontend.css" ] && \
  cp "$CORE_DIST/plugin-agentbook-core-frontend.css" "$CDN_VER/plugin-agentbook-core-frontend.css"
```

- [ ] **Step 3: Commit CDN artifacts**

```bash
git add -f apps/web-next/public/cdn/plugins/agentbook-core/
git commit -m "chore: rebuild core plugin — Chatbots tab + Chat History tab"
```

- [ ] **Step 4: Deploy to Vercel**

```bash
vercel pull --yes --environment=production
vercel build --prod
vercel deploy --prebuilt --prod
```
Expected final line: `Production: https://...vercel.app`

- [ ] **Step 5: Verify in browser**

1. Navigate to `https://agentbook.brainliber.com/agentbook/settings`
2. Confirm three tabs visible: Business Profile, Invoice Defaults, Chatbots, Chat History
3. Click **Chatbots** — Telegram card shows (connected or not connected depending on seeded data), WhatsApp card shows dimmed "Coming soon"
4. Click **Chat History** — conversation list loads, search and channel filters work
5. Navigate to `https://agentbook.brainliber.com/agentbook/telegram` — redirects to settings with back link

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|-----------------|------|
| "Chatbots" tab in SettingsPage | Task 6 |
| Telegram card — not connected state (setup form) | Task 2 |
| Telegram card — connected state (status + quick-start) | Task 2 |
| WhatsApp coming-soon card | Task 3 |
| `/agentbook/telegram` route kept, thin wrapper | Task 7 |
| Chat History 4th tab | Task 6 |
| Search endpoint with q, channel, cursor, limit | Task 1 |
| ConversationRow with expand + highlight | Task 4 |
| ChatHistoryTab with debounce, filter, pagination | Task 5 |
| Dark theme semantic tokens throughout | Tasks 2–6 |

**No placeholders:** All steps contain complete code.

**Type consistency:** `ConversationItem` defined in `ConversationRow.tsx`, imported and used in `ChatHistoryTab.tsx`. `BotStatus` and `SetupResult` defined inline in `TelegramCard.tsx`. `Channel` type defined in `ChatHistoryTab.tsx`. All consistent.
