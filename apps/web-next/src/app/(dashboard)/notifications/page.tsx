'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck, Loader2 } from 'lucide-react';

interface NotificationItem {
  id: string;
  category: string;
  severity: string;
  title: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-blue-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  urgent: 'bg-red-500',
};

const CATEGORY_LABEL: Record<string, string> = {
  feature: 'New feature',
  reward: 'Discount / reward',
  referral_thanks: 'Referral',
  tax_deadline: 'Tax deadline',
  invoice_due: 'Invoice due',
  expense_review: 'Expense review',
  admin_broadcast: 'Announcement',
  budget_alert: 'Budget alert',
  net_worth_update: 'Net worth update',
  savings_warning: 'Savings warning',
};

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function NotificationsPage() {
  const router = useRouter();
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/v1/agentbook-core/notifications?limit=100`, { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        setItems(data.data.notifications);
      } else {
        setError('Could not load notifications.');
      }
    } catch {
      setError('Could not load notifications — check your connection and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const markAllRead = async () => {
    await fetch('/api/v1/agentbook-core/notifications/mark-all-read', { method: 'POST', credentials: 'include' });
    setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
  };

  const handleClick = async (item: NotificationItem) => {
    await fetch(`/api/v1/agentbook-core/notifications/${item.id}/read`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acted: !!item.ctaUrl }),
    });
    setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)));
    if (item.ctaUrl) router.push(item.ctaUrl);
  };

  const visible = filter === 'unread' ? items.filter((n) => !n.readAt) : items;
  const unreadCount = items.filter((n) => !n.readAt).length;

  return (
    <div className="p-4 max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Bell className="w-5 h-5" />
            Notifications
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">Everything AgentBook has sent you, in one place.</p>
        </div>
        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground border border-border rounded-md px-3 py-1.5"
          >
            <CheckCheck className="w-3.5 h-3.5" /> Mark all read
          </button>
        )}
      </div>

      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setFilter('all')}
          className={`text-sm px-3 py-1 rounded-full ${filter === 'all' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
        >
          All ({items.length})
        </button>
        <button
          onClick={() => setFilter('unread')}
          className={`text-sm px-3 py-1 rounded-full ${filter === 'unread' ? 'bg-foreground text-background' : 'bg-muted text-muted-foreground'}`}
        >
          Unread ({unreadCount})
        </button>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive px-4 py-3 rounded-lg mb-4 text-sm">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
        </div>
      ) : visible.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          {filter === 'unread' ? "You're all caught up." : 'No notifications yet.'}
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border overflow-hidden">
          {visible.map((item) => (
            <button
              key={item.id}
              onClick={() => handleClick(item)}
              className={`w-full text-left px-4 py-3.5 hover:bg-muted/40 transition-colors ${!item.readAt ? 'bg-primary/5' : ''}`}
            >
              <div className="flex items-start gap-3">
                <span className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${SEVERITY_DOT[item.severity] || 'bg-muted-foreground'}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-foreground">{item.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">{formatDate(item.deliveredAt)}</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{item.body}</p>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-[11px] text-muted-foreground uppercase tracking-wide">{CATEGORY_LABEL[item.category] || item.category}</span>
                    {item.ctaLabel && (
                      <span className="text-xs text-primary font-medium">{item.ctaLabel} →</span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
