'use client';
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';

interface Options {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  rootMargin?: string;
  /**
   * Pause automatic loading (e.g. after a failed page). Without this, a page
   * that errors would flip `loading` back to false with the sentinel still in
   * view and the re-observe below would retry in a tight loop. The caller shows
   * a Retry button wired to `loadMore` instead.
   */
  disabled?: boolean;
}

const subscribe = (): (() => void) => () => {};
const getSnapshot = (): boolean => typeof IntersectionObserver === 'function';
// The server (and the hydration pass) assume support, so a browser without
// IntersectionObserver re-renders into the fallback instead of mismatching.
const getServerSnapshot = (): boolean => true;

/** The shell's scroll container: <main id="mobile-main"> scrolls, not the window. */
function shellRoot(): Element | null {
  try {
    return document.getElementById('mobile-main');
  } catch {
    return null;
  }
}

/**
 * Calls onLoadMore when a sentinel element nears the viewport. Subtleties:
 *  - An observer only fires on CHANGES in intersection. If a page lands and the
 *    sentinel is still visible (short pages, tall phones), nothing would fire
 *    again — so after every load we unobserve+observe, which makes the observer
 *    deliver the current state once more.
 *  - /app scrolls inside <main id="mobile-main">. rootMargin only reaches past
 *    a scroll container's edge when that container IS the observer root, so the
 *    shell main is used as the root when present (else the viewport).
 *  - Callers read `supported` and render a "Load more" button (wired to
 *    `loadMore`) when false.
 */
export function useInfiniteScroll({ hasMore, loading, onLoadMore, rootMargin = '400px', disabled = false }: Options) {
  const supported = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const latest = useRef({ hasMore, loading, onLoadMore, disabled });
  latest.current = { hasMore, loading, onLoadMore, disabled };
  const observer = useRef<IntersectionObserver | null>(null);
  const element = useRef<Element | null>(null);

  const sentinelRef = useCallback((el: Element | null) => {
    observer.current?.disconnect();
    observer.current = null;
    element.current = el;
    if (!el || typeof IntersectionObserver !== 'function') return;
    const root = shellRoot();
    observer.current = new IntersectionObserver((entries) => {
      const s = latest.current;
      if (entries.some((e) => e.isIntersecting) && s.hasMore && !s.loading && !s.disabled) s.onLoadMore();
    }, root ? { root, rootMargin } : { rootMargin });
    observer.current.observe(el);
  }, [rootMargin]);

  useEffect(() => {
    const el = element.current;
    const o = observer.current;
    if (el && o && !loading && hasMore && !disabled) {
      o.unobserve(el);
      o.observe(el);
    }
  }, [loading, hasMore, disabled]);

  useEffect(() => () => {
    observer.current?.disconnect();
    observer.current = null;
  }, []);

  /** Manual trigger for the "Load more" / Retry button; same guards as the observer except `disabled`. */
  const loadMore = useCallback(() => {
    const s = latest.current;
    if (s.hasMore && !s.loading) s.onLoadMore();
  }, []);

  return { sentinelRef, supported, loadMore };
}
