'use client';

import React, { useRef, useState } from 'react';
import { Camera, Check } from 'lucide-react';

export default function MobileCapture() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPhoto = async (file: File) => {
    setPhotoName(file.name);
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      // Store + OCR the receipt; prefill the fields for the user to confirm.
      const r = await fetch('/api/v1/agentbook-expense/receipts/scan', { method: 'POST', body: form });
      const j = await r.json();
      if (r.ok && j.success) {
        if (j.data.receiptUrl) setReceiptUrl(j.data.receiptUrl);
        if (j.data.amountCents != null) setAmount(String(j.data.amountCents / 100));
        if (j.data.vendor) setVendor(j.data.vendor);
      }
    } catch {
      /* photo optional — keep going */
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch('/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          amountCents: Math.round(Number(amount) * 100),
          vendor: vendor.trim() || undefined,
          description: vendor.trim() || 'Expense',
          ...(receiptUrl ? { receiptUrl } : {}),
        }),
      });
      if (!r.ok) throw new Error((await r.json()).error || `${r.status}`);
      setDone(true);
      setAmount(''); setVendor(''); setPhotoName(null); setReceiptUrl(null);
      setTimeout(() => setDone(false), 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: '20px 16px', color: 'var(--foreground,#fff)' }}>
      <h1 style={{ fontSize: 20, fontWeight: 500, marginBottom: 16 }}>Capture expense</h1>

      <button
        onClick={() => fileRef.current?.click()}
        style={{
          width: '100%', padding: 20, borderRadius: 12, border: '1px dashed var(--border,#333)',
          background: 'var(--card,#111)', color: 'var(--foreground,#fff)', display: 'flex',
          flexDirection: 'column', alignItems: 'center', gap: 8, marginBottom: 16, cursor: 'pointer',
        }}
      >
        <Camera style={{ width: 28, height: 28, color: '#10b981' }} />
        <span style={{ fontSize: 14 }}>{photoName ? (uploading ? 'Uploading…' : `📎 ${photoName}`) : 'Take a photo of the receipt'}</span>
      </button>
      <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPhoto(f); }} />

      <div style={{ display: 'grid', gap: 10 }}>
        <input value={amount} onChange={(e) => setAmount(e.target.value)} type="number" inputMode="decimal" placeholder="Amount"
          style={inputStyle} />
        <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Vendor / description"
          style={inputStyle} />
        <button onClick={() => void save()} disabled={saving || !amount}
          style={{ padding: 14, borderRadius: 12, border: 'none', background: '#10b981', color: '#04130c', fontSize: 15, fontWeight: 600, opacity: saving || !amount ? 0.5 : 1 }}>
          {done ? <span><Check style={{ width: 16, height: 16, verticalAlign: -3 }} /> Saved</span> : saving ? 'Saving…' : 'Save expense'}
        </button>
        {error && <p style={{ color: '#ef4444', fontSize: 13 }}>{error}</p>}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border,#333)',
  background: 'var(--background,#0a0a0a)', color: 'var(--foreground,#fff)', fontSize: 16,
};
