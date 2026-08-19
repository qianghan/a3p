/**
 * Self-check for the CJK tofu detector used in i18n-language-switcher.spec.ts.
 *
 * The detector is a measurement heuristic, so it needs its own positive AND
 * negative case pinned down — otherwise it is an assertion nobody has ever seen
 * fail, which is how the first version of it shipped: it compared glyph WIDTHS,
 * and because CJK is full-width those are identical whether the font covers the
 * codepoint or not. That version would have failed on a healthy page while
 * claiming to detect missing fonts.
 *
 * This runs against a local data page, needs no credentials, and no server.
 */
import { test, expect } from '@playwright/test';

/** The detector, identical in shape to the one in the switcher spec. */
const INK = `(() => {
  const c = document.createElement('canvas');
  c.width = 40; c.height = 40;
  const g = c.getContext('2d');
  const count = (ch) => {
    g.clearRect(0, 0, 40, 40);
    g.fillStyle = '#000';
    g.font = '24px sans-serif';
    g.textBaseline = 'top';
    g.fillText(ch, 2, 2);
    const d = g.getImageData(0, 0, 40, 40).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 32) n++;
    return n;
  };
  return { dense: count('发'), sparse: count('一'), blank: count(' '),
           tofuA: count(''), tofuB: count('') };
})()`;

test('the ink detector separates real CJK glyphs from .notdef boxes', async ({ page }) => {
  await page.setContent('<body style="font:16px sans-serif">x</body>');
  const ink = await page.evaluate(INK);

  // Positive case: two structurally different CJK glyphs must rasterise to
  // different amounts of ink. This is what the switcher spec asserts.
  expect(ink.blank).toBe(0);
  expect(ink.dense).toBeGreaterThan(0);
  expect(ink.sparse).toBeGreaterThan(0);
  expect(ink.dense).not.toBe(ink.sparse);

  // Negative case: two DIFFERENT private-use codepoints, which no font covers,
  // rasterise to the SAME box. This is the signature the detector keys on, and
  // pinning it here is what makes the positive assertion meaningful rather than
  // merely true.
  expect(ink.tofuA).toBe(ink.tofuB);

  // And the two cases must actually be distinguishable, which is the whole
  // claim: real glyphs differ from each other, tofu does not.
  expect(ink.dense === ink.sparse).toBe(false);
  expect(ink.tofuA === ink.tofuB).toBe(true);
});

test('glyph WIDTH would not have worked — recorded so it is not retried', async ({ page }) => {
  await page.setContent('<body style="font:16px sans-serif">x</body>');
  const w = await page.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = '16px sans-serif';
    return { dense: ctx.measureText('发').width, sparse: ctx.measureText('一').width };
  });
  // Both are exactly 1em. Any detector built on width difference is broken in
  // the direction that fails healthy pages.
  expect(w.dense).toBe(w.sparse);
});
