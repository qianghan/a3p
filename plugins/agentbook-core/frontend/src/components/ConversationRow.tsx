import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export interface ConversationItem {
  id: string;
  question: string;
  answer: string;
  channel: string;
  skillUsed: string | null;
  createdAt: string;
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
