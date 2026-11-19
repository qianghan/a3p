import React, { useEffect, useRef, useState } from 'react';
import { Upload, DollarSign, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { ChatCTA } from '@naap/plugin-sdk';
import { useI18n } from '@naap/plugin-sdk';

const API_BASE = '/api/v1/agentbook-expense';
const ACCOUNTS_URL = '/api/v1/agentbook-core/accounts?type=expense';
/** The suspense account is a bookkeeping holding pen, never a category a person picks. */
const SUSPENSE_CODE = '6999';
const SUGGEST_DEBOUNCE_MS = 300;

interface CategoryOption { id: string; name: string }
interface Suggestion { categoryId: string; categoryName: string; confidence: number; source: 'vendor' | 'pattern' | 'ai' }

/** GET /tax-codes (PR 2b.8): the tax row's view, computed server-side by the tax engine. */
interface TaxRowView {
  visible: boolean;
  codes: Array<{ code: string; recoverable: boolean }>;
  defaultCode: string | null;
  registrationPrompt: boolean;
  preview: { taxCode: string; inclusive: boolean; grossCents: number; netCents: number; taxCents: number } | null;
}
type TaxMode = 'inclusive' | 'exclusive';

class TaxRowError extends Error {
  constructor(public readonly serverMessage: string | null) { super(serverMessage ?? 'tax row unavailable'); }
}

async function fetchTaxRow(q: { amountCents?: number; inclusive: boolean; taxCode?: string | null }): Promise<TaxRowView | null> {
  const qs = new URLSearchParams();
  if (q.amountCents && q.amountCents > 0) qs.set('amountCents', String(q.amountCents));
  qs.set('inclusive', String(q.inclusive));
  if (q.taxCode) qs.set('taxCode', q.taxCode);
  const r = await fetch(`${API_BASE}/tax-codes?${qs.toString()}`);
  const d = await r.json().catch(() => null);
  // A server refusal is not "no tax row": surface its message (T6a review minor 4).
  if (!r.ok || !d?.success) throw new TaxRowError(typeof d?.error === 'string' ? d.error : null);
  const v = d.data as TaxRowView;
  return v && v.visible === true && Array.isArray(v.codes) ? v : null;
}

interface OCRResult {
  amount_cents?: number;
  tax_cents?: number;
  tax_label?: string | null;
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
  // One-step entry: the category is part of the form, prefilled from the vendor's history
  // (or one AI guess), so saving once books the expense on its real category.
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [categoryId, setCategoryId] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  // Once the person picks a category themselves, a late suggestion must never overwrite it.
  const categoryTouched = useRef(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Locale-aware money input.
  //
  // These are <input type="number">, whose value-sanitization algorithm
  // (HTML spec) normalises to a dot-decimal string and blanks anything else.
  // Verified in jsdom: setting '45,50' yields value === '' , so parseFloat
  // gives NaN — NOT 45. There is therefore no 100x misread on this path.
  //
  // Two real problems remain, and parseAmount fixes both:
  //   1. NaN escaped to the API. Math.round(parseFloat('') * 100) is NaN, and
  //      that went into the request body. parseAmount returns ok:false / 0.
  //   2. A fr-CA user cannot type '45,50' into these fields at all — the
  //      browser blanks it. That is a usability defect, and routing through
  //      parseAmount means switching a field to type="text" later Just Works.
  const { parseAmount, formatMoney, t } = useI18n();
  // PR 2b.8 tax row: shown only when the server's view says so (AU/CA registrants and unknowns).
  const [taxView, setTaxView] = useState<TaxRowView | null>(null);
  const [taxCode, setTaxCode] = useState<string | null>(null);
  const [taxMode, setTaxMode] = useState<TaxMode>('inclusive');

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

  useEffect(() => {
    let live = true;
    fetch(ACCOUNTS_URL)
      .then((r) => r.json())
      .then((d) => {
        if (!live || !d?.success || !Array.isArray(d.data)) return;
        setCategories(
          (d.data as Array<{ id: string; name: string; code?: string; isActive?: boolean }>)
            .filter((a) => a.isActive !== false && a.code !== SUSPENSE_CODE)
            .map((a) => ({ id: a.id, name: a.name })),
        );
      })
      .catch(() => { /* no list → the field stays optional and the server books to suspense, as before */ });
    return () => { live = false; };
  }, []);

  // Ask for a suggestion once the vendor/description settle. Best-effort: a failure leaves the form as-is.
  useEffect(() => {
    if (!vendor.trim() && !description.trim()) return;
    let live = true;
    const timer = setTimeout(() => {
      const qs = new URLSearchParams({ vendor, description });
      fetch(`${API_BASE}/categories/suggest?${qs.toString()}`)
        .then((r) => r.json())
        .then((d) => {
          if (!live || !d?.success || !d.data) return;
          const s = d.data as Suggestion;
          setSuggestion(s);
          if (!categoryTouched.current) setCategoryId(s.categoryId);
        })
        .catch(() => { /* ignore */ });
    }, SUGGEST_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
  }, [vendor, description]);

  useEffect(() => {
    if (isPersonal) { setTaxView(null); return; }
    let live = true;
    const timer = setTimeout(() => {
      const cents = amount ? parseAmount(amount).cents : 0;
      fetchTaxRow({ amountCents: cents > 0 ? cents : undefined, inclusive: taxMode === 'inclusive', taxCode })
        .then((v) => {
          if (!live) return;
          setTaxView(v);
          if (v && !taxCode && v.defaultCode) setTaxCode(v.defaultCode);
        })
        .catch(() => { if (live) setTaxView(null); });
    }, SUGGEST_DEBOUNCE_MS);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parseAmount is stable per locale
  }, [amount, taxCode, taxMode, isPersonal]);

  const taxCodeLabel = (code: string): string => {
    switch (code) {
      case 'FRE': return t('expenses_ui.tax_code_gst_free');
      case 'INP': return t('expenses_ui.tax_code_input_taxed');
      case 'NTR': return t('expenses_ui.tax_code_no_gst');
      case 'CAP': return t('expenses_ui.tax_code_capital');
      case 'ZERO': return t('expenses_ui.tax_code_zero_rated');
      case 'EXEMPT': return t('expenses_ui.tax_code_exempt');
      case 'OUT_OF_SCOPE': return t('expenses_ui.tax_code_out_of_scope');
      default: return code.split('_').join(' + '); // GST, HST, GST + QST: acronyms
    }
  };

  const handleReceiptFile = async (file: File) => {
    if (!file) return;
    if (!/^image\/|application\/pdf$/.test(file.type)) {
      setReceiptStatus({ kind: 'error', message: t('expenses_ui.file_type_unsupported') });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      setReceiptStatus({ kind: 'error', message: t('expenses_ui.file_too_large') });
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
      // Tax row: the engine converts an exclusive entry to the document gross (amountCents is always gross).
      let amountCents = parseAmount(amount).cents;
      let tax: { taxCode?: string; taxAmountCents?: number } = {};
      if (taxView && taxCode && !isPersonal) {
        let v: TaxRowView | null = null;
        try {
          v = await fetchTaxRow({ amountCents, inclusive: taxMode === 'inclusive', taxCode });
        } catch (err) {
          if (err instanceof TaxRowError && err.serverMessage) {
            setSubmitError(err.serverMessage);
            return;
          }
          v = null; // offline: an inclusive entry still saves (the server resolves tax)
        }
        if (v?.preview) {
          amountCents = v.preview.grossCents;
          tax = { taxCode: v.preview.taxCode, taxAmountCents: v.preview.taxCents };
        } else if (taxMode === 'exclusive') {
          setSubmitError(t('expenses_ui.tax_preview_failed'));
          return;
        }
      }
      const body: Record<string, unknown> = {
        ...tax,
        amountCents,
        vendor: vendor || undefined,
        description: description || vendor || 'Expense',
        date,
        isPersonal,
      };
      if (!isPersonal && categoryId) {
        body.categoryId = categoryId;
        // Only a human choice teaches the vendor memory. Changing what we suggested is a correction.
        body.categorySource = suggestion && suggestion.categoryId !== categoryId ? 'user_corrected' : 'user';
      }
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
        setCategoryId(''); setSuggestion(null); categoryTouched.current = false;
        setTaxCode(null); setTaxMode('inclusive');
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
      <h1 className="text-2xl font-bold mb-3">{t('expenses_ui.record_expense')}</h1>

      {/* PR 41 / Tier 1 #1: chat-first escape hatch */}
      <ChatCTA example="I spent $42 at Starbucks for client meeting today" />

      {success && (
        <div className="bg-green-500/10 text-green-500 p-4 rounded-lg mb-6">{t('expenses_ui.expense_recorded_ok')}</div>
      )}
      {submitError && (
        <div role="alert" className="bg-destructive/10 text-destructive p-4 rounded-lg mb-6 flex items-center gap-2">
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
            <p className="text-xs text-muted-foreground mt-1">{t('expenses_ui.prefilled_hint')}
            </p>
          </>
        )}
        {receiptStatus.kind === 'error' && (
          <>
            <AlertCircle className="w-10 h-10 mx-auto mb-3 text-red-500" />
            <p className="text-foreground">{receiptStatus.message}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('expenses_ui.try_another_file')}</p>
          </>
        )}
        {receiptStatus.kind === 'idle' && (
          <>
            <Upload className="w-10 h-10 mx-auto mb-3 text-muted-foreground" />
            <p className="text-muted-foreground">{t('expenses_ui.drop_receipt')}</p>
            <p className="text-xs text-muted-foreground mt-1">{t('expenses_ui.drop_receipt_formats')}</p>
          </>
        )}
      </div>

      <div className="text-center text-muted-foreground text-sm mb-6">— or enter manually —</div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="new-expense-amount" className="block text-sm font-medium mb-1">Amount *</label>
          <div className="relative">
            <DollarSign className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input id="new-expense-amount" type="number" step="0.01" min="0.01" required value={amount} onChange={e => setAmount(e.target.value)}
              className="w-full pl-9 pr-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50 focus:border-primary" placeholder="0.00" />
          </div>
        </div>

        {taxView && !isPersonal && (
          <div data-testid="new-expense-tax-row" className="space-y-2">
            <div role="group" aria-label={t('expenses_ui.tax_code_label')} className="flex flex-wrap gap-2">
              {taxView.codes.map((c) => (
                <button key={c.code} type="button" data-testid={`new-expense-tax-code-${c.code}`} aria-pressed={taxCode === c.code}
                  onClick={() => setTaxCode(c.code)}
                  className={`px-3 py-1 rounded-full border text-sm ${taxCode === c.code ? 'bg-primary text-primary-foreground border-primary' : 'border-border'}`}>
                  {taxCodeLabel(c.code)}
                </button>
              ))}
            </div>
            <div role="radiogroup" aria-label={t('expenses_ui.tax_mode_label')} className="flex gap-2">
              {(['inclusive', 'exclusive'] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={taxMode === m} data-testid={`new-expense-tax-mode-${m}`}
                  onClick={() => setTaxMode(m)}
                  className={`flex-1 py-2 rounded-lg border text-sm ${taxMode === m ? 'bg-primary text-primary-foreground border-primary' : 'border-border'}`}>
                  {m === 'inclusive' ? t('expenses_ui.tax_inclusive') : t('expenses_ui.tax_exclusive')}
                </button>
              ))}
            </div>
            {taxView.preview && (
              <p data-testid="new-expense-tax-amount" className="text-xs text-muted-foreground">
                {t('expenses_ui.tax_amount', { tax: formatMoney(taxView.preview.taxCents), total: formatMoney(taxView.preview.grossCents) })}
              </p>
            )}
            {receiptStatus.kind === 'extracted' && (receiptStatus.result.tax_cents ?? 0) > 0 && (
              <p className="text-xs text-muted-foreground">
                {t('expenses_ui.tax_printed', { label: receiptStatus.result.tax_label ?? '', amount: formatMoney(receiptStatus.result.tax_cents ?? 0) })}
              </p>
            )}
            {taxView.registrationPrompt && (
              <p data-testid="new-expense-tax-prompt" className="text-sm">
                {t('expenses_ui.tax_registration_prompt')}{' '}
                <a href="/settings" className="text-primary underline">{t('expenses_ui.tax_registration_link')}</a>
              </p>
            )}
          </div>
        )}

        <div>
          <label htmlFor="new-expense-vendor" className="block text-sm font-medium mb-1">{t('expenses_ui.col_vendor')}</label>
          <input id="new-expense-vendor" type="text" value={vendor} onChange={e => setVendor(e.target.value)}
            className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50" placeholder="e.g., Starbucks, Amazon" />
        </div>

        <div>
          <label htmlFor="new-expense-description" className="block text-sm font-medium mb-1">{t('expenses_ui.col_description')}</label>
          <input id="new-expense-description" type="text" value={description} onChange={e => setDescription(e.target.value)}
            className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50" placeholder={t('expenses_ui.description_placeholder')} />
        </div>

        <div>
          <label htmlFor="new-expense-category" className="block text-sm font-medium mb-1">{t('expenses_ui.category_label')}</label>
          <select
            id="new-expense-category"
            value={categoryId}
            required={!isPersonal && categories.length > 0}
            onChange={e => { categoryTouched.current = true; setCategoryId(e.target.value); }}
            className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50"
          >
            <option value="">{t('expenses_ui.category_choose')}</option>
            {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {suggestion && categoryId === suggestion.categoryId && (
            <p className="text-xs text-muted-foreground mt-1">
              {suggestion.source === 'vendor'
                ? t('expenses_ui.category_hint_vendor')
                : suggestion.source === 'pattern'
                  ? t('expenses_ui.category_hint_pattern', { pct: Math.round(suggestion.confidence * 100) })
                  : t('expenses_ui.category_hint_ai', { pct: Math.round(suggestion.confidence * 100) })}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="new-expense-date" className="block text-sm font-medium mb-1">{t('expenses_ui.col_date')}</label>
          <input id="new-expense-date" type="date" value={date} onChange={e => setDate(e.target.value)}
            className="w-full px-4 py-2 bg-background border border-border rounded-lg focus:ring-2 focus:ring-primary/50" />
        </div>

        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={isPersonal} onChange={e => setIsPersonal(e.target.checked)} className="rounded" />
          <span className="text-sm">{t('expenses_ui.is_personal_expense')}</span>
        </label>

        <button type="submit" disabled={submitting || !amount}
          className="w-full py-3 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors disabled:opacity-50">
          {submitting ? t('expenses_ui.recording') : t('expenses_ui.record_expense')}
        </button>
      </form>
    </div>
  );
};
