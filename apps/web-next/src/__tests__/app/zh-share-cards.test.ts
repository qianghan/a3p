import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Chinese share cards.
 *
 * The partner materials page was translated except for the thing a partner
 * actually posts. It carried an honest note saying so — "卡片图片本身目前是
 * 英文的" — which is better than pretending, and still leaves a Chinese
 * partner with nothing to share.
 *
 * The risk in a translated SVG is not the translation. It is that a CJK glyph
 * is roughly twice the advance width of a Latin one at the same font-size, so
 * copy that fits in English silently runs off the 1200px canvas. Nothing
 * throws; the card is just cut in half. So these check geometry, not wording.
 */

const CARDS_DIR = join(__dirname, '..', '..', '..', 'public', 'guides', 'cards');
const ZH_DIR = join(CARDS_DIR, 'zh');
const CANVAS = 1200;
const MARGIN = 80; // the x= every text element starts at

const cards = readdirSync(ZH_DIR).filter((f) => f.endsWith('.svg'));

/**
 * Advance width.
 *
 * The CJK half is EXACT, not an estimate: a CJK glyph occupies a full em
 * square by definition, so a line of n Han characters at f px is n × f px
 * wide in any font. That is what makes this guard trustworthy for these
 * cards, where the copy is almost entirely CJK.
 *
 * The Latin coefficient is a deliberately generous 0.55em, and this is why
 * the check is applied ONLY to the Chinese set. Measured against a rendered
 * English card, the real average for this typeface is closer to 0.41em, so
 * the same estimator declares every English sub-line an overflow when none
 * of them is. An approximation that fails on known-good content is not a
 * guard, so it is not pointed at that content.
 */
function estimateWidth(text: string, fontSize: number): number {
  let em = 0;
  for (const ch of text) {
    em += /[　-鿿＀-￯]/.test(ch) ? 1 : 0.55;
  }
  return em * fontSize;
}

describe('a Chinese card exists for every English one', () => {
  it('the two sets match, file for file', () => {
    const en = readdirSync(CARDS_DIR).filter((f) => f.endsWith('.svg')).sort();
    expect(cards.slice().sort()).toEqual(en);
  });
});

describe('the text fits on the canvas', () => {
  // The failure being caught: a CJK glyph is roughly twice the advance width
  // of a Latin one, so copy translated line-for-line runs off the card.
  // Nothing throws — the headline is just cut in half in every share.
  it.each(cards)('%s stays inside 1200px', (file) => {
    const svg = readFileSync(join(ZH_DIR, file), 'utf8');
    const texts = [...svg.matchAll(/<text[^>]*font-size="(\d+)"[^>]*>(.*?)<\/text>/gs)];
    expect(texts.length).toBeGreaterThan(0);
    for (const [, size, body] of texts) {
      const plain = body.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
      const width = estimateWidth(plain, Number(size));
      expect(
        MARGIN + width,
        `overflows: "${plain}" at ${size}px ≈ ${Math.round(width)}px wide`,
      ).toBeLessThanOrEqual(CANVAS);
    }
  });
});

describe('the cards are actually in Chinese', () => {
  it.each(cards)('%s has CJK copy and no leftover English headline', (file) => {
    const zh = readFileSync(join(ZH_DIR, file), 'utf8');
    const en = readFileSync(join(CARDS_DIR, file), 'utf8');
    const body = (s: string) => [...s.matchAll(/<text[^>]*>(.*?)<\/text>/gs)]
      .map((m) => m[1].replace(/<[^>]*>/g, '').trim());

    const zhText = body(zh);
    const enText = body(en);
    // The wordmark and the URL are the same in both by design — a locale does
    // not rename the product or move the domain.
    const translated = zhText.filter((_, i) => i !== 0 && i !== zhText.length - 1);
    const original = enText.filter((_, i) => i !== 0 && i !== enText.length - 1);
    for (const line of translated) {
      expect(line, `not translated in ${file}: "${line}"`).not.toBe('');
      expect(/[一-鿿]/.test(line), `no CJK in "${line}"`).toBe(true);
      expect(original, `English copy left in ${file}: "${line}"`).not.toContain(line);
    }
    expect(zhText[0]).toBe(enText[0]);
    expect(zhText[zhText.length - 1]).toBe(enText[enText.length - 1]);
  });

  it.each(cards)('%s declares a CJK-capable font stack', (file) => {
    // Without one, the glyphs fall back to whatever the viewer happens to
    // have — which on a share asset means a different card per reader.
    const svg = readFileSync(join(ZH_DIR, file), 'utf8');
    expect(svg).toMatch(/PingFang SC|Noto Sans CJK SC|Microsoft YaHei/);
  });
});

describe('the pages point at their own set', () => {
  const page = (p: string) => readFileSync(join(__dirname, '..', '..', 'app', 'guides', p, 'sales-rep', 'materials', 'page.tsx'), 'utf8');

  it('the Chinese page serves the Chinese cards, and no longer apologises', () => {
    const src = page('zh');
    expect(src).toContain('/guides/cards/zh/');
    // The note that the images were English has to go with the images.
    expect(src).not.toContain('卡片图片本身目前是英文的');
  });

  it('the English page still serves the English cards', () => {
    const src = page('.');
    expect(src).toContain('/guides/cards/${c.file}.svg');
    expect(src).not.toContain('/guides/cards/zh/');
  });

  it('neither page hand-rolls its own language cross-link', () => {
    // GuidesChrome already renders a 中文 / English toggle on every guide,
    // resolved through guidesCounterpart. A second, hand-written one on this
    // page only is an inconsistency — and on the English side it is one more
    // hardcoded user-facing string for the i18n ratchet to carry, which is
    // how CI caught it.
    expect(page('zh')).not.toContain('英文版素材');
    expect(page('.')).not.toContain('Chinese set');
  });
});
