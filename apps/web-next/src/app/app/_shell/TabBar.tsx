'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Home, FileText, Camera, MessageCircle, type LucideIcon } from 'lucide-react';
import { useT } from '@/hooks/use-t';
import { tokens, TOUCH } from '../_kit/tokens';
import { useShellBadges } from '../_lib/useShellBadges';
import { BADGES_ENABLED, type BadgeGate } from './badges';

export const TAB_ORDER = ['/app', '/app/docs', '/app/capture', '/app/chat'] as const;

export function isTabActive(href: string, pathname: string | null): boolean {
  const p = pathname ?? '';
  if (href === '/app') return p === '/app' || p === '/app/';
  return p === href || p.startsWith(`${href}/`);
}

/**
 * State styling inline styles cannot express. Inline `style` has no
 * :focus-visible, so the raised Capture button would otherwise show its
 * keyboard focus on the invisible 44px link box instead of on the circle the
 * user sees. Token colours only.
 */
export const TAB_CLASS = { tab: 'ab-tab', raised: 'ab-tab-raised', circle: 'ab-tab-circle', count: 'ab-tab-count' } as const;

/**
 * Docs count colours, per theme. 11px bold needs 4.5:1 (WCAG AA). White on
 * --error is ~3.7:1, and no single text token clears 4.5:1 on --error in both
 * themes, so the text token flips with `.dark` (on <html>): --foreground in
 * light (~4.9:1), --background in dark (~5.1:1). shell.test.tsx computes these
 * ratios from the real values in packages/theme/src/shell-variables.css.
 */
const BADGE_TOKEN = { error: tokens.color.critical, foreground: tokens.color.fg, background: tokens.color.bg } as const;
type BadgeVar = keyof typeof BADGE_TOKEN;
export const COUNT_BADGE_COLOURS: Readonly<Record<'light' | 'dark', { bg: BadgeVar; fg: BadgeVar }>> = {
  light: { bg: 'error', fg: 'foreground' },
  dark: { bg: 'error', fg: 'background' },
};
const countRule = (sel: string, c: { bg: BadgeVar; fg: BadgeVar }) =>
  `${sel}{background:${BADGE_TOKEN[c.bg]};color:${BADGE_TOKEN[c.fg]}}`;
export const TAB_CSS = [
  `.${TAB_CLASS.tab}:focus-visible{outline:2px solid ${tokens.color.fg};outline-offset:-4px;border-radius:${tokens.radius.md}px}`,
  `.${TAB_CLASS.raised}:focus-visible{outline:none}`,
  `.${TAB_CLASS.circle}{box-shadow:0 4px 12px ${tokens.color.primaryGlow}}`,
  `.${TAB_CLASS.raised}:focus-visible .${TAB_CLASS.circle}{outline:3px solid ${tokens.color.fg};outline-offset:3px}`,
  `.${TAB_CLASS.raised}[aria-current="page"] .${TAB_CLASS.circle}{box-shadow:0 0 0 3px ${tokens.color.card},0 0 0 6px ${tokens.color.primary},0 4px 12px ${tokens.color.primaryGlow}}`,
  countRule(`.${TAB_CLASS.count}`, COUNT_BADGE_COLOURS.light),
  countRule(`.dark .${TAB_CLASS.count}`, COUNT_BADGE_COLOURS.dark),
].join('\n');

interface TabDef {
  href: (typeof TAB_ORDER)[number];
  label: string;
  Icon: LucideIcon;
  ariaLabel?: string;
  dot?: boolean;
  count?: number;
  raised?: boolean;
}

/** `badges` defaults to the shipped gate; tests pass a different one. */
export function TabBar({ badges = BADGES_ENABLED }: { badges?: BadgeGate } = {}) {
  const t = useT();
  const pathname = usePathname();
  const { homeCritical, docsNeedsReview } = useShellBadges(badges);

  const tabs: TabDef[] = [
    {
      href: '/app',
      label: t('mobile.tabs.home'),
      Icon: Home,
      dot: homeCritical,
      ariaLabel: homeCritical ? t('mobile.tabs.home_attention') : undefined,
    },
    {
      href: '/app/docs',
      label: t('mobile.tabs.docs'),
      Icon: FileText,
      count: docsNeedsReview,
      ariaLabel: docsNeedsReview > 0 ? t('mobile.tabs.docs_review', { count: docsNeedsReview }) : undefined,
    },
    { href: '/app/capture', label: t('mobile.tabs.capture'), Icon: Camera, raised: true },
    { href: '/app/chat', label: t('mobile.tabs.chat'), Icon: MessageCircle },
  ];

  return (
    <nav
      aria-label={t('mobile.tabs.nav_label')}
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 40,
        height: `calc(${tokens.tabBarHeight}px + env(safe-area-inset-bottom))`,
        paddingBottom: 'env(safe-area-inset-bottom)',
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        alignItems: 'stretch',
        borderTop: `1px solid ${tokens.color.border}`,
        background: tokens.color.card,
      }}
    >
      <style>{TAB_CSS}</style>
      {tabs.map((tab) => {
        const active = isTabActive(tab.href, pathname);
        const colour = tab.raised ? tokens.color.fg : active ? tokens.color.primary : tokens.color.muted;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            data-tab={tab.href}
            className={tab.raised ? `${TAB_CLASS.tab} ${TAB_CLASS.raised}` : TAB_CLASS.tab}
            aria-current={active ? 'page' : undefined}
            aria-label={tab.ariaLabel}
            style={{
              position: 'relative',
              minHeight: TOUCH,
              minWidth: TOUCH,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              textDecoration: 'none',
              color: colour,
              fontWeight: active ? 600 : 500,
            }}
          >
            {tab.raised ? (
              <span
                aria-hidden="true"
                className={TAB_CLASS.circle}
                data-active={active ? 'true' : undefined}
                style={{
                  width: 56,
                  height: 56,
                  marginTop: -24,
                  borderRadius: tokens.radius.pill,
                  background: tokens.color.primary,
                  color: tokens.color.primaryFg,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  border: `3px solid ${tokens.color.card}`,
                }}
              >
                <tab.Icon width={26} height={26} />
              </span>
            ) : (
              <span aria-hidden="true" style={{ position: 'relative', display: 'inline-flex' }}>
                <tab.Icon width={22} height={22} />
                {tab.dot && (
                  <span
                    data-badge="home-dot"
                    style={{
                      position: 'absolute',
                      top: -2,
                      right: -4,
                      width: 9,
                      height: 9,
                      borderRadius: tokens.radius.pill,
                      background: tokens.color.critical,
                      border: `2px solid ${tokens.color.card}`,
                    }}
                  />
                )}
                {typeof tab.count === 'number' && tab.count > 0 && (
                  <span
                    data-badge="docs-count"
                    className={TAB_CLASS.count}
                    style={{
                      position: 'absolute',
                      top: -6,
                      right: -12,
                      minWidth: 18,
                      height: 18,
                      padding: '0 5px',
                      borderRadius: tokens.radius.pill,
                      // Colours come from TAB_CSS (theme-dependent); inline would override it.
                      fontSize: tokens.font.xs,
                      fontWeight: 700,
                      lineHeight: '18px',
                      textAlign: 'center',
                    }}
                  >
                    {tab.count > 99 ? '99+' : tab.count}
                  </span>
                )}
              </span>
            )}
            <span style={{ fontSize: tokens.font.xs }}>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
