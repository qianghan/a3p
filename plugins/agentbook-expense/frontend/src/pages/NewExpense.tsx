import React, { useRef, useState } from 'react';
import { Upload, DollarSign, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';

const API_BASE = '/api/v1/agentbook-expense';

interface OCRResult {
  amount_cents?: number;
  vendor?: string;
  date?: string;
  description?: string;
  confidence?: number;
  status?: string;
}

export const NewExpensePage: React.FC = () => {
  const [amount, setAmount] = useState('');
  const [vendor, setVendor] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [isPersonal, setIsPersonal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Receipt OCR state (G-031 — closes the "non-functional theater" finding).
  const [receiptStatus, setReceiptStatus] = useState<
    | { kind: 'idle' }
    | { kind: 'uploading' }
    | { kind: 'extracting' }
    | { kind: 'extracted'; result: OCRResult; blobUrl: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleReceiptFile = async (file: File) => {
    if (!file) return;
    if (!/^image\/|application\/pdf$/.test(file.type)) {
      setReceiptStatus({ kind: 'error', message: 'Unsupported file type. Use JPG, PNG, or PDF.' });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setReceiptStatus({ kind: 'error', message: 'File too large (max 10MB).' });
      return;
    }

    try {
      // 1. Read file as base64 + upload to permanent storage.
      setReceiptStatus({ kind: 'uploading' });
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          // result is "data:image/jpeg;base64,<base64>" — strip the prefix.
          const commaIdx = result.indexOf(',');
          resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const uploadRes = await fetch(`${API_BASE}/receipts/upload-blob`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dataBase64,
          contentType: file.type,
          filename: file.name,
        }),
      });
      if (!uploadRes.ok) {
        throw new Error(`upload failed: HTTP ${uploadRes.status}`);
      }
      const uploadData = await uploadRes.json();
      const blobUrl: string | undefined = uploadData?.data?.url || uploadData?.data?.permanentUrl;
      if (!blobUrl) throw new Error('upload response missing url');

      // 2. Send to OCR.
      setReceiptStatus({ kind: 'extracting' });
      const ocrRes = await fetch(`${API_BASE}/receipts/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageUrl: blobUrl }),
      });
      if (!ocrRes.ok) {
        throw new Error(`OCR failed: HTTP ${ocrRes.status}`);
      }
      const ocrPayload = await ocrRes.json();
      const result: OCRResult = ocrPayload?.data ?? ocrPayload;

      // 3. Populate the form. User reviews + clicks Record (rubric #3 —
      //    confirm-before-destructive: never auto-create the expense).
      if (result.amount_cents && result.amount_cents > 0) {
        setAmount((result.amount_cents / 100).toFixed(2));
      }
      if (result.vendor) setVendor(result.vendor);
      if (result.description) setDescription(result.description);
      if (result.date && /^\d{4}-\d{2}-\d{2}/.test(result.date)) {
        setDate(result.date.slice(0, 10));
      }
      setReceiptStatus({ kind: 'extracted', result, blobUrl });
    } catch (err) {
      setReceiptStatus({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(true);
  };
  const onDragLeave = () => setDragging(false);
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleReceiptFile(file);
  };
  const onFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleReceiptFile(file);
    // Reset so picking the same file twice in a row still fires.
    e.target.value = '';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const body: Record<string, unknown> = {
        amountCents: Math.round(parseFloat(amount) * 100),
        vendor: vendor || undefined,
        description: description || vendor || 'Expense',
        date,
        isPersonal,
      };
      // If we have a stored receipt URL from OCR, attach it.
      if (receiptStatus.kind === 'extracted') {
        body.receiptUrl = receiptStatus.blobUrl;
      }
      const res = await fetch(`${API_BASE}/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setSuccess(true);
        setAmount(''); setVendor(''); setDescription('');
        setReceiptStatus({ kind: 'idle' });
        setTimeout(() => setSuccess(false), 3000);
      } else {
        // QA-P5-002: this branch didn't exist — a well-formed error response
        // (e.g. a validation failure) was as silent as a thrown network
        // exception. The form just sat there with no feedback either way.
        setSubmitError(typeof data.error === 'string' ? data.error : 'Could not save this expense. Please try again.');
      }
    } catch (err) {
      console.error(err);
      setSubmitError('Could not save this expense — check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-3">Record Expense</h1>

      {/* PR 41 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="I spent $42 at Starbucks for client meeting today" />

      {success && (
        <div className="bg-green-500/10 text-green-500 p-4 rounded-lg mb-6">Expense recorded successfully!</div>
      )}
      {submitError && (
        <div className="bg-destructive/10 text-destructive p-4 rounded-lg mb-6 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          {submitError}
        </div>
      )}

      {/* Receipt Upload Zone — wired for real (G-031) */}
      <div
        onClick={() => fileInputRef.current?.click()}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        className={`border-2 border-dashed rounded-xl p-8 mb-6 text-center transition-colors cursor-pointer ${
          dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/heic,application/pdf"
          onChange={onFileInputChange}
          className="hidden"
        />
        {receiptStatus.kind === 'uploading' && (
          <>
            <Loader2 className="w-10 h-10 mx-auto mb-3 text-primary animate-spin" />
            <p className="text-muted-foreground">Uploading receipt…</p>
          </>
        )}
        {receiptStatus.kind === 'extracting' && (
          <>
            <Loader2 className="w-10 h-10 mx-auto mb-3 text-primary animate-spin" />
            <p className="text-muted-foreground">Reading the receipt…</p>
          </>
        )}
        {receiptStatus.kind === 'extracted' && (
          <>
            <CheckCircle className="w-10 h-10 mx-auto mb-3 text-green-500" />
            <p className="text-foreground">
              Extracted{receiptStatus.result.vendor ? ` from ${receiptStatus.result.vendor}` : ''}
              {typeof receiptStatus.result.confidence === 'number'
                ? ` · confidence ${Math.round(receiptStatus.result.confidence * 100)}%`
                : ''}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Fields below are pre-filled. Review and edit, then click Record.
            </p>
          </>
        )}
        {receiptStatus.kind === 'error' && (
          <>
            <AlertCircle className="w-10 h-10 mx-auto mb-3 text-red-500" />
            <p className="text-foreground">{receiptStatus.message}</p>
            <p className="text-xs text-muted-foreground mt-1">Click to try another file.</p>
          </>
        )}
        {receiptStatus.kind === 'idle' && (
          <>
            <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">Drag and drop a receipt, or click to upload</p>
            <p className="text-xs text-muted-foreground mt-1">JPG, PNG, PDF — we'll extract the details automatically</p>
          </>
        )}
      </div>

      <div className="text-center text-muted-foreground text-sm mb-6">— or enter manually —</div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Amount *</label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input type="number" step="0.01" min="0.01" required value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50 focus:border-primary" placeholder="0.00" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Vendor</label>
          <input type="text" value={vendor} onChange={e => setVendor(e.target.value)}
            className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50" placeholder="e.g., Starbucks, Amazon" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Description</label>
          <input type="text" value={description} onChange={e => setDescription(e.target.value)}
            className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50" placeholder="What was this for?" />
        </div>

        <div>
          <label className="block text-sm font-medium mb-1">Date</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50" />
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isPersonal} onChange={e => setIsPersonal(e.target.checked)} className="rounded" />
          <span className="text-sm">This is a personal expense</span>
        </label>

        <button type="submit" disabled={submitting || !amount}
          className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
          {submitting ? 'Recording...' : 'Record Expense'}
        </button>
      </form>
    </div>
  );
};
