import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FileUp, Loader2, CheckCircle2, AlertCircle, RefreshCw, Download, ChevronDown } from 'lucide-react';

const API = '/api/v1/agentbook-tax';
const YEAR_OPTIONS = Array.from({ length: 6 }, (_, i) => new Date().getFullYear() - 1 - i);

interface PastFiling {
  id: string;
  taxYear: number;
  jurisdiction: string;
  region: string | null;
  formType: string;
  status: string;
  confidence: number;
  extractedData: any;
  notes: string | null;
  errorMsg: string | null;
  createdAt: string;
}

function fmtCents(c?: number, ccy = 'CAD'): string {
  if (c == null) return '—';
  return (c / 100).toLocaleString(ccy === 'CAD' ? 'en-CA' : 'en-US', { style: 'currency', currency: ccy });
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'confirmed') return <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-600"><CheckCircle2 className="w-3 h-3" /> confirmed</span>;
  if (status === 'parsing') return <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600"><Loader2 className="w-3 h-3 animate-spin" /> parsing…</span>;
  if (status === 'error') return <span className="inline-flex items-center gap-1 text-xs font-medium text-red-500"><AlertCircle className="w-3 h-3" /> error</span>;
  return <span className="text-xs text-muted-foreground">{status}</span>;
}

export const PastFilingsPage: React.FC = () => {
  const [filings, setFilings] = useState<PastFiling[]>([]);
  const [uploading, setUploading] = useState(false);
  const [year, setYear] = useState(YEAR_OPTIONS[0]);
  const [jurisdiction, setJurisdiction] = useState<'ca' | 'us'>('ca');
  const [formType, setFormType] = useState('');
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API}/past-filings`);
      const j = await res.json();
      if (j.success) setFilings(j.data);
    } catch { /* silent */ }
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(() => {
      setFilings((prev) => {
        if (prev.some((f) => f.status === 'parsing' || f.status === 'uploaded')) {
          load();
        }
        return prev;
      });
    }, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const handleUpload = async (file: File) => {
    if (file.type !== 'application/pdf') { setError('Only PDF files are accepted.'); return; }
    if (file.size > 20 * 1024 * 1024) { setError('File must be under 20 MB.'); return; }
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('taxYear', String(year));
      fd.append('jurisdiction', jurisdiction);
      if (formType) fd.append('formType', formType);
      const res = await fetch(`${API}/past-filings/upload`, { method: 'POST', body: fd });
      const j = await res.json();
      if (!j.success) { setError(j.error || 'Upload failed'); return; }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (file) handleUpload(file);
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this filing? The PDF will be removed from storage.')) return;
    await fetch(`${API}/past-filings/${id}`, { method: 'DELETE' });
    await load();
  };

  const handleReParse = async (id: string) => {
    await fetch(`${API}/past-filings/${id}/parse`, { method: 'POST' });
    await load();
  };

  const handleConfirm = async (id: string) => {
    await fetch(`${API}/past-filings/${id}/confirm`, { method: 'POST' });
    await load();
  };

  const handleDownload = (id: string) => {
    window.open(`${API}/past-filings/${id}/download`, '_blank');
  };

  return (
    <div className="px-4 py-5 sm:p-6 max-w-4xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Past Tax Filings</h1>

      {/* Upload card */}
      <div className="bg-card border border-border rounded-xl p-4 mb-6">
        <div
          className="border-2 border-dashed border-border rounded-lg p-8 text-center cursor-pointer hover:border-primary/50 transition-colors"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
        >
          <FileUp className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm font-medium mb-1">Drag &amp; drop PDF here, or click to browse</p>
          <p className="text-xs text-muted-foreground">T1 · T4 · T4A · NOA · 1040 · W-2 · 1099-NEC · max 20 MB</p>
          <input ref={fileRef} type="file" accept="application/pdf" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUpload(f); e.target.value = ''; }} />
        </div>

        <div className="flex gap-3 mt-3 flex-wrap items-end">
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Tax year</label>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))}
              className="p-2 border border-border rounded-lg bg-background text-sm">
              {YEAR_OPTIONS.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Jurisdiction</label>
            <select value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value as 'ca' | 'us')}
              className="p-2 border border-border rounded-lg bg-background text-sm">
              <option value="ca">Canada</option>
              <option value="us">United States</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Form type</label>
            <select value={formType} onChange={(e) => setFormType(e.target.value)}
              className="p-2 border border-border rounded-lg bg-background text-sm">
              <option value="">Auto-detect</option>
              {jurisdiction === 'ca'
                ? ['T1', 'T4', 'T4A', 'T5', 'NOA', 'T2125', 'RRSP'].map((f) => <option key={f} value={f}>{f}</option>)
                : ['1040', 'W-2', '1099-NEC', '1099-MISC', 'K-1'].map((f) => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          {uploading && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground self-center mt-4" />}
        </div>
        {error && <p className="text-sm text-red-500 mt-2">{error}</p>}
      </div>

      {/* Filings list */}
      <h2 className="text-sm font-medium text-muted-foreground mb-3">Uploaded filings</h2>
      {filings.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-6">
          No past filings yet. Upload a T1, NOA, 1040, or other return PDF above.
        </p>
      )}
      <div className="space-y-2">
        {filings.map((f) => {
          const ccy = f.jurisdiction === 'ca' ? 'CAD' : 'USD';
          const data = f.extractedData || {};
          const income = data.totalIncomeCents ?? data.keyLines?.['15000'] ?? data.noaLines?.totalIncome;
          const refund = data.refundOrBalanceCents ?? data.keyLines?.['48400'] ?? data.noaLines?.refundOrBalance;
          return (
            <div key={f.id} className="bg-card border border-border rounded-lg p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {f.taxYear} · <span className="text-muted-foreground">{f.formType}</span> ·{' '}
                    {f.jurisdiction.toUpperCase()}{f.region ? ` / ${f.region}` : ''}
                  </p>
                  <div className="flex items-center gap-3 mt-0.5">
                    <StatusBadge status={f.status} />
                    {f.confidence > 0 && (
                      <span className="text-xs text-muted-foreground">conf: {Math.round(f.confidence * 100)}%</span>
                    )}
                  </div>
                  {income != null && (
                    <p className="text-xs text-muted-foreground mt-1">
                      Income {fmtCents(income, ccy)}{refund != null ? ` · ${refund >= 0 ? 'Refund' : 'Owing'} ${fmtCents(Math.abs(refund), ccy)}` : ''}
                    </p>
                  )}
                  {f.errorMsg && <p className="text-xs text-red-500 mt-1">{f.errorMsg}</p>}
                  {f.notes && <p className="text-xs text-muted-foreground mt-1 italic">{f.notes}</p>}
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    Uploaded {new Date(f.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap justify-end">
                  <button onClick={() => handleDownload(f.id)}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1">
                    <Download className="w-3 h-3" /> PDF
                  </button>
                  {f.status === 'error' && (
                    <button onClick={() => handleReParse(f.id)}
                      className="px-2.5 py-1.5 text-xs rounded-lg border border-border hover:bg-muted/50 inline-flex items-center gap-1">
                      <RefreshCw className="w-3 h-3" /> Re-parse
                    </button>
                  )}
                  {f.status !== 'confirmed' && f.status !== 'parsing' && f.status !== 'uploaded' && (
                    <button onClick={() => handleConfirm(f.id)}
                      className="px-2.5 py-1.5 text-xs rounded-lg border border-emerald-600/40 text-emerald-600 hover:bg-emerald-50/20 text-xs">
                      Confirm
                    </button>
                  )}
                  <button onClick={() => handleDelete(f.id)}
                    className="px-2.5 py-1.5 text-xs rounded-lg border border-border hover:bg-red-50/20 text-red-500 text-xs">
                    Delete
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
