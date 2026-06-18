import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAgentEvents } from '@naap/plugin-sdk';
import { InvoiceStatusBadge } from '../components/InvoiceStatusBadge';
import {
  Plus,
  FileText,
  Clock,
  DollarSign,
  Loader2,
  RefreshCw,
} from 'lucide-react';

// API returns raw Prisma rows from /api/v1/agentbook-invoice/invoices
// (apps/web-next/.../invoices/route.ts + the parallel Express handler in
// plugins/agentbook-invoice/backend). Field names are camelCase; amounts
// are stored in cents. Both backends include the client relation, so
// `client.name` is available for display.
interface Invoice {
  id: string;
  number: string;
  client?: { name: string };
  amountCents: number;
  currency: string;
  dueDate: string;
  status: 'draft' | 'sent' | 'overdue' | 'paid' | 'void';
  // Origin of the invoice — set on drafts created via the Telegram bot.
  source?: 'web' | 'telegram' | 'api' | null;
  // PR 26: soft-delete timestamp (null when live).
  deletedAt?: string | null;
  // Task 7: timestamp of last reminder email sent (null when never sent).
  lastRemindedAt?: string | null;
}

const TABS = ['all', 'draft', 'sent', 'overdue', 'paid'] as const;

function formatCurrency(cents: number, currency = 'USD') {
  const value = Number.isFinite(cents) ? cents / 100 : 0;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() || 'USD' }).format(value);
}

function formatDate(d?: string | null) {
  if (!d) return '—';
  const parsed = new Date(d);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export const InvoiceListPage: React.FC = () => {
  const navigate = useNavigate();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<string>('all');
  // PR 26: opt-in toggle to include soft-deleted invoices in the list.
  const [showDeleted, setShowDeleted] = useState(false);
  // Task 7: bulk-remind loading state.
  const [remindingAll, setRemindingAll] = useState(false);

  const fetchInvoices = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = showDeleted ? '?includeDeleted=true' : '';
      const res = await fetch(`/api/v1/agentbook-invoice/invoices${qs}`);
      if (!res.ok) throw new Error('Failed to fetch invoices');
      const data = await res.json();
      setInvoices(Array.isArray(data) ? data : data.invoices ?? data.data ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [showDeleted]);

  const overdueInvoices = invoices.filter((inv) => inv.status === 'overdue');

  const sendAllReminders = async (): Promise<void> => {
    setRemindingAll(true);
    for (const inv of overdueInvoices) {
      await fetch(`/api/v1/agentbook-invoice/invoices/${inv.id}/remind`, { method: 'POST' })
        .catch(() => null);
      await new Promise((r) => setTimeout(r, 200)); // throttle to avoid rate-limiting
    }
    setRemindingAll(false);
    fetchInvoices();
  };

  // PR 28 adoption: refetch when the agent mutates invoice state via chat
  // / Telegram (create, send, void, payment recorded, etc.).
  const { lastChange } = useAgentEvents({ kinds: ['invoice', 'payment'] });

  useEffect(() => {
    fetchInvoices();
  }, [fetchInvoices, lastChange]);

  // PR 26: restore a soft-deleted invoice within the 90-day window.
  const handleRestore = async (id: string) => {
    try {
      const res = await fetch(`/api/v1/agentbook-core/restore/invoice/${id}`, { method: 'POST' });
      if (!res.ok) return;
      setInvoices(prev => prev.map(i => i.id === id ? { ...i, deletedAt: null } : i));
    } catch { /* silent */ }
  };

  const filtered = activeTab === 'all' ? invoices : invoices.filter((i) => i.status === activeTab);

  const outstandingCents = invoices
    .filter((i) => i.status === 'sent' || i.status === 'overdue')
    .reduce((sum, i) => sum + (Number.isFinite(i.amountCents) ? i.amountCents : 0), 0);
  // Use the currency of the first outstanding invoice for the banner; if
  // a tenant mixes currencies the per-row amounts still render correctly.
  const outstandingCurrency = invoices.find((i) => i.status === 'sent' || i.status === 'overdue')?.currency || 'USD';

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-primary)' }}>
            Invoices
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Manage and track all your invoices
          </p>
        </div>
        <button
          onClick={() => navigate('/new')}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-white transition-colors"
          style={{ backgroundColor: 'var(--accent-emerald, #10b981)' }}
        >
          <Plus className="w-4 h-4" />
          New Invoice
        </button>
      </div>

      {/* Outstanding banner */}
      <div
        className="rounded-xl p-4 mb-6 flex items-center gap-3"
        style={{ backgroundColor: 'var(--bg-secondary, #f9fafb)' }}
      >
        <div className="p-2 rounded-lg bg-amber-100">
          <DollarSign className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
            Total Outstanding
          </p>
          <p className="text-xl font-bold" style={{ color: 'var(--text-primary)' }}>
            {formatCurrency(outstandingCents, outstandingCurrency)}
          </p>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex gap-1 mb-6 overflow-x-auto pb-1">
        {TABS.map((tab) => {
          const count = tab === 'all' ? invoices.length : invoices.filter((i) => i.status === tab).length;
          return (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                activeTab === tab
                  ? 'text-white'
                  : 'hover:bg-gray-100'
              }`}
              style={
                activeTab === tab
                  ? { backgroundColor: 'var(--accent-emerald, #10b981)' }
                  : { color: 'var(--text-secondary)' }
              }
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)} ({count})
            </button>
          );
        })}
        {/* PR 26: Show deleted toggle */}
        <button
          onClick={() => setShowDeleted(v => !v)}
          className={`ml-auto px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
            showDeleted ? 'bg-red-100 text-red-700' : 'hover:bg-gray-100'
          }`}
          style={!showDeleted ? { color: 'var(--text-secondary)' } : undefined}
          title="Include soft-deleted invoices"
        >
          {showDeleted ? 'Hide deleted' : 'Show deleted'}
        </button>
      </div>

      {/* Task 7: Overdue banner with bulk-remind */}
      {activeTab === 'overdue' && overdueInvoices.length > 0 && (
        <div className="mb-4 flex items-center justify-between rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <span className="text-sm font-medium text-red-800">
            {overdueInvoices.length} invoice{overdueInvoices.length !== 1 ? 's' : ''} past due —{' '}
            {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
              overdueInvoices.reduce((s, inv) => s + inv.amountCents, 0) / 100,
            )}{' '}
            outstanding
          </span>
          <button
            onClick={sendAllReminders}
            disabled={remindingAll}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {remindingAll ? 'Sending…' : 'Send all reminders'}
          </button>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--accent-emerald)' }} />
        </div>
      ) : error ? (
        <div className="text-center py-20">
          <p className="text-red-500 mb-3">{error}</p>
          <button
            onClick={fetchInvoices}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border hover:bg-gray-50"
          >
            <RefreshCw className="w-4 h-4" /> Retry
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20" style={{ color: 'var(--text-secondary)' }}>
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No invoices found</p>
          <p className="text-sm mt-1">Create your first invoice to get started.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((inv) => {
            return (
              <div
                key={inv.id}
                onClick={() => navigate('/invoices/' + inv.id)}
                className={`rounded-xl p-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 border border-border bg-card transition-shadow hover:shadow-md cursor-pointer ${inv.deletedAt ? 'line-through text-muted-foreground/70 opacity-70' : ''}`}
              >
                {/* Left: invoice info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-semibold text-sm text-foreground">
                      {inv.number}
                    </span>
                    <InvoiceStatusBadge status={inv.status} />
                    {inv.source === 'telegram' && (
                      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-100 text-sky-700">
                        via Telegram
                      </span>
                    )}
                    {inv.deletedAt && (
                      <button
                        onClick={(ev) => { ev.stopPropagation(); handleRestore(inv.id); }}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium no-underline bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                        title="Restore (within 90 days of delete)"
                      >Restore</button>
                    )}
                    {/* Task 7: per-row remind button for overdue invoices */}
                    {inv.status === 'overdue' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const cooldown = inv.lastRemindedAt
                            ? Date.now() - new Date(inv.lastRemindedAt).getTime() < 24 * 60 * 60 * 1000
                            : false;
                          if (cooldown) return;
                          fetch(`/api/v1/agentbook-invoice/invoices/${inv.id}/remind`, { method: 'POST' })
                            .then(() => fetchInvoices())
                            .catch(console.error);
                        }}
                        className={`ml-2 rounded px-2 py-0.5 text-xs font-medium border ${
                          inv.lastRemindedAt &&
                          Date.now() - new Date(inv.lastRemindedAt).getTime() < 24 * 60 * 60 * 1000
                            ? 'border-gray-200 text-gray-400 cursor-default'
                            : 'border-red-300 text-red-600 hover:bg-red-50'
                        }`}
                      >
                        {inv.lastRemindedAt &&
                        Date.now() - new Date(inv.lastRemindedAt).getTime() < 24 * 60 * 60 * 1000
                          ? `Reminded ${new Date(inv.lastRemindedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
                          : 'Remind'}
                      </button>
                    )}
                  </div>
                  <p className="text-sm truncate text-muted-foreground">
                    {inv.client?.name ?? ''}
                  </p>
                </div>

                {/* Right: amount + due date */}
                <div className="flex items-center justify-between sm:flex-col sm:items-end gap-1">
                  <span className="font-bold text-base" style={{ color: 'var(--text-primary)' }}>
                    {formatCurrency(inv.amountCents, inv.currency)}
                  </span>
                  <span className="text-xs flex items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
                    <Clock className="w-3 h-3" />
                    {formatDate(inv.dueDate)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default InvoiceListPage;
