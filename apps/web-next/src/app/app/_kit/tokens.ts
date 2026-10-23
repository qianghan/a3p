/**
 * Design tokens for the /app PWA.
 *
 * The shell's CSS variables hold bare HSL TRIPLETS ("166 70% 42%"), not
 * colours — see packages/theme/src/shell-variables.css. Every colour here is
 * therefore wrapped in hsl(var(--x)). The pre-redesign pages wrote
 * `var(--primary, #10b981)`: that resolves to the triplet, is invalid as a
 * colour, and silently fell back — the active tab was never actually green.
 *
 * Light and dark both work because the same variable names are redefined under
 * `.dark`; kit-tokens.test.tsx asserts every variable used here exists in both.
 */
/**
 * Mobile-scoped contrast adjustments (the shell variables are shared with the
 * desktop and must not move). Mixing in sRGB toward a theme colour that is
 * already high-contrast works in both themes: darker in light, lighter in dark.
 * Ratios are asserted in kit-contrast.test.ts.
 */
export const MUTED_MIX_PCT = 20;
export const PRIMARY_STRONG_BLACK_PCT = 32;

const v = (name: string, alpha?: number): string =>
  alpha === undefined ? `hsl(var(--${name}))` : `hsl(var(--${name}) / ${alpha})`;

export const tokens = {
  color: {
    bg: v('background'),
    fg: v('foreground'),
    card: v('card'),
    cardFg: v('card-foreground'),
    border: v('border'),
    primary: v('primary'),
    primaryFg: v('primary-foreground'),
    primarySoft: v('primary', 0.12),
    primaryGlow: v('primary', 0.35),
    /** Secondary text: --muted-foreground nudged toward --foreground so it clears 4.5:1 on card and muted surfaces. */
    muted: `color-mix(in srgb, hsl(var(--muted-foreground)) ${100 - MUTED_MIX_PCT}%, hsl(var(--foreground)) ${MUTED_MIX_PCT}%)`,
    /** Fill behind white text (primary buttons): --primary darkened so white on it is >= 4.5:1 in both themes. */
    primaryStrong: `color-mix(in srgb, hsl(var(--primary)) ${100 - PRIMARY_STRONG_BLACK_PCT}%, black ${PRIMARY_STRONG_BLACK_PCT}%)`,
    mutedBg: v('muted'),
    good: v('success'),
    goodSoft: v('success', 0.12),
    warn: v('warning'),
    warnSoft: v('warning', 0.14),
    critical: v('error'),
    criticalSoft: v('error', 0.12),
    /** Modal backdrop. Fixed black in both themes: a scrim must darken. */
    scrim: 'hsl(0 0% 0% / 0.5)',
  },
  radius: { sm: 8, md: 12, lg: 16, pill: 999 },
  space: { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 },
  font: { xs: 11, sm: 13, md: 15, lg: 17, xl: 22, kpi: 22 },
  touch: 44,
  tabBarHeight: 64,
} as const;

/** Minimum interactive target, CSS px (spec §3.6). */
export const TOUCH = tokens.touch;

export type Tone = 'neutral' | 'primary' | 'good' | 'warn' | 'critical';
export interface ToneColors {
  fg: string;
  bg: string;
  accent: string;
}

export function toneColors(tone: Tone): ToneColors {
  switch (tone) {
    case 'primary':
      return { fg: tokens.color.primary, bg: tokens.color.primarySoft, accent: tokens.color.primary };
    case 'good':
      return { fg: tokens.color.good, bg: tokens.color.goodSoft, accent: tokens.color.good };
    // Amber and red text on a light card fall below WCAG AA at body size, so
    // these tones keep the body colour for text and carry the colour in the
    // accent (border, dot, icon).
    case 'warn':
      return { fg: tokens.color.fg, bg: tokens.color.warnSoft, accent: tokens.color.warn };
    case 'critical':
      return { fg: tokens.color.fg, bg: tokens.color.criticalSoft, accent: tokens.color.critical };
    default:
      return { fg: tokens.color.muted, bg: tokens.color.mutedBg, accent: tokens.color.border };
  }
}

export function severityTone(severity: 'critical' | 'warn' | 'info'): Tone {
  if (severity === 'critical') return 'critical';
  if (severity === 'warn') return 'warn';
  return 'primary';
}
