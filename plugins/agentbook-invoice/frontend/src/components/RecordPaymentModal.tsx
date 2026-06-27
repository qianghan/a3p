// plugins/agentbook-invoice/frontend/src/components/RecordPaymentModal.tsx
import { useState } from 'react';

const METHODS = [
  { value: 'manual', label: 'Manual' },
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'check', label: 'Check' },
  { value: 'cash', label: 'Cash' },
  { value: 'stripe', label: 'Stripe' },
  { value: 'other', label: 'Other' },
];

interface RecordPaymentModalProps {
  invoiceId: string;
  invoiceNumber: string;
  currency: string;
  balanceDueCents: number;
  onClose: () => void;
  onDone: () => void;
}

export function RecordPaymentModal({
  invoiceId,
  invoiceNumber,
  currency,
  balanceDueCents,
  onClose,
  onDone,
}: RecordPaymentModalProps): JSX.Element {
  const defaultAmount = (balanceDueCents / 100).toFixed(2);
  const [amount, setAmount] = useState(defaultAmount);
  const [method, setMethod] = useState('manual');
  const [paidAt, setPaidAt] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    const amountCents = Math.round(parseFloat(amount) * 100);
    if (isNaN(amountCents) || amountCents <= 0) {
      setErr('Amount must be greater than 0');
      return;
    }
    if (amountCents > balanceDueCents) {
      setErr(`Amount cannot exceed balance due (${(balanceDueCents / 100).toFixed(2)} ${currency})`);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/v1/agentbook-invoice/payments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          invoiceId,
          amountCents,
          method,
          date: new Date(paidAt + 'T12:00:00Z').toISOString(),
        }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `${r.status}`);
      }
      onDone();
    } catch (e2: unknown) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-[420px] rounded-xl bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-semibold">Record Payment — {invoiceNumber}</h3>
          <button onClick={onClose} aria-label="Close" className="text-xl text-gray-400 hover:text-gray-600">×</button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Amount ({currency})
            </label>
            <input
              type="number"
              step="0.01"
              min="0.01"
              max={(balanceDueCents / 100).toFixed(2)}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
            <p className="mt-1 text-xs text-gray-400">
              Balance due: {(balanceDueCents / 100).toFixed(2)} {currency}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Payment date</label>
            <input
              type="date"
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">Method</label>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="mt-1 w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </div>
          {err && <div className="rounded bg-red-50 p-2 text-sm text-red-700">{err}</div>}

          <div className="flex gap-3 pt-2">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 rounded-lg bg-green-600 py-2.5 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
            >
              {busy ? 'Recording…' : 'Record payment'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="flex-1 rounded-lg border py-2.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
