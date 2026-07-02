import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Send, CreditCard, AlertTriangle, Loader2, X } from 'lucide-react';
import { InvoiceStatusBadge, type InvoiceStatus } from '../components/InvoiceStatusBadge';
import { RecordPaymentModal } from '../components/RecordPaymentModal';

interface InvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitPriceCents: number;
  amountCents: number;
}

interface Payment {
  id: string;
  paidAt: string;
  method: string;
  amountCents: number;
}

interface InvoiceDetail {
  id: string;
  number: string;
  status: string;
  issuedDate: string;
  dueDate: string | null;
  amountCents: number;
  currency: string;
  totalPaidCents: number;
  balanceDueCents: number;
  lastRemindedAt: string | null;
  client?: { id: string; name: string; email?: string | null };
  lines: InvoiceLine[];
  payments: Payment[];
}

function fmt(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null || isNaN(cents)) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

const METHOD_LABELS: Record<string, string> = {
  manual: 'Manual',
  bank_transfer: 'Bank Transfer',
  check: 'Check',
  cash: 'Cash',
  stripe: 'Stripe',
  other: 'Other',
};

function daysOverdue(dueDate: string | null): number {
  if (!dueDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(dueDate).getTime()) / 86400000));
}

function reminderTone(days: number): string {
  if (days > 30) return 'urgent';
  if (days > 7) return 'firm';
  return 'gentle';
}

export function InvoiceDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [invoice, setInvoice] = useState<InvoiceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Separate from `err` — that state gates whether the whole page renders
  // (see the `if (err || !invoice)` guard below), so reusing it for an
  // action failure on an already-loaded invoice would blow away the entire
  // page instead of showing an inline message.
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  const [showPayModal, setShowPayModal] = useState(false);

  const showToast = (msg: string, type: 'success' | 'error' = 'success'): void => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const reload = useCallback((): void => {
    setLoading(true);
    fetch(`/api/v1/agentbook-invoice/invoices/${id}`)
      .then((r) => r.json())
      .then((body: { data: InvoiceDetail }) => setInvoice(body.data))
      .catch((e: unknown) => setErr(String(e)))
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => { reload(); }, [reload]);

  // QA-P5-003: these three handlers passed String(e) straight into the
  // toast — a real user saw the raw "TypeError: Failed to fetch" exception
  // text for 3.5s, then it vanished with no lasting trace. Now shows a
  // human-readable message via the toast AND a persistent inline banner
  // (actionError, rendered near the buttons below), so a user who reads it
  // a moment late — or wants to act on it — still can.
  const doSend = async (): Promise<void> => {
    setActionError(null);
    setActionBusy('send');
    try {
      const r = await fetch(`/api/v1/agentbook-invoice/invoices/${id}/send`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}`);
      reload();
      showToast('Invoice marked as issued');
    } catch {
      const msg = "Couldn't send this invoice — check your connection and try again.";
      showToast(msg, 'error');
      setActionError(msg);
    } finally { setActionBusy(null); }
  };

  const doVoid = async (): Promise<void> => {
    if (!window.confirm('Void this invoice? This will reverse the journal entry and cannot be undone.')) return;
    setActionError(null);
    setActionBusy('void');
    try {
      const r = await fetch(`/api/v1/agentbook-invoice/invoices/${id}/void`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}`);
      reload();
      showToast('Invoice voided');
    } catch {
      const msg = "Couldn't void this invoice — check your connection and try again.";
      showToast(msg, 'error');
      setActionError(msg);
    } finally { setActionBusy(null); }
  };

  const doRemind = async (): Promise<void> => {
    setActionError(null);
    setActionBusy('remind');
    try {
      const r = await fetch(`/api/v1/agentbook-invoice/invoices/${id}/remind`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}`);
      reload();
      showToast('Reminder sent');
    } catch {
      const msg = "Couldn't send a reminder — check your connection and try again.";
      showToast(msg, 'error');
      setActionError(msg);
    } finally { setActionBusy(null); }
  };

  const openPdf = (): void => {
    window.open(`/api/v1/agentbook-invoice/invoices/${id}/pdf`, '_blank');
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (err || !invoice) {
    return (
      <div className="p-6">
        <p className="text-destructive">{err ?? 'Invoice not found'}</p>
      </div>
    );
  }

  const status = invoice.status as InvoiceStatus;
  const overdueDays = daysOverdue(invoice.dueDate);
  const canRemind = ['sent', 'viewed', 'overdue'].includes(status);
  const remindCooldown = invoice.lastRemindedAt
    ? Date.now() - new Date(invoice.lastRemindedAt).getTime() < 24 * 60 * 60 * 1000
    : false;
  const canSend = status === 'draft';
  const canDownload = ['sent', 'viewed', 'overdue', 'paid', 'void'].includes(status);

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6 space-y-5">

      {/* Toast */}
      {toast && (
        <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 rounded-lg px-4 py-3 text-sm shadow-lg ${
          toast.type === 'error'
            ? 'bg-destructive/10 border border-destructive/20 text-destructive'
            : 'bg-primary/10 border border-primary/20 text-foreground'
        }`}>
          {toast.msg}
          <button onClick={() => setToast(null)} className="ml-2 text-muted-foreground hover:text-foreground">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Back + invoice header */}
      <div>
        <button
          onClick={() => navigate('/')}
          className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" /> Invoices
        </button>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-2xl font-bold text-foreground">{invoice.number}</span>
              <InvoiceStatusBadge status={status} />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {invoice.client?.name ?? 'No client'}
              {invoice.client?.email ? ` · ${invoice.client.email}` : ''}
              {' · Issued '}{fmtDate(invoice.issuedDate)}
              {invoice.dueDate ? ` · Due ${fmtDate(invoice.dueDate)}` : ''}
            </p>
          </div>
        </div>
      </div>

      {/* Overdue banner */}
      {status === 'overdue' && (
        <div className="flex items-center gap-3 rounded-xl border border-destructive/20 bg-destructive/10 px-4 py-3">
          <AlertTriangle className="w-4 h-4 text-destructive shrink-0" />
          <span className="text-sm text-destructive">
            {overdueDays} day{overdueDays !== 1 ? 's' : ''} past due · {reminderTone(overdueDays)} reminder tone
          </span>
        </div>
      )}

      {/* Action bar — primary / secondary / ghost hierarchy */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Primary: send or record payment */}
        {canSend && (
          <button
            onClick={doSend}
            disabled={actionBusy === 'send'}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {actionBusy === 'send' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {actionBusy === 'send' ? 'Sending…' : 'Send Invoice'}
          </button>
        )}
        {canRemind && (
          <button
            onClick={() => setShowPayModal(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <CreditCard className="w-4 h-4" /> Record Payment
          </button>
        )}

        {/* Secondary: send reminder */}
        {canRemind && (
          <button
            onClick={doRemind}
            disabled={actionBusy === 'remind' || remindCooldown}
            className="flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
          >
            {actionBusy === 'remind' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {actionBusy === 'remind' ? 'Sending…' : remindCooldown ? `Reminded ${fmtDate(invoice.lastRemindedAt ?? '')}` : 'Send Reminder'}
          </button>
        )}

        {/* Ghost: download PDF */}
        {canDownload && (
          <button
            onClick={openPdf}
            className="flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50"
          >
            <Download className="w-4 h-4" /> Download PDF
          </button>
        )}

        {/* Destructive ghost: void */}
        {canRemind && (
          <button
            onClick={doVoid}
            disabled={actionBusy === 'void'}
            className="ml-auto flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:text-destructive hover:bg-destructive/5 disabled:opacity-50"
          >
            {actionBusy === 'void' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            Void
          </button>
        )}
      </div>

      {actionError && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-sm text-destructive">{actionError}</div>
      )}

      {/* Summary totals */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Invoice total', value: fmt(invoice.amountCents, invoice.currency), highlight: false },
          { label: 'Amount paid', value: fmt(invoice.totalPaidCents, invoice.currency), highlight: false },
          { label: 'Balance due', value: fmt(invoice.balanceDueCents, invoice.currency), highlight: invoice.balanceDueCents > 0 },
        ].map(({ label, value, highlight }) => (
          <div
            key={label}
            className={`rounded-xl border p-4 ${
              highlight
                ? 'border-yellow-500/30 bg-yellow-500/5'
                : 'border-border bg-card'
            }`}
          >
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={`mt-1 text-xl font-bold ${highlight ? 'text-yellow-400' : 'text-foreground'}`}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Line items */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-background">
            <tr>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Description</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Qty</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Rate</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id} className="border-b border-border last:border-0">
                <td className="px-4 py-3 text-foreground">{line.description}</td>
                <td className="px-4 py-3 text-right text-muted-foreground">{line.quantity}</td>
                <td className="px-4 py-3 text-right text-muted-foreground">
                  {fmt(line.unitPriceCents, invoice.currency)}
                </td>
                <td className="px-4 py-3 text-right font-medium text-foreground">
                  {fmt(line.amountCents, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Totals row */}
        <div className="border-t border-border bg-background px-4 py-3 flex justify-end">
          <div className="text-right space-y-1">
            <div className="flex gap-8 text-sm">
              <span className="text-muted-foreground">Total</span>
              <span className="font-bold text-foreground">{fmt(invoice.amountCents, invoice.currency)}</span>
            </div>
            {invoice.totalPaidCents > 0 && (
              <div className="flex gap-8 text-sm">
                <span className="text-muted-foreground">Paid</span>
                <span className="text-primary">−{fmt(invoice.totalPaidCents, invoice.currency)}</span>
              </div>
            )}
            {invoice.balanceDueCents > 0 && (
              <div className="flex gap-8 text-sm border-t border-border pt-1 mt-1">
                <span className="text-muted-foreground font-medium">Balance due</span>
                <span className="font-bold text-yellow-400">{fmt(invoice.balanceDueCents, invoice.currency)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Payment history */}
      {invoice.payments.length > 0 && (
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Payment history</h3>
          <div className="rounded-xl border border-border bg-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-background">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Date</th>
                  <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Method</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((p) => (
                  <tr key={p.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3 text-muted-foreground">{fmtDate(p.paidAt)}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {METHOD_LABELS[p.method] ?? p.method}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-primary">
                      +{fmt(p.amountCents, invoice.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showPayModal && invoice && (
        <RecordPaymentModal
          invoiceId={invoice.id}
          invoiceNumber={invoice.number}
          currency={invoice.currency}
          balanceDueCents={invoice.balanceDueCents}
          onClose={() => setShowPayModal(false)}
          onDone={() => { setShowPayModal(false); reload(); showToast('Payment recorded'); }}
        />
      )}
    </div>
  );
}
