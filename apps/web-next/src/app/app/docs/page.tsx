'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { LayoutGrid, List as ListIcon, Search } from 'lucide-react';
import { useT, useShellLocale } from '@/hooks/use-t';
import type { DocCounts, DocFilter, DocList, MobileDoc } from '@/lib/mobile/types';
import { ApiError, listDocs } from '../_lib/api';
import { useMobileData } from '../_lib/useMobileData';
import { useOnlineStatus } from '../_lib/useOnlineStatus';
import { useTenantCurrency } from '../_lib/useTenantCurrency';
import { useInfiniteScroll } from '../_lib/useInfiniteScroll';
import { readJson, writeJson } from '../_lib/safe-storage';
import { parseDocFilter, saveDocNav } from '../_lib/doc-nav';
import { formatTime } from '../_lib/format';
import { Skeleton, EmptyState, buttonStyle, iconButtonStyle, tokens, TOUCH, visuallyHidden } from '../_kit';
import { FilterChips } from './_components/FilterChips';
import { DocItem } from './_components/DocItem';
import { AiBanner } from './_components/AiBanner';

const VIEW_KEY = 'ab:mobile:docs:view';
const PAGE_SIZE = 30;
const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_MAX_LENGTH = 100; // the list route cuts `q` at 100 characters
const DOCS_PATH = '/app/docs';
// How long a param set we wrote ourselves is still recognised as ours when it shows up in useSearchParams.
const OWN_WRITE_TTL_MS = 2000;
type ViewMode = 'list' | 'grid';

const viewToggle: React.CSSProperties = {
  ...iconButtonStyle(),
  border: `1px solid ${tokens.color.border}`,
  background: tokens.color.card,
  color: tokens.color.fg,
  borderRadius: tokens.radius.sm + 2,
};
const notice: React.CSSProperties = {
  margin: `${tokens.space.sm}px ${tokens.space.lg}px 0`,
  padding: `${tokens.space.xs}px ${tokens.space.xs}px ${tokens.space.xs}px ${tokens.space.md}px`,
  minHeight: TOUCH,
  borderRadius: tokens.radius.md,
  background: tokens.color.warnSoft,
  borderLeft: `4px solid ${tokens.color.warn}`,
  color: tokens.color.fg,
  fontSize: tokens.font.sm,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: tokens.space.sm,
};

export default function MobileDocsPage() {
  // useSearchParams() needs a Suspense boundary or `next build` refuses to prerender the route.
  return (
    <Suspense fallback={<DocsSkeleton />}>
      <DocsScreen />
    </Suspense>
  );
}

function DocsSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-label={t('mobile.kit.loading')} aria-busy="true" data-testid="docs-skeleton" style={{ display: 'grid', gap: tokens.space.sm, padding: `${tokens.space.md}px ${tokens.space.lg}px` }}>
      {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} height={68} radius={tokens.radius.md} />)}
    </div>
  );
}

/** The query string the screen's own state maps to (what we write, and what a matching URL looks like). */
function urlFor(filter: DocFilter, q: string): string {
  const p = new URLSearchParams();
  if (filter !== 'all') p.set('filter', filter);
  if (q) p.set('q', q);
  return p.toString();
}

function DocsScreen() {
  const t = useT();
  const params = useSearchParams();
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const paramKey = params?.toString() ?? '';

  const [filter, setFilter] = useState<DocFilter>(() => parseDocFilter(params?.get('filter')));
  // `query` is what the box shows; `q` is what was last committed (after a pause in typing) and is what is fetched.
  const [query, setQuery] = useState(() => params?.get('q') ?? '');
  const [q, setQ] = useState(() => (params?.get('q') ?? '').trim());
  const [view, setView] = useState<ViewMode>('list');
  const [counts, setCounts] = useState<DocCounts | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  // How many documents the current list has (null until its first page lands): announced by the status region below.
  const [resultCount, setResultCount] = useState<number | null>(null);
  const online = useOnlineStatus();
  const currency = useTenantCurrency();

  // Read after mount, not in the initial state: the server cannot see localStorage, and a
  // different first render would be a hydration mismatch on the toggle's icon and label.
  useEffect(() => {
    if (readJson<string>('local', VIEW_KEY, 'list') === 'grid') setView('grid');
  }, []);

  useEffect(() => {
    const next = query.trim();
    if (next === q) return;
    const h = setTimeout(() => setQ(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(h);
  }, [query, q]);

  // URL <-> state. The page's own state is the source of truth and the URL is written from it with
  // history.replaceState: a router.replace to the same path is a real server navigation in Next 15, which
  // offline falls back to a full browser navigation that the service worker cannot serve. Next syncs
  // useSearchParams with replaceState without a request. `urlKey` is the query the URL holds as far as
  // this screen knows; `recentWrites` lets the params of our own writes be told apart from an outside
  // navigation (the Docs tab tapped again, a link to /app/docs?filter=x while mounted) when they arrive.
  const urlKey = useRef(paramKey);
  const recentWrites = useRef<{ key: string; at: number }[]>([]);
  useEffect(() => {
    const s = urlFor(filter, q);
    if (s === urlKey.current) return;
    urlKey.current = s;
    const now = Date.now();
    recentWrites.current = [...recentWrites.current.filter((w) => now - w.at < OWN_WRITE_TTL_MS), { key: s, at: now }];
    window.history.replaceState(null, '', s ? `${DOCS_PATH}?${s}` : DOCS_PATH);
  }, [filter, q]);
  useEffect(() => {
    if (paramKey === urlKey.current) return;
    const now = Date.now();
    if (recentWrites.current.some((w) => w.key === paramKey && now - w.at < OWN_WRITE_TTL_MS)) return;
    urlKey.current = paramKey;
    recentWrites.current = [];
    const p = paramsRef.current;
    const nextQ = p?.get('q') ?? '';
    setFilter(parseDocFilter(p?.get('filter')));
    setQuery(nextQ);
    setQ(nextQ.trim());
  }, [paramKey]);

  const toggleView = () => {
    const next: ViewMode = view === 'list' ? 'grid' : 'list';
    setView(next);
    writeJson('local', VIEW_KEY, next);
  };
  // The AI banner changed something (a run, an accepted or rejected pick): re-read the list AND the counts.
  // A pick dropped as `no_suggestion` can still be uncategorized, so the list has to show it again.
  const onAiChanged = useCallback(() => setRefreshToken((n) => n + 1), []);

  return (
    <div style={{ padding: `${tokens.space.md}px 0 ${tokens.space.xl}px`, color: tokens.color.fg }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: `0 ${tokens.space.lg}px` }}>
        <h1 style={{ fontSize: tokens.font.xl, fontWeight: 600, margin: 0 }}>{t('common.documents')}</h1>
        <button type="button" onClick={toggleView} style={viewToggle} aria-label={view === 'list' ? t('mobile.docs.view_grid') : t('mobile.docs.view_list')}>
          {view === 'list' ? <LayoutGrid aria-hidden="true" style={{ width: 20, height: 20 }} /> : <ListIcon aria-hidden="true" style={{ width: 20, height: 20 }} />}
        </button>
      </div>

      <div style={{ padding: `${tokens.space.md}px ${tokens.space.lg}px 0` }}>
        {/* Not remounted on change: that would close an open review sheet mid-flow. It re-reads its own picks. */}
        <AiBanner noCategoryCount={counts?.noCategory ?? 0} online={online} currency={currency} onChanged={onAiChanged} />
      </div>

      <FilterChips value={filter} counts={counts} onChange={setFilter} />

      <label
        style={{
          display: 'flex', alignItems: 'center', gap: tokens.space.sm, margin: `${tokens.space.sm}px ${tokens.space.lg}px 0`, padding: `0 ${tokens.space.md}px`,
          minHeight: TOUCH, borderRadius: tokens.radius.md - 2, border: `1px solid ${tokens.color.border}`, background: tokens.color.bg,
        }}
      >
        <Search aria-hidden="true" style={{ width: 16, height: 16, color: tokens.color.muted }} />
        <input
          data-testid="docs-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          maxLength={SEARCH_MAX_LENGTH}
          aria-label={t('mobile.docs.search_label')}
          placeholder={t('mobile.docs.search_placeholder')}
          style={{ flex: 1, minWidth: 0, minHeight: TOUCH - 2, border: 'none', outline: 'none', background: 'transparent', color: tokens.color.fg, fontSize: 16 }}
        />
      </label>

      {/* Always mounted and outside the keyed list: a live region that is created together with its text is often not announced. */}
      <div role="status" aria-live="polite" data-testid="docs-results" style={visuallyHidden}>
        {resultCount === null ? '' : resultCount === 0 ? t('mobile.docs.results_none') : t('mobile.docs.results', { count: resultCount })}
      </div>

      <DocsList key={`${filter}|${q}`} filter={filter} q={q} view={view} currency={currency} online={online} refreshToken={refreshToken} onCounts={setCounts} onResultCount={setResultCount} />
    </div>
  );
}

function EmptyForFilter({ filter, searching }: { filter: DocFilter; searching: boolean }) {
  const t = useT();
  if (searching) return <EmptyState title={t('mobile.docs.empty_search_title')} body={t('mobile.docs.empty_search_body')} testId="docs-empty" />;
  const copy: Record<DocFilter, { title: string; body: string }> = {
    'needs-review': { title: t('mobile.docs.empty_needs_review_title'), body: t('mobile.docs.empty_needs_review_body') },
    'no-category': { title: t('mobile.docs.empty_no_category_title'), body: t('mobile.docs.empty_no_category_body') },
    'no-receipt': { title: t('mobile.docs.empty_no_receipt_title'), body: t('mobile.docs.empty_no_receipt_body') },
    all: { title: t('mobile.docs.empty_all_title'), body: t('mobile.docs.empty_all_body') },
    archived: { title: t('mobile.docs.empty_archived_title'), body: t('mobile.docs.empty_archived_body') },
  };
  return (
    <EmptyState title={copy[filter].title} body={copy[filter].body} testId="docs-empty">
      {filter === 'all' && (
        <div>
          <Link href="/app/capture" style={buttonStyle('secondary')}>{t('mobile.docs.snap_receipt')}</Link>
        </div>
      )}
    </EmptyState>
  );
}

function DocsList({ filter, q, view, currency, online, refreshToken, onCounts, onResultCount }: {
  filter: DocFilter;
  q: string;
  view: ViewMode;
  currency: string | null;
  online: boolean;
  refreshToken: number;
  onCounts: (c: DocCounts) => void;
  onResultCount: (n: number | null) => void;
}) {
  const t = useT();
  const locale = useShellLocale();
  const regionRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const fetchFirst = useCallback(() => listDocs({ filter, q: q || undefined, limit: PAGE_SIZE, withCounts: true }), [filter, q]);
  const { data, error, refreshing, offline, staleAt, reload } = useMobileData<DocList>(`docs:${filter}:${q}`, fetchFirst);
  const [more, setMore] = useState<MobileDoc[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [manualMore, setManualMore] = useState(false);
  const loadingRef = useRef(false);
  // Bumped whenever the first page is replaced: a "load more" still in flight belongs to the old list and must not append to the new one.
  const generation = useRef(0);

  const lastToken = useRef(refreshToken);
  useEffect(() => {
    if (lastToken.current === refreshToken) return;
    lastToken.current = refreshToken;
    reload();
  }, [refreshToken, reload]);

  useEffect(() => {
    if (!data) return;
    generation.current += 1;
    loadingRef.current = false;
    setLoadingMore(false);
    setMoreError(false);
    setMore([]);
    setCursor(data.nextCursor);
    if (data.counts) onCounts(data.counts);
    // A snapshot saved before `total` existed has none: the rows of its first page are what it can honestly say.
    onResultCount(data.total ?? data.items.length);
  }, [data, onCounts, onResultCount]);
  // This list is replaced when the filter or search changes (its key): until the new one answers, announce nothing.
  useEffect(() => () => onResultCount(null), [onResultCount]);

  const items = useMemo(() => {
    const seen = new Set<string>();
    return [...(data?.items ?? []), ...more].filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  }, [data, more]);

  // The viewer's prev/next walks exactly what this list shows.
  useEffect(() => {
    if (data) saveDocNav({ ids: items.map((d) => d.id), filter, q });
  }, [data, items, filter, q]);

  const loadMore = useCallback(async (manual = false) => {
    if (!cursor || loadingRef.current) return;
    loadingRef.current = true;
    const g = generation.current;
    setLoadingMore(true);
    setManualMore(manual);
    setMoreError(false);
    try {
      const next = await listDocs({ filter, q: q || undefined, cursor, limit: PAGE_SIZE });
      if (g !== generation.current) return;
      const firstNew = listRef.current?.children.length ?? 0;
      setMore((m) => [...m, ...next.items]);
      setCursor(next.nextCursor);
      // A button press must not leave focus on a button that is about to disappear: move it to the first new row.
      if (manual) requestAnimationFrame(() => (listRef.current?.children[firstNew]?.querySelector('a') as HTMLElement | null)?.focus());
    } catch (err) {
      if (g !== generation.current) return;
      if (err instanceof ApiError && err.status === 401) reload(); // the session is gone: the first-page path shows the sign-in state
      setMoreError(true);
    } finally {
      if (g === generation.current) {
        loadingRef.current = false;
        setLoadingMore(false);
      }
    }
  }, [cursor, filter, q, reload]);

  const offlineNow = offline || !online;
  // A failed page pauses automatic loading (`disabled`); the Retry button below is the way out, not a tight retry loop.
  const { sentinelRef, supported } = useInfiniteScroll({
    hasMore: !!cursor && !offlineNow,
    loading: loadingMore,
    disabled: moreError,
    onLoadMore: () => void loadMore(),
  });

  const retry = () => {
    // The panel the button lives in is replaced by the skeleton: keep focus on a stable element.
    regionRef.current?.focus();
    reload();
  };

  let body: React.ReactNode;
  if (!data && !error) {
    body = <DocsSkeleton />;
  } else if (!data) {
    const code = error instanceof ApiError ? error.code : undefined;
    if (code === 'unauthorized') {
      body = (
        <div role="alert" style={{ padding: tokens.space.lg }}>
          <EmptyState title={t('mobile.docs.signed_out_title')} body={t('mobile.docs.signed_out_body')}>
            <div><Link href="/login?redirect=%2Fapp%2Fdocs" style={buttonStyle('primary')}>{t('mobile.docs.sign_in')}</Link></div>
          </EmptyState>
        </div>
      );
    } else {
      const off = offlineNow || code === 'offline';
      body = (
        <div role="alert" style={{ padding: tokens.space.lg }}>
          <EmptyState title={off ? t('mobile.kit.offline_title') : t('mobile.docs.error_title')} body={off ? t('mobile.kit.offline_body') : t('mobile.kit.error_body')} testId="docs-error">
            <div>
              <button type="button" style={buttonStyle('secondary')} onClick={retry}>{t('mobile.docs.retry')}</button>
            </div>
          </EmptyState>
        </div>
      );
    }
  } else {
    const showMore = !!cursor && items.length > 0 && !offlineNow;
    // Without IntersectionObserver, after a failed page, and while a pressed button's own request runs.
    const showButton = showMore && (!supported || moreError || (manualMore && loadingMore));
    const time = staleAt ? formatTime(staleAt, locale) : '';
    body = (
      <>
        {staleAt && offlineNow ? (
          <p role="status" data-testid="docs-offline" style={notice}>{t('mobile.docs.offline_snapshot', { time })}</p>
        ) : staleAt ? (
          <div data-testid="docs-stale" style={notice}>
            {/* Only the message is the live region: the Retry button must not be read out as part of the status. */}
            <span role="status">{t('mobile.kit.stale_as_of', { time })}</span>
            <button type="button" style={buttonStyle('ghost', refreshing)} aria-disabled={refreshing || undefined} aria-busy={refreshing || undefined} onClick={() => { if (!refreshing) reload(); }}>
              {t('mobile.docs.retry')}
            </button>
          </div>
        ) : offlineNow ? (
          <p role="status" data-testid="docs-offline" style={notice}>{t('mobile.docs.offline_readonly')}</p>
        ) : null}
        {items.length === 0 ? (
          <div style={{ padding: `0 ${tokens.space.lg}px` }}><EmptyForFilter filter={filter} searching={!!q} /></div>
        ) : (
          <ul
            ref={listRef}
            data-testid="doc-list"
            data-view={view}
            style={{
              listStyle: 'none', margin: 0, padding: `${tokens.space.md}px ${tokens.space.lg}px`, display: 'grid', gap: tokens.space.sm,
              ...(view === 'grid' ? { gridTemplateColumns: 'repeat(auto-fill, minmax(114px, 1fr))' } : null),
            }}
          >
            {items.map((d) => <li key={d.id} style={{ minWidth: 0 }}><DocItem doc={d} view={view} currency={currency} /></li>)}
          </ul>
        )}
        {showMore && (
          <div ref={sentinelRef} style={{ padding: tokens.space.lg, minHeight: TOUCH, display: 'grid', gap: tokens.space.sm, justifyItems: 'center' }}>
            {/* Always mounted with the sentinel: a live region added together with its text is often not announced. */}
            <p role="status" aria-live="polite" style={{ margin: 0, fontSize: tokens.font.sm, color: moreError ? tokens.color.critical : tokens.color.muted }}>
              {loadingMore ? t('mobile.docs.loading_more') : moreError ? t('mobile.docs.load_more_failed') : ''}
            </p>
            {showButton && (
              <button
                type="button"
                style={buttonStyle('secondary', loadingMore)}
                aria-disabled={loadingMore || undefined}
                aria-busy={loadingMore || undefined}
                onClick={() => { if (!loadingMore) void loadMore(true); }}
              >
                {moreError ? t('mobile.docs.retry') : t('mobile.docs.load_more')}
              </button>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <div data-testid="docs-screen" ref={regionRef} tabIndex={-1} aria-busy={refreshing || undefined} style={{ outline: 'none' }}>
      {body}
    </div>
  );
}
