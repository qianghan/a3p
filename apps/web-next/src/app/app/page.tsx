'use client';

import React, { useEffect, useState } from 'react';

interface Estimate {
  total_revenue: number;
  total_expenses: number;
  total_estimated_tax: number;
}

const fmt$ = (n: number) => '$' + Math.round(n).toLocaleString('en-US');

export default function MobileHome() {
  const [est, setEst] = useState<Estimate | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/v1/agentbook-tax/tax/estimate')
      .then((r) => r.json())
      .then((j) => { if (j?.success) setEst(j); })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: '20px 16px', color: 'var(--foreground, #fff)' }}>
      <h1 style={{ fontSize: 22, fontWeight: 500, marginBottom: 2 }}>AgentBook</h1>
      <p style={{ color: 'var(--muted-foreground, #888)', fontSize: 14, marginBottom: 20 }}>Year to date</p>

      {loading ? (
        <p style={{ color: 'var(--muted-foreground, #888)' }}>Loading…</p>
      ) : (
        <div style={{ display: 'grid', gap: 12 }}>
          <Tile label="Revenue" value={fmt$(est?.total_revenue ?? 0)} accent="#10b981" />
          <Tile label="Expenses" value={fmt$(est?.total_expenses ?? 0)} accent="#ef4444" />
          <Tile label="Estimated tax" value={fmt$(est?.total_estimated_tax ?? 0)} accent="#f59e0b" />
        </div>
      )}

      <div style={{ marginTop: 24, padding: 16, borderRadius: 12, border: '1px solid var(--border,#262626)' }}>
        <p style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Snap a receipt</p>
        <p style={{ fontSize: 13, color: 'var(--muted-foreground,#888)', marginBottom: 10 }}>
          Use the Capture tab to add an expense with a photo.
        </p>
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
