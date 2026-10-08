'use client';

import React from 'react';
import { RefreshCw } from 'lucide-react';
import type { MobileHome } from '@/lib/mobile/types';
import { useT } from '@/hooks/use-t';
import { ApiError, getHome } from './_lib/api';
import { useMobileData } from './_lib/useMobileData';
import { HOME_KEY } from './_lib/useShellBadges';
import { usePullToRefresh } from './_lib/usePullToRefresh';
import { useSettledReload } from './_lib/useSettledReload';
import { useRevalidateOnVisible } from './_lib/useRevalidateOnVisible';
import { BADGE_MAX_AGE_MS } from './_shell/badges';
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
 * PWA Home — "what needs me?" at a glance, one tap to act (spec §4.2).
 *
 * States are distinct and labelled, never a blank or a silent zero:
 *   loading (no data, no error)  → skeleton
 *   401                          → signed-out card with a sign-in link (no auto-retry)
 *   failed, nothing cached       → error card with Retry (offline / rate-limited / server copy)
 *   failed/offline, cache exists → cached screen + "as of HH:MM" notice (offline vs couldn't refresh)
 *   brand-new account            → any alerts' banner, then welcome + the three next-step cards
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
  const settledReload = useSettledReload(reload, { busy: loading || refreshing, data, error, staleAt });
  const pull = usePullToRefresh(settledReload);
  // Resumed in place after BADGE_MAX_AGE_MS: refetch, like the tab bar's dot does on the same
  // trigger (getHome() shares the request, so the two cost one fetch).
  useRevalidateOnVisible(reload, { hasData: data !== null, live: data !== null && staleAt === null && !error, busy: loading || refreshing }, BADGE_MAX_AGE_MS);
  // One instance for the banner AND the KPI sheet: one POST per alert, one "Reminded" state.
  const actions = useAlertAction(reload);

  const busy = refreshing || pull.refreshing;
  const code = error instanceof ApiError ? error.code : undefined;
  const refresh = () => {
    if (!busy) reload();
  };

  return (
    <div {...pull.bind} style={{ padding: `${tokens.space.md}px ${tokens.space.lg}px ${tokens.space.xl}px`, color: tokens.color.fg }}>
      {/* Gesture feedback only: a Refresh tap or a background reload must not insert this row (layout jump) or announce twice. */}
      <PullIndicator distance={pull.distance} busy={pull.refreshing} />
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
      {data && data.isBrandNew && (
        <>
          {/* A brand-new account can still have an alert (a tax date, an overdue bill) — and
              the tab bar's red dot comes from the same alerts, so its reason must be on screen. */}
          {data.alerts.length > 0 && <AlertCarousel alerts={data.alerts} currency={data.currency} actions={actions} />}
          <BrandNewHome />
        </>
      )}
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
