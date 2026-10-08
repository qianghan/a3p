'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

export interface PullToRefresh {
  distance: number;
  refreshing: boolean;
  bind: {
    onTouchStart: (e: React.TouchEvent) => void;
    onTouchMove: (e: React.TouchEvent) => void;
    onTouchEnd: () => void;
    onTouchCancel: () => void;
  };
}

export interface PullToRefreshOptions {
  /** Pixels of (damped) pull needed to trigger a refresh. */
  threshold?: number;
  /** Explicit scroll-position source; wins over `scrollRef`. */
  getScrollTop?: () => number;
  /** The scroll container the screen renders in. Without either option the hook reads the shell's <main id="mobile-main">. */
  scrollRef?: React.RefObject<HTMLElement | null>;
}

/** Movement before the gesture is classified as a pull or a scroll/swipe. */
const DECIDE_PX = 10;

/** The shell's scroll container (MobileShell <main id="mobile-main">), else the window. */
function shellScrollTop(): number {
  try {
    const main = document.getElementById('mobile-main');
    return main ? main.scrollTop : window.scrollY;
  } catch {
    return 0;
  }
}

type Mode = 'idle' | 'undecided' | 'pull' | 'ignore';

/**
 * Pull down from the top of the screen to refresh. Only arms when the scroll
 * container is at the very top, and only commits to a pull when the first
 * decisive movement is predominantly vertical and downward — so a normal scroll
 * or a horizontal swipe (the banner carousel) never refreshes. There is no
 * animation here: the indicator tracks the finger, so reduced-motion holds by
 * construction.
 */
export function usePullToRefresh(
  onRefresh: () => void | Promise<void>,
  opts: PullToRefreshOptions = {},
): PullToRefresh {
  const threshold = opts.threshold ?? 64;
  const { getScrollTop: customScrollTop, scrollRef } = opts;
  const scrollTopRef = useRef<() => number>(shellScrollTop);
  scrollTopRef.current =
    customScrollTop ?? (scrollRef ? () => scrollRef.current?.scrollTop ?? 0 : shellScrollTop);

  const mode = useRef<Mode>('idle');
  const startX = useRef(0);
  const startY = useRef(0);
  const pulled = useRef(0);
  const busy = useRef(false);
  const mounted = useRef(true);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const [distance, setDistance] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    mode.current = 'idle';
    pulled.current = 0;
    setDistance(0);
  }, []);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    const t = e.touches[0];
    pulled.current = 0;
    // Synthetic touch events bubble through React portals: a touch inside a portalled
    // Sheet reaches these handlers although the sheet is not inside this element in
    // the DOM. A pull there must not refresh the screen behind it.
    const inside = e.target instanceof Node && e.currentTarget instanceof Node && e.currentTarget.contains(e.target);
    if (!t || !inside || scrollTopRef.current() > 0) {
      mode.current = 'ignore';
      return;
    }
    startX.current = t.clientX;
    startY.current = t.clientY;
    mode.current = 'undecided';
  }, []);

  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (mode.current === 'idle' || mode.current === 'ignore') return;
      const t = e.touches[0];
      if (!t) return;
      // The container moved off the top mid-gesture: it is a scroll now.
      if (scrollTopRef.current() > 0) {
        mode.current = 'ignore';
        pulled.current = 0;
        setDistance(0);
        return;
      }
      const dx = t.clientX - startX.current;
      const dy = t.clientY - startY.current;
      if (mode.current === 'undecided') {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < DECIDE_PX) return;
        if (dy > 0 && dy > Math.abs(dx)) {
          mode.current = 'pull';
        } else {
          mode.current = 'ignore'; // upward, or sideways: leave it to normal scrolling / the carousel
          return;
        }
      }
      // Half-speed resistance, capped, so the indicator never runs away from the thumb.
      const d = dy > 0 ? Math.min(dy / 2, threshold * 1.5) : 0;
      pulled.current = d;
      setDistance(d);
    },
    [threshold],
  );

  const onTouchEnd = useCallback(() => {
    const armed = mode.current === 'pull';
    const d = pulled.current;
    reset();
    if (!armed || d < threshold || busy.current) return;
    busy.current = true;
    setRefreshing(true);
    Promise.resolve()
      .then(() => refreshRef.current())
      .catch(() => {
        // The screen's own state machine reports load failures; the gesture just ends.
      })
      .finally(() => {
        busy.current = false;
        if (mounted.current) setRefreshing(false);
      });
  }, [threshold, reset]);

  return { distance, refreshing, bind: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel: reset } };
}
