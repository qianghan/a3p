'use client';

import React, { useEffect, useState } from 'react';
import { FileText, Paperclip } from 'lucide-react';
import { formatCurrencyCents, defaultCurrencyFor } from '@/lib/jurisdiction-currency';

interface Expense { id: string; amountCents: number; vendorName?: string | null; description?: string | null; date?: string; receiptUrl?: string | null; currency?: string | null }

export default function MobileDocs() {
  const [items, setItems] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  // Tenant currency, resolved from jurisdiction — same source the PWA home
  // screen uses. Falls back to USD so a CA/AU user never sees a bare "$".
  const [tenantCurrency, setTenantCurrency] = useState('USD');

  useEffect(() => {
    fetch('/api/v1/agentbook-expense/expenses?limit=30')
      .then((r) => r.json())
      .then((j) => { if (j?.success) setItems(j.data); })
      .finally(() => setLoading(false));
    fetch('/api/v1/agentbook-tax/tax/estimate')
      .then((r) => r.json())
      .then((j) => { if (j?.success) setTenantCurrency(defaultCurrencyFor(j?.data?.jurisdiction)); })
      .catch(() => { /* keep USD fallback */ });
  }, []);

  // Prefer a per-expense currency when present, else the tenant currency.
  const fmt$ = (c: number, cur?: string | null) => formatCurrencyCents(c, cur || tenantCurrency);

  return (
    <div style={{ padding: '20px 16px', color: 'var(--foreground,#fff)' }}>
      <h1 style={{ fontSize: 20, fontWeight: 500, marginBottom: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
        <FileText style={{ width: 20, height: 20 }} /> Documents
      </h1>
      {loading ? (
        <p style={{ color: 'var(--muted-foreground,#888)' }}>Loading…</p>
      ) : items.length === 0 ? (
        <p style={{ color: 'var(--muted-foreground,#888)' }}>No expenses yet. Capture one to get started.</p>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {items.map((e) => (
            <div key={e.id} style={{ padding: 14, borderRadius: 10, background: 'var(--card,#111)', border: '1px solid var(--border,#262626)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <p style={{ fontSize: 14, fontWeight: 500 }}>{e.vendorName || e.description || 'Expense'}</p>
                <p style={{ fontSize: 12, color: 'var(--muted-foreground,#888)' }}>{e.date ? new Date(e.date).toLocaleDateString() : ''}</p>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {e.receiptUrl && (
                  <a href={e.receiptUrl} target="_blank" rel="noreferrer" style={{ color: '#10b981' }}>
                    <Paperclip style={{ width: 16, height: 16 }} />
                  </a>
                )}
                <span style={{ fontSize: 14, fontWeight: 600 }}>{fmt$(e.amountCents, e.currency)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
