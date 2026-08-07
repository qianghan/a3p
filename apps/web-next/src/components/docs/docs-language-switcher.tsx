import Link from 'next/link';
import { Languages } from 'lucide-react';

/**
 * English ⇄ 中文 for the page you are already reading.
 *
 * Deliberately a link to the SAME page in the other language rather than a
 * generic "switch language" that dumps you at the docs home. Someone halfway
 * through the Telegram setup wants that page in Chinese, not to start over.
 *
 * Server component with no state: the counterpart is resolved at build time
 * and rendered as a plain anchor, so it works before hydration and is a real
 * URL a reader can bookmark or share.
 */
export function DocsLanguageSwitcher({
  href,
  to,
}: {
  /** The same page in the other locale. */
  href: string;
  to: 'en' | 'zh';
}) {
  return (
    <Link
      href={href}
      hrefLang={to}
      className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
      // The label is written in the language being switched TO — a reader who
      // cannot read the current page still has to be able to read the way out.
      aria-label={to === 'zh' ? '切换到中文' : 'Switch to English'}
    >
      <Languages className="h-4 w-4" aria-hidden="true" />
      {to === 'zh' ? '中文' : 'English'}
    </Link>
  );
}
