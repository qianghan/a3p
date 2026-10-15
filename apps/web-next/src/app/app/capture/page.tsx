'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Camera, PenLine } from 'lucide-react';
import { parseAmountToCents } from '@agentbook/i18n';
import { useT, useShellLocale } from '@/hooks/use-t';
import type { FromReceiptResult, MobileDoc } from '@/lib/mobile/types';
import { queueExpense } from '@/lib/offline-queue';
import { uploadReceipt, patchDoc, categorizeDoc, deleteDoc } from '../_lib/api';
import { confirmDoc, createExpense, getTenantCurrency } from '../_lib/api-extra';
import { compressImage } from '../_lib/image';
import { queueReceiptForReplay, isOfflineError, newIdempotencyKey } from '../_lib/offline';
import { getRecentCategories, pushRecentCategory, type RecentCategory } from '../_lib/category-recents';
import { formatAmountInput, todayIso } from '../_lib/format';
import { useTenantCurrency } from '../_lib/useTenantCurrency';
import { Chip, Pill, tokens, useToast } from '../_kit';
import { CategoryPicker } from '../docs/_components/CategoryPicker';
import { QueuePill } from './_components/QueuePill';

type Stage = 'idle' | 'uploading' | 'review';
/** Where the expense stands while the form is open. */
type Source = 'uploaded' | 'offline' | 'failed' | 'manual';
type ErrorKind = null | 'read_failed' | 'upload_too_large' | 'save_too_large' | 'save_failed' | 'queue_failed'
  | 'amount_invalid' | 'amount_ambiguous' | 'discard_failed' | 'review_amount' | 'receipt_deleted';

interface Draft { amount: string; vendor: string; date: string; categoryId: string | null; categoryName: string | null; isPersonal: boolean }
interface Fields { amountCents: number; vendor?: string; date?: string; categoryId?: string; isPersonal: boolean }

const emptyDraft = (): Draft => ({ amount: '', vendor: '', date: todayIso(), categoryId: null, categoryName: null, isPersonal: false });
const statusOf = (e: unknown) => (e && typeof e === 'object' ? (e as { status?: number }).status : undefined);
const codeOf = (e: unknown) => (e && typeof e === 'object' ? (e as { code?: string }).code : undefined);
/** A too-large photo: the client pre-flight (code) or the platform's plain-text 413 (status). Never branch on the message. */
const isTooLarge = (e: unknown) => codeOf(e) === 'file_too_large' || statusOf(e) === 413;
const deviceOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Marks a failure to write the IndexedDB queue itself (private mode, quota). */
class QueueError extends Error {}
/** The expense for this attempt's key was deleted since: nothing was saved and nothing may be re-created. */
class DeletedError extends Error {}
async function queueOr<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch { throw new QueueError('queue'); }
}


const field: React.CSSProperties = { width: '100%', minHeight: 44, padding: '10px 12px', borderRadius: 10, border: `1px solid ${tokens.color.border}`, background: tokens.color.bg, color: tokens.color.fg, fontSize: 16 };
const label: React.CSSProperties = { display: 'grid', gap: 4, fontSize: 13, color: tokens.color.muted };
const primary: React.CSSProperties = { minHeight: 48, borderRadius: 12, border: 'none', background: tokens.color.primary, color: tokens.color.primaryFg, fontSize: 15, fontWeight: 600 };
const secondary: React.CSSProperties = { minHeight: 48, borderRadius: 12, border: `1px solid ${tokens.color.border}`, background: tokens.color.card, color: tokens.color.fg, fontSize: 15, fontWeight: 500 };
const linkBtn: React.CSSProperties = { minHeight: 44, border: 'none', background: 'transparent', color: tokens.color.fg, fontSize: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6 };
const seg = (on: boolean): React.CSSProperties => ({ flex: 1, minHeight: 44, borderRadius: 10, border: `1px solid ${on ? tokens.color.primary : tokens.color.border}`, background: on ? tokens.color.primary : tokens.color.card, color: on ? tokens.color.primaryFg : tokens.color.fg, fontWeight: on ? 600 : 500 });

export default function MobileCapture() {
  const t = useT();
  const locale = useShellLocale();
  const toast = useToast();
  const currency = useTenantCurrency();
  const fileRef = useRef<HTMLInputElement>(null);
  const snapRef = useRef<HTMLButtonElement>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [source, setSource] = useState<Source>('manual');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [attemptKey, setAttemptKey] = useState<string | null>(null);
  const [doc, setDoc] = useState<MobileDoc | null>(null);
  const [aiGuess, setAiGuess] = useState<RecentCategory | null>(null);
  const [recents, setRecents] = useState<RecentCategory[]>([]);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [errorKind, setErrorKind] = useState<ErrorKind>(null);
  const [ambiguous, setAmbiguous] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => { setRecents(getRecentCategories()); }, []);
  useEffect(() => () => { if (preview && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(preview); }, [preview]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function reset(focusSnap: boolean) {
    setStage('idle'); setSource('manual'); setFile(null); setPreview(null); setAttemptKey(null);
    setDoc(null); setAiGuess(null); setDraft(emptyDraft()); setErrorKind(null); setAmbiguous('');
    setRecents(getRecentCategories());
    if (focusSnap) setTimeout(() => snapRef.current?.focus(), 0);
  }

  function applyUpload(res: FromReceiptResult) {
    const d = res.doc;
    setDoc(d);
    // A timed-out OCR comes back 201 pending_review with a $0/blank amount: leave the field empty
    // and ask the user to type it. Never prefill (or save) a $0.
    const ocrCents = res.ocr.amountCents != null && res.ocr.amountCents > 0 ? res.ocr.amountCents : null;
    const cents = ocrCents ?? (d.amountCents > 0 ? d.amountCents : null);
    setErrorKind(cents == null && d.status === 'pending_review' ? 'review_amount' : null);
    const guess: RecentCategory | null = d.categoryId && d.categoryName && d.categorySource !== 'user'
      ? { id: d.categoryId, name: d.categoryName }
      : d.suggestion ? { id: d.suggestion.categoryId, name: d.suggestion.categoryName } : null;
    setAiGuess(guess);
    setDraft({
      amount: cents != null ? formatAmountInput(cents, locale) : '',
      vendor: res.ocr.vendor ?? d.vendorName ?? '',
      date: (res.ocr.date ?? d.date ?? todayIso()).slice(0, 10),
      categoryId: d.categoryId,
      categoryName: d.categoryName,
      isPersonal: d.isPersonal,
    });
  }

  async function onPhoto(raw: File) {
    const compressed = await compressImage(raw);
    const key = newIdempotencyKey(); // one key per capture attempt; every retry of THIS photo reuses it
    setFile(compressed);
    setAttemptKey(key);
    setPreview(typeof URL.createObjectURL === 'function' ? URL.createObjectURL(compressed) : null);
    setDraft(emptyDraft()); setDoc(null); setAiGuess(null); setErrorKind(null);
    if (deviceOffline()) { setSource('offline'); setStage('review'); return; }
    setStage('uploading');
    try {
      const res = await uploadReceipt(compressed, { idempotencyKey: key });
      if (res.deleted) { setSource('failed'); setErrorKind('receipt_deleted'); }
      else { applyUpload(res); setSource('uploaded'); }
    } catch (e) {
      if (isOfflineError(e)) {
        setSource('offline');
      } else {
        setSource('failed');
        setErrorKind(isTooLarge(e) ? 'upload_too_large' : 'read_failed');
      }
    } finally {
      setStage('review');
    }
  }

  function startManual() {
    reset(false);
    setAttemptKey(newIdempotencyKey());
    setSource('manual');
    setStage('review');
  }

  async function maybeConfirm(d: MobileDoc, categoryId: string | null | undefined) {
    // Only with a category: the confirm route posts no journal entry for an
    // uncategorized expense, which would leave it "confirmed" but off the books.
    if (d.status === 'pending_review' && categoryId) await confirmDoc(d.id);
  }

  async function finalizeUploaded(d: MobileDoc, f: Fields) {
    const patch: Partial<{ amountCents: number; vendor: string; date: string; isPersonal: boolean }> = {};
    if (f.amountCents !== d.amountCents) patch.amountCents = f.amountCents;
    if (f.vendor && f.vendor !== (d.vendorName ?? '')) patch.vendor = f.vendor;
    if (f.date && f.date !== (d.date ?? '').slice(0, 10)) patch.date = f.date;
    if (f.isPersonal !== d.isPersonal) patch.isPersonal = f.isPersonal;
    let latest = d;
    if (Object.keys(patch).length) latest = await patchDoc(d.id, patch);
    if (f.categoryId && f.categoryId !== latest.categoryId) latest = await categorizeDoc(d.id, f.categoryId);
    await maybeConfirm(latest, latest.categoryId ?? f.categoryId);
  }

  /** Photo taken but nothing confirmed server-side: same request online or queued. Returns true if queued. */
  async function saveReceipt(f: Fields): Promise<boolean> {
    if (!file || !attemptKey) throw new QueueError('missing_photo');
    const queue = async () => { await queueOr(() => queueReceiptForReplay(file, { idempotencyKey: attemptKey, ...f })); return true; };
    if (deviceOffline()) return queue();
    try {
      const res = await uploadReceipt(file, { idempotencyKey: attemptKey, ...f });
      if (res.deleted) throw new DeletedError('deleted');
      // duplicate:true means the photo-time upload DID land (its response was lost);
      // the server returned that original expense, so apply the typed fields to it.
      if (res.duplicate) await finalizeUploaded(res.doc, f);
      else await maybeConfirm(res.doc, f.categoryId ?? res.doc.categoryId);
      return false;
    } catch (e) {
      if (isOfflineError(e)) return queue();
      throw e;
    }
  }

  async function saveManual(f: Fields): Promise<boolean> {
    // Never let the route's 'USD' default book a CA/AU expense: fetch the currency if the
    // cached one has not arrived yet; omit it only when that is impossible (offline, no snapshot).
    const cur = currency ?? (deviceOffline() ? null : await getTenantCurrency().catch(() => null));
    const payload = {
      amountCents: f.amountCents, vendor: f.vendor, date: f.date, categoryId: f.categoryId, isPersonal: f.isPersonal,
      ...(cur ? { currency: cur } : {}),
    };
    const key = attemptKey ?? newIdempotencyKey();
    const queue = async () => { await queueOr(() => queueExpense(payload)); return true; };
    if (deviceOffline()) return queue();
    try {
      await createExpense(payload, key);
      return false;
    } catch (e) {
      if (isOfflineError(e)) return queue();
      throw e;
    }
  }

  async function save(next: boolean) {
    const parsed = parseAmountToCents(draft.amount, locale);
    if (!parsed.ok || parsed.cents <= 0) { setErrorKind('amount_invalid'); return; }
    if (parsed.ambiguous) { setAmbiguous(parsed.formatted); setErrorKind('amount_ambiguous'); return; }
    setErrorKind(null);
    const f: Fields = {
      amountCents: parsed.cents,
      vendor: draft.vendor.trim() || undefined,
      date: draft.date || undefined,
      categoryId: draft.categoryId ?? undefined,
      isPersonal: draft.isPersonal,
    };
    setSaving(true);
    try {
      let queued = false;
      if (source === 'uploaded' && doc) await finalizeUploaded(doc, f);
      else if (source === 'manual') queued = await saveManual(f);
      else queued = await saveReceipt(f);
      if (draft.categoryId && draft.categoryName) pushRecentCategory({ id: draft.categoryId, name: draft.categoryName });
      toast.show(queued ? t('mobile.capture.queued_toast') : t('mobile.capture.saved'), { tone: queued ? 'neutral' : 'good' });
      reset(next);
    } catch (e) {
      if (e instanceof DeletedError) {
        toast.show(t('mobile.capture.receipt_deleted'), { tone: 'critical' });
        reset(false);
        return;
      }
      setErrorKind(e instanceof QueueError ? 'queue_failed' : isTooLarge(e) ? 'save_too_large' : 'save_failed');
    } finally {
      setSaving(false);
    }
  }

  async function discard() {
    if (source === 'uploaded' && doc) {
      try {
        await deleteDoc(doc.id);
        toast.show(t('mobile.capture.discarded'), { tone: 'good' });
      } catch {
        setErrorKind('discard_failed');
        return;
      }
    }
    reset(false);
  }

  const picked: RecentCategory | null = draft.categoryId && draft.categoryName ? { id: draft.categoryId, name: draft.categoryName } : null;
  const chipCats: RecentCategory[] = [];
  for (const c of [aiGuess, picked, ...recents]) {
    if (c && !chipCats.some((x) => x.id === c.id)) chipCats.push(c);
  }
  const visibleChips = chipCats.slice(0, 5);
  /** Literal keys only (the hygiene guard resolves each t() call). Never the server's message. */
  function errorLines(kind: Exclude<ErrorKind, null>): string[] {
    switch (kind) {
      case 'read_failed': return [t('mobile.capture.read_failed')];
      case 'upload_too_large': return [t('mobile.capture.too_large'), t('mobile.capture.read_failed')];
      case 'save_too_large': return [t('mobile.capture.too_large')];
      case 'save_failed': return [t('mobile.capture.save_failed')];
      case 'queue_failed': return [t('mobile.capture.queue_failed')];
      case 'amount_invalid': return [t('mobile.capture.amount_invalid')];
      case 'amount_ambiguous': return [t('mobile.capture.amount_ambiguous', { formatted: ambiguous })];
      case 'discard_failed': return [t('mobile.capture.discard_failed')];
      case 'review_amount': return [t('mobile.capture.review_amount')];
      case 'receipt_deleted': return [t('mobile.capture.receipt_deleted')];
    }
  }
  const busy = saving || stage === 'uploading';

  return (
    <div style={{ padding: '16px 16px 32px', color: tokens.color.fg, display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>{t('mobile.capture.title')}</h1>
        <QueuePill currency={currency} />
      </div>

      <input ref={fileRef} type="file" accept="image/*" capture="environment" data-testid="capture-file" style={{ display: 'none' }}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void onPhoto(f); }} />

      {stage === 'idle' ? (
        <>
          <button ref={snapRef} type="button" onClick={() => fileRef.current?.click()}
            style={{ minHeight: 180, borderRadius: 16, border: `1px dashed ${tokens.color.border}`, background: tokens.color.card, color: tokens.color.fg, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Camera aria-hidden="true" style={{ width: 40, height: 40, color: tokens.color.primary }} />
            <span style={{ fontSize: 17, fontWeight: 600 }}>{t('mobile.capture.snap')}</span>
            <span style={{ fontSize: 13, color: tokens.color.muted }}>{t('mobile.capture.snap_hint')}</span>
          </button>
          <button type="button" style={linkBtn} onClick={startManual}>
            <PenLine aria-hidden="true" style={{ width: 16, height: 16 }} /> {t('mobile.capture.manual')}
          </button>
        </>
      ) : (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {preview && <img src={preview} alt={t('mobile.capture.preview_alt')} style={{ width: '100%', maxHeight: 260, objectFit: 'contain', borderRadius: 12, background: tokens.color.card }} />}
          {stage === 'uploading' && <p role="status" style={{ margin: 0 }}>{t('mobile.capture.reading')}</p>}
          {stage === 'review' && source === 'uploaded' && <p style={{ margin: 0, fontSize: 13, color: tokens.color.muted }}>{t('mobile.capture.uploaded_hint')}</p>}
          {stage === 'review' && source === 'offline' && (
            <p role="status" style={{ margin: 0, padding: '8px 12px', borderRadius: 10, fontSize: 13, background: tokens.color.mutedBg }}>{t('mobile.capture.offline_mode')}</p>
          )}
          {errorKind && (
            <div role="alert" style={{ color: tokens.color.critical, fontSize: 13, display: 'grid', gap: 4 }}>
              {errorLines(errorKind).map((line) => <p key={line} style={{ margin: 0 }}>{line}</p>)}
            </div>
          )}

          <fieldset disabled={busy} style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 10 }}>
            <label style={label}>{t('mobile.capture.field_amount')}
              <input style={field} inputMode="decimal" value={draft.amount} onChange={(e) => set('amount', e.target.value)} />
            </label>
            <label style={label}>{t('mobile.capture.field_vendor')}
              <input style={field} value={draft.vendor} onChange={(e) => set('vendor', e.target.value)} />
            </label>
            <label style={label}>{t('mobile.capture.field_date')}
              <input style={field} type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
            </label>
            <div role="group" aria-label={t('mobile.capture.category_label')} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              {visibleChips.map((c) => (
                <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Chip label={c.name} selected={draft.categoryId === c.id}
                    onClick={() => setDraft((d) => (d.categoryId === c.id ? { ...d, categoryId: null, categoryName: null } : { ...d, categoryId: c.id, categoryName: c.name }))} />
                  {aiGuess?.id === c.id && <Pill tone="primary">{t('mobile.capture.ai_guess')}</Pill>}
                </span>
              ))}
              <Chip label={t('mobile.capture.more_categories')} onClick={() => setPickerOpen(true)} />
            </div>
            <div role="radiogroup" aria-label={t('mobile.capture.kind_label')} style={{ display: 'flex', gap: 8 }}>
              {[false, true].map((p) => (
                <button key={String(p)} type="button" role="radio" aria-checked={draft.isPersonal === p} style={seg(draft.isPersonal === p)}
                  onClick={() => set('isPersonal', p)}>
                  {p ? t('mobile.capture.personal') : t('mobile.capture.business')}
                </button>
              ))}
            </div>
          </fieldset>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <button type="button" style={primary} disabled={busy || !draft.amount.trim()} onClick={() => void save(false)}>
              {saving ? t('mobile.capture.saving') : t('mobile.capture.save')}
            </button>
            <button type="button" style={secondary} disabled={busy || !draft.amount.trim()} onClick={() => void save(true)}>
              {t('mobile.capture.save_next')}
            </button>
          </div>
          <button type="button" style={linkBtn} disabled={saving} onClick={() => void discard()}>{t('mobile.capture.discard')}</button>
        </>
      )}

      <CategoryPicker open={pickerOpen} onClose={() => setPickerOpen(false)} currentId={draft.categoryId}
        onSelect={(c) => { setPickerOpen(false); setDraft((d) => ({ ...d, categoryId: c.id, categoryName: c.name })); }} />
    </div>
  );
}
