import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCS_LANDING, localeHref } from '@/lib/docs/landing';
import { DOC_LOCALES, getDocBySlug } from '@/lib/docs/content';

/**
 * The docs landing page, per locale.
 *
 * Every page BEHIND the landing was already translated. The landing itself
 * was a hardcoded array of English strings inside `app/docs/page.tsx`, so
 * `/docs/zh` had nothing to render and redirected straight past the front
 * door into a quickstart — the reader never saw the page that says what the
 * documentation contains.
 */

const LOCALES = ['en', ...DOC_LOCALES] as const;

describe('every locale has a complete landing', () => {
  it.each(LOCALES)('%s has hero copy, sections and popular links', (l) => {
    const c = DOCS_LANDING[l];
    expect(c.heroTitle).toBeTruthy();
    expect(c.heroBody).toBeTruthy();
    expect(c.sections.length).toBeGreaterThan(0);
    expect(c.popular.length).toBeGreaterThan(0);
  });

  it('the translations cover exactly the same sections and links as English', () => {
    // The failure this guards is a section added to the landing in English
    // and quietly missing from the Chinese one — which is how the landing
    // came to be untranslated in the first place.
    const en = DOCS_LANDING.en;
    for (const l of DOC_LOCALES) {
      const other = DOCS_LANDING[l];
      expect(other.sections.map((s) => s.path)).toEqual(en.sections.map((s) => s.path));
      expect(other.popular.map((p) => p.path)).toEqual(en.popular.map((p) => p.path));
      expect(other.sections.map((s) => s.icon)).toEqual(en.sections.map((s) => s.icon));
    }
  });

  it('nothing in a translated landing is still English', () => {
    // Not a spot-check of one string: every user-visible field. A landing
    // that is half translated reads worse than one that is not translated.
    for (const l of DOC_LOCALES) {
      const en = DOCS_LANDING.en;
      const other = DOCS_LANDING[l];
      const pairs: [string, string][] = [
        [en.heroTitle, other.heroTitle],
        [en.heroBody, other.heroBody],
        [en.popularLabel, other.popularLabel],
        [en.explore, other.explore],
        ...en.sections.map((s, i) => [s.title, other.sections[i].title] as [string, string]),
        ...en.sections.map((s, i) => [s.description, other.sections[i].description] as [string, string]),
        ...en.popular.map((p, i) => [p.label, other.popular[i].label] as [string, string]),
      ];
      for (const [a, b] of pairs) {
        expect(b, `still English in ${l}: "${a}"`).not.toBe(a);
      }
    }
  });
});

describe('the links go somewhere', () => {
  it('every landing link resolves to a real doc in that locale', () => {
    // A translated landing that links into the English tree, or at a page
    // that has no translation, is a dead end dressed up as navigation.
    for (const l of LOCALES) {
      for (const path of [...DOCS_LANDING[l].sections.map((s) => s.path), ...DOCS_LANDING[l].popular.map((p) => p.path)]) {
        const slug = l === 'en' ? path.split('/') : [l, ...path.split('/')];
        expect(getDocBySlug(slug), `${l}: ${path}`).toBeTruthy();
      }
    }
  });

  it('localeHref keeps a translated landing inside its own tree', () => {
    expect(localeHref('en', 'setup/quickstart')).toBe('/docs/setup/quickstart');
    expect(localeHref('zh', 'setup/quickstart')).toBe('/docs/zh/setup/quickstart');
  });
});

describe('the route actually renders it', () => {
  it('/docs/zh renders the landing instead of redirecting past it', () => {
    // Asserted on the source: the bare-locale branch used to call
    // `redirect(docHref(first.slug))`, which is indistinguishable from a
    // working landing unless you look at where the reader ends up.
    const src = readFileSync(
      join(__dirname, '..', '..', 'app', 'docs', '[...slug]', 'page.tsx'), 'utf8',
    );
    const branch = src.slice(src.indexOf('if (bare.length === 0)'), src.indexOf('// A section directory'));
    expect(branch).toContain('DocsLanding');
    expect(branch).not.toMatch(/redirect\(docHref/);
  });

  it('both landings come from one component, not a translated copy', () => {
    const en = readFileSync(join(__dirname, '..', '..', 'app', 'docs', 'page.tsx'), 'utf8');
    expect(en).toContain('DocsLanding');
    // The English page used to carry the section array inline; a copy of it
    // is what a second landing would have become.
    expect(en).not.toContain('const sections');
  });
});
