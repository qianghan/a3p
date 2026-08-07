import { describe, it, expect } from 'vitest';
import GithubSlugger from 'github-slugger';
import {
  extractHeadings,
  getNavigation,
  getSearchIndex,
  getPrevNext,
  getAllDocSlugs,
  localeOf,
  stripLocale,
  withLocale,
  hasTranslation,
  DOC_LOCALES,
} from '@/lib/docs/content';

/**
 * Chinese documentation.
 *
 * English lives at the root of the content tree and each translation in a
 * directory named for its locale, so /docs/setup/quickstart and
 * /docs/zh/setup/quickstart are the same page. Two things had to change for
 * that to work at all, and both were silent failures rather than errors.
 */

describe('table-of-contents ids survive a non-Latin script', () => {
  /**
   * The one that would have shipped unnoticed.
   *
   * extractHeadings built ids with `.replace(/[^a-z0-9]+/g, '-')`. For English
   * that agrees with rehype-slug by coincidence. For Chinese every character
   * is stripped, so EVERY heading on a translated page produced the empty
   * string: a table of contents where every link points at `#`, all of them
   * colliding, while the rendered DOM carried the real ids from github-slugger.
   *
   * The fix is to use that same slugger rather than a second implementation
   * that happens to agree on ASCII.
   */
  it('matches the slugger that actually puts ids in the DOM', () => {
    const headings = ['Getting started', '如何开始', '连接你的银行账户', '第 1 步：安装应用'];
    const md = headings.map((h) => `## ${h}`).join('\n\n');
    const fresh = new GithubSlugger();
    expect(extractHeadings(md).map((h) => h.id)).toEqual(headings.map((h) => fresh.slug(h)));
  });

  it('gives Chinese headings distinct, non-empty ids', () => {
    const ids = extractHeadings('## 如何开始\n\n## 连接银行\n\n## 常见问题').map((h) => h.id);
    expect(ids.every((id) => id.length > 0), `empty id in ${JSON.stringify(ids)}`).toBe(true);
    expect(new Set(ids).size, 'two headings share an anchor').toBe(ids.length);
  });

  it('still dedupes repeated headings, per page', () => {
    const ids = extractHeadings('## Notes\n\n## Notes').map((h) => h.id);
    expect(ids[0]).not.toBe(ids[1]);
    // A fresh slugger per call — otherwise page two starts at "notes-2".
    expect(extractHeadings('## Notes').map((h) => h.id)).toEqual(['notes']);
  });
});

describe('a locale directory is not a section', () => {
  it('maps slugs to locales', () => {
    expect(localeOf(['setup', 'quickstart'])).toBe('en');
    expect(localeOf(['zh', 'setup', 'quickstart'])).toBe('zh');
    expect(stripLocale(['zh', 'setup', 'quickstart'])).toEqual(['setup', 'quickstart']);
    expect(withLocale(['setup', 'quickstart'], 'zh')).toEqual(['zh', 'setup', 'quickstart']);
    expect(withLocale(['zh', 'setup', 'quickstart'], 'en')).toEqual(['setup', 'quickstart']);
  });

  it('round-trips through both locales', () => {
    const en = ['working', 'invoices'];
    expect(withLocale(withLocale(en, 'zh'), 'en')).toEqual(en);
  });

  it('keeps "zh" out of the English sidebar', () => {
    // Without a locale filter, getNavigation groups on slug[0] and the
    // translation directory becomes a section called "zh" full of Chinese
    // pages, sitting in the English nav.
    const titles = getNavigation('en').map((s) => s.title);
    expect(titles).not.toContain('zh');
    for (const section of getNavigation('en')) {
      for (const item of section.items) {
        expect(item.href, `English nav links into a translation: ${item.href}`)
          .not.toMatch(/^\/docs\/zh\//);
      }
    }
  });

  it('the Chinese sidebar links only to Chinese pages', () => {
    const nav = getNavigation('zh');
    expect(nav.length, 'no Chinese docs found').toBeGreaterThan(0);
    for (const section of nav) {
      expect(section.items.length).toBeGreaterThan(0);
      for (const item of section.items) {
        expect(item.href).toMatch(/^\/docs\/zh\//);
      }
    }
  });

  it('labels the Chinese sections in Chinese', () => {
    const titles = getNavigation('zh').map((s) => s.title).join(' ');
    expect(titles).toMatch(/[一-鿿]/);
    expect(titles).not.toMatch(/Set up|Troubleshooting/);
  });
});

describe('the two trees stay in step', () => {
  // `regions/canada.fr` is the pre-existing French one-off — a locale baked
  // into the FILENAME, which is why it reads as an English-tree page here. It
  // is not an English page and does not need a Chinese twin; excluding it is
  // narrower than migrating it, which would change a live URL.
  const bare = (l: 'en' | 'zh') =>
    getAllDocSlugs()
      .filter((s) => localeOf(s) === l)
      .map((s) => stripLocale(s).join('/'))
      .filter((p) => !/\.[a-z]{2}$/.test(p))
      .sort();

  it('every English page has a Chinese counterpart', () => {
    // A half-translated guide is the failure mode users actually hit: they
    // follow the sidebar and fall off a cliff into English.
    const missing = bare('en').filter((p) => !bare('zh').includes(p));
    expect(missing, `not translated: ${missing.join(', ')}`).toEqual([]);
  });

  it('no orphan translations', () => {
    const orphans = bare('zh').filter((p) => !bare('en').includes(p));
    expect(orphans, `Chinese page with no English original: ${orphans.join(', ')}`).toEqual([]);
  });

  it('hasTranslation agrees with the tree', () => {
    const anyEn = getAllDocSlugs().find((s) => localeOf(s) === 'en')!;
    expect(hasTranslation(anyEn, 'zh')).toBe(true);
    expect(hasTranslation(['setup', 'no-such-page'], 'zh')).toBe(false);
  });
});

describe('navigation does not leak across locales', () => {
  it('prev/next stays inside the reader\'s language', () => {
    const zh = getAllDocSlugs().filter((s) => localeOf(s) === 'zh');
    expect(zh.length).toBeGreaterThan(1);
    for (const slug of zh) {
      const { prev, next } = getPrevNext(slug);
      for (const link of [prev, next]) {
        if (link) expect(link.href, `paged out of zh from ${slug.join('/')}`).toMatch(/^\/docs\/zh\//);
      }
    }
  });

  it('search is scoped to one locale', () => {
    expect(getSearchIndex('en').every((e) => !e.href.startsWith('/docs/zh/'))).toBe(true);
    const zh = getSearchIndex('zh');
    expect(zh.length).toBeGreaterThan(0);
    expect(zh.every((e) => e.href.startsWith('/docs/zh/'))).toBe(true);
  });

  it('declares the locales it supports', () => {
    expect(DOC_LOCALES).toContain('zh');
  });
});
