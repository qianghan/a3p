'use client';

import React, { useRef, useState } from 'react';
import { Camera, Check, CloudOff } from 'lucide-react';
import { queueExpense, queueReceipt } from '@/lib/offline-queue';

/** True when there's no connection at all — either `fetch()` itself threw
 * (TypeError, happens if the service worker isn't yet controlling the page)
 * or the service worker intercepted the request and answered with its own
 * synthetic offline response (the normal case once it's active — `fetch()`
 * doesn't throw for that, since the SW is what's answering). Distinct from
 * a real error response, which means the request reached the server and
 * got a considered answer — no point queuing that; it'll fail the same way
 * again. */
function isOfflineFailure(e: unknown, response?: Response): boolean {
  if (e instanceof TypeError) return true;
  return response?.headers.get('X-Agentbook-Offline') === '1';
}

/** Full-resolution phone camera photos (commonly 3-12MB) exceed the
 * platform's request body limit for this route, which rejects them outright
 * before our code ever runs — so every mobile capture failed silently.
 * Downscale to a size that's still easily OCR-readable but comfortably
 * under that limit before uploading. Falls back to the original file if the
 * browser can't decode it (e.g. an unsupported format). */
async function compressImage(file: File, maxDim = 1800, quality = 0.85): Promise<File> {
  try {
    if (typeof createImageBitmap !== 'function') return file;
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '.jpg'), { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

export default function MobileCapture() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [queuedOffline, setQueuedOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onPhoto = async (file: File) => {
    setPhotoName(file.name);
    setUploading(true);
    setError(null);
    let response: Response | undefined;
    try {
      const upload = await compressImage(file);
      const form = new FormData();
      form.append('file', upload);
      // Store + OCR the receipt; prefill the fields for the user to confirm.
      response = await fetch('/api/v1/agentbook-expense/receipts/scan', { method: 'POST', body: form });
      if (isOfflineFailure(undefined, response)) {
        await queueReceipt(upload).catch(() => {});
        return;
      }
      let j: { success?: boolean; data?: { receiptUrl?: string; amountCents?: number; vendor?: string }; error?: string };
      try {
        j = await response.json();
      } catch {
        throw new Error(`Server error (${response.status})`);
      }
      if (response.ok && j.success && j.data) {
        if (j.data.receiptUrl) setReceiptUrl(j.data.receiptUrl);
        if (j.data.amountCents != null) setAmount(String(j.data.amountCents / 100));
        if (j.data.vendor) setVendor(j.data.vendor);
      } else {
        throw new Error(j.error || `Server error (${response.status})`);
      }
    } catch (e) {
      // No signal to OCR the receipt right now — queue the photo itself so
      // it still gets uploaded once back online, and let the user carry on
      // typing the amount/vendor by hand instead of blocking on it.
      if (isOfflineFailure(e, response)) {
        await queueReceipt(file).catch(() => {});
      } else {
        setError("Couldn't auto-read the receipt — enter the amount and vendor manually below.");
      }
    } finally {
      setUploading(false);
    }
  };

  const queueAndClear = async (payload: Record<string, unknown>) => {
    // No connection — don't lose the entry. Queue it for background sync
    // (or a same-tab retry on `online`, on browsers like iOS Safari with no
    // Background Sync API) instead of just erroring.
    await queueExpense(payload).catch(() => { setError('Could not save — please try again.'); return; });
    setQueuedOffline(true);
    setAmount(''); setVendor(''); setPhotoName(null); setReceiptUrl(null);
    setTimeout(() => setQueuedOffline(false), 3500);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      amountCents: Math.round(Number(amount) * 100),
      vendor: vendor.trim() || undefined,
      description: vendor.trim() || 'Expense',
      ...(receiptUrl ? { receiptUrl } : {}),
    };
    let response: Response | undefined;
    try {
      response = await fetch('/api/v1/agentbook-expense/expenses', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (isOfflineFailure(undefined, response)) {
        await queueAndClear(payload);
        return;
      }
      if (!response.ok) throw new Error((await response.json()).error || `${response.status}`);
      setDone(true);
      setAmount(''); setVendor(''); setPhotoName(null); setReceiptUrl(null);
      setTimeout(() => setDone(false), 2500);
    } catch (e) {
      if (isOfflineFailure(e, response)) {
        await queueAndClear(payload);
      } else {
        setError(String(e));
      }
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
          style={{ padding: 14, borderRadius: 12, border: 'none', background: queuedOffline ? '#f59e0b' : '#10b981', color: '#04130c', fontSize: 15, fontWeight: 600, opacity: saving || !amount ? 0.5 : 1 }}>
          {done ? <span><Check style={{ width: 16, height: 16, verticalAlign: -3 }} /> Saved</span>
            : queuedOffline ? <span><CloudOff style={{ width: 16, height: 16, verticalAlign: -3 }} /> Saved — will sync when online</span>
            : saving ? 'Saving…' : 'Save expense'}
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
