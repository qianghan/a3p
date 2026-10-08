'use client';

import React from 'react';
import { tokens, TOUCH } from './tokens';

export function chipStyle(selected: boolean): React.CSSProperties {
  return {
    minHeight: TOUCH,
    minWidth: TOUCH,
    padding: `0 ${tokens.space.md + 2}px`,
    borderRadius: tokens.radius.pill,
    border: `1px solid ${selected ? tokens.color.primary : tokens.color.border}`,
    background: selected ? tokens.color.primarySoft : tokens.color.card,
    color: selected ? tokens.color.primary : tokens.color.fg,
    fontSize: tokens.font.sm,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: tokens.space.xs + 2,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  };
}

export interface ChipProps {
  label: string;
  selected?: boolean;
  count?: number;
  onClick?: () => void;
  ariaLabel?: string;
}

export function Chip({ label, selected = false, count, onClick, ariaLabel }: ChipProps) {
  return (
    <button type="button" aria-pressed={selected} aria-label={ariaLabel} onClick={onClick} style={chipStyle(selected)}>
      <span>{label}</span>
      {typeof count === 'number' && (
        <span
          style={{
            minWidth: 20,
            padding: '0 6px',
            borderRadius: tokens.radius.pill,
            background: selected ? tokens.color.primary : tokens.color.mutedBg,
            color: selected ? tokens.color.primaryFg : tokens.color.muted,
            fontSize: tokens.font.xs,
            fontWeight: 600,
            textAlign: 'center',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}
