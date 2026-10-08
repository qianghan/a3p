import type { CSSProperties } from 'react';
import { tokens, TOUCH } from './tokens';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export function buttonStyle(variant: ButtonVariant = 'primary', disabled = false): CSSProperties {
  const base: CSSProperties = {
    minHeight: TOUCH,
    minWidth: TOUCH,
    padding: `0 ${tokens.space.lg}px`,
    borderRadius: tokens.radius.md,
    fontSize: tokens.font.md,
    fontWeight: 600,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.space.sm,
    textDecoration: 'none',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
  if (variant === 'primary') {
    return { ...base, background: tokens.color.primary, color: tokens.color.primaryFg, border: `1px solid ${tokens.color.primary}` };
  }
  if (variant === 'secondary') {
    return { ...base, background: tokens.color.card, color: tokens.color.fg, border: `1px solid ${tokens.color.border}` };
  }
  return { ...base, background: 'transparent', color: tokens.color.primary, border: '1px solid transparent' };
}

export function iconButtonStyle(): CSSProperties {
  return {
    minHeight: TOUCH,
    minWidth: TOUCH,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'transparent',
    border: 'none',
    borderRadius: tokens.radius.pill,
    color: tokens.color.muted,
    cursor: 'pointer',
  };
}
