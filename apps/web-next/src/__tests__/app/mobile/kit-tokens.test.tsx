import React from 'react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { screen } from '@testing-library/react';
import { tokens, toneColors, severityTone, type Tone } from '@/app/app/_kit/tokens';
import { buttonStyle, iconButtonStyle } from '@/app/app/_kit/styles';
import { Money, moneyText } from '@/app/app/_kit/Money';
import { makeFormatters } from '@/app/app/_kit/format';
import { formatCurrencyCents } from '@/lib/jurisdiction-currency';
import { renderWithI18n, expectTokenOnly } from './test-utils';

const VARS_CSS = readFileSync(
  join(__dirname, '..', '..', '..', '..', '..', '..', 'packages', 'theme', 'src', 'shell-variables.css'),
  'utf8',
);

function declaredIn(selector: ':root' | '.dark'): Set<string> {
  const start = VARS_CSS.indexOf(`${selector} {`);
  const body = VARS_CSS.slice(start, VARS_CSS.indexOf('}', start));
  return new Set([...body.matchAll(/--([a-z-]+)\s*:/g)].map((m) => m[1]));
}

describe('tokens', () => {
  const colours = Object.entries(tokens.color);

  it('every colour is hsl(var(--x)) — the variables hold HSL triplets, not colours', () => {
    for (const [name, value] of colours) {
      if (name === 'scrim') continue;
      expect(value, name).toMatch(/^hsl\(var\(--[a-z-]+\)( \/ [\d.]+)?\)$/);
    }
    expect(tokens.color.scrim).toBe('hsl(0 0% 0% / 0.5)');
  });

  it('every variable a token reads is defined for BOTH the light and the dark theme', () => {
    const light = declaredIn(':root');
    const dark = declaredIn('.dark');
    expect(light.size).toBeGreaterThan(20);
    expect(dark.size).toBeGreaterThan(20);
    for (const [name, value] of colours) {
      const v = /var\(--([a-z-]+)\)/.exec(value)?.[1];
      if (!v) continue;
      expect(light.has(v), `${name}: --${v} missing from :root`).toBe(true);
      expect(dark.has(v), `${name}: --${v} missing from .dark`).toBe(true);
    }
  });

  it('semantic good/warn/critical are separate from the brand accent', () => {
    expect(tokens.color.good).not.toBe(tokens.color.primary);
    expect(new Set([tokens.color.good, tokens.color.warn, tokens.color.critical]).size).toBe(3);
  });

  it.each<Tone>(['neutral', 'primary', 'good', 'warn', 'critical'])('tone %s uses tokens only', (tone) => {
    const c = toneColors(tone);
    expectTokenOnly({ color: c.fg, background: c.bg, borderColor: c.accent });
  });

  it('warn and critical keep body text in the foreground colour (amber/red text fails AA)', () => {
    expect(toneColors('warn').fg).toBe(tokens.color.fg);
    expect(toneColors('critical').fg).toBe(tokens.color.fg);
    expect(toneColors('critical').accent).toBe(tokens.color.critical);
  });

  it('maps alert severity to a tone', () => {
    expect(severityTone('critical')).toBe('critical');
    expect(severityTone('warn')).toBe('warn');
    expect(severityTone('info')).toBe('primary');
  });
});

describe('button styles', () => {
  it.each(['primary', 'secondary', 'ghost'] as const)('%s is a 44px target drawn from tokens', (variant) => {
    const s = buttonStyle(variant);
    expect(s.minHeight).toBeGreaterThanOrEqual(44);
    expect(s.minWidth).toBeGreaterThanOrEqual(44);
    expectTokenOnly(s);
  });

  it('the icon button is a 44px target', () => {
    const s = iconButtonStyle();
    expect(s.minHeight).toBe(44);
    expect(s.minWidth).toBe(44);
    expectTokenOnly(s);
  });
});

describe('Money', () => {
  it.each([
    ['CAD', 'CA$1,800'],
    ['AUD', 'A$1,800'],
    ['USD', '$1,800'],
  ])('formats %s in the tenant currency', (currency, expected) => {
    renderWithI18n(<Money cents={180_000} currency={currency} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('follows the shell locale, not a hardcoded one', () => {
    const { container } = renderWithI18n(<Money cents={180_000} currency="CAD" />, 'fr-CA');
    // fr-CA groups with U+202F / U+00A0; getByText's matcher string is not
    // whitespace-normalised (the node text is), so compare textContent exactly.
    const expected = formatCurrencyCents(180_000, 'CAD', 'fr-CA');
    expect(expected).not.toBe(formatCurrencyCents(180_000, 'CAD', 'en'));
    expect(container.querySelector('[data-money="CAD"]')?.textContent).toBe(expected);
  });

  it('renders an unavailable figure as a labelled dash, never as zero', () => {
    renderWithI18n(<Money cents={null} currency="USD" />);
    const el = screen.getByLabelText('Not available');
    expect(el).toHaveTextContent('—');
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('signs positive amounts on request', () => {
    renderWithI18n(<Money cents={4_200} currency="USD" signed />);
    expect(screen.getByText('+$42')).toBeInTheDocument();
  });

  it('moneyText is the same formatter', () => {
    expect(moneyText(250_000, 'AUD', 'en')).toBe(formatCurrencyCents(250_000, 'AUD', 'en'));
  });
});

describe('formatters', () => {
  it('formats a time with hours and minutes', () => {
    expect(makeFormatters('en').time('2026-10-07T15:04:00.000Z')).toMatch(/\d{1,2}:\d{2}/);
  });

  it('formats a logical date without shifting it a day west of UTC', () => {
    expect(makeFormatters('en').dateOnly('2026-10-15')).toBe('Oct 15');
  });

  it('localises month names', () => {
    expect(makeFormatters('fr-CA').dateOnly('2026-10-15')).toMatch(/oct/i);
  });
});
