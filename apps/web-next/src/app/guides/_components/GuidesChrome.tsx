'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { GUIDES_UI, guidesLocaleOf, guidesCounterpart } from '../_i18n';
import { useT } from '@/hooks/use-t';

/**
 * The guides' header and footer, in the reader's language.
 *
 * A client component only because the layout sits above the route segments and
 * never sees their params — the URL carries the same signal. The switcher
 * points at the SAME guide in the other language, not the index: someone
 * halfway through the partner earnings page wants that page in Chinese.
 */
export function GuidesTop() {
  const t = useT();
  const pathname = usePathname() ?? '/guides';
  const locale = guidesLocaleOf(pathname);
  const ui = GUIDES_UI[locale];
  const other = guidesCounterpart(pathname);

  return (
    <header className="gd-top">
      <Link href={locale === 'zh' ? '/guides/zh' : '/'} className="gd-brand">
        {t('core_ui.agent')}<span>Book</span>
      </Link>
      <nav className="gd-topnav">
        <Link href={locale === 'zh' ? '/guides/zh' : '/guides'}>{ui.allGuides}</Link>
        <Link href="/register">{ui.getStarted}</Link>
        <Link href={other.href} hrefLang={other.to} aria-label={ui.switchLabel}>
          {ui.switchTo}
        </Link>
      </nav>
    </header>
  );
}

export function GuidesFooter() {
  const pathname = usePathname() ?? '/guides';
  const ui = GUIDES_UI[guidesLocaleOf(pathname)];

  return (
    <footer className="gd-foot">
      {ui.footerPre}
      <a href="/login">{ui.footerApp}</a>
      {ui.footerOr}
      <a href="/register">{ui.footerRegister}</a>
      {ui.footerPost}
    </footer>
  );
}
