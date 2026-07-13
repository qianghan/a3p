'use client';

import { DocsHeader } from '@/components/docs/docs-header';
import { DocsSidebarProvider, useDocsSidebar } from '@/components/docs/docs-sidebar-context';

function DocsChrome({ children }: { children: React.ReactNode }) {
  const { isOpen, toggle, close } = useDocsSidebar();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <DocsHeader onToggleSidebar={toggle} isSidebarOpen={isOpen} />

      {/* Mobile sidebar backdrop — the actual drawer content (MobileDocsSidebar)
          is rendered by each page (it needs the server-computed `navigation`
          prop), both consuming the same context so tapping here or a nav
          link inside the drawer close it. */}
      {isOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
          onClick={close}
        />
      )}

      <div className="mx-auto max-w-[90rem]">
        {children}
      </div>
    </div>
  );
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <DocsSidebarProvider>
      <DocsChrome>{children}</DocsChrome>
    </DocsSidebarProvider>
  );
}
