'use client';

import React, { useEffect, useState } from 'react';
import { formatCurrencyCents, defaultCurrencyFor } from '@/lib/jurisdiction-currency';

interface Estimate {
  total_revenue: number;
  total_expenses: number;
  total_estimated_tax: number;
  jurisdiction?: string;
}

export default function MobileHome() {
  const [est, setEst] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    fetch('/api/v1/agentbook-tax/tax/estimate')
      .then((r) => r.json())
      .then((j) => {
        if (j?.success) setEst({ ...j, jurisdiction: j?.data?.jurisdiction });
        else setFailed(true);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  const currency = defaultCurrencyFor(est?.jurisdiction);
  const fmt$ = (n: number) => formatCurrencyCents(Math.round(n * 100), currency);

  // A brand-new account has nothing to summarize. Three $0 tiles read as
  // "broken" and offer no way forward, so surface the first useful actions
  // instead — and keep that distinct from "we couldn't load your numbers".
  const isEmpty =
    !!est
    && (est.total_revenue ?? 0) === 0
    && (est.total_expenses ?? 0) === 0
    && (est.total_estimated_tax ?? 0) === 0;

  return (
    <div style={{ padding: '20px 16px', color: 'var(--foreground, #fff)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 2 }}>AgentBook</h1>
      <p style={{ color: 'var(--muted-foreground, #888)', fontSize: 14, marginBottom: 20 }}>
        {isEmpty ? 'Welcome — let’s get your books started' : 'Year to date'}
      </p>

      {loading && <p style={{ color: 'var(--muted-foreground, #888)' }}>Loading…</p>}

      {!loading && failed && (
        <div style={{ padding: 16, borderRadius: 12, border: '1px solid var(--border,#262626)' }}>
          <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Couldn’t load your numbers</p>
          <p style={{ fontSize: 13, color: 'var(--muted-foreground,#888)' }}>
            Check your connection and pull to refresh — your data is safe.
          </p>
        </div>
      )}

      {!loading && !failed && !isEmpty && (
        <div style={{ display: 'grid', gap: 12 }}>
          <Tile label="Revenue" value={fmt$(est?.total_revenue ?? 0)} accent="#10b981" />
          <Tile label="Expenses" value={fmt$(est?.total_expenses ?? 0)} accent="#ef4444" />
          <Tile label="Estimated tax" value={fmt$(est?.total_estimated_tax ?? 0)} accent="#f59e0b" />
        </div>
      )}

      {!loading && !failed && isEmpty && (
        <p style={{ fontSize: 14, color: 'var(--muted-foreground,#888)', lineHeight: 1.5, marginBottom: 16 }}>
          Add one expense and your revenue, expenses and tax estimate start filling in
          automatically. Pick whichever is easiest:
        </p>
      )}

      {/* Real next steps — always tappable, never a dead hint. */}
      <div style={{ display: 'grid', gap: 10, marginTop: isEmpty ? 0 : 24 }}>
        <ActionCard
          href="/app/capture"
          title="Snap a receipt"
          body="Photograph it and the amount, vendor and date are read for you."
        />
        <ActionCard
          href="/app/chat"
          title="Just tell your advisor"
          body="Say “spent $24 on coffee” and it’s logged and categorized."
        />
        <ActionCard
          href="/app/docs"
          title="See what else it can do"
          body="Invoices, bank sync, tax estimates and reports."
        />
      </div>
    </div>
  );
}

function Tile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ padding: 16, borderRadius: 12, background: 'var(--card,#111)', border: '1px solid var(--border,#262626)' }}>
      <p style={{ fontSize: 13, color: 'var(--muted-foreground,#888)' }}>{label}</p>
      <p style={{ fontSize: 28, fontWeight: 600, color: accent }}>{value}</p>
    </div>
  );
}

function ActionCard({ href, title, body }: { href: string; title: string; body: string }) {
  return (
    <a
      href={href}
      style={{
        display: 'block',
        padding: 16,
        borderRadius: 12,
        background: 'var(--card,#111)',
        border: '1px solid var(--border,#262626)',
        color: 'inherit',
        textDecoration: 'none',
      }}
    >
      <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>
        {title} <span aria-hidden="true" style={{ color: 'var(--muted-foreground,#888)' }}>›</span>
      </p>
      <p style={{ fontSize: 13, color: 'var(--muted-foreground,#888)' }}>{body}</p>
    </a>
  );
}
