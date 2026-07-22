// Server-compatible (no 'use client') — French UI Phase 1 (AU-1 plan
// appendix, Task 12, Step 6). A minimal cross-link between a doc page and
// its alternate-language sibling, e.g. /docs/regions/canada <-> canada.fr.
// This is the one real MDX-facing consumer of the new lib/i18n `t()` helper.
import { t, type Locale } from '@/lib/i18n';

export function DocsLanguageNote({ locale, href }: { locale: Locale; href: string }) {
  return (
    <p className="text-sm text-muted-foreground italic mt-2">
      <a
        href={href}
        className="text-primary hover:text-primary/80 underline decoration-primary/30 hover:decoration-primary underline-offset-2 transition-colors"
      >
        {t('docs.also_available_other_lang', locale)}
      </a>
    </p>
  );
}
