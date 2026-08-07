import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';
import { getDocBySlug, getAllDocSlugs, getNavigation, extractHeadings, getPrevNext, getFirstDocInSection, localeOf, stripLocale, withLocale, docHref, hasTranslation, sectionLabel, DOC_LOCALES } from '@/lib/docs/content';
import { DocsSidebar } from '@/components/docs/docs-sidebar';
import { DocsLanguageSwitcher } from '@/components/docs/docs-language-switcher';
import { DOCS_UI } from '@/lib/docs/ui-strings';
import { MobileDocsSidebar } from '@/components/docs/mobile-docs-sidebar';
import { getMdxComponents } from '@/components/docs/mdx-components';
import { DocPageClient } from './doc-page-client';

export async function generateStaticParams() {
  const slugs = getAllDocSlugs();
  // Include section-level paths (e.g. ['getting-started']) so redirects are pre-rendered
  // Section paths are per-locale: /docs/setup AND /docs/zh/setup both redirect
  // to their own first page. Keying on slug[0] alone would emit /docs/zh as a
  // "section" and no Chinese section paths at all.
  const sectionSlugs = new Set<string>();
  for (const s of slugs) {
    const locale = localeOf(s);
    const bare = stripLocale(s);
    sectionSlugs.add(JSON.stringify(locale === 'en' ? [bare[0]] : [locale, bare[0]]));
    if (locale !== 'en') sectionSlugs.add(JSON.stringify([locale]));
  }
  return [
    ...slugs.map((slug) => ({ slug })),
    ...[...sectionSlugs].map((j) => ({ slug: JSON.parse(j) as string[] })),
  ];
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);
  if (!doc) {
    // Section-level slug that resolves to a real section — redirect will
    // fire from the page, so use the section name as the title.
    if (slug.length === 1 && getFirstDocInSection(slug[0])) {
      const label = slug[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      return { title: `${label} - AgentBook Docs` };
    }
    return { title: 'Not Found' };
  }

  return {
    title: `${doc.frontmatter.title} - AgentBook Docs`,
    description: doc.frontmatter.description,
  };
}

export default async function DocPage({ params }: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await params;
  const doc = getDocBySlug(slug);

  if (!doc) {
    const locale = localeOf(slug);
    const bare = stripLocale(slug);

    // A bare locale segment (/docs/zh) is the translated docs home. Send it to
    // that locale's first page rather than 404ing on a URL we generate links to.
    if (bare.length === 0) {
      const first = getFirstDocInSection('setup', locale) ?? getFirstDocInSection('configure', locale);
      if (first) redirect(docHref(first.slug));
      notFound();
    }

    // A section directory, in whichever locale — redirect to its first page.
    if (bare.length === 1) {
      const firstDoc = getFirstDocInSection(bare[0], locale);
      if (firstDoc) {
        redirect(docHref(firstDoc.slug));
      }
      // A single-segment slug that isn't a known section either (e.g. a
      // mistyped URL) — show the docs 404 boundary. Routing this through
      // redirect() instead (like the multi-segment branch below) hits a
      // production-only bug where an on-demand-rendered single-segment
      // catch-all path 500s instead of redirecting.
      notFound();
    }
    // Unknown/removed multi-segment doc (e.g. old NaaP dev-doc URLs after
    // the rewrite): send readers to the help-center home instead of a dead end.
    redirect('/docs');
  }

  // Loaded lazily, only once a real doc is confirmed to exist. Output file
  // tracing doesn't reliably bundle this pure-ESM package for this route's
  // on-demand (non-statically-generated) render path — a static top-level
  // import would throw ERR_MODULE_NOT_FOUND for *every* request that falls
  // through to this function, including the redirect/notFound branches above
  // that never need it at all (this is exactly what caused unmatched
  // single-segment URLs to 500 instead of redirecting/404ing).
  const { MDXRemote } = await import('next-mdx-remote/rsc');

  const locale = localeOf(slug);
  const ui = DOCS_UI[locale];
  const navigation = getNavigation(locale);
  const headings = extractHeadings(doc.content);
  const { prev, next } = getPrevNext(slug);
  // Offered only where the counterpart actually exists — a switcher that lands
  // the reader on a 404 is worse than no switcher.
  const otherLocale = locale === 'en' ? (DOC_LOCALES[0] as 'zh') : 'en';
  const translationHref = hasTranslation(slug, otherLocale)
    ? docHref(withLocale(slug, otherLocale))
    : null;
  const components = getMdxComponents();

  return (
    <div className="flex">
      <MobileDocsSidebar navigation={navigation} />
      {/* Sidebar */}
      <aside className="hidden lg:block w-64 shrink-0 border-r border-border">
        <div className="sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto py-6 px-4">
          <DocsSidebar navigation={navigation} />
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0">
        <div className="flex">
          {/* Article */}
          <article className="flex-1 min-w-0 px-6 lg:px-10 py-10 max-w-3xl">
            {/* Breadcrumb + language */}
            <div className="flex items-center justify-between gap-4 mb-6">
              <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
                <Link
                  href={locale === 'en' ? '/docs' : `/docs/${locale}`}
                  className="hover:text-foreground transition-colors shrink-0"
                >
                  {ui.home}
                </Link>
                {/* Locale-stripped: the crumb read "Zh / Setup / Quickstart"
                    otherwise, exposing a routing detail as a section name. */}
                {stripLocale(slug).map((segment, i, arr) => {
                  const last = i === arr.length - 1;
                  // Crumbs come from the URL, which is English by design. On a
                  // translated page show the reader words they can read: the
                  // section's own label, and the page's own title.
                  const label = last
                    ? doc.frontmatter.title
                    : sectionLabel(segment, locale);
                  return (
                    <span key={i} className="flex items-center gap-2 min-w-0">
                      <span className="text-border">/</span>
                      <span className={`truncate ${last ? 'text-foreground font-medium' : ''}`}>
                        {label}
                      </span>
                    </span>
                  );
                })}
              </div>
              {translationHref && (
                <DocsLanguageSwitcher href={translationHref} to={otherLocale} />
              )}
            </div>

            {/* Title */}
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
              {doc.frontmatter.title}
            </h1>
            {doc.frontmatter.description && (
              <p className="text-lg text-muted-foreground mb-8 leading-relaxed">
                {doc.frontmatter.description}
              </p>
            )}

            {/* Content — prose resets that let our custom components take over */}
            <div className="prose prose-neutral dark:prose-invert max-w-none prose-headings:scroll-mt-24 prose-headings:font-semibold prose-a:no-underline prose-pre:bg-transparent prose-pre:p-0 prose-pre:m-0 prose-pre:border-0 prose-code:before:content-none prose-code:after:content-none prose-code:font-normal prose-img:rounded-xl prose-img:border prose-img:border-border [&_pre]:!bg-transparent [&_pre]:!p-0 [&_pre]:!m-0 [&_pre]:!border-0 [&_pre]:!rounded-none [&_pre]:!shadow-none">
              <MDXRemote
                source={doc.content}
                components={components}
                options={{
                  mdxOptions: {
                    format: 'md',
                    remarkPlugins: [remarkGfm],
                    rehypePlugins: [rehypeSlug],
                  },
                }}
              />
            </div>

            {/* Prev / Next */}
            {(prev || next) && (
              <div className="flex items-center justify-between mt-12 pt-6 border-t border-border">
                {prev ? (
                  <Link
                    href={prev.href}
                    className="group flex flex-col items-start px-4 py-3 rounded-xl border border-border hover:border-primary/30 hover:bg-muted/50 transition-all max-w-[45%]"
                  >
                    <span className="text-xs text-muted-foreground mb-1">{ui.previous}</span>
                    <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors truncate">
                      {prev.title}
                    </span>
                  </Link>
                ) : (
                  <div />
                )}
                {next ? (
                  <Link
                    href={next.href}
                    className="group flex flex-col items-end px-4 py-3 rounded-xl border border-border hover:border-primary/30 hover:bg-muted/50 transition-all max-w-[45%] ml-auto"
                  >
                    <span className="text-xs text-muted-foreground mb-1">{ui.next}</span>
                    <span className="text-sm font-medium text-foreground group-hover:text-primary transition-colors truncate">
                      {next.title}
                    </span>
                  </Link>
                ) : (
                  <div />
                )}
              </div>
            )}
          </article>

          {/* Table of Contents */}
          <DocPageClient headings={headings} navigation={navigation} tocLabel={ui.onThisPage} />
        </div>
      </main>
    </div>
  );
}
