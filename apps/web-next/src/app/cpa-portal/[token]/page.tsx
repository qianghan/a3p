'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

const fmt$ = (c: number) => (c < 0 ? '-' : '') + '$' + Math.abs(c / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });

interface DocRequest { id: string; description: string; status: string; fulfilledUrl: string | null; createdAt: string }
interface PortalData {
  companyName: string;
  cpaName: string | null;
  period: string;
  pnl: { revenueCents: number; expensesCents: number; netIncomeCents: number };
  documentRequests: DocRequest[];
}

export default function CpaPortalPage() {
  const params = useParams();
  const token = String(params?.token || '');
  const [data, setData] = useState<PortalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/v1/agentbook-cpa/portal/${token}`);
      const j = await r.json();
      if (!r.ok || !j.success) { setError(j.error || 'This invite is no longer active.'); return; }
      setData(j.data);
    } catch { setError('Could not load the portal.'); } finally { setLoading(false); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);

  const requestDoc = async () => {
    setBusy(true);
    try {
      await fetch(`/api/v1/agentbook-cpa/portal/${token}/document-request`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ description: desc }),
      });
      setDesc('');
      await load();
    } finally { setBusy(false); }
  };

  if (loading) return <Centered>Loading…</Centered>;
  if (error || !data) return <Centered>{error || 'Not found.'}</Centered>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1.25rem', fontFamily: 'system-ui, sans-serif', color: '#111' }}>
      <p style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#888' }}>Accountant portal</p>
      <h1 style={{ fontSize: 24, fontWeight: 500, margin: '4px 0 2px' }}>{data.companyName}</h1>
      <p style={{ color: '#666', marginBottom: 24 }}>{data.period}{data.cpaName ? ` · ${data.cpaName}` : ''}</p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 24 }}>
        <Card label="Revenue (YTD)" value={fmt$(data.pnl.revenueCents)} />
        <Card label="Expenses (YTD)" value={fmt$(data.pnl.expensesCents)} />
        <Card label="Net income" value={fmt$(data.pnl.netIncomeCents)} />
      </div>

      <h2 style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>Document requests</h2>
      {data.documentRequests.length === 0 && <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>No requests yet.</p>}
      {data.documentRequests.map((d) => (
        <div key={d.id} style={{ borderLeft: `3px solid ${d.status === 'fulfilled' ? '#0ca30c' : '#eda100'}`, paddingLeft: 12, marginBottom: 10 }}>
          <p style={{ fontSize: 14 }}>{d.description}</p>
          <p style={{ fontSize: 12, color: '#888' }}>
            {d.status === 'fulfilled' && d.fulfilledUrl
              ? <a href={d.fulfilledUrl} target="_blank" rel="noreferrer" style={{ color: '#0ca30c' }}>✓ Fulfilled — view document</a>
              : 'Awaiting the business owner'}
          </p>
        </div>
      ))}

      <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
        <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2} placeholder="Request a document (e.g. “receipt for the $1,200 AWS charge in March”)…"
          style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 }} />
        <button onClick={() => void requestDoc()} disabled={busy || !desc.trim()}
          style={{ padding: '8px 14px', background: '#111', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer', opacity: busy || !desc.trim() ? 0.5 : 1, justifySelf: 'start' }}>
          Request document
        </button>
      </div>
    </div>
  );
}

function Card({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ background: '#f7f7f5', borderRadius: 10, padding: 12 }}>
      <p style={{ fontSize: 12, color: '#888' }}>{label}</p>
      <p style={{ fontSize: 20, fontWeight: 500 }}>{value}</p>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: '60vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', fontFamily: 'system-ui' }}>{children}</div>;
}
