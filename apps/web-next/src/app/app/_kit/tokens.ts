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
    muted: v('muted-foreground'),
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
