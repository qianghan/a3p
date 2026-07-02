'use client';

import { useEffect, useState } from 'react';

const MOBILE_BREAKPOINT_QUERY = '(max-width: 767px)';

/**
 * QA-P5-001: the dashboard shell had no viewport awareness at all — the
 * sidebar rendered at full desktop width on every screen size. Defaults to
 * `false` for the SSR/first-paint render (matching desktop today, so this
 * introduces no behavior change until the effect below corrects it on
 * mount) and updates live on resize/orientation change.
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(MOBILE_BREAKPOINT_QUERY);
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
