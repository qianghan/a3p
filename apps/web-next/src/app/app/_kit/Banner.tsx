'use client';

import React, { useId } from 'react';
import { useT } from '@/hooks/use-t';
import { tokens, toneColors, severityTone } from './tokens';
import { visuallyHidden } from './styles';

export type BannerSeverity = 'critical' | 'warn' | 'info';

export function bannerStyle(severity: BannerSeverity): React.CSSProperties {
  const c = toneColors(severityTone(severity));
  return {
    background: c.bg,
    color: c.fg,
    borderLeft: `4px solid ${c.accent}`,
    position: 'relative',
    borderRadius: tokens.radius.md,
    padding: `${tokens.space.md}px ${tokens.space.lg}px`,
    display: 'grid',
    gap: tokens.space.xs,
  };
}

export interface BannerProps {
  severity: BannerSeverity;
  title: string;
  body?: string;
  action?: React.ReactNode;
}

/**
 * Severity must not be conveyed by colour alone (WCAG 1.4.1), so each banner
 * carries a visually-hidden text prefix. Critical banners are announced
 * assertively (role=alert); the others stay a labelled group.
 */
export function Banner({ severity, title, body, action }: BannerProps) {
  const t = useT();
  const titleId = useId();
  const prefix =
    severity === 'critical'
      ? t('mobile.kit.severity_critical')
      : severity === 'warn'
        ? t('mobile.kit.severity_warn')
        : t('mobile.kit.severity_info');
  return (
    <div role={severity === 'critical' ? 'alert' : 'group'} aria-labelledby={titleId} data-severity={severity} style={bannerStyle(severity)}>
      <p id={titleId} style={{ fontSize: tokens.font.md, fontWeight: 600, margin: 0, lineHeight: 1.35 }}>
        <span style={visuallyHidden}>{prefix}</span> {title}
      </p>
      {body && <p style={{ fontSize: tokens.font.sm, margin: 0, color: tokens.color.muted }}>{body}</p>}
      {action && <div style={{ marginTop: tokens.space.sm }}>{action}</div>}
    </div>
  );
}
