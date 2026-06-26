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
