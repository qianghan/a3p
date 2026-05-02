import React from 'react';
import type { ActivityItem } from './types';

const fmtAmount = (cents: number) => {
  if (cents === 0) return '';
  const sign = cents > 0 ? '+' : '−';
  return `${sign}$${Math.abs(Math.round(cents / 100)).toLocaleString('en-US')}`;
};

const fmtRelative = (iso: string) => {
  const d = new Date(iso);
  const ms = Date.now() - d.getTime();
  const hr = Math.floor(ms / 3_600_000);
  if (hr < 1) return 'just now';
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
};

interface Props {
  items: ActivityItem[];
  loading: boolean;
  onLoadMore: () => void;
}

export const ActivityFeed: React.FC<Props> = ({ items, loading, onLoadMore }) => {
  return (
    <section className="bg-card border border-border rounded-2xl p-4 sm:p-6">
      <h2 className="text-sm font-medium text-muted-foreground mb-3 uppercase tracking-wide">Recent activity</h2>
      {items.length === 0 && !loading && (
        <p className="text-sm text-muted-foreground">No recent activity.</p>
      )}
      <ul className="divide-y divide-border">
        {items.map(item => (
          <li key={item.id} className="py-2.5 flex items-center gap-3">
            <a href={item.href || '#'} className="flex-1 min-w-0 text-sm text-foreground truncate">{item.label}</a>
            <span className={`text-sm font-mono ${item.amountCents > 0 ? 'text-green-600' : item.amountCents < 0 ? 'text-foreground' : 'text-muted-foreground'}`}>{fmtAmount(item.amountCents)}</span>
            <span className="text-xs text-muted-foreground whitespace-nowrap">{fmtRelative(item.date)}</span>
          </li>
        ))}
      </ul>
      {items.length >= 10 && (
        <button onClick={onLoadMore} disabled={loading} className="w-full mt-3 text-sm text-primary hover:bg-primary/5 rounded-lg py-2">
          {loading ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  );
};
