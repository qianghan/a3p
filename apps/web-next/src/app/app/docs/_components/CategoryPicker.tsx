'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import type { ExpenseCategory } from '@/lib/mobile/types';
import { listExpenseCategories } from '../../_lib/api';
import { getRecentCategories, orderWithRecents } from '../../_lib/category-recents';
import { useOnlineStatus } from '../../_lib/useOnlineStatus';
import { Banner, EmptyState, Sheet, Skeleton, TOUCH, buttonStyle, tokens, visuallyHidden } from '../../_kit';

const SEARCH_MAX_LENGTH = 100;
/**
 * The ledger's suspense account ("Uncategorized Expenses"). The server returns it among the active expense
 * accounts, but an uncategorized expense must keep categoryId === null (the suspense posting is internal);
 * explicitly picking it would hide the expense from the needs-category watchdog and the Uncategorized
 * reports. So it is never offered. Mirrors UNCATEGORIZED_CODE in lib/agentbook-chart-of-accounts.ts, which
 * is `server-only` and cannot be imported here; a test pins the two equal.
 */
export const SUSPENSE_ACCOUNT_CODE = '6999';
// An HTML enum (the virtual keyboard's action key), not copy: held in a constant because the hygiene guard
// reads any `*Hint="…"` attribute as English text.
const ENTER_KEY_HINT = 'search' as const;

/**
 * Case-, diacritic- and width-insensitive: "cafe" finds "Café", "DEPENSES" finds "Dépenses", and the
 * full-width digits a CJK IME types ("５１００") find "5100".
 * NFKD splits an accented letter into base + combining mark (the marks are then dropped) and maps
 * compatibility forms such as full-width characters onto their ASCII equivalents.
 */
export function foldForSearch(s: string): string {
  return s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

const optionStyle = (selected: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: TOUCH,
  textAlign: 'left',
  padding: `${tokens.space.sm}px ${tokens.space.md}px`,
  borderRadius: tokens.radius.md,
  fontSize: tokens.font.md,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: tokens.space.sm,
  border: `1px solid ${selected ? tokens.color.primary : tokens.color.border}`,
  background: selected ? tokens.color.primarySoft : tokens.color.card,
  color: tokens.color.fg,
  cursor: 'pointer',
});

const headingStyle: React.CSSProperties = {
  fontSize: tokens.font.xs,
  fontWeight: 600,
  textTransform: 'uppercase',
  color: tokens.color.muted,
  margin: `${tokens.space.md}px 0 ${tokens.space.sm - 2}px`,
};

const listStyle: React.CSSProperties = { listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: tokens.space.sm - 2 };

/**
 * Chooses the expense account an expense is booked to, so what it offers and what it
 * returns are the server's, minus the suspense account (see SUSPENSE_ACCOUNT_CODE): GET /accounts?type=expense (active expense accounts of
 * this tenant, by code), rendered as received and handed to `onSelect` unchanged. There is
 * no client-side fallback list — when the request fails the picker says so and offers Retry
 * rather than an empty list that reads as "you have no categories".
 *
 * Recents (per device) only reorder: a recent that the server no longer returns is dropped,
 * and recents are not offered at all until the server list has loaded, so a stale or
 * deactivated account can never be picked from memory. Picking does not record a recent;
 * the caller does that once the choice is actually saved.
 *
 * The search box is not auto-focused: on a phone that would raise the keyboard over the
 * very list (recents first) the sheet exists to show.
 */
export function CategoryPicker({ open, onClose, onSelect, currentId }: {
  open: boolean;
  onClose: () => void;
  onSelect: (c: ExpenseCategory) => void;
  currentId: string | null;
}) {
  const t = useT();
  const online = useOnlineStatus();
  const [all, setAll] = useState<ExpenseCategory[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [query, setQuery] = useState('');
  const statusRef = useRef<HTMLDivElement>(null);
  // Set when the user pressed Retry: the Retry button unmounts on success, so focus must be
  // handed to the status region instead of falling to <body>.
  const refocusRef = useRef(false);
  const loadingRef = useRef(false);
  loadingRef.current = loading;
  const failedRef = useRef(false);
  failedRef.current = failed;
  // One choice per open: a second tap before the caller has closed the sheet must not select twice.
  const pickedRef = useRef(false);

  // Fresh on every open: a category deactivated since the last open must not linger.
  useEffect(() => {
    pickedRef.current = false;
    if (!open) {
      setAll(null);
      setFailed(false);
      setLoading(false);
      setQuery('');
      return;
    }
    let cancelled = false;
    setLoading(true);
    listExpenseCategories()
      .then((rows) => {
        if (cancelled) return;
        setAll(rows);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [open, attempt]);

  // Coming back online after a failed load is the one moment a retry is certain to be wanted.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current && failedRef.current && !loadingRef.current) setAttempt((n) => n + 1);
    wasOnline.current = online;
  }, [online]);

  useEffect(() => {
    if (all && refocusRef.current) {
      refocusRef.current = false;
      statusRef.current?.focus();
    }
  }, [all]);

  const recents = useMemo(() => (open ? getRecentCategories() : []), [open]);
  // Filtered before anything else uses the list, so recents, search and the count can never see the suspense account.
  const offered = useMemo(() => (all ? all.filter((c) => c.code !== SUSPENSE_ACCOUNT_CODE) : null), [all]);
  const { recent, rest } = useMemo(() => orderWithRecents(offered ?? [], recents), [offered, recents]);
  const needle = foldForSearch(query.trim());
  const match = (c: ExpenseCategory) => !needle || foldForSearch(c.name).includes(needle) || foldForSearch(c.code).includes(needle);
  const shownRecent = recent.filter(match);
  const shownRest = rest.filter(match);
  const shownCount = shownRecent.length + shownRest.length;

  const locked = loading || !online;
  const retry = () => {
    if (locked) return;
    refocusRef.current = true;
    setAttempt((n) => n + 1);
  };

  const renderOption = (c: ExpenseCategory) => {
    const selected = c.id === currentId;
    return (
      <li key={c.id}>
        <button type="button" data-testid="category-option" data-category-id={c.id} aria-pressed={selected} style={optionStyle(selected)} onClick={() => {
          if (pickedRef.current) return;
          pickedRef.current = true;
          onSelect(c);
        }}>
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span data-testid="category-name">{c.name}</span>
            {c.code && <span style={{ fontSize: tokens.font.xs, color: tokens.color.muted }}>{c.code}</span>}
          </span>
          {selected && <Check aria-hidden="true" width={18} height={18} color={tokens.color.primary} />}
        </button>
      </li>
    );
  };

  // Same wording as the visible state: an empty server list is "no categories", not a search with no hits.
  const status = !offered
    ? ''
    : offered.length === 0
      ? t('mobile.docs.categories_empty')
      : shownCount === 0
        ? t('mobile.docs.empty_search_title')
        : t('mobile.docs.category_count', { count: shownCount });

  return (
    <Sheet open={open} onClose={onClose} title={t('mobile.docs.choose_category')}>
      <div style={{ position: 'sticky', top: 0, zIndex: 1, background: tokens.color.card, paddingBottom: tokens.space.sm }}>
        <label
          style={{
            display: 'flex', alignItems: 'center', gap: tokens.space.sm, padding: `0 ${tokens.space.md}px`, minHeight: TOUCH,
            borderRadius: tokens.radius.md, border: `1px solid ${tokens.color.border}`, background: tokens.color.bg,
          }}
        >
          <Search aria-hidden="true" style={{ width: 16, height: 16, color: tokens.color.muted }} />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              // Search is live, so Enter has nothing to submit: it dismisses the keyboard to show the results.
              if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
            }}
            maxLength={SEARCH_MAX_LENGTH}
            enterKeyHint={ENTER_KEY_HINT}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            aria-label={t('mobile.docs.category_search')}
            placeholder={t('mobile.docs.category_search')}
            style={{ flex: 1, minWidth: 0, minHeight: TOUCH - 2, border: 'none', outline: 'none', background: 'transparent', color: tokens.color.fg, fontSize: 16 }}
          />
        </label>
      </div>
      <div ref={statusRef} role="status" tabIndex={-1} data-testid="category-status" style={{ ...visuallyHidden, outline: 'none' }}>
        {status}
      </div>
      {failed && (
        <Banner
          severity="critical"
          title={t('mobile.docs.categories_failed')}
          body={online ? undefined : t('mobile.docs.categories_offline')}
          action={
            // aria-disabled, not disabled: a disabled button would drop keyboard focus to <body> mid-retry.
            <button
              type="button"
              style={buttonStyle('secondary', locked)}
              aria-disabled={locked || undefined}
              aria-busy={loading || undefined}
              onClick={retry}
            >
              {t('mobile.docs.retry')}
            </button>
          }
        />
      )}
      {!all && !failed && (
        <div data-testid="category-loading" style={{ display: 'grid', gap: tokens.space.sm, marginTop: tokens.space.md }}>
          <Skeleton height={TOUCH} />
          <Skeleton height={TOUCH} />
          <Skeleton height={TOUCH} />
        </div>
      )}
      {offered && offered.length === 0 && <EmptyState title={t('mobile.docs.categories_empty')} />}
      {offered && offered.length > 0 && shownCount === 0 && (
        <EmptyState title={t('mobile.docs.empty_search_title')} body={t('mobile.docs.empty_search_body')} />
      )}
      {shownRecent.length > 0 && (
        <section>
          <h3 style={headingStyle}>{t('mobile.docs.recent_categories')}</h3>
          <ul style={listStyle}>{shownRecent.map(renderOption)}</ul>
        </section>
      )}
      {shownRest.length > 0 && (
        <section>
          <h3 style={headingStyle}>{t('mobile.docs.all_categories')}</h3>
          <ul style={listStyle}>{shownRest.map(renderOption)}</ul>
        </section>
      )}
    </Sheet>
  );
}
