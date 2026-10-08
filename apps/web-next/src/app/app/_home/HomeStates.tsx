'use client';

import React from 'react';
import Link from 'next/link';
import { RefreshCw } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { Card } from '../_kit/Card';
import { Button } from '../_kit/Button';
import { Skeleton } from '../_kit/Skeleton';
import { buttonStyle } from '../_kit/styles';
import { tokens } from '../_kit/tokens';

export function HomeSkeleton() {
  const t = useT();
  return (
    <div role="status" aria-label={t('mobile.kit.loading')} data-testid="home-skeleton" style={{ display: 'grid', gap: tokens.space.md }}>
      <Skeleton height={84} radius={tokens.radius.md} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: tokens.space.sm }}>
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={88} radius={tokens.radius.md} />
        ))}
      </div>
      <Skeleton height={120} radius={tokens.radius.md} />
    </div>
  );
}

/**
 * `code` is ApiError.code. It chooses the copy; ApiError.message is never
 * rendered (it is a developer string and may carry a server sentence).
 */
export function HomeError({ offline, onRetry, code }: { offline: boolean; onRetry: () => void; code?: string }) {
  const t = useT();
  if (code === 'unauthorized') {
    return (
      <Card role="alert" data-testid="home-error" style={{ display: 'grid', gap: tokens.space.sm }}>
        <p style={{ fontSize: tokens.font.md, fontWeight: 600, margin: 0 }}>{t('mobile.home.error.signed_out_title')}</p>
        <p style={{ fontSize: tokens.font.sm, color: tokens.color.muted, margin: 0 }}>{t('mobile.home.error.signed_out_body')}</p>
        <div>
          <Link href="/login" style={buttonStyle('primary')}>
            {t('mobile.home.error.sign_in')}
          </Link>
        </div>
      </Card>
    );
  }
  const rateLimited = code === 'rate_limited' && !offline;
  const title = offline ? t('mobile.kit.offline_title') : rateLimited ? t('mobile.home.error.rate_limited_title') : t('mobile.kit.error_title');
  const body = offline ? t('mobile.kit.offline_body') : rateLimited ? t('mobile.home.error.rate_limited_body') : t('mobile.kit.error_body');
  return (
    <Card role="alert" data-testid="home-error" style={{ display: 'grid', gap: tokens.space.sm }}>
      <p style={{ fontSize: tokens.font.md, fontWeight: 600, margin: 0 }}>{title}</p>
      <p style={{ fontSize: tokens.font.sm, color: tokens.color.muted, margin: 0 }}>{body}</p>
      <div>
        <Button onClick={onRetry}>{t('mobile.kit.retry')}</Button>
      </div>
    </Card>
  );
}

export function StaleNotice({ offline, time, onRetry }: { offline: boolean; time: string; onRetry: () => void }) {
  const t = useT();
  return (
    <div
      data-testid="stale-notice"
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: tokens.space.sm,
        padding: `${tokens.space.xs}px ${tokens.space.xs}px ${tokens.space.xs}px ${tokens.space.md}px`,
        borderRadius: tokens.radius.md,
        background: tokens.color.warnSoft,
        borderLeft: `4px solid ${tokens.color.warn}`,
        color: tokens.color.fg,
        marginBottom: tokens.space.md,
      }}
    >
      <span style={{ fontSize: tokens.font.sm }}>
        {offline ? t('mobile.kit.offline_as_of', { time }) : t('mobile.kit.stale_as_of', { time })}
      </span>
      <Button variant="ghost" onClick={onRetry}>{t('mobile.kit.retry')}</Button>
    </div>
  );
}

export function PullIndicator({ distance, busy }: { distance: number; busy: boolean }) {
  const t = useT();
  if (distance <= 0 && !busy) return null;
  return (
    <div
      data-testid="pull-indicator"
      role="status"
      style={{
        height: busy ? 32 : distance,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.space.xs,
        overflow: 'hidden',
        color: tokens.color.muted,
        fontSize: tokens.font.xs,
      }}
    >
      <RefreshCw aria-hidden="true" width={16} height={16} />
      {busy ? t('mobile.home.refreshing') : t('mobile.home.pull_to_refresh')}
    </div>
  );
}
