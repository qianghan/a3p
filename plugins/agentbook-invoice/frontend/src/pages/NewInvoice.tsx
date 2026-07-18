import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Trash2, Send, Save, ArrowLeft, Loader2 } from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';

interface LineItem {
  id: string;
  description: string;
  quantity: number;
  rate: number;
}

interface Client {
  id: string;
  name: string;
  email?: string;
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function formatCurrency(n: number, currency = 'USD') {
  // Intl will throw on a bad code; fall back to en-US/USD without crashing
  // the page.
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(n);
  } catch {
    return `${currency} ${n.toFixed(2)}`;
  }
}

const TERMS_OPTIONS = [
  { value: 'net-30', label: 'Net 30', days: 30 },
  { value: 'net-15', label: 'Net 15', days: 15 },
  { value: 'due-on-receipt', label: 'Due on Receipt', days: 0 },
];

// Currencies the invoice form lets the user pick. Tenant booking currency
// is the default; non-tenant choices trigger an FX preview.
const CURRENCY_OPTIONS = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'] as const;

// Client-side PREVIEW ONLY, mirroring packages/agentbook-jurisdictions/src/{au,ca,us}/sales-tax.ts —
// the backend (computeInvoiceTax) is the authoritative computation and is
// what actually gets persisted; this just pre-fills an editable field so
// the user isn't staring at "0%" for AU/CA/US tenants. Keep in sync with
// those files if their rates ever change.
const CA_PROVINCE_RATES: Record<string, number> = {
  AB: 5, BC: 12, SK: 11, MB: 12, ON: 13, QC: 14.975,
  NB: 15, NS: 15, NL: 15, PE: 15, NT: 5, NU: 5, YT: 5,
};

// Mirrors packages/agentbook-jurisdictions/src/us/sales-tax.ts's STATE_RATES —
// see that file's authoritative table if these ever need updating. That
// file's values are fractions (e.g. 0.0725); this file's convention
// (matching CA_PROVINCE_RATES above) is percentages (e.g. 7.25).
const US_STATE_RATES: Record<string, number> = {
  CA: 7.25, NY: 4, TX: 6.25, FL: 6, WA: 6.5,
  IL: 6.25, PA: 6, OH: 5.75, GA: 4, NC: 4.75,
  OR: 0, NH: 0, MT: 0, DE: 0, AK: 0,
};

function defaultTaxRatePercent(jurisdiction: string, region: string): number {
  if (jurisdiction === 'au') return 10;
  if (jurisdiction === 'ca') return CA_PROVINCE_RATES[region.toUpperCase()] ?? 0;
  if (jurisdiction === 'us') return US_STATE_RATES[region.toUpperCase()] ?? 0;
  return 0;
}

const API = '/api/v1/agentbook-invoice';
const CORE_API = '/api/v1/agentbook-core';

export const NewInvoicePage: React.FC = () => {
  const navigate = useNavigate();
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [clientName, setClientName] = useState('');
  const [clientEmail, setClientEmail] = useState('');
  const [description, setDescription] = useState('');
  const [terms, setTerms] = useState('net-30');
  const [invoiceDate, setInvoiceDate] = useState(new Date().toISOString().slice(0, 10));
  // Deferred revenue (retainers/subscriptions): recognize evenly over N months.
  const [deferEnabled, setDeferEnabled] = useState(false);
  const [deferMonths, setDeferMonths] = useState(12);
  const [lineItems, setLineItems] = useState<LineItem[]>([
    { id: uid(), description: '', quantity: 1, rate: 0 },
  ]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Multi-currency (PR 13)
  const [tenantCurrency, setTenantCurrency] = useState<string>('USD');
  const [currency, setCurrency] = useState<string>('USD');
  const [fxRate, setFxRate] = useState<number | null>(null);
  const [fxLoading, setFxLoading] = useState(false);

  // Sales tax (Launch-gap PR-6) — AU/CA/US, per computeInvoiceTax's scope.
  const [jurisdiction, setJurisdiction] = useState<string>('us');
  const [region, setRegion] = useState<string>('');
  const [taxRatePercent, setTaxRatePercent] = useState<number>(0);

  // Load existing clients
  useEffect(() => {
    fetch(`${API}/clients`).then(r => r.json()).then(d => {
      if (d.success) setClients(d.data || []);
    }).catch(() => {});
  }, []);

  // Load tenant booking currency + jurisdiction (defaults the currency
  // selector and the tax-rate field below).
  useEffect(() => {
    fetch(`${CORE_API}/tenant-config`)
      .then(r => r.json())
      .then(d => {
        if (d.success && d.data?.currency) {
          setTenantCurrency(d.data.currency);
          setCurrency(d.data.currency);
        }
        if (d.success && d.data?.jurisdiction) {
          setJurisdiction(d.data.jurisdiction);
          setRegion(d.data.region || '');
          setTaxRatePercent(defaultTaxRatePercent(d.data.jurisdiction, d.data.region || ''));
        }
      })
      .catch(() => {});
  }, []);

  // Whenever the user picks a non-tenant currency, fetch a preview rate.
  useEffect(() => {
    if (!currency || currency === tenantCurrency) {
      setFxRate(null);
      return;
    }
    let cancelled = false;
    setFxLoading(true);
    fetch(`${CORE_API}/fx/rate?from=${currency}&to=${tenantCurrency}`)
      .then(r => r.json())
      .then(d => {
        if (cancelled) return;
        if (d.success && typeof d.data?.rate === 'number') setFxRate(d.data.rate);
        else setFxRate(null);
      })
      .catch(() => {
        if (!cancelled) setFxRate(null);
      })
      .finally(() => {
        if (!cancelled) setFxLoading(false);
      });
    return () => { cancelled = true; };
  }, [currency, tenantCurrency]);

  const addLineItem = () => {
    setLineItems((prev) => [...prev, { id: uid(), description: '', quantity: 1, rate: 0 }]);
  };

  const removeLineItem = (id: string) => {
    if (lineItems.length <= 1) return;
    setLineItems((prev) => prev.filter((li) => li.id !== id));
  };

  const updateLineItem = (id: string, field: keyof LineItem, value: string | number) => {
    setLineItems((prev) =>
      prev.map((li) => (li.id === id ? { ...li, [field]: value } : li))
    );
  };

  const subtotal = lineItems.reduce((sum, li) => sum + li.quantity * li.rate, 0);
  const showTaxField = jurisdiction === 'au' || jurisdiction === 'ca' || jurisdiction === 'us';
  const taxAmount = showTaxField ? subtotal * (taxRatePercent / 100) : 0;
  const total = subtotal + taxAmount;

  const handleSubmit = async (status: 'draft' | 'sent') => {
    setSubmitting(true);
    setError('');
    try {
      // 1. Resolve clientId — use selected or create new
      let clientId = selectedClientId;
      if (!clientId && clientName.trim()) {
        const clientRes = await fetch(`${API}/clients`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: clientName.trim(), email: clientEmail.trim() || undefined }),
        });
        const clientData = await clientRes.json();
        if (!clientData.success) {
          setError(clientData.error || 'Failed to create client');
          return;
        }
        clientId = clientData.data.id;
      }

      if (!clientId) {
        setError('Please select a client or enter a new client name');
        return;
      }

      // Validate line items
      const validLines = lineItems.filter(li => li.description.trim() && li.rate > 0);
      if (validLines.length === 0) {
        setError('Add at least one line item with a description and rate');
        return;
      }

      // 2. Calculate due date from terms
      const termsDays = TERMS_OPTIONS.find(t => t.value === terms)?.days ?? 30;
      const issuedDate = new Date(invoiceDate);
      const dueDate = new Date(issuedDate);
      dueDate.setDate(dueDate.getDate() + termsDays);

      // 3. Compute booked-currency line items.
      //    If the user picked a non-tenant currency we apply the previewed
      //    rate to convert each rate into the tenant booking currency
      //    before posting. The original-currency block goes alongside.
      const isForeign = currency !== tenantCurrency;
      const rateMultiplier = isForeign && fxRate ? fxRate : 1;
      const bookedLines = validLines.map(({ description: desc, quantity, rate }) => ({
        description: desc,
        quantity,
        rateCents: Math.round(rate * 100 * rateMultiplier),
      }));
      const originalTotalCents = isForeign
        ? validLines.reduce((sum, li) => sum + Math.round(li.quantity * li.rate * 100), 0)
        : null;

      // 4. Create invoice — amounts in CENTS
      const res = await fetch(`${API}/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId,
          issuedDate: invoiceDate,
          dueDate: dueDate.toISOString().slice(0, 10),
          status,
          currency: tenantCurrency,
          lines: bookedLines,
          ...(showTaxField ? { taxRate: taxRatePercent / 100 } : {}),
          ...(deferEnabled && deferMonths >= 2 ? { deferOverMonths: deferMonths } : {}),
          ...(isForeign && fxRate && originalTotalCents != null
            ? {
                originalCurrency: currency,
                originalAmountCents: originalTotalCents,
                fxRate,
                fxRateSource: 'ecb',
                fxRateDate: new Date().toISOString(),
              }
            : {}),
        }),
      });

      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to create invoice');
        return;
      }

      navigate('/');
    } catch (err) {
      setError(String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const fieldClass =
    'w-full px-3 py-2 rounded-lg border border-input bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring';
  const fieldClassRight = `${fieldClass} text-right`;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button type="button" onClick={() => navigate('/')} className="p-2 rounded-lg hover:bg-muted transition-colors text-muted-foreground">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-2xl font-bold text-foreground">
          New Invoice
        </h1>
      </div>

      {/* PR 41 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="invoice Acme $5,000 for January consulting, due in 30 days" />

      <div className="space-y-6">
        {/* Client info */}
        <div className="rounded-xl p-4 sm:p-6 border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-4 text-muted-foreground">
            Client Details
          </h2>
          {clients.length > 0 && (
            <div className="mb-4">
              <label className="block text-sm font-medium mb-1 text-foreground">
                Select Existing Client
              </label>
              <select
                value={selectedClientId}
                onChange={(e) => { setSelectedClientId(e.target.value); if (e.target.value) { setClientName(''); setClientEmail(''); } }}
                className={fieldClass}
              >
                <option value="">— New client —</option>
                {clients.map(c => <option key={c.id} value={c.id}>{c.name}{c.email ? ` (${c.email})` : ''}</option>)}
              </select>
            </div>
          )}
          {!selectedClientId && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1 text-foreground">
                  Client Name
                </label>
                <input
                  type="text"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  placeholder="Enter client name"
                  className={fieldClass}
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1 text-foreground">
                  Client Email
                </label>
                <input
                  type="email"
                  value={clientEmail}
                  onChange={(e) => setClientEmail(e.target.value)}
                  placeholder="client@example.com"
                  className={fieldClass}
                />
              </div>
            </div>
          )}
        </div>

        {/* Invoice details */}
        <div className="rounded-xl p-4 sm:p-6 border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-4 text-muted-foreground">
            Invoice Details
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">
                Invoice Date
              </label>
              <input
                type="date"
                value={invoiceDate}
                onChange={(e) => setInvoiceDate(e.target.value)}
                className={fieldClass}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">
                Terms
              </label>
              <select
                value={terms}
                onChange={(e) => setTerms(e.target.value)}
                className={fieldClass}
              >
                {TERMS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-1">
              <label className="block text-sm font-medium mb-1 text-foreground">
                Description
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Project description"
                className={fieldClass}
              />
            </div>
          </div>
          {/* Deferred revenue — retainers/subscriptions billed up front */}
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <label className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={deferEnabled}
                onChange={(e) => setDeferEnabled(e.target.checked)}
              />
              Recognize revenue over time (retainer / subscription)
            </label>
            {deferEnabled && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Over</span>
                <input
                  type="number"
                  min={2}
                  max={60}
                  value={deferMonths}
                  onChange={(e) => setDeferMonths(Math.max(2, Math.min(60, Number(e.target.value) || 2)))}
                  className="w-20 rounded-lg border border-border bg-background px-2 py-1 text-sm text-foreground"
                />
                <span className="text-sm text-muted-foreground">months — earned evenly each month.</span>
              </div>
            )}
          </div>
          {/* Currency selector — multi-currency (PR 13) */}
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1 text-foreground">
                Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className={fieldClass}
                data-testid="invoice-currency-select"
              >
                {CURRENCY_OPTIONS.map((c) => (
                  <option key={c} value={c}>{c}{c === tenantCurrency ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>
            {currency !== tenantCurrency && (
              <div className="sm:col-span-2 flex items-end text-xs text-muted-foreground">
                {fxLoading ? (
                  <span>Looking up rate…</span>
                ) : fxRate ? (
                  <span data-testid="invoice-fx-preview">
                    Will be booked in <b>{tenantCurrency}</b> at
                    {' '}
                    <b>1 {currency} ≈ {fxRate.toFixed(4)} {tenantCurrency}</b>.
                  </span>
                ) : (
                  <span className="text-destructive">No rate available — invoice will be booked in {currency}.</span>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Line items */}
        <div className="rounded-xl p-4 sm:p-6 border border-border bg-card">
          <h2 className="text-sm font-semibold uppercase tracking-wide mb-4 text-muted-foreground">
            Line Items
          </h2>

          <div className="space-y-3">
            {/* Desktop header */}
            <div className="hidden sm:grid sm:grid-cols-12 gap-3 text-xs font-medium uppercase tracking-wide px-1 text-muted-foreground">
              <span className="col-span-5">Description</span>
              <span className="col-span-2 text-right">Qty</span>
              <span className="col-span-2 text-right">Rate</span>
              <span className="col-span-2 text-right">Amount</span>
              <span className="col-span-1" />
            </div>

            {lineItems.map((li) => (
              <div
                key={li.id}
                className="grid grid-cols-1 sm:grid-cols-12 gap-3 p-3 rounded-lg bg-muted/40"
              >
                <div className="sm:col-span-5">
                  <label className="sm:hidden block text-xs font-medium mb-1 text-muted-foreground">
                    Description
                  </label>
                  <input
                    type="text"
                    value={li.description}
                    onChange={(e) => updateLineItem(li.id, 'description', e.target.value)}
                    placeholder="Item description"
                    className={fieldClass}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="sm:hidden block text-xs font-medium mb-1 text-muted-foreground">
                    Quantity
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={li.quantity}
                    onChange={(e) => updateLineItem(li.id, 'quantity', parseFloat(e.target.value) || 0)}
                    className={fieldClassRight}
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="sm:hidden block text-xs font-medium mb-1 text-muted-foreground">
                    Rate
                  </label>
                  <input
                    type="number"
                    min={0}
                    step={0.01}
                    value={li.rate}
                    onChange={(e) => updateLineItem(li.id, 'rate', parseFloat(e.target.value) || 0)}
                    className={fieldClassRight}
                  />
                </div>
                <div className="sm:col-span-2 flex items-center justify-end">
                  <span className="font-semibold text-sm text-foreground">
                    {formatCurrency(li.quantity * li.rate, currency)}
                  </span>
                </div>
                <div className="sm:col-span-1 flex items-center justify-end">
                  <button
                    type="button"
                    onClick={() => removeLineItem(li.id)}
                    disabled={lineItems.length <= 1}
                    className="p-1.5 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors disabled:opacity-30"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={addLineItem}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors hover:bg-muted text-primary"
          >
            <Plus className="w-4 h-4" />
            Add Line Item
          </button>
        </div>

        {/* Subtotal / tax / total + actions */}
        <div className="rounded-xl p-4 sm:p-6 border border-border bg-card">
          {showTaxField ? (
            <div className="mb-6 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Subtotal</span>
                <span className="text-sm font-medium text-foreground">{formatCurrency(subtotal, currency)}</span>
              </div>
              <div className="flex items-center justify-between">
                <label htmlFor="tax-rate" className="text-sm text-muted-foreground">
                  Tax rate (%)
                </label>
                <input
                  id="tax-rate"
                  type="number"
                  min={0}
                  max={100}
                  step={0.001}
                  value={taxRatePercent}
                  onChange={(e) => setTaxRatePercent(parseFloat(e.target.value) || 0)}
                  className="w-24 px-2 py-1 text-sm text-right rounded-lg border border-border bg-background text-foreground"
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Tax</span>
                <span className="text-sm font-medium text-foreground">{formatCurrency(taxAmount, currency)}</span>
              </div>
              <div className="flex items-center justify-between pt-2 border-t border-border">
                <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Total</span>
                <span className="text-2xl font-bold text-foreground">{formatCurrency(total, currency)}</span>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between mb-6">
              <span className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Total
              </span>
              <span className="text-2xl font-bold text-foreground">
                {formatCurrency(total, currency)}
              </span>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 rounded-lg text-sm text-destructive bg-destructive/10 border border-destructive/20">
              {error}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => handleSubmit('draft')}
              disabled={submitting}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium border border-border bg-background text-foreground transition-colors hover:bg-muted disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save as Draft
            </button>
            <button
              type="button"
              onClick={() => handleSubmit('sent')}
              disabled={submitting}
              className="flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
              Create &amp; Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default NewInvoicePage;
