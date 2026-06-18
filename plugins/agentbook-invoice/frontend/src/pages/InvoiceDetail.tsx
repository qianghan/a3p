// plugins/agentbook-invoice/frontend/src/pages/InvoiceDetail.tsx
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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

function fmt(cents: number, currency = 'USD'): string {
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
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [showPayModal, setShowPayModal] = useState(false);

  const showToast = (msg: string): void => {
    setToast(msg);
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

  const doSend = async (): Promise<void> => {
    setErr(null);
    setActionBusy('send');
    try {
      const r = await fetch(`/api/v1/agentbook-invoice/invoices/${id}/send`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}`);
      reload();
      showToast('Invoice marked as issued');
    } catch (e: unknown) { setErr(String(e)); }
    finally { setActionBusy(null); }
  };

  const doVoid = async (): Promise<void> => {
    if (!window.confirm('Void this invoice? This will reverse the journal entry and cannot be undone.')) return;
    setErr(null);
    setActionBusy('void');
    try {
      const r = await fetch(`/api/v1/agentbook-invoice/invoices/${id}/void`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}`);
      reload();
      showToast('Invoice voided');
    } catch (e: unknown) { setErr(String(e)); }
    finally { setActionBusy(null); }
  };

  const doMarkPaid = async (): Promise<void> => {
    if (!invoice) return;
    if (!window.confirm(
      `Mark ${invoice.number} (${fmt(invoice.balanceDueCents, invoice.currency)}) as fully paid via manual payment today?`,
    )) return;
    setErr(null);
    setActionBusy('markpaid');
    try {
      const r = await fetch('/api/v1/agentbook-invoice/payments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invoiceId: id,
          amountCents: invoice.balanceDueCents,
          method: 'manual',
          date: new Date().toISOString(),
        }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      reload();
      showToast('Payment recorded — invoice is now Paid');
    } catch (e: unknown) { setErr(String(e)); }
    finally { setActionBusy(null); }
  };

  const doRemind = async (): Promise<void> => {
    setErr(null);
    setActionBusy('remind');
    try {
      const r = await fetch(`/api/v1/agentbook-invoice/invoices/${id}/remind`, { method: 'POST' });
      if (!r.ok) throw new Error(`${r.status}`);
      reload();
      showToast('Reminder sent');
    } catch (e: unknown) { setErr(String(e)); }
    finally { setActionBusy(null); }
  };

  const openPdf = (): void => {
    window.open(`/api/v1/agentbook-invoice/invoices/${id}/pdf`, '_blank');
  };

  if (loading) return <div className="p-6 text-gray-500">Loading…</div>;
  if (err || !invoice) return <div className="p-6 text-red-600">{err ?? 'Invoice not found'}</div>;

  const status = invoice.status as InvoiceStatus;
  const overdueDays = daysOverdue(invoice.dueDate);
  const canRemind = ['sent', 'viewed', 'overdue'].includes(status);
  const remindCooldown = invoice.lastRemindedAt
    ? Date.now() - new Date(invoice.lastRemindedAt).getTime() < 24 * 60 * 60 * 1000
    : false;

  return (
    <div className="mx-auto max-w-3xl p-6 space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/')}
            className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            aria-label="Back to invoices"
          >
            ← Back
          </button>
          <div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-xl font-bold text-gray-900">{invoice.number}</span>
              <InvoiceStatusBadge status={status} />
            </div>
            <div className="mt-1 text-sm text-gray-500">
              {invoice.client?.name ?? 'No client'} · Issued {fmtDate(invoice.issuedDate)}
              {invoice.dueDate ? ` · Due ${fmtDate(invoice.dueDate)}` : ''}
            </div>
          </div>
        </div>
      </div>

      {/* Overdue alert */}
      {status === 'overdue' && (
        <div className="flex items-center justify-between rounded-lg bg-red-50 border border-red-200 px-4 py-3">
          <span className="text-sm font-medium text-red-800">
            ⚠ This invoice is {overdueDays} day{overdueDays !== 1 ? 's' : ''} past due
            {' '}({reminderTone(overdueDays)} tone)
          </span>
        </div>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap gap-2">
        {['sent', 'viewed', 'overdue', 'paid', 'void'].includes(status) && (
          <button
            onClick={openPdf}
            className="rounded-lg border px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            View PDF ↗
          </button>
        )}
        {status === 'draft' && (
          <button
            onClick={doSend}
            disabled={actionBusy === 'send'}
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {actionBusy === 'send' ? 'Sending…' : 'Send (mark Issued)'}
          </button>
        )}
        {canRemind && (
          <>
            <button
              onClick={doMarkPaid}
              disabled={actionBusy === 'markpaid'}
              className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {actionBusy === 'markpaid' ? 'Recording…' : 'Mark as Paid'}
            </button>
            <button
              onClick={() => setShowPayModal(true)}
              className="rounded-lg border border-green-300 px-3 py-1.5 text-sm font-medium text-green-700 hover:bg-green-50"
            >
              Record Payment
            </button>
            <button
              onClick={doRemind}
              disabled={actionBusy === 'remind' || remindCooldown}
              className={`rounded-lg border px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                status === 'overdue'
                  ? 'border-red-300 text-red-700 hover:bg-red-50'
                  : 'border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {actionBusy === 'remind'
                ? 'Sending…'
                : remindCooldown
                ? `Reminded ${fmtDate(invoice.lastRemindedAt ?? '')}`
                : 'Send Reminder'}
            </button>
            <button
              onClick={doVoid}
              disabled={actionBusy === 'void'}
              className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-500 hover:bg-gray-50 disabled:opacity-50"
            >
              Void
            </button>
          </>
        )}
      </div>

      {err && <div className="rounded bg-red-50 p-3 text-sm text-red-700">{err}</div>}
      {toast && <div className="rounded bg-green-50 p-3 text-sm text-green-700">{toast}</div>}

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Invoice total', value: fmt(invoice.amountCents, invoice.currency) },
          { label: 'Amount paid', value: fmt(invoice.totalPaidCents, invoice.currency) },
          { label: 'Balance due', value: fmt(invoice.balanceDueCents, invoice.currency), highlight: invoice.balanceDueCents > 0 },
        ].map(({ label, value, highlight }) => (
          <div key={label} className={`rounded-lg border p-4 ${highlight ? 'border-amber-300 bg-amber-50' : 'bg-white'}`}>
            <div className="text-xs text-gray-500">{label}</div>
            <div className={`mt-1 text-2xl font-bold ${highlight ? 'text-amber-800' : 'text-gray-900'}`}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {/* Line items */}
      <div className="rounded-lg border bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="border-b bg-gray-50">
            <tr>
              <th className="px-4 py-2 text-left font-medium text-gray-600">Description</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600">Qty</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600">Rate</th>
              <th className="px-4 py-2 text-right font-medium text-gray-600">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.map((line) => (
              <tr key={line.id} className="border-b last:border-0">
                <td className="px-4 py-3 text-gray-800">{line.description}</td>
                <td className="px-4 py-3 text-right text-gray-600">{line.quantity}</td>
                <td className="px-4 py-3 text-right text-gray-600">
                  {fmt(line.unitPriceCents, invoice.currency)}
                </td>
                <td className="px-4 py-3 text-right font-medium text-gray-900">
                  {fmt(line.amountCents, invoice.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Payment history */}
      {invoice.payments.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">Payment history</h3>
          <div className="rounded-lg border bg-white overflow-hidden">
            <table className="w-full text-sm">
              <thead className="border-b bg-gray-50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Date</th>
                  <th className="px-4 py-2 text-left font-medium text-gray-600">Method</th>
                  <th className="px-4 py-2 text-right font-medium text-gray-600">Amount</th>
                </tr>
              </thead>
              <tbody>
                {invoice.payments.map((p) => (
                  <tr key={p.id} className="border-b last:border-0">
                    <td className="px-4 py-3 text-gray-700">{fmtDate(p.paidAt)}</td>
                    <td className="px-4 py-3 text-gray-700">
                      {METHOD_LABELS[p.method] ?? p.method}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-green-700">
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
