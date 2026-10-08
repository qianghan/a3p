'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import { RefreshCw } from 'lucide-react';
import type { MobileHome } from '@/lib/mobile/types';
import { useT } from '@/hooks/use-t';
import { ApiError, getHome } from './_lib/api';
import { useMobileData } from './_lib/useMobileData';
import { HOME_KEY } from './_lib/useShellBadges';
import { usePullToRefresh } from './_lib/usePullToRefresh';
import { tokens } from './_kit/tokens';
import { iconButtonStyle } from './_kit/styles';
import { useFormatters } from './_kit/format';
import { AlertCarousel } from './_home/AlertCarousel';
import { KpiStrip } from './_home/KpiStrip';
import { NextUp } from './_home/NextUp';
import { RecentActivity } from './_home/RecentActivity';
import { QuickActions } from './_home/QuickActions';
import { BrandNewHome } from './_home/BrandNewHome';
import { HomeSkeleton, HomeError, StaleNotice, PullIndicator } from './_home/HomeStates';
import { useAlertAction } from './_home/useAlertAction';

/**
 * `reload()` only bumps a counter, so it settles before the request has even
 * started. This returns a promise that resolves when the load it starts has
 * finished (the data hook went busy and came back), so the pull gesture's
 * "Refreshing" spans the whole request instead of flickering off at once.
 */
function useSettledReload(reload: () => void, busy: boolean): () => Promise<void> {
  const waiters = useRef<Array<() => void>>([]);
  const sawBusy = useRef(false);

  useEffect(() => {
    if (busy) {
      sawBusy.current = true;
      return;
    }
    if (!sawBusy.current) return;
    sawBusy.current = false;
    const done = waiters.current;
    waiters.current = [];
    done.forEach((resolve) => resolve());
  }, [busy]);

  useEffect(
    () => () => {
      // Unmounted mid-request: nobody will report the end, so release the callers.
      const done = waiters.current;
      waiters.current = [];
      done.forEach((resolve) => resolve());
    },
    [],
  );

  return useCallback(
    () =>
      new Promise<void>((resolve) => {
        waiters.current.push(resolve);
        reload();
      }),
    [reload],
  );
}

/**
 * PWA Home — "what needs me?" at a glance, one tap to act (spec §4.2).
 *
 * States are distinct and labelled, never a blank or a silent zero:
 *   loading (no data, no error)  → skeleton
 *   401                          → signed-out card with a sign-in link (no auto-retry)
 *   failed, nothing cached       → error card with Retry (offline / rate-limited / server copy)
 *   failed/offline, cache exists → cached screen + "as of HH:MM" notice (offline vs couldn't refresh)
 *   brand-new account            → welcome + the three next-step cards
 *   populated                    → banner, KPIs, next up, recent, quick actions
 *
 * Copy is chosen from ApiError.code only; ApiError.message is never shown.
 * The data key is the shell badges' HOME_KEY and getHome() shares its
 * in-flight request, so opening Home costs one /mobile/home round trip and a
 * successful load refreshes the badges' snapshot.
 */
export default function MobileHomePage() {
  const t = useT();
  const fmt = useFormatters();
  const { data, error, loading, refreshing, offline, staleAt, reload } = useMobileData<MobileHome>(HOME_KEY, getHome);
  const settledReload = useSettledReload(reload, loading || refreshing);
  const pull = usePullToRefresh(settledReload);
  // One instance for the banner AND the KPI sheet: one POST per alert, one "Reminded" state.
  const actions = useAlertAction(reload);

  const busy = refreshing || pull.refreshing;
  const code = error instanceof ApiError ? error.code : undefined;
  const refresh = () => {
    if (!busy) reload();
  };

  return (
    <div {...pull.bind} style={{ padding: `${tokens.space.md}px ${tokens.space.lg}px ${tokens.space.xl}px`, color: tokens.color.fg }}>
      <PullIndicator distance={pull.distance} busy={busy} />
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: tokens.space.sm, marginBottom: tokens.space.lg }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: tokens.font.xl, fontWeight: 600, margin: 0 }}>AgentBook</h1>
          <p style={{ fontSize: tokens.font.sm, color: tokens.color.muted, margin: '2px 0 0' }}>{t('mobile.home.subtitle')}</p>
        </div>
        {data && (
          <button
            type="button"
            onClick={refresh}
            aria-label={t('mobile.home.refresh')}
            aria-busy={busy}
            aria-disabled={busy}
            style={{ ...iconButtonStyle(), flexShrink: 0, opacity: busy ? 0.6 : 1 }}
          >
            <RefreshCw aria-hidden="true" width={20} height={20} />
          </button>
        )}
      </div>

      {data && staleAt && <StaleNotice offline={offline} time={fmt.time(staleAt)} onRetry={refresh} busy={busy} />}
      {!data && !error && <HomeSkeleton />}
      {!data && error && <HomeError offline={offline} code={code} onRetry={reload} />}
      {data && data.isBrandNew && <BrandNewHome />}
      {data && !data.isBrandNew && (
        <>
          <AlertCarousel alerts={data.alerts} currency={data.currency} actions={actions} />
          <KpiStrip data={data} actions={actions} />
          <NextUp items={data.nextUp} currency={data.currency} />
          <RecentActivity items={data.recent} currency={data.currency} />
          <QuickActions />
        </>
      )}
    </div>
  );
}
