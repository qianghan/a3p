import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MUTED_MIX_PCT, PRIMARY_STRONG_BLACK_PCT, PRIMARY_TEXT_FG_PCT, tokens } from '@/app/app/_kit/tokens';
import { DOT_KEYFRAMES } from '@/app/app/chat/_components/ChatParts';

type RGB = [number, number, number];
const css = readFileSync(resolve(__dirname, '../../../../../../packages/theme/src/shell-variables.css'), 'utf8');

function vars(block: string): Record<string, RGB> {
  const out: Record<string, RGB> = {};
  for (const m of block.matchAll(/--([a-z-]+):\s*(\d+)\s+(\d+)%\s+(\d+)%;/g)) out[m[1]] = hsl(+m[2], +m[3], +m[4]);
  return out;
}
function hsl(h: number, s: number, l: number): RGB {
  const sf = s / 100, lf = l / 100, a = sf * Math.min(lf, 1 - lf);
  const f = (n: number) => { const k = (n + h / 30) % 12; return lf - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}
const mix = (a: RGB, b: RGB, pctB: number): RGB => a.map((x, i) => x * (1 - pctB / 100) + b[i] * (pctB / 100)) as RGB;
const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: RGB, b: RGB) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

const darkAt = css.indexOf('\n.dark {');
const light = vars(css.slice(0, darkAt));
const dark = { ...light, ...vars(css.slice(darkAt)) };
const BLACK: RGB = [0, 0, 0];

describe('mobile contrast (WCAG AA 4.5:1)', () => {
  it('tokens emit the mixes the maths below assumes', () => {
    expect(tokens.color.muted).toContain(`${MUTED_MIX_PCT}%`);
    expect(tokens.color.primaryStrong).toContain(`black ${PRIMARY_STRONG_BLACK_PCT}%`);
    expect(tokens.color.primaryInk).toContain(`hsl(var(--foreground)) ${PRIMARY_TEXT_FG_PCT}%`);
  });

  for (const [name, th] of [['light', light], ['dark', dark]] as const) {
    it(`muted text clears 4.5:1 on background, card and muted surfaces (${name})`, () => {
      const fg = mix(th['muted-foreground'], th['foreground'], MUTED_MIX_PCT);
      for (const surface of ['background', 'card', 'muted']) expect(ratio(fg, th[surface])).toBeGreaterThanOrEqual(4.5);
    });
    // Measured on production by axe: the brand colour AS TEXT was 3.63:1 on the card (active tab label, 11px) and
    // 3.29:1 on its own 12% tint (info-tone banner title). Text uses primaryInk, not primary.
    it(`brand-coloured text (primaryInk) clears 4.5:1 on background, card and its own tint (${name})`, () => {
      const fg = mix(th['primary'], th['foreground'], PRIMARY_TEXT_FG_PCT);
      for (const surface of ['background', 'card']) expect(ratio(fg, th[surface])).toBeGreaterThanOrEqual(4.5);
      // primarySoft = --primary at 12% over the page background
      const tint = mix(th['background'], th['primary'], 12);
      expect(ratio(fg, tint)).toBeGreaterThanOrEqual(4.5);
      const tintOnCard = mix(th['card'], th['primary'], 12);
      expect(ratio(fg, tintOnCard)).toBeGreaterThanOrEqual(4.5);
    });
    it(`white text on the strong primary fill clears 4.5:1 (${name})`, () => {
      const fill = mix(th['primary'], BLACK, PRIMARY_STRONG_BLACK_PCT);
      expect(ratio(th['primary-foreground'], fill)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('the old values failed (documents the before numbers)', () => {
    expect(ratio(light['muted-foreground'], light['muted'])).toBeLessThan(4.5);
    expect(ratio(light['primary-foreground'], light['primary'])).toBeLessThan(4.5);
    expect(ratio(dark['primary-foreground'], dark['primary'])).toBeLessThan(4.5);
    expect(ratio(light['primary'], light['card'])).toBeLessThan(4.5); // brand text on the card (tab label)
    expect(ratio(light['primary'], mix(light['background'], light['primary'], 12))).toBeLessThan(4.5); // banner title
  });
});

describe('reduced motion', () => {
  it('typing-dot keyframes ship a prefers-reduced-motion rule that stops the animation', () => {
    expect(DOT_KEYFRAMES).toMatch(/@media \(prefers-reduced-motion: reduce\)\{\[data-chat-dot\]\{animation:none/);
  });
});
