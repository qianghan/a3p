'use client';

import React, { useId } from 'react';
import { tokens, toneColors, severityTone } from './tokens';

export type BannerSeverity = 'critical' | 'warn' | 'info';

export function bannerStyle(severity: BannerSeverity): React.CSSProperties {
  const c = toneColors(severityTone(severity));
  return {
    background: c.bg,
    color: c.fg,
    borderLeft: `4px solid ${c.accent}`,
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

export function Banner({ severity, title, body, action }: BannerProps) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} data-severity={severity} style={bannerStyle(severity)}>
      <p id={titleId} style={{ fontSize: tokens.font.md, fontWeight: 600, margin: 0, lineHeight: 1.35 }}>
        {title}
      </p>
      {body && <p style={{ fontSize: tokens.font.sm, margin: 0, color: tokens.color.muted }}>{body}</p>}
      {action && <div style={{ marginTop: tokens.space.sm }}>{action}</div>}
    </div>
  );
}
