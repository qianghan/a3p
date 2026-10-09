'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useT, useShellLocale } from '@/hooks/use-t';
import type { ExpenseCategory, MobileDoc } from '@/lib/mobile/types';
import { archiveDoc, categorizeDoc, deleteDoc, getDoc, patchDoc, reviewSuggestions, unarchiveDoc } from '../../_lib/api';
import { confirmDoc, getPendingSuggestions } from '../../_lib/api-extra';
import { SNAPSHOT_PREFIX, useMobileData } from '../../_lib/useMobileData';
import { useOnlineStatus } from '../../_lib/useOnlineStatus';
import { useTenantCurrency } from '../../_lib/useTenantCurrency';
import { docsHref, neighbors, readDocNav, removeFromDocNav } from '../../_lib/doc-nav';
import { pushRecentCategory } from '../../_lib/category-recents';
import { formatTime } from '../../_lib/format';
import { removeJson } from '../../_lib/safe-storage';
import { EmptyState, Pill, Sheet, Skeleton, buttonStyle, iconButtonStyle, tokens, TOUCH, useToast } from '../../_kit';
import { Amount } from '../_components/Amount';
import { CategoryPicker } from '../_components/CategoryPicker';
import { ReceiptPanel } from '../_components/ReceiptPanel';
import { diffForm, isDirty, toForm, type FormError, type FormState } from '../_lib/edit-form';

const VENDOR_MAX_LENGTH = 200; // the edit route rejects a longer vendor name

const field: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', minHeight: TOUCH, padding: `${tokens.space.sm + 2}px ${tokens.space.md}px`,
  borderRadius: tokens.radius.md, border: `1px solid ${tokens.color.border}`, background: tokens.color.bg, color: tokens.color.fg, fontSize: 16,
};
const labelStyle: React.CSSProperties = { display: 'grid', gap: tokens.space.xs, fontSize: tokens.font.sm, color: tokens.color.muted };
const noteStyle: React.CSSProperties = {
  margin: 0, padding: `${tokens.space.sm}px ${tokens.space.md}px`, borderRadius: tokens.radius.md, fontSize: tokens.font.sm,
  background: tokens.color.mutedBg, color: tokens.color.fg,
};
const navLink: React.CSSProperties = { ...iconButtonStyle(), color: tokens.color.fg, textDecoration: 'none' };
const dangerStyle = (locked: boolean): React.CSSProperties => ({
  ...buttonStyle('secondary', locked), color: tokens.color.critical, borderColor: tokens.color.critical,
});

/** Thrown inside acceptSuggestion to leave its try block; never shown to the user. */
class AcceptRejected extends Error {}
/** The server no longer holds the pick and the expense is still uncategorized. */
class PickGone extends AcceptRejected {}

type Busy = null | 'save' | 'categorize' | 'archive' | 'delete' | 'confirm';
type Translate = ReturnType<typeof useT>;
type ApiLike = { status?: number; code?: string } | null;

/** Each form error maps to a literal t() call: the hygiene guard forbids a t(variable). */
function formErrorText(t: Translate, e: FormError): string {
  if (e.key === 'mobile.docs.amount_ambiguous') return t('mobile.docs.amount_ambiguous', e.params);
  if (e.key === 'mobile.docs.vendor_required') return t('mobile.docs.vendor_required');
  return t('mobile.docs.amount_invalid');
}

export default function DocViewerPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  // Keyed by id: prev/next reuses this route, and every piece of per-document state must start over.
  return <DocViewer key={id} id={id} />;
}

function DocViewer({ id }: { id: string }) {
  const t = useT();
  const locale = useShellLocale();
  const router = useRouter();
  const toast = useToast();
  const online = useOnlineStatus();
  const currency = useTenantCurrency();
  const fetchDoc = useCallback(() => getDoc(id), [id]);
  const { data, error, staleAt, refreshing, reload } = useMobileData<MobileDoc>(`doc:${id}`, fetchDoc);

  const [doc, setDoc] = useState<MobileDoc | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  // The state above lags a tap by a render; this does not, so a double tap cannot start a second request.
  const lockRef = useRef<Busy>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const [pendingSuggestion, setPendingSuggestion] = useState<MobileDoc['suggestion']>(null);
  const [suggestionChecked, setSuggestionChecked] = useState(false);
  const autoOpened = useRef(false);
  const docRef = useRef<MobileDoc | null>(null);
  docRef.current = doc;
  const formRef = useRef<FormState | null>(null);
  formRef.current = form;
  const regionRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const categoryButtonRef = useRef<HTMLButtonElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const vendorRef = useRef<HTMLInputElement>(null);

  // What the list showed, read once: prev/next and Back follow THAT list, and only when it really held this
  // document (a deep link from Home must not inherit the filter of a list opened an hour ago).
  const nav = useMemo(() => {
    const saved = readDocNav();
    return saved && saved.ids.includes(id) ? saved : null;
  }, [id]);
  const { prev, next } = neighbors(nav, id);
  const backHref = docsHref(nav);

  // An offline snapshot (or one served because the server failed) is for reading only.
  const readOnly = !online || !!staleAt;

  // Server data replaces the view — unless a write is in flight (its answer is newer) — and replaces the form
  // only when the user has not typed anything, so a background refresh never eats an edit.
  // The locale is read through a ref on purpose: a language switch must not replay old server data over a newer doc.
  const localeRef = useRef(locale);
  localeRef.current = locale;
  useEffect(() => {
    if (!data || lockRef.current) return;
    const before = docRef.current;
    const typed = formRef.current;
    setDoc(data);
    if (!before || !typed || !isDirty(before, typed, localeRef.current)) setForm(toForm(data, localeRef.current));
  }, [data]);

  // A language switch re-formats an untouched form (the amount's decimal separator follows the locale).
  const lastLocale = useRef(locale);
  useEffect(() => {
    const was = lastLocale.current;
    if (was === locale) return;
    lastLocale.current = locale;
    const d = docRef.current;
    const f = formRef.current;
    if (d && f && !isDirty(d, f, was)) setForm(toForm(d, locale));
  }, [locale]);

  const docId = doc?.id ?? null;
  const hasOwnSuggestion = !!doc?.suggestion;
  const categoryId = doc?.categoryId ?? null;
  useEffect(() => {
    if (!docId) return;
    // Offline the service worker may answer this GET from its cache with no marker, so it is not asked.
    if (hasOwnSuggestion || categoryId || !online) { setSuggestionChecked(true); return; }
    let cancelled = false;
    getPendingSuggestions()
      .then((r) => {
        if (cancelled) return;
        const s = r.items.find((i) => i.expenseId === docId);
        if (s) setPendingSuggestion({ categoryId: s.suggestedCategoryId, categoryName: s.suggestedCategoryName, confidence: s.confidence });
      })
      .catch(() => { /* no suggestion is a valid state */ })
      .finally(() => { if (!cancelled) setSuggestionChecked(true); });
    return () => { cancelled = true; };
  }, [docId, hasOwnSuggestion, categoryId, online]);

  const suggestion = doc?.suggestion ?? pendingSuggestion;
  // A suggestion only ever applies to a document that has no category yet.
  const showSuggestion = !!suggestion && !!doc && !doc.categoryId;

  // An uncategorized document with no AI pick opens the picker — but only once the pick check has finished (the
  // picker must not cover a suggestion that is about to arrive) and only while a choice can actually be saved.
  useEffect(() => {
    if (!doc || autoOpened.current || readOnly || !suggestionChecked || busy) return;
    if (!doc.categoryId && !suggestion && !doc.archivedAt) {
      autoOpened.current = true;
      setPickerOpen(true);
    }
  }, [doc, suggestion, suggestionChecked, readOnly, busy]);

  const begin = (kind: Exclude<Busy, null>): boolean => {
    if (lockRef.current) return false;
    lockRef.current = kind;
    setBusy(kind);
    return true;
  };
  const end = () => {
    lockRef.current = null;
    setBusy(null);
  };
  // A write that failed may still have landed (the answer was lost, or the re-read after it failed): ask the server.
  const reconcile = () => { if (online) reload(); };

  // ── Edit ───────────────────────────────────────────────────────────────────
  async function save() {
    const before = docRef.current;
    const typed = formRef.current;
    if (readOnly || !before || !typed || lockRef.current) return;
    const { body, error: problem } = diffForm(before, typed, locale);
    if (problem) {
      setFormError(problem);
      (problem.key === 'mobile.docs.vendor_required' ? vendorRef : amountRef).current?.focus();
      return;
    }
    setFormError(null);
    if (Object.keys(body).length === 0) { setForm(toForm(before, locale)); return; }
    if (!begin('save')) return;
    setDoc({
      ...before,
      ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
      ...(body.vendor !== undefined ? { vendorName: body.vendor } : {}),
      ...(body.date !== undefined ? { date: body.date } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.isPersonal !== undefined ? { isPersonal: body.isPersonal } : {}),
    });
    try {
      const server = await patchDoc(before.id, body);
      setDoc(server);
      setForm(toForm(server, locale));
      toast.show(t('mobile.docs.saved'), { tone: 'good' });
    } catch (e) {
      setDoc(before); // the figures go back; what was typed stays, so Retry is one tap
      // 422 is the books refusing (closed period, split entry, already reversed): say that, not "try again".
      toast.show((e as ApiLike)?.status === 422 ? t('mobile.docs.save_blocked') : t('mobile.docs.save_failed'), { tone: 'critical' });
      reconcile();
    } finally {
      end();
    }
  }

  // ── Category ───────────────────────────────────────────────────────────────
  /** The picker's choice. The sheet is closed first, synchronously; a recent is recorded only once it is saved. */
  async function pickCategory(cat: ExpenseCategory) {
    setPickerOpen(false);
    const before = docRef.current;
    if (readOnly || !before || cat.id === before.categoryId) return;
    if (!begin('categorize')) return;
    setDoc({ ...before, categoryId: cat.id, categoryName: cat.name, categorySource: 'user', suggestion: null });
    try {
      const server = await categorizeDoc(before.id, cat.id);
      setDoc(server);
      setPendingSuggestion(null);
      pushRecentCategory({ id: cat.id, name: cat.name });
      toast.show(t('mobile.docs.categorized'), { tone: 'good' });
    } catch {
      setDoc(before);
      toast.show(t('mobile.docs.categorize_failed'), { tone: 'critical' });
      reconcile();
    } finally {
      end();
    }
  }

  /**
   * Accept the AI's pick. A BARE accept: the server applies ITS stored suggestion and keeps its stale-accept
   * guard (an expense categorized since this page loaded is not overwritten). Sending the category id from here
   * would bypass that guard. The document is then re-read, so what is shown is what the server did.
   */
  async function acceptSuggestion() {
    const before = docRef.current;
    const pick = before?.suggestion ?? pendingSuggestion;
    if (readOnly || !before || !pick || before.categoryId) return;
    if (!begin('categorize')) return;
    // The Accept button is about to unmount: keep focus on something that stays.
    categoryButtonRef.current?.focus();
    setDoc({ ...before, categoryId: pick.categoryId, categoryName: pick.categoryName, categorySource: 'ai', suggestion: null });
    try {
      const results = await reviewSuggestions([{ expenseId: before.id, action: 'accept' }]);
      const r = results.find((x) => x.expenseId === before.id);
      // `no_suggestion` is ambiguous (already categorized, or the pick is gone): the re-read below decides.
      if (!r || (!r.ok && r.error !== 'no_suggestion')) throw new AcceptRejected();
      const server = await getDoc(before.id);
      if (!server.categoryId) throw new PickGone();
      setDoc(server);
      setPendingSuggestion(null);
      if (r.ok) pushRecentCategory({ id: server.categoryId, name: server.categoryName ?? pick.categoryName });
      toast.show(t('mobile.docs.categorized'), { tone: 'good' });
    } catch (e) {
      const dropPick = e instanceof PickGone;
      setDoc(dropPick ? { ...before, suggestion: null } : before);
      if (dropPick) setPendingSuggestion(null);
      toast.show(t('mobile.docs.categorize_failed'), { tone: 'critical' });
      reconcile();
    } finally {
      end();
    }
  }

  /** `confirm` books a journal entry only when the expense has a category, so it is never offered without one. */
  async function markReviewed() {
    const before = docRef.current;
    if (readOnly || !before || !before.categoryId || before.status !== 'pending_review') return;
    if (!begin('confirm')) return;
    titleRef.current?.focus(); // the button disappears once the document is confirmed
    setDoc({ ...before, status: 'confirmed' });
    try {
      await confirmDoc(before.id);
      toast.show(t('mobile.docs.reviewed'), { tone: 'good' });
    } catch {
      setDoc(before);
      toast.show(t('mobile.docs.confirm_failed'), { tone: 'critical' });
      reconcile();
    } finally {
      end();
    }
  }

  // ── Archive / restore ──────────────────────────────────────────────────────
  async function toggleArchive() {
    const before = docRef.current;
    if (readOnly || !before || !begin('archive')) return;
    const archiving = !before.archivedAt;
    const optimisticAt = new Date().toISOString();
    setDoc({ ...before, archivedAt: archiving ? optimisticAt : null });
    try {
      const r = archiving ? await archiveDoc(before.id) : await unarchiveDoc(before.id);
      const at = archiving ? (typeof r?.archivedAt === 'string' ? r.archivedAt : optimisticAt) : null;
      setDoc((d) => (d ? { ...d, archivedAt: at } : d));
      // The document just left the list it was opened from (archived → every list but Archived; restored → Archived):
      // prev/next must not walk it. It is archived, not deleted, so it is still readable here.
      if (nav && (archiving ? nav.filter !== 'archived' : nav.filter === 'archived')) removeFromDocNav(before.id);
      toast.show(archiving ? t('mobile.docs.archived_toast') : t('mobile.docs.restored_toast'), { tone: 'good' });
    } catch {
      setDoc(before);
      toast.show(archiving ? t('mobile.docs.archive_failed') : t('mobile.docs.restore_failed'), { tone: 'critical' });
      reconcile();
    } finally {
      end();
    }
  }

  // ── Delete (waits for the server) ──────────────────────────────────────────
  async function confirmDelete() {
    const before = docRef.current;
    if (readOnly || !before || !begin('delete')) return;
    setDeleteFailed(false);
    try {
      await deleteDoc(before.id);
    } catch {
      // In the dialog, not a toast: a toast sits outside the modal, where assistive tech cannot reach it.
      setDeleteFailed(true);
      reconcile(); // it may have gone through: a 404 on the re-read shows "no longer exists"
      end();
      return;
    }
    // Gone for good: no prev/next may walk it, and its offline copy must not outlive it.
    removeFromDocNav(before.id);
    removeJson('local', `${SNAPSHOT_PREFIX}doc:${before.id}`);
    setDeleteOpen(false);
    toast.show(t('mobile.docs.deleted_toast'), { tone: 'good' });
    router.push(next ? `/app/docs/${encodeURIComponent(next)}` : backHref);
  }

  // ── Not a document yet ─────────────────────────────────────────────────────
  const failure = error as ApiLike;
  const gone = failure?.status === 404 || failure?.code === 'not_found';
  const backLink = (
    <Link href={backHref} aria-label={t('mobile.docs.back')} style={navLink}>
      <ArrowLeft aria-hidden="true" style={{ width: 20, height: 20 }} />
    </Link>
  );

  if (gone || !doc || !form) {
    let body: React.ReactNode;
    if (gone) {
      body = <EmptyState title={t('mobile.docs.not_found')} />;
    } else if (!error) {
      return (
        <div role="status" aria-label={t('mobile.kit.loading')} aria-busy="true" data-testid="doc-skeleton" style={{ padding: tokens.space.lg, display: 'grid', gap: tokens.space.md }}>
          <Skeleton height={TOUCH} />
          <Skeleton height={240} />
          <Skeleton height={TOUCH} />
        </div>
      );
    } else if (failure?.code === 'unauthorized') {
      body = (
        <div role="alert">
          <EmptyState title={t('mobile.docs.signed_out_title')} body={t('mobile.docs.signed_out_body')}>
            <div>
              <Link href={`/login?redirect=${encodeURIComponent(`/app/docs/${encodeURIComponent(id)}`)}`} style={buttonStyle('primary')}>{t('mobile.docs.sign_in')}</Link>
            </div>
          </EmptyState>
        </div>
      );
    } else {
      const off = !online || failure?.status === 0;
      body = (
        <div role="alert">
          <EmptyState title={off ? t('mobile.kit.offline_title') : t('mobile.docs.load_failed')} body={off ? t('mobile.kit.offline_body') : t('mobile.kit.error_body')}>
            <div>
              <button
                type="button"
                style={buttonStyle('secondary')}
                onClick={() => {
                  // The panel the button lives in is replaced by the skeleton: keep focus on a stable element.
                  regionRef.current?.focus();
                  reload();
                }}
              >
                {t('mobile.docs.retry')}
              </button>
            </div>
          </EmptyState>
        </div>
      );
    }
    return (
      <div ref={regionRef} tabIndex={-1} style={{ padding: tokens.space.lg, outline: 'none', color: tokens.color.fg }}>
        {backLink}
        {body}
      </div>
    );
  }

  // ── The document ───────────────────────────────────────────────────────────
  const current = doc;
  const dirty = isDirty(current, form, locale);
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setFormError(null);
    setForm((f) => (f ? { ...f, [k]: v } : f));
  };
  const title = current.vendorName || current.description || t('mobile.docs.untitled');
  const writesLocked = readOnly || busy !== null;
  const inputsLocked = readOnly || busy === 'save';
  const saveLocked = !dirty || readOnly || busy !== null;
  const reviewLocked = writesLocked || !current.categoryId;
  const confidencePct = suggestion ? Math.round(Math.min(1, Math.max(0, suggestion.confidence)) * 100) : 0;
  // aria-disabled, not disabled: a disabled button drops keyboard focus to <body> mid-flow.
  const lock = (locked: boolean, working = false) => ({ 'aria-disabled': locked || undefined, 'aria-busy': working || undefined }) as const;

  return (
    <div style={{ padding: `${tokens.space.sm}px ${tokens.space.lg}px ${tokens.space.xl + tokens.space.lg}px`, color: tokens.color.fg, display: 'grid', gap: tokens.space.md }}>
      <nav aria-label={t('mobile.docs.nav_label')} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {backLink}
        <span style={{ display: 'flex', gap: tokens.space.xs }}>
          {prev ? (
            <Link href={`/app/docs/${encodeURIComponent(prev)}`} aria-label={t('mobile.docs.prev')} style={navLink}>
              <ChevronLeft aria-hidden="true" style={{ width: 20, height: 20 }} />
            </Link>
          ) : <span aria-hidden="true" style={{ width: TOUCH }} />}
          {next ? (
            <Link href={`/app/docs/${encodeURIComponent(next)}`} aria-label={t('mobile.docs.next')} style={navLink}>
              <ChevronRight aria-hidden="true" style={{ width: 20, height: 20 }} />
            </Link>
          ) : <span aria-hidden="true" style={{ width: TOUCH }} />}
        </span>
      </nav>

      <header style={{ display: 'grid', gap: tokens.space.xs }}>
        <h1 ref={titleRef} tabIndex={-1} style={{ margin: 0, fontSize: tokens.font.md, fontWeight: 500, color: tokens.color.muted, outline: 'none' }}>{title}</h1>
        <span data-testid="doc-amount" style={{ fontSize: tokens.font.xl + 6, fontWeight: 600 }}>
          <Amount cents={current.amountCents} currency={currency} />
        </span>
        <span style={{ display: 'flex', gap: tokens.space.sm - 2, flexWrap: 'wrap' }}>
          {current.status === 'pending_review' && <Pill tone="warn">{t('mobile.docs.needs_review_banner')}</Pill>}
          {current.archivedAt && <Pill tone="neutral">{t('mobile.docs.archived_pill')}</Pill>}
        </span>
      </header>

      {staleAt && !online ? (
        <p role="status" style={noteStyle}>{t('mobile.docs.offline_snapshot', { time: formatTime(staleAt, locale) })}</p>
      ) : staleAt ? (
        <div style={{ ...noteStyle, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.space.sm }}>
          {/* Only the message is the live region: the Retry button must not be read out as part of the status. */}
          <span role="status">{t('mobile.kit.stale_as_of', { time: formatTime(staleAt, locale) })}</span>
          <button type="button" style={buttonStyle('ghost', refreshing)} aria-disabled={refreshing || undefined} aria-busy={refreshing || undefined} onClick={() => { if (!refreshing) reload(); }}>
            {t('mobile.docs.retry')}
          </button>
        </div>
      ) : !online ? (
        <p role="status" style={noteStyle}>{t('mobile.docs.offline_readonly')}</p>
      ) : null}
      {current.archivedAt && <p role="status" style={noteStyle}>{t('mobile.docs.archived_banner')}</p>}

      <ReceiptPanel url={current.receiptUrl} />

      {showSuggestion && suggestion && (
        <div data-testid="ai-suggestion" style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm, flexWrap: 'wrap', padding: tokens.space.md, borderRadius: tokens.radius.md, border: `1px solid ${tokens.color.border}`, background: tokens.color.card }}>
          <Sparkles aria-hidden="true" style={{ width: 16, height: 16 }} />
          <span style={{ flex: 1, minWidth: 0 }}>{t('mobile.docs.suggested', { category: suggestion.categoryName })}</span>
          <Pill tone="primary">{t('mobile.docs.confidence', { pct: confidencePct })}</Pill>
          <button
            type="button"
            data-testid="accept-suggestion"
            style={buttonStyle('primary', writesLocked)}
            {...lock(writesLocked, busy === 'categorize')}
            onClick={() => { if (!writesLocked) void acceptSuggestion(); }}
          >
            {t('mobile.docs.accept')}
          </button>
        </div>
      )}

      <div style={labelStyle}>
        <span>{t('mobile.docs.field_category')}</span>
        <div data-testid="doc-category" style={{ display: 'flex', alignItems: 'center', gap: tokens.space.sm }}>
          <span style={{ fontSize: 16, color: tokens.color.fg }}>{current.categoryName ?? t('mobile.docs.no_category')}</span>
          {current.categorySource === 'ai' && <Pill tone="primary">{t('mobile.docs.ai_pill')}</Pill>}
          <button
            ref={categoryButtonRef}
            type="button"
            style={{ ...buttonStyle('secondary', writesLocked), marginLeft: 'auto' }}
            {...lock(writesLocked, busy === 'categorize')}
            onClick={() => { if (!writesLocked) setPickerOpen(true); }}
          >
            {t('mobile.docs.change_category')}
          </button>
        </div>
      </div>

      <label style={labelStyle}>{t('mobile.docs.field_amount')}
        <input
          ref={amountRef}
          style={field}
          inputMode="decimal"
          value={form.amount}
          readOnly={inputsLocked}
          aria-invalid={formError && formError.key !== 'mobile.docs.vendor_required' ? true : undefined}
          onChange={(e) => set('amount', e.target.value)}
        />
      </label>
      <label style={labelStyle}>{t('mobile.docs.field_vendor')}
        <input
          ref={vendorRef}
          style={field}
          value={form.vendor}
          maxLength={VENDOR_MAX_LENGTH}
          readOnly={inputsLocked}
          aria-invalid={formError?.key === 'mobile.docs.vendor_required' ? true : undefined}
          onChange={(e) => set('vendor', e.target.value)}
        />
      </label>
      <label style={labelStyle}>{t('mobile.docs.field_date')}
        <input style={field} type="date" value={form.date} readOnly={inputsLocked} onChange={(e) => set('date', e.target.value)} />
      </label>
      <label style={labelStyle}>{t('mobile.docs.field_description')}
        <textarea style={{ ...field, minHeight: 72 }} value={form.description} readOnly={inputsLocked} onChange={(e) => set('description', e.target.value)} />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: tokens.space.md - 2, minHeight: TOUCH, color: tokens.color.fg }}>
        <input
          type="checkbox"
          checked={form.isPersonal}
          aria-disabled={inputsLocked || undefined}
          onChange={(e) => { if (!inputsLocked) set('isPersonal', e.target.checked); }}
          style={{ width: 22, height: 22 }}
        />
        {t('mobile.docs.personal_toggle')}
      </label>
      {formError && <p role="alert" style={{ color: tokens.color.critical, fontSize: tokens.font.sm, margin: 0 }}>{formErrorText(t, formError)}</p>}
      <button
        type="button"
        data-testid="save-changes"
        style={buttonStyle('primary', saveLocked)}
        {...lock(saveLocked, busy === 'save')}
        onClick={() => { if (!saveLocked) void save(); }}
      >
        {busy === 'save' ? t('mobile.docs.saving') : t('mobile.docs.save')}
      </button>

      <div style={{ display: 'flex', gap: tokens.space.sm, flexWrap: 'wrap' }}>
        {current.status === 'pending_review' && (
          <>
            <button
              type="button"
              style={buttonStyle('secondary', reviewLocked)}
              {...lock(reviewLocked, busy === 'confirm')}
              onClick={() => { if (!reviewLocked) void markReviewed(); }}
            >
              {t('mobile.docs.mark_reviewed')}
            </button>
            {!current.categoryId && <p style={{ fontSize: tokens.font.sm, color: tokens.color.muted, margin: 0, flexBasis: '100%' }}>{t('mobile.docs.review_needs_category')}</p>}
          </>
        )}
        <button
          type="button"
          style={buttonStyle('secondary', writesLocked)}
          {...lock(writesLocked, busy === 'archive')}
          onClick={() => { if (!writesLocked) void toggleArchive(); }}
        >
          {current.archivedAt ? t('mobile.docs.restore') : t('mobile.docs.archive')}
        </button>
        <button
          type="button"
          data-testid="delete-doc"
          style={dangerStyle(writesLocked)}
          {...lock(writesLocked)}
          onClick={() => { if (!writesLocked) { setDeleteFailed(false); setDeleteOpen(true); } }}
        >
          {t('mobile.docs.delete')}
        </button>
      </div>

      <CategoryPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentId={current.categoryId}
        onSelect={(c) => void pickCategory(c)}
      />

      <Sheet open={deleteOpen} onClose={() => { if (busy !== 'delete') setDeleteOpen(false); }} title={t('mobile.docs.delete_title')}>
        <p style={{ marginTop: 0 }}>{t('mobile.docs.delete_body')}</p>
        {deleteFailed && <p role="alert" style={{ color: tokens.color.critical, fontSize: tokens.font.sm }}>{t('mobile.docs.delete_failed')}</p>}
        <div style={{ display: 'flex', gap: tokens.space.sm }}>
          <button type="button" style={buttonStyle('secondary', busy === 'delete')} {...lock(busy === 'delete')} onClick={() => { if (busy !== 'delete') setDeleteOpen(false); }}>
            {t('mobile.docs.cancel')}
          </button>
          <button
            type="button"
            data-testid="confirm-delete"
            style={{ ...dangerStyle(readOnly || busy !== null), fontWeight: 600 }}
            {...lock(readOnly || busy !== null, busy === 'delete')}
            onClick={() => { if (!readOnly && busy === null) void confirmDelete(); }}
          >
            {t('mobile.docs.delete_confirm')}
          </button>
        </div>
      </Sheet>
    </div>
  );
}
