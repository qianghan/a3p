import fs from 'fs';
import path from 'path';
import GithubSlugger from 'github-slugger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DocFrontmatter {
  title: string;
  description: string;
  order?: number;
  section?: string;
  icon?: string;
}

export interface DocPage {
  slug: string[];
  frontmatter: DocFrontmatter;
  content: string;
}

export interface NavItem {
  title: string;
  href: string;
  order: number;
  icon?: string;
  children?: NavItem[];
}

export interface NavSection {
  title: string;
  order: number;
  icon?: string;
  items: NavItem[];
}

export interface SearchEntry {
  title: string;
  description: string;
  href: string;
  section: string;
}

export interface TocHeading {
  id: string;
  text: string;
  level: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTENT_DIR = path.join(process.cwd(), 'src/content/docs');

/**
 * Documentation locales.
 *
 * English lives at the root of the content tree and every other locale in a
 * directory named for it, so `/docs/setup/quickstart` and
 * `/docs/zh/setup/quickstart` are the same page. A locale directory is NOT a
 * section — see sectionKeyOf.
 *
 * The existing `regions/canada.fr.mdx` predates this and is a one-off: a
 * filename suffix that becomes its own slug and its own sidebar entry, linked
 * by hand from the English page. That does not generalise to 25 pages, which
 * is why translations get a directory rather than a suffix.
 */
export const DOC_LOCALES = ['zh'] as const;
export type DocLocale = 'en' | (typeof DOC_LOCALES)[number];

/** Which locale a slug belongs to. A leading locale segment decides it. */
export function localeOf(slug: string[]): DocLocale {
  const head = slug[0];
  return (DOC_LOCALES as readonly string[]).includes(head) ? (head as DocLocale) : 'en';
}

/** The slug with any locale prefix removed — the page's identity across locales. */
export function stripLocale(slug: string[]): string[] {
  return localeOf(slug) === 'en' ? slug : slug.slice(1);
}

/** The same page in another locale. Does not check that it exists. */
export function withLocale(slug: string[], locale: DocLocale): string[] {
  const bare = stripLocale(slug);
  return locale === 'en' ? bare : [locale, ...bare];
}

/** Href for a slug, locale prefix included. */
export function docHref(slug: string[]): string {
  return `/docs/${slug.join('/')}`;
}

/** The section a doc belongs to, ignoring any locale prefix. */
function sectionKeyOf(slug: string[]): string {
  return stripLocale(slug)[0];
}

const SECTION_META: Record<string, { title: string; order: number; icon: string }> = {
  setup: { title: 'Set up', order: 1, icon: 'Rocket' },
  configure: { title: 'Configure', order: 2, icon: 'Settings' },
  working: { title: 'Working day-to-day', order: 3, icon: 'Sparkles' },
  regions: { title: 'Regions & taxes', order: 4, icon: 'Map' },
  troubleshooting: { title: 'Troubleshooting', order: 5, icon: 'LifeBuoy' },
};

/**
 * Section labels per locale. ONLY the label is translated — the key, the order
 * and the icon stay shared, so the two sidebars are structurally identical and
 * a section cannot appear in one language but silently not the other.
 */
const SECTION_TITLES: Record<DocLocale, Record<string, string>> = {
  en: {}, // falls back to SECTION_META
  zh: {
    setup: '开始设置',
    configure: '配置',
    working: '日常使用',
    regions: '国家与税务',
    troubleshooting: '疑难解答',
  },
};

/** Display name for a section key in a locale. Used by the breadcrumb. */
export function sectionLabel(key: string, locale: DocLocale = 'en'): string {
  return sectionMetaFor(key, locale).title;
}

function sectionMetaFor(key: string, locale: DocLocale) {
  const base = SECTION_META[key] || { title: key, order: 99, icon: 'File' };
  return { ...base, title: SECTION_TITLES[locale]?.[key] ?? base.title };
}

// ---------------------------------------------------------------------------
// Frontmatter parser (simple, no extra deps)
// ---------------------------------------------------------------------------

function parseFrontmatter(raw: string): { frontmatter: DocFrontmatter; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return {
      frontmatter: { title: 'Untitled', description: '' },
      content: raw,
    };
  }

  const yamlBlock = match[1];
  const content = raw.slice(match[0].length).trim();
  const frontmatter: Record<string, unknown> = {};

  for (const line of yamlBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value: string | number = line.slice(colonIdx + 1).trim();
    // Remove surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Parse numbers
    if (/^\d+$/.test(value)) {
      value = parseInt(value, 10);
    }
    frontmatter[key] = value;
  }

  return {
    frontmatter: {
      title: (frontmatter.title as string) || 'Untitled',
      description: (frontmatter.description as string) || '',
      order: frontmatter.order as number | undefined,
      section: frontmatter.section as string | undefined,
      icon: frontmatter.icon as string | undefined,
    },
    content,
  };
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

function getMdxFiles(dir: string, basePath: string[] = []): { slug: string[]; filePath: string }[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const results: { slug: string[]; filePath: string }[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      results.push(...getMdxFiles(path.join(dir, entry.name), [...basePath, entry.name]));
    } else if (entry.name.endsWith('.mdx')) {
      const name = entry.name.replace(/\.mdx$/, '');
      results.push({
        slug: [...basePath, name],
        filePath: path.join(dir, entry.name),
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get a single doc page by its slug segments */
export function getDocBySlug(slug: string[]): DocPage | null {
  const filePath = path.join(CONTENT_DIR, ...slug) + '.mdx';

  if (!fs.existsSync(filePath)) return null;

  const raw = fs.readFileSync(filePath, 'utf-8');
  const { frontmatter, content } = parseFrontmatter(raw);

  return { slug, frontmatter, content };
}

/** Get all doc pages */
export function getAllDocs(): DocPage[] {
  const files = getMdxFiles(CONTENT_DIR);

  return files.map(({ slug, filePath }) => {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(raw);
    return { slug, frontmatter, content };
  });
}

/** Get all slug params for generateStaticParams */
export function getAllDocSlugs(): string[][] {
  const files = getMdxFiles(CONTENT_DIR);
  return files.map(f => f.slug);
}

/** Build navigation tree grouped by section */
export function getNavigation(locale: DocLocale = 'en'): NavSection[] {
  // Filtering by locale is what stops `zh` showing up as a sixth section in
  // the English sidebar, and what stops the Chinese sidebar linking to
  // English pages.
  const docs = getAllDocs().filter((d) => localeOf(d.slug) === locale);
  const sectionMap = new Map<string, NavItem[]>();

  for (const doc of docs) {
    const sectionKey = sectionKeyOf(doc.slug);
    if (!sectionMap.has(sectionKey)) {
      sectionMap.set(sectionKey, []);
    }

    sectionMap.get(sectionKey)!.push({
      title: doc.frontmatter.title,
      href: docHref(doc.slug),
      order: doc.frontmatter.order ?? 99,
      icon: doc.frontmatter.icon,
    });
  }

  const sections: NavSection[] = [];

  for (const [key, items] of sectionMap) {
    const meta = sectionMetaFor(key, locale);
    sections.push({
      title: meta.title,
      order: meta.order,
      icon: meta.icon,
      items: items.sort((a, b) => a.order - b.order),
    });
  }

  return sections.sort((a, b) => a.order - b.order);
}

/** Does this page exist in the given locale? Drives the language switcher. */
export function hasTranslation(slug: string[], locale: DocLocale): boolean {
  return getDocBySlug(withLocale(slug, locale)) !== null;
}

/** Get the first doc in a section (for section-level redirects) */
export function getFirstDocInSection(sectionKey: string, locale: DocLocale = 'en'): DocPage | null {
  const prefix = locale === 'en' ? [] : [locale];
  const sectionDir = path.join(CONTENT_DIR, ...prefix, sectionKey);
  if (!fs.existsSync(sectionDir) || !fs.statSync(sectionDir).isDirectory()) return null;

  const files = getMdxFiles(sectionDir, [...prefix, sectionKey]);
  if (files.length === 0) return null;

  // Sort by frontmatter order, return the first
  const docs = files.map(({ slug, filePath }) => {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, content } = parseFrontmatter(raw);
    return { slug, frontmatter, content };
  });

  docs.sort((a, b) => (a.frontmatter.order ?? 99) - (b.frontmatter.order ?? 99));
  return docs[0];
}

/** Build flat search index */
export function getSearchIndex(locale: DocLocale = 'en'): SearchEntry[] {
  // Scoped to one locale: a reader searching the Chinese docs should not get
  // English results they cannot read, and vice versa.
  const docs = getAllDocs().filter((d) => localeOf(d.slug) === locale);

  return docs.map(doc => {
    const sectionKey = sectionKeyOf(doc.slug);
    return {
      title: doc.frontmatter.title,
      description: doc.frontmatter.description,
      href: docHref(doc.slug),
      section: sectionMetaFor(sectionKey, locale).title,
    };
  });
}

/**
 * Extract headings from MDX content for the table of contents.
 *
 * Uses github-slugger — the SAME slugger rehype-slug uses to put ids on the
 * rendered headings. It used to hand-roll `[^a-z0-9]+`, which is fine for
 * English and silently fatal for anything else: every Chinese heading
 * stripped to the empty string, so a translated page got a table of contents
 * where every entry linked to `#` and collided with the others, while the DOM
 * carried the real ids (如何开始). One slugger means the two cannot disagree.
 *
 * A fresh instance per call, because the slugger dedupes across a document
 * (`x`, `x-1`, `x-2`) and that counter has to start clean for each page.
 */
export function extractHeadings(content: string): TocHeading[] {
  const headingRegex = /^(#{2,4})\s+(.+)$/gm;
  const headings: TocHeading[] = [];
  const slugger = new GithubSlugger();
  let match;

  while ((match = headingRegex.exec(content)) !== null) {
    const level = match[1].length;
    const text = match[2].trim();
    headings.push({ id: slugger.slug(text), text, level });
  }

  return headings;
}

/** Get prev/next pages relative to current slug */
export function getPrevNext(currentSlug: string[]): { prev: NavItem | null; next: NavItem | null } {
  // Within the reader's own locale. Paging off the end of the Chinese docs
  // into an English page would be a worse bug than having no next link.
  const nav = getNavigation(localeOf(currentSlug));
  const allItems: NavItem[] = [];

  for (const section of nav) {
    for (const item of section.items) {
      allItems.push(item);
    }
  }

  const currentHref = docHref(currentSlug);
  const currentIndex = allItems.findIndex(item => item.href === currentHref);

  return {
    prev: currentIndex > 0 ? allItems[currentIndex - 1] : null,
    next: currentIndex < allItems.length - 1 ? allItems[currentIndex + 1] : null,
  };
}
