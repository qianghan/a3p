'use client';

import { usePathname } from 'next/navigation';
import { Menu } from 'lucide-react';
import { useShell } from '@/contexts/shell-context';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useT } from '@/hooks/use-t';
import { NotificationBell } from './notification-bell';
import { LanguageSwitcher } from './language-switcher';

/**
 * Derive a human-readable view title from the current pathname.
 *
 * This sits at the top of EVERY page, and it was English on every one of
 * them — "Dashboard" for a French reader who had already switched the whole
 * shell to French. It read as a bug in the language switcher rather than as
 * one missing string.
 *
 * The map holds catalog KEYS, not labels. It is declared inside the hook
 * because the values are resolved per render; a module-scope constant would
 * be evaluated before there is a translator.
 *
 * Falls back to a cleaned-up version of the last path segment, which stays
 * English by construction: a plugin route slug has no key to look up. That is
 * a recognisable name rather than a translated one, and it only affects routes
 * outside this list.
 */
function useViewTitle(): string {
  const pathname = usePathname();
  const t = useT();

  const titleKeys: Record<string, string> = {
    '/': 'nav.dashboard',
    '/agentbook': 'nav.dashboard',
    '/settings': 'common.settings',
    '/teams': 'nav.teams',
    '/marketplace': 'nav.marketplace',
    '/feedback': 'nav.feedback',
    '/docs': 'nav.documentation',
    '/admin/users': 'nav.admin',
    '/accountant': 'nav.account_access',
    '/personal': 'nav.personal_finance',
  };

  if (titleKeys[pathname]) return t(titleKeys[pathname]);

  // Plugin / dynamic routes — use the last meaningful segment
  const segments = pathname.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return t('dash.overview');
  return last
    .replace(/[-_]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * TopBar — sits inside the content panel (not fixed).
 * Shows the current view title on the left (Linear-style)
 * and minimal contextual actions on the right.
 */
export function TopBar() {
  const t = useT();
  const title = useViewTitle();
  const { toggleMobileMenu } = useShell();
  const isMobile = useIsMobile();

  return (
    <div className="shrink-0 h-12 border-b border-border/40">
      <div className="flex h-full items-center justify-between px-4 gap-4">
        {/* Left side — hamburger (mobile only) + view title */}
        <div className="flex items-center gap-2 min-w-0">
          {isMobile && (
            <button
              onClick={toggleMobileMenu}
              className="p-1.5 -ml-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
              aria-label={t('common.open_menu')}
            >
              <Menu size={18} />
            </button>
          )}
          <h1 className="text-[13px] font-semibold text-foreground truncate">
            {title}
          </h1>
        </div>

        {/* Right side — contextual actions */}
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <NotificationBell />
        </div>
      </div>
    </div>
  );
}
