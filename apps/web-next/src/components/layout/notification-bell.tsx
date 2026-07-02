'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bell, CheckCheck } from 'lucide-react';

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

const POLL_INTERVAL_MS = 30_000;

function relativeTime(iso: string | null): string {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SEVERITY_DOT: Record<string, string> = {
  info: 'bg-blue-500',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  urgent: 'bg-red-500',
};

export function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/agentbook-core/notifications?limit=10', { credentials: 'include' });
      const data = await res.json();
      if (data.success) {
        setItems(data.data.notifications);
        setUnreadCount(data.data.unreadCount);
      }
    } catch {
      // Best-effort — the bell just shows stale/no data until the next poll.
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  const handleOpen = () => {
    setOpen((prev) => !prev);
    if (!open) load();
  };

  const handleItemClick = async (item: NotificationItem) => {
    setLoading(true);
    try {
      await fetch(`/api/v1/agentbook-core/notifications/${item.id}/read`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acted: !!item.ctaUrl }),
      });
      setItems((prev) => prev.map((n) => (n.id === item.id ? { ...n, readAt: new Date().toISOString() } : n)));
      setUnreadCount((prev) => Math.max(0, prev - (item.readAt ? 0 : 1)));
    } finally {
      setLoading(false);
    }
    setOpen(false);
    if (item.ctaUrl) router.push(item.ctaUrl);
  };

  const markAllRead = async () => {
    setLoading(true);
    try {
      await fetch('/api/v1/agentbook-core/notifications/mark-all-read', { method: 'POST', credentials: 'include' });
      setItems((prev) => prev.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })));
      setUnreadCount(0);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <button
        onClick={handleOpen}
        className="relative p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors duration-100"
        aria-label="Notifications"
      >
        <Bell size={16} />
        {unreadCount > 0 && (
          <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 bg-primary rounded-full" />
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-80 max-h-[28rem] overflow-y-auto rounded-lg border border-border bg-card shadow-xl z-50">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 sticky top-0 bg-card">
              <span className="text-[13px] font-semibold text-foreground">Notifications</span>
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  disabled={loading}
                  className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  <CheckCheck size={12} /> Mark all read
                </button>
              )}
            </div>

            {items.length === 0 ? (
              <p className="text-[12px] text-muted-foreground px-3 py-6 text-center">No notifications yet.</p>
            ) : (
              items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleItemClick(item)}
                  className={`w-full text-left px-3 py-2.5 border-b border-border/40 last:border-0 hover:bg-muted/50 transition-colors ${
                    !item.readAt ? 'bg-primary/5' : ''
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`mt-1 h-1.5 w-1.5 rounded-full shrink-0 ${SEVERITY_DOT[item.severity] || 'bg-muted-foreground'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[12.5px] font-medium text-foreground truncate">{item.title}</span>
                        <span className="text-[10px] text-muted-foreground shrink-0">{relativeTime(item.deliveredAt)}</span>
                      </div>
                      <p className="text-[11.5px] text-muted-foreground mt-0.5 line-clamp-2">{item.body}</p>
                      {item.ctaLabel && (
                        <span className="text-[11px] text-primary font-medium mt-1 inline-block">{item.ctaLabel} →</span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}

            <button
              onClick={() => { setOpen(false); router.push('/notifications'); }}
              className="w-full text-center text-[11.5px] text-muted-foreground hover:text-foreground py-2 border-t border-border/60 sticky bottom-0 bg-card"
            >
              View all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
