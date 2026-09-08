import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The landing page's font payload, guarded.
 *
 * Measured on production before these were fixed: `/` fetched seven woff2
 * files totalling 501 kB, every one with initiatorType "link" — meaning the
 * browser was told to fetch all seven up front, whether or not a glyph needed
 * them. Two were dead weight (87 kB): Inter, and a second copy of JetBrains
 * Mono. Both came from the ROOT layout, which puts its fonts in the preload
 * manifest for every route including the one marketing page that renders
 * neither. Afterwards: five files, 419 kB.
 *
 * These are source-level assertions rather than build assertions on purpose —
 * a `next build` takes minutes and needs a full environment, so a unit test is
 * the only guard that runs on every PR. Both facts are one-line edits away
 * from being undone by someone who has no reason to know what they cost.
 */

const src = (p: string) => readFileSync(join(__dirname, '..', p), 'utf8');

/** Drop comments so a rule can't be satisfied by prose describing it. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('root layout fonts', () => {
  const layout = stripComments(src('app/layout.tsx'));

  // Both families are declared here, so Next preloads them on EVERY route.
  // The landing page renders neither. Without `preload: false` that is 87 kB
  // fetched before anything else on the first page a visitor ever sees.
  it.each(['Inter', 'JetBrains_Mono'])('%s opts out of preload', (family) => {
    const call = layout.match(new RegExp(`${family}\\(\\{([^}]*)\\}\\)`));
    expect(call, `${family}() call not found in app/layout.tsx`).not.toBeNull();
    expect(call![1]).toMatch(/preload:\s*false/);
  });
});

describe('landing page fonts', () => {
  const page = stripComments(src('app/page.tsx'));

  // Newsreader and JetBrains Mono are variable fonts: one file spans the whole
  // weight axis, so a discrete list saves no bytes. It does two harmful
  // things. It caps the usable range — with ['400','500'] a later
  // `font-semibold` snaps back to 500 instead of rendering at 600. And it made
  // this page's JetBrains declaration DIFFER from the root layout's, so
  // next/font emitted two files for the same family; matching them collapsed
  // 31 kB. Fraunces is already 'variable' because `axes` requires it.
  it.each(['Fraunces', 'Newsreader', 'JetBrains_Mono'])(
    "%s declares weight: 'variable'",
    (family) => {
      const call = page.match(new RegExp(`${family}\\(\\{([^}]*)\\}\\)`));
      expect(call, `${family}() call not found in app/page.tsx`).not.toBeNull();
      expect(call![1]).toMatch(/weight:\s*'variable'/);
    },
  );

  // Italic is a genuinely separate file for both text faces, and both are used
  // here. This asserts the styles that are PAID FOR are the styles declared —
  // adding a third style, or a fourth family, is a payload change that should
  // be a deliberate edit to this list.
  it('loads exactly the three families the page renders', () => {
    const families = [...page.matchAll(/([A-Z][A-Za-z_]+)\(\{[^}]*subsets:/g)].map((m) => m[1]);
    expect(new Set(families)).toEqual(new Set(['Fraunces', 'Newsreader', 'JetBrains_Mono']));
  });
});
