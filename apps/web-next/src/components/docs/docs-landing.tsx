import Link from 'next/link';
import { Rocket, Settings, Sparkles, LifeBuoy, Map, ArrowRight } from 'lucide-react';
import { Wordmark } from '@/components/brand/Wordmark';
import { DocsSidebar } from '@/components/docs/docs-sidebar';
import { MobileDocsSidebar } from '@/components/docs/mobile-docs-sidebar';
import { DocsLanguageSwitcher } from '@/components/docs/docs-language-switcher';
import { getNavigation, type DocLocale, DOC_LOCALES } from '@/lib/docs/content';
import { DOCS_LANDING, localeHref } from '@/lib/docs/landing';

/**
 * The docs front door, in whichever locale.
 *
 * One component for both, rather than a translated copy of the English page:
 * a second copy is how the two drift, and the landing is the page most likely
 * to gain a section that the translation then silently lacks.
 */

const ICONS = {
  rocket: Rocket, settings: Settings, sparkles: Sparkles, map: Map, lifebuoy: LifeBuoy,
} as const;

export function DocsLanding({ locale }: { locale: DocLocale }) {
  const copy = DOCS_LANDING[locale];
  const navigation = getNavigation(locale);
  // The landing exists in every locale we ship, so unlike a doc page the
  // switcher here never needs to check whether a counterpart exists.
  const otherLocale: DocLocale = locale === 'en' ? (DOC_LOCALES[0] as DocLocale) : 'en';
  const otherHref = otherLocale === 'en' ? '/docs' : `/docs/${otherLocale}`;

  return (
    <div className="flex">
      <MobileDocsSidebar navigation={navigation} />
      <aside className="hidden lg:block w-64 shrink-0 border-r border-border">
        <div className="sticky top-14 h-[calc(100vh-3.5rem)] overflow-y-auto py-6 px-4">
          <DocsSidebar navigation={navigation} />
        </div>
      </aside>
      <main className="flex-1 min-w-0 px-4 lg:px-8">
        <div className="max-w-3xl mx-auto pt-16 pb-10 text-center">
          <div className="flex items-center justify-center gap-2 mb-5">
            <Wordmark size={30} />
            <span className="text-2xl font-semibold text-muted-foreground tracking-tight">
              {locale === 'zh' ? '文档' : 'docs'}
            </span>
          </div>
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight mb-4 text-foreground">
            {copy.heroTitle}
          </h1>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto leading-relaxed">
            {copy.heroBody}
          </p>
          <div className="mt-6 flex justify-center">
            <DocsLanguageSwitcher href={otherHref} to={otherLocale as "en" | "zh"} />
          </div>
        </div>

        <div className="max-w-3xl mx-auto mb-14">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground mb-3 text-center">
            {copy.popularLabel}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {copy.popular.map((p) => (
              <Link
                key={p.path}
                href={localeHref(locale, p.path)}
                className="group flex items-center justify-between gap-2 px-4 py-3 rounded-lg border border-border bg-card hover:border-primary/40 transition-colors"
              >
                <span className="text-sm text-foreground">{p.label}</span>
                <ArrowRight size={14} className="text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
              </Link>
            ))}
          </div>
        </div>

        <div className="max-w-4xl mx-auto pb-20">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {copy.sections.map((section) => {
              const Icon = ICONS[section.icon];
              return (
                <Link
                  key={section.path}
                  href={localeHref(locale, section.path)}
                  className="group relative p-6 rounded-xl border border-border bg-card hover:border-primary/40 hover:shadow-lg hover:-translate-y-0.5 transition-all"
                >
                  <div className="w-10 h-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-4">
                    <Icon size={20} className="text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2 text-foreground">{section.title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed mb-4">{section.description}</p>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-primary group-hover:gap-2 transition-all">
                    {copy.explore}
                    <ArrowRight size={14} />
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      </main>
    </div>
  );
}
