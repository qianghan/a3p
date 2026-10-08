'use client';

import React from 'react';
import { tokens, toneColors, type Tone } from './tokens';

export function pillStyle(tone: Tone): React.CSSProperties {
  const c = toneColors(tone);
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.space.xs,
    padding: '2px 8px',
    borderRadius: tokens.radius.pill,
    background: c.bg,
    color: c.fg,
    border: `1px solid ${c.accent}`,
    fontSize: tokens.font.xs,
    fontWeight: 600,
    lineHeight: 1.4,
    whiteSpace: 'nowrap',
  };
}

export function Pill({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <span data-tone={tone} style={pillStyle(tone)}>
      {children}
    </span>
  );
}
