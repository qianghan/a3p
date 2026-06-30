'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

const fmt$ = (cents: number) =>
  (cents < 0 ? '-' : '') + '$' + Math.abs(cents / 100).toLocaleString('en-US', { maximumFractionDigits: 0 });

interface Finding { severity: string; category: string; title: string; detail: string; actionItem: string }
interface Review { period: string; score: number; findings: Finding[] }
interface Comment { id: string; authorName: string | null; body: string; createdAt: string }
interface PublicData {
  companyName: string;
  period: string;
  pnl: { revenueCents: number; expensesCents: number; netIncomeCents: number };
  review: Review | null;
  comments: Comment[];
  signoff: { period: string; cpaName: string | null; signedAt: string } | null;
}

const SEV_COLOR: Record<string, string> = {
  critical: '#d03b3b', warning: '#eda100', info: '#2a78d6', clean: '#0ca30c',
};

export default function PublicReviewPage() {
  const params = useParams();
  const token = String(params?.token || '');
  const [data, setData] = useState<PublicData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/v1/agentbook-cpa/public/${token}`);
      const j = await r.json();
      if (!r.ok || !j.success) { setError(j.error || 'This link is no longer active.'); return; }
      setData(j.data);
    } catch {
      setError('Could not load this review.');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const submitComment = async () => {
    setBusy(true);
    try {
      await fetch(`/api/v1/agentbook-cpa/public/${token}/comment`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: comment, authorName: name || undefined }),
      });
      setComment('');
      await load();
    } finally { setBusy(false); }
  };

  const approve = async () => {
    setBusy(true);
    try {
      await fetch(`/api/v1/agentbook-cpa/public/${token}/signoff`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cpaName: name || undefined }),
      });
      await load();
    } finally { setBusy(false); }
  };

  if (loading) return <Centered>Loading…</Centered>;
  if (error || !data) return <Centered>{error || 'Not found.'}</Centered>;

  return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1.25rem', fontFamily: 'system-ui, sans-serif', color: '#111' }}>
      <p style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#888' }}>Accountant review</p>
      <h1 style={{ fontSize: 24, fontWeight: 500, margin: '4px 0 2px' }}>{data.companyName}</h1>
      <p style={{ color: '#666', marginBottom: 24 }}>{data.period} · read-only</p>

      {data.signoff && (
        <div style={{ background: '#eafaef', border: '1px solid #b6e6c6', borderRadius: 10, padding: 12, marginBottom: 20, color: '#0a7a32' }}>
          ✓ Approved for {data.signoff.period}{data.signoff.cpaName ? ` by ${data.signoff.cpaName}` : ''}
        </div>
      )}

      {/* P&L */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 24 }}>
        <Card label="Revenue (YTD)" value={fmt$(data.pnl.revenueCents)} />
        <Card label="Expenses (YTD)" value={fmt$(data.pnl.expensesCents)} />
        <Card label="Net income" value={fmt$(data.pnl.netIncomeCents)} />
      </div>

      {/* Review findings */}
      {data.review && (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 }}>
            <h2 style={{ fontSize: 16, fontWeight: 500 }}>AI review</h2>
            <span style={{ color: '#666', fontSize: 13 }}>health score {data.review.score}/100</span>
          </div>
          <div style={{ border: '1px solid #eee', borderRadius: 10, overflow: 'hidden', marginBottom: 24 }}>
            {data.review.findings.map((f, i) => (
              <div key={i} style={{ padding: 12, borderTop: i ? '1px solid #f0f0f0' : 'none', display: 'flex', gap: 10 }}>
                <span style={{ width: 8, height: 8, borderRadius: 8, background: SEV_COLOR[f.severity] || '#888', marginTop: 6, flexShrink: 0 }} />
                <div>
                  <p style={{ fontWeight: 500, fontSize: 14 }}>{f.title}</p>
                  <p style={{ color: '#666', fontSize: 13, margin: '2px 0' }}>{f.detail}</p>
                  <p style={{ color: '#2a78d6', fontSize: 13 }}>→ {f.actionItem}</p>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Comments */}
      <h2 style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>Comments</h2>
      {data.comments.length === 0 && <p style={{ color: '#888', fontSize: 14, marginBottom: 12 }}>No comments yet.</p>}
      {data.comments.map((c) => (
        <div key={c.id} style={{ borderLeft: '3px solid #eee', paddingLeft: 12, marginBottom: 12 }}>
          <p style={{ fontSize: 13, color: '#888' }}>{c.authorName || 'Accountant'} · {new Date(c.createdAt).toLocaleDateString()}</p>
          <p style={{ fontSize: 14 }}>{c.body}</p>
        </div>
      ))}

      <div style={{ marginTop: 16, display: 'grid', gap: 8 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (optional)"
          style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 }} />
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Leave a note for the business owner…" rows={3}
          style={{ padding: '8px 10px', border: '1px solid #ddd', borderRadius: 8, fontSize: 14 }} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => void submitComment()} disabled={busy || !comment.trim()}
            style={{ padding: '8px 14px', background: '#111', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer', opacity: busy || !comment.trim() ? 0.5 : 1 }}>
            Post comment
          </button>
          <button onClick={() => void approve()} disabled={busy}
            style={{ padding: '8px 14px', background: '#0ca30c', color: '#fff', border: 'none', borderRadius: 8, fontSize: 14, cursor: 'pointer', opacity: busy ? 0.5 : 1 }}>
            ✓ Approve books
          </button>
        </div>
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
