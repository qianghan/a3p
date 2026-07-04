'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send, Key, Loader2, Trash2, RefreshCw, CheckCircle, XCircle,
  AlertCircle, ExternalLink, Search, ChevronDown, ChevronUp,
  Copy, Check, Gift, Users,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TenantConfig {
  companyName: string | null;
  companyAddress: string | null;
  companyEmail: string | null;
  companyPhone: string | null;
  logoUrl: string | null;
  brandColor: string;
  defaultPaymentTerms: string | null;
  defaultCurrency: string | null;
  invoiceFooterNote: string | null;
  invoiceThankYouMessage: string | null;
  accountingBasis?: string;
}

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
  webhookRegistered: boolean;
}

interface ConversationItem {
  id: string;
  question: string;
  answer: string;
  channel: string;
  skillUsed: string | null;
  createdAt: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const API = '/api/v1/agentbook-core';

const PAYMENT_TERMS = [
  { value: 'net-30', label: 'Net 30' },
  { value: 'net-15', label: 'Net 15' },
  { value: 'net-60', label: 'Net 60' },
  { value: 'due-on-receipt', label: 'Due on receipt' },
];

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF', 'MXN', 'BRL', 'INR'];

const CHANNELS = ['all', 'web', 'telegram', 'api'] as const;
type Channel = typeof CHANNELS[number];
const CHANNEL_LABELS: Record<Channel, string> = {
  all: 'All', web: 'Web', telegram: 'Telegram', api: 'API',
};

const CHANNEL_META: Record<string, { icon: string; label: string }> = {
  telegram: { icon: '✈️', label: 'Telegram' },
  web:      { icon: '💻', label: 'Web' },
  api:      { icon: '⚙️', label: 'API' },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function highlight(text: string, q: string): React.ReactElement {
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

async function fetchConfig(): Promise<TenantConfig> {
  const r = await fetch(`${API}/tenant-config`);
  if (!r.ok) throw new Error(`${r.status}`);
  const { data } = await r.json() as { data: TenantConfig };
  return data;
}

async function saveConfig(patch: Partial<TenantConfig>): Promise<void> {
  const r = await fetch(`${API}/tenant-config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`Save failed: ${r.status}`);
}

async function uploadLogo(file: File): Promise<string> {
  const form = new FormData();
  form.append('file', file);
  const r = await fetch(`${API}/tenant-config/logo`, { method: 'POST', body: form });
  if (!r.ok) {
    const { error } = await r.json() as { error: string };
    throw new Error(error);
  }
  const { url } = await r.json() as { url: string };
  return url;
}

async function fetchConversations(params: {
  q: string; channel: Channel; cursor?: string; limit?: number;
}): Promise<{ items: ConversationItem[]; nextCursor: string | null; total: number }> {
  const sp = new URLSearchParams({ limit: String(params.limit ?? 20) });
  if (params.q) sp.set('q', params.q);
  if (params.channel !== 'all') sp.set('channel', params.channel);
  if (params.cursor) sp.set('cursor', params.cursor);
  const res = await fetch(`${API}/conversations/search?${sp}`);
  const d = await res.json();
  if (!d.success) throw new Error(d.error);
  return d.data;
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ProfilePreview({
  companyName, logoUrl, brandColor, pendingLogoUrl,
}: {
  companyName: string; logoUrl: string | null; brandColor: string; pendingLogoUrl: string | null;
}): React.ReactElement {
  const displayLogo = pendingLogoUrl ?? logoUrl;
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wide">
        Invoice header preview
      </p>
      <div className="flex items-center gap-3 rounded p-3" style={{ borderLeft: `4px solid ${brandColor}` }}>
        {displayLogo ? (
          <img src={displayLogo} alt="logo" className="h-10 w-10 rounded object-contain" />
        ) : (
          <div
            className="flex h-10 w-10 items-center justify-center rounded text-white text-xs font-bold"
            style={{ backgroundColor: brandColor }}
          >
            {(companyName || 'CO').slice(0, 2).toUpperCase()}
          </div>
        )}
        <div>
          <div className="font-semibold" style={{ color: brandColor }}>
            {companyName || 'Your Company'}
          </div>
          <div className="text-xs text-muted-foreground">Invoice header</div>
        </div>
      </div>
    </div>
  );
}

function ConversationRow({ item, searchQuery = '' }: { item: ConversationItem; searchQuery?: string }): React.ReactElement {
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
            <><span className="text-border">·</span><span className="rounded bg-muted px-1.5 py-0.5">{item.skillUsed}</span></>
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

function TelegramCard(): React.ReactElement {
  const [status, setStatus]       = useState<BotStatus | null>(null);
  const [loading, setLoading]     = useState(true);
  const [saving, setSaving]       = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [botToken, setBotToken]   = useState('');
  const [error, setError]         = useState<string | null>(null);
  const [success, setSuccess]     = useState<string | null>(null);

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
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-lg">✈️</div>
        <div className="flex-1">
          <div className="text-sm font-semibold text-foreground">Telegram</div>
          <div className="text-xs text-muted-foreground">
            {status?.configured && status.botUsername ? `@${status.botUsername}` : 'Record expenses and manage finances via chat'}
          </div>
        </div>
        {status?.configured && (
          <span className="rounded-full bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary">● Connected</span>
        )}
        {status !== null && !status.configured && (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">Not connected</span>
        )}
      </div>
      <div className="px-4 py-4">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0" />{error}
          </div>
        )}
        {success && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/10 p-3 text-sm text-foreground">
            <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-primary" />{success}
          </div>
        )}
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /><span className="text-sm">Loading…</span>
          </div>
        ) : status?.configured ? (
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
                  {status.webhookActive === true ? 'Active' : status.webhookActive === false ? 'Error' : 'Unknown'}
                </div>
              </div>
              <div className="rounded-lg bg-background px-3 py-2">
                <div className="text-xs text-muted-foreground">Linked chats</div>
                <div className="text-sm font-medium text-foreground">{status.chatIds?.length ?? 0}</div>
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
                  <a href={`https://t.me/${status.botUsername}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                    {status.botUsername}
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
          <div className="space-y-3">
            <ol className="space-y-1.5 text-sm text-muted-foreground">
              <li className="flex gap-2">
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-muted text-xs">1</span>
                Open <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="mx-1 text-primary hover:underline">@BotFather</a> in Telegram
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

function WhatsAppCard(): React.ReactElement {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-dashed border-border/50 bg-card px-4 py-3 opacity-50">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-green-500/10 text-lg">💬</div>
      <div className="flex-1">
        <div className="text-sm font-semibold text-muted-foreground">WhatsApp</div>
        <div className="text-xs text-muted-foreground">Business API integration</div>
      </div>
      <span className="rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">Coming soon</span>
    </div>
  );
}

function ChatHistoryTab(): React.ReactElement {
  const [query, setQuery]     = useState('');
  const [channel, setChannel] = useState<Channel>('all');
  const [items, setItems]     = useState<ConversationItem[]>([]);
  const [total, setTotal]     = useState(0);
  const [cursor, setCursor]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (q: string, ch: Channel, append = false, cur?: string): Promise<void> => {
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
  }, []);

  useEffect(() => {
    void load(query, channel);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

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

  return (
    <div className="space-y-3">
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
      <div className="flex items-center justify-between">
        <div className="flex gap-1.5">
          {CHANNELS.map(ch => (
            <button
              key={ch}
              onClick={() => handleChannelChange(ch)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                channel === ch ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:text-foreground'
              }`}
            >
              {CHANNEL_LABELS[ch]}
            </button>
          ))}
        </div>
        {!loading && <span className="text-xs text-muted-foreground">{total} message{total !== 1 ? 's' : ''}</span>}
      </div>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /><span className="text-sm">Loading…</span>
          </div>
        ) : error ? (
          <div className="px-4 py-8 text-center text-sm text-destructive">{error}</div>
        ) : items.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">No messages found</p>
            {query && (
              <button onClick={() => handleSearch('')} className="mt-2 text-xs text-primary hover:underline">
                Clear search
              </button>
            )}
          </div>
        ) : (
          items.map(item => <ConversationRow key={item.id} item={item} searchQuery={query} />)
        )}
      </div>
      {cursor && !loading && (
        <button
          onClick={() => { if (cursor) void load(query, channel, true, cursor); }}
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

// ── Main panel ────────────────────────────────────────────────────────────────

type SettingsTab = 'profile' | 'invoice' | 'chatbots' | 'history' | 'billing' | 'referrals' | 'sharing' | 'notifications';

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'profile',   label: 'Business Profile' },
  { key: 'invoice',   label: 'Invoice Defaults' },
  { key: 'billing',   label: 'Billing' },
  { key: 'referrals', label: 'Referrals' },
  { key: 'sharing',   label: 'Sharing' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'chatbots',  label: 'Chatbots' },
  { key: 'history',   label: 'Chat History' },
];

function isSettingsTab(v: string | undefined | null): v is SettingsTab {
  return !!v && TABS.some((t) => t.key === v);
}

interface BillingPlan { id: string; code: string; name: string; description?: string | null; priceCents: number; interval: string }

function BillingTab(): React.ReactElement {
  const [plans, setPlans] = useState<BillingPlan[]>([]);
  const [current, setCurrent] = useState<{ code?: string; name?: string; status?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/v1/agentbook-billing/plans').then((r) => r.json()).catch(() => null),
      fetch('/api/v1/agentbook-billing/me/subscription').then((r) => r.json()).catch(() => null),
    ]).then(([p, c]) => {
      if (p?.plans) setPlans(p.plans);
      if (c) setCurrent({ code: c.code ?? c.planCode ?? c.plan?.code, name: c.name ?? c.plan?.name, status: c.status });
    }).finally(() => setLoading(false));
  }, []);

  const fmt = (cents: number) => cents === 0 ? 'Free' : `$${(cents / 100).toFixed(0)}`;

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading billing…</div>;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Your plan</h3>
        <p className="text-sm text-muted-foreground">
          {current?.name || current?.code
            ? <>Currently on <span className="font-medium text-foreground capitalize">{current.name || current.code}</span>{current.status ? ` · ${current.status}` : ''}.</>
            : 'You are on the Free plan.'}
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {plans.map((p) => {
          const isCurrent = current?.code === p.code;
          return (
            <div key={p.id} className={`rounded-xl border p-4 ${isCurrent ? 'border-primary' : 'border-border'} bg-card`}>
              <div className="flex items-center justify-between mb-1">
                <p className="text-sm font-semibold text-foreground">{p.name}</p>
                {isCurrent && <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary">Current</span>}
              </div>
              <p className="text-2xl font-bold text-foreground">{fmt(p.priceCents)}<span className="text-xs font-normal text-muted-foreground">{p.priceCents > 0 ? `/${p.interval}` : ''}</span></p>
              {p.description && <p className="text-xs text-muted-foreground mt-1.5">{p.description}</p>}
            </div>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">To change or cancel your plan, contact support or use the upgrade prompt in the app. Managed securely via Stripe.</p>
    </div>
  );
}

interface ReferralInvitee { maskedEmail: string | null; status: string; joinedAt: string; paidAt: string | null }
interface ReferralSummary { code: string; shareUrl: string; monthsEarned: number; monthsCap: number; invitees: ReferralInvitee[] }

function CopyField({ value, label }: { value: string; label: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);
  return (
    <div>
      <label className="text-xs text-muted-foreground">{label}</label>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 min-w-0 truncate rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
          {value}
        </code>
        <button
          type="button"
          onClick={copy}
          className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function shareCaption(code: string, shareUrl: string): string {
  return `I do my books & taxes with AgentBook — AI bookkeeping that saves me on tax-prep fees and hours of admin. Use my code ${code} to get started: ${shareUrl}`;
}

function ShareCard({ code, shareUrl }: { code: string; shareUrl: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const caption = shareCaption(code, shareUrl);
  const cardUrl = `/api/v1/agentbook-billing/referrals/card/${encodeURIComponent(code)}`;

  const copyCaption = useCallback(() => {
    navigator.clipboard.writeText(caption).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [caption]);

  const shareLinks = [
    { label: 'X', href: `https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}` },
    {
      label: 'LinkedIn',
      href: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`,
    },
    { label: 'WhatsApp', href: `https://wa.me/?text=${encodeURIComponent(caption)}` },
  ];

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-2">Your shareable card</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- server-generated PNG, not an optimizable static asset */}
      <img
        src={cardUrl}
        alt="AgentBook referral card"
        className="w-full max-w-md rounded-lg border border-border"
      />
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={copyCaption}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
        >
          {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
          {copied ? 'Copied caption' : 'Copy caption'}
        </button>
        <a
          href={cardUrl}
          download={`agentbook-referral-${code}.png`}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
        >
          Download image
        </a>
        {shareLinks.map((s) => (
          <a
            key={s.label}
            href={s.href}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
          >
            Share on {s.label}
          </a>
        ))}
      </div>
    </div>
  );
}

function QrCard({ code }: { code: string }): React.ReactElement {
  const qrUrl = `/api/v1/agentbook-billing/referrals/qr-card/${encodeURIComponent(code)}`;
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground mb-2">Or let them scan</p>
      {/* eslint-disable-next-line @next/next/no-img-element -- server-generated PNG, not an optimizable static asset */}
      <img
        src={qrUrl}
        alt="Scan to join AgentBook"
        className="w-full max-w-[200px] rounded-lg border border-border"
      />
      <a
        href={qrUrl}
        download={`agentbook-qr-${code}.png`}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
      >
        Download QR code
      </a>
    </div>
  );
}

function ReferralsTab(): React.ReactElement {
  const [summary, setSummary] = useState<ReferralSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/agentbook-billing/referrals/me', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (d.success) setSummary(d.data); else setErr(d.error || 'Failed to load'); })
      .catch(() => setErr('Failed to load'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading referrals…</div>;
  if (err || !summary) return <div className="py-8 text-center text-sm text-destructive">{err || 'Failed to load'}</div>;

  const { code, shareUrl, monthsEarned, monthsCap, invitees } = summary;
  const pct = Math.min(100, Math.round((monthsEarned / monthsCap) * 100));
  const paidCount = invitees.filter((i) => i.status === 'paid').length;

  const encouragement =
    monthsEarned >= monthsCap
      ? "You've earned a full free year — amazing! Keep sharing to help more friends save on their books."
      : paidCount === 0
        ? 'Share your link — when a friend signs up and pays, you get 1 month free.'
        : `${monthsCap - monthsEarned} more paid invite${monthsCap - monthsEarned === 1 ? '' : 's'} to reach a full year free.`;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1 flex items-center gap-1.5">
          <Gift size={16} className="text-primary" /> Invite friends, earn free months
        </h3>
        <p className="text-sm text-muted-foreground">
          For every friend who signs up with your link and pays, you get 1 month free — up to a full year.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <CopyField label="Your referral code" value={code} />
        <CopyField label="Your share link" value={shareUrl} />
      </div>

      <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-start">
        <ShareCard code={code} shareUrl={shareUrl} />
        <QrCard code={code} />
      </div>

      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-foreground">{monthsEarned} / {monthsCap} months earned</span>
          <span className="text-xs text-muted-foreground">{paidCount} paid invite{paidCount === 1 ? '' : 's'}</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden">
          <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
        </div>
        <p className="text-xs text-muted-foreground mt-2">{encouragement}</p>
      </div>

      <div>
        <h4 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1.5">
          <Users size={14} /> Your invitees
        </h4>
        {invitees.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center rounded-lg border border-dashed border-border">
            No invites yet — share your link above to get started.
          </p>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Invitee</th>
                  <th className="text-left px-3 py-2 font-medium">Status</th>
                  <th className="text-left px-3 py-2 font-medium">Joined</th>
                  <th className="text-left px-3 py-2 font-medium">Paid</th>
                </tr>
              </thead>
              <tbody>
                {invitees.map((inv, i) => (
                  <tr key={i} className="border-t border-border">
                    <td className="px-3 py-2 text-foreground">{inv.maskedEmail || '—'}</td>
                    <td className="px-3 py-2">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                          inv.status === 'paid'
                            ? 'bg-emerald-500/10 text-emerald-500'
                            : 'bg-amber-500/10 text-amber-500'
                        }`}
                      >
                        {inv.status === 'paid' ? 'Paid' : 'Joined'}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">{new Date(inv.joinedAt).toLocaleDateString()}</td>
                    <td className="px-3 py-2 text-muted-foreground">{inv.paidAt ? new Date(inv.paidAt).toLocaleDateString() : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Reuses the CPA review-link mechanism (AbCpaReviewLink + /review/[token]) —
// a link is `{ tenantId, token, label, expiresAt }` with no CPA-specific
// concept baked into creation, so a "share with a parent" flow is the same
// endpoint with different label/copy, not a new access-control model.
interface ShareLink { id: string; token: string; label: string | null; expiresAt: string; status: string }

function ParentShareTab(): React.ReactElement {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [origin, setOrigin] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/agentbook-cpa/link', { credentials: 'include' }).then((x) => x.json());
      if (r?.success) setLinks(r.data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setOrigin(window.location.origin);
    void load();
  }, [load]);

  const createLink = useCallback(async () => {
    setCreating(true);
    try {
      await fetch('/api/v1/agentbook-cpa/link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'Parent summary', validityDays: 365 }),
      });
      await load();
    } finally {
      setCreating(false);
    }
  }, [load]);

  const copy = useCallback((link: ShareLink) => {
    navigator.clipboard.writeText(`${origin}/review/${link.token}`).then(() => {
      setCopiedId(link.id);
      setTimeout(() => setCopiedId(null), 2000);
    });
  }, [origin]);

  const active = links.filter((l) => l.status === 'active');

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Share a summary with a parent</h3>
        <p className="text-sm text-muted-foreground">
          Create a read-only link showing your income and spending summary — no login required to view it, and
          you can create as many as you like. It never shows your full transaction detail or lets anyone make changes.
        </p>
      </div>

      <button
        type="button"
        onClick={() => void createLink()}
        disabled={creating}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
      >
        {creating ? <Loader2 size={14} className="animate-spin" /> : <Gift size={14} />}
        Create a new link
      </button>

      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center rounded-lg border border-dashed border-border">
          No active links yet — create one above to share with a parent or guardian.
        </p>
      ) : (
        <div className="space-y-2">
          {active.map((l) => (
            <div key={l.id} className="flex items-center justify-between gap-2 text-sm">
              <code className="flex-1 min-w-0 truncate rounded-lg border border-border bg-background px-3 py-2 text-xs text-foreground">
                {origin}/review/{l.token}
              </code>
              <span className="text-xs text-muted-foreground shrink-0">
                expires {new Date(l.expiresAt).toLocaleDateString()}
              </span>
              <button
                type="button"
                onClick={() => copy(l)}
                className="shrink-0 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-foreground hover:bg-muted transition-colors"
              >
                {copiedId === l.id ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                {copiedId === l.id ? 'Copied' : 'Copy'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface NotificationPreference {
  category: string;
  locked: boolean;
  inAppEnabled: boolean;
  emailEnabled: boolean;
}

const NOTIFICATION_CATEGORY_LABELS: Record<string, { label: string; description: string }> = {
  feature: { label: 'New features', description: 'What just shipped and how to use it' },
  reward: { label: 'Discounts & rewards', description: 'Promotions and special offers' },
  referral_thanks: { label: 'Referral thank-yous', description: 'When someone you invited pays, and your reward' },
  admin_broadcast: { label: 'Announcements', description: 'General updates from the AgentBook team' },
  tax_deadline: { label: 'Tax deadlines', description: 'Upcoming filing dates — always on' },
  invoice_due: { label: 'Invoice reminders', description: 'Your own invoices approaching their due date — always on' },
  expense_review: { label: 'Expense review', description: "Expenses that need your attention — always on" },
};

function NotificationsPreferencesTab(): React.ReactElement {
  const [prefs, setPrefs] = useState<NotificationPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [savingCategory, setSavingCategory] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/v1/agentbook-core/notifications/preferences', { credentials: 'include' })
      .then((r) => r.json())
      .then((d) => { if (d.success) setPrefs(d.data.preferences); else setErr('Failed to load preferences'); })
      .catch(() => setErr('Failed to load preferences'))
      .finally(() => setLoading(false));
  }, []);

  const updatePref = async (category: string, field: 'inAppEnabled' | 'emailEnabled', value: boolean) => {
    setSavingCategory(category);
    const prev = prefs;
    setPrefs((p) => p.map((pr) => (pr.category === category ? { ...pr, [field]: value } : pr)));
    try {
      const res = await fetch('/api/v1/agentbook-core/notifications/preferences', {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, [field]: value }),
      });
      const data = await res.json();
      if (!data.success) setPrefs(prev); // revert on failure
    } catch {
      setPrefs(prev);
    } finally {
      setSavingCategory(null);
    }
  };

  if (loading) return <div className="py-8 text-center text-sm text-muted-foreground">Loading preferences…</div>;
  if (err) return <div className="py-8 text-center text-sm text-destructive">{err}</div>;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground mb-1">Notifications</h3>
        <p className="text-sm text-muted-foreground">
          Choose what you hear about, and how. Tax, invoice, and expense-review reminders can&apos;t be turned off — they&apos;re about your own money.
        </p>
      </div>

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground">
            <tr>
              <th className="text-left px-3 py-2 font-medium">Category</th>
              <th className="text-center px-3 py-2 font-medium w-24">In-app</th>
              <th className="text-center px-3 py-2 font-medium w-24">Email</th>
            </tr>
          </thead>
          <tbody>
            {prefs.map((pref) => {
              const meta = NOTIFICATION_CATEGORY_LABELS[pref.category] || { label: pref.category, description: '' };
              return (
                <tr key={pref.category} className="border-t border-border">
                  <td className="px-3 py-3">
                    <div className="font-medium text-foreground">{meta.label}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{meta.description}</div>
                  </td>
                  <td className="px-3 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={pref.inAppEnabled}
                      disabled={pref.locked || savingCategory === pref.category}
                      onChange={(e) => updatePref(pref.category, 'inAppEnabled', e.target.checked)}
                      className="h-4 w-4 accent-primary disabled:opacity-40"
                    />
                  </td>
                  <td className="px-3 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={pref.emailEnabled}
                      disabled={pref.locked || savingCategory === pref.category}
                      onChange={(e) => updatePref(pref.category, 'emailEnabled', e.target.checked)}
                      className="h-4 w-4 accent-primary disabled:opacity-40"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AgentBookSettingsPanel({ initialTab }: { initialTab?: string }): React.ReactElement {
  const [tab, setTab] = useState<SettingsTab>(isSettingsTab(initialTab) ? initialTab : 'profile');
  const [form, setForm] = useState<TenantConfig | null>(null);
  const [pendingLogoUrl, setPendingLogoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving]       = useState(false);
  const [toast, setToast]         = useState<string | null>(null);
  const [err, setErr]             = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchConfig()
      .then((c) => setForm(c))
      .catch((e: unknown) => setErr(String(e)));
  }, []);

  const showToast = (msg: string): void => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (!file) return;
    const localUrl = URL.createObjectURL(file);
    setPendingLogoUrl(localUrl);
    setUploading(true);
    try {
      const url = await uploadLogo(file);
      setForm((f) => f ? { ...f, logoUrl: url } : f);
      URL.revokeObjectURL(localUrl);
      setPendingLogoUrl(null);
      showToast('Logo uploaded');
    } catch (e2: unknown) {
      setErr(String(e2));
      URL.revokeObjectURL(localUrl);
      setPendingLogoUrl(null);
    } finally {
      setUploading(false);
    }
  };

  const handleSave = async (): Promise<void> => {
    if (!form) return;
    setSaving(true);
    setErr(null);
    try {
      await saveConfig(form);
      showToast('Settings saved');
    } catch (e2: unknown) {
      setErr(String(e2));
    } finally {
      setSaving(false);
    }
  };

  const set = (patch: Partial<TenantConfig>): void =>
    setForm((f) => f ? { ...f, ...patch } : f);

  if (!form) {
    return (
      <div className="p-6 text-muted-foreground">
        {err ? `Error: ${err}` : 'Loading settings…'}
      </div>
    );
  }

  const inputCls = 'mt-1 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30';

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">AgentBook Settings</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Business profile, invoice defaults, and chatbot integrations</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-border">
        {TABS.map(({ key, label }) => (
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

      {tab === 'profile' && (
        <div className="space-y-5">
          <ProfilePreview
            companyName={form.companyName ?? ''}
            logoUrl={form.logoUrl}
            brandColor={form.brandColor}
            pendingLogoUrl={pendingLogoUrl}
          />
          <div>
            <label className="block text-sm font-medium text-foreground">Company name</label>
            <input type="text" value={form.companyName ?? ''} onChange={(e) => set({ companyName: e.target.value || null })}
              className={inputCls} placeholder="Acme Corp" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Email</label>
            <input type="email" value={form.companyEmail ?? ''} onChange={(e) => set({ companyEmail: e.target.value || null })}
              className={inputCls} placeholder="billing@acme.com" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Phone</label>
            <input type="tel" value={form.companyPhone ?? ''} onChange={(e) => set({ companyPhone: e.target.value || null })}
              className={inputCls} placeholder="+1 555 000 0000" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Address</label>
            <textarea value={form.companyAddress ?? ''} onChange={(e) => set({ companyAddress: e.target.value || null })}
              rows={3} className={inputCls} placeholder="123 Main St, Suite 100" />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Logo</label>
            <div className="mt-1 flex items-center gap-3">
              {(pendingLogoUrl ?? form.logoUrl) ? (
                <img src={pendingLogoUrl ?? form.logoUrl ?? ''} alt="logo" className="h-12 w-12 rounded border object-contain" />
              ) : (
                <div className="flex h-12 w-12 items-center justify-center rounded border border-border bg-muted text-xs text-muted-foreground">No logo</div>
              )}
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/svg+xml,image/webp" className="hidden" onChange={handleLogoChange} />
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
                className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted disabled:opacity-50">
                {uploading ? 'Uploading…' : 'Choose file'}
              </button>
              <span className="text-xs text-muted-foreground">PNG, JPEG, SVG, WebP · max 2MB</span>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Accent colour</label>
            <div className="mt-1 flex items-center gap-3">
              <input type="color" value={form.brandColor} onChange={(e) => set({ brandColor: e.target.value })}
                className="h-9 w-12 cursor-pointer rounded border border-border" />
              <input
                type="text"
                value={form.brandColor}
                onChange={(e) => {
                  if (/^#[0-9a-fA-F]{0,6}$/.test(e.target.value)) set({ brandColor: e.target.value });
                }}
                className="w-28 rounded-lg border border-border px-3 py-1.5 font-mono text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary/30"
              />
            </div>
          </div>
        </div>
      )}

      {tab === 'invoice' && (
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-foreground">Accounting basis</label>
            <select value={form.accountingBasis ?? 'accrual'} onChange={(e) => set({ accountingBasis: e.target.value })}
              className={inputCls}>
              <option value="accrual">Accrual — revenue when invoiced</option>
              <option value="cash">Cash — revenue when paid</option>
            </select>
            <p className="mt-1 text-xs text-muted-foreground">
              Changes how your Profit &amp; Loss recognizes income. Accrual counts invoices when issued;
              cash counts payments when received. Check with your accountant before switching.
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Default payment terms</label>
            <select value={form.defaultPaymentTerms ?? 'net-30'} onChange={(e) => set({ defaultPaymentTerms: e.target.value })}
              className={inputCls}>
              {PAYMENT_TERMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">Default currency</label>
            <select value={form.defaultCurrency ?? 'USD'} onChange={(e) => set({ defaultCurrency: e.target.value })}
              className={inputCls}>
              {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Invoice footer note{' '}
              <span className="font-normal text-muted-foreground">(appears on all invoices)</span>
            </label>
            <textarea value={form.invoiceFooterNote ?? ''} onChange={(e) => set({ invoiceFooterNote: e.target.value || null })}
              rows={3} maxLength={500} className={inputCls} placeholder="Thank you for your business." />
            <p className="mt-1 text-xs text-muted-foreground">{(form.invoiceFooterNote ?? '').length}/500 characters</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Thank-you message{' '}
              <span className="font-normal text-muted-foreground">(shown on paid invoices)</span>
            </label>
            <input type="text" value={form.invoiceThankYouMessage ?? ''} onChange={(e) => set({ invoiceThankYouMessage: e.target.value || null })}
              maxLength={200} className={inputCls} placeholder="Thank you for your payment!" />
          </div>
        </div>
      )}

      {tab === 'chatbots' && (
        <div className="space-y-4">
          <TelegramCard />
          <WhatsAppCard />
        </div>
      )}

      {tab === 'history' && <ChatHistoryTab />}

      {tab === 'billing' && <BillingTab />}

      {tab === 'referrals' && <ReferralsTab />}

      {tab === 'sharing' && <ParentShareTab />}

      {tab === 'notifications' && <NotificationsPreferencesTab />}

      {/* Save bar (profile + invoice tabs only) */}
      {(tab === 'profile' || tab === 'invoice') && (
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div>
            {err && <p className="text-sm text-destructive">{err}</p>}
            {toast && <p className="text-sm text-primary">{toast}</p>}
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      )}
    </div>
  );
}
