'use client';

import { DocsSidebar, type NavSection } from './docs-sidebar';
import { useDocsSidebar } from './docs-sidebar-context';

/**
 * Mobile slide-in drawer. The header's hamburger button toggles the shared
 * `DocsSidebarContext` state; previously that state only rendered a dark
 * backdrop (docs/layout.tsx) with no actual navigation content behind it —
 * tapping the menu button opened an empty overlay. This is the missing
 * piece: the actual nav, rendered as a fixed panel so it works from a
 * server-rendered page (the `<aside>` in docs/page.tsx and
 * docs/[...slug]/page.tsx stays as the always-static desktop version).
 */
export function MobileDocsSidebar({ navigation }: { navigation: NavSection[] }) {
  const { isOpen, close } = useDocsSidebar();

  return (
    <div
      className={`fixed inset-y-0 left-0 z-40 w-72 max-w-[85vw] overflow-y-auto bg-background border-r border-border py-6 px-4 transition-transform duration-200 ease-out lg:hidden ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
      aria-hidden={!isOpen}
    >
      <DocsSidebar navigation={navigation} onNavigate={close} />
    </div>
  );
}
