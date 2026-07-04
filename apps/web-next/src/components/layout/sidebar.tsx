'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { useShell, useEvents } from '@/contexts/shell-context';
import { usePlugins, type PluginManifest } from '@/contexts/plugin-context';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { WorkspaceSwitcher } from './workspace-switcher';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  X,
  Shield,
  Users,
  ShoppingBag,
  MessageSquare,
  Box,
  MoreHorizontal,
  BookOpen,
  GripVertical,
  Search,
  Command,
  // Plugin icons - referenced by name in plugin.json manifests
  Wallet,
  UserCheck,
  Banknote,
  Receipt,
  Radio,
  BarChart3,
  Video,
  Upload,
  Code,
  Cpu,
  Zap,
  LayoutDashboard,
  Globe,
  Package,
  Puzzle,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
}

/** Normalize plugin name for deduplication (my-wallet == myWallet == mywallet) */
function normalizePluginName(name: string): string {
  return name.toLowerCase().replace(/[-_]/g, '');
}

function getPluginNavSection(plugin: PluginManifest): 'main' | 'network' {
  const metadata = plugin.metadata as Record<string, unknown> | undefined;
  if (metadata?.navigation && typeof metadata.navigation === 'object') {
    const nav = metadata.navigation as { section?: string };
    if (nav.section === 'network') return 'network';
    if (nav.section === 'main') return 'main';
  }

  const category = (metadata?.category as string) || '';
  if (['networking', 'infrastructure', 'communication'].includes(category)) {
    return 'network';
  }

  return 'main';
}

/**
 * Map of icon names to Lucide components.
 * Add entries here when new plugins define icons in their plugin.json.
 * This avoids importing the entire lucide-react library (tree-shaking safe).
 */
const ICON_MAP: Record<string, LucideIcon> = {
  Activity,
  BarChart3,
  Box,
  Code,
  Cpu,
  Globe,
  LayoutDashboard,
  Package,
  Puzzle,
  Radio,
  ShoppingBag,
  Upload,
  Users,
  Video,
  Wallet,
  Zap,
};

/**
 * Resolves a Lucide icon by name from the plugin manifest.
 * Falls back to Box if the icon name is not in the map.
 */
function resolveIcon(iconName?: string): LucideIcon {
  if (!iconName) return Box;
  return ICON_MAP[iconName] || Box;
}

// Sidebar width constants — tighter default for Linear-style density
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 280;
const SIDEBAR_DEFAULT_WIDTH = 240;
const SIDEBAR_COLLAPSED_WIDTH = 52;

export function Sidebar() {
  const pathname = usePathname();
  const { hasRole } = useAuth();
  const { isSidebarOpen, toggleSidebar, isMobileMenuOpen, closeMobileMenu } = useShell();
  const { plugins, isLoading, version, refreshPlugins } = usePlugins();
  const eventBus = useEvents();
  const isMobile = useIsMobile();

  const isAdmin = hasRole('system:admin');
  const isSalesRep = hasRole('sales_rep');

  // Close the mobile drawer on navigation — a link tap should take the user
  // to the page, not leave the overlay covering it.
  useEffect(() => {
    closeMobileMenu();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Sidebar width for resizing
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;
    const saved = localStorage.getItem('naap_sidebar_width');
    return saved ? parseInt(saved, 10) : SIDEBAR_DEFAULT_WIDTH;
  });

  // Resizing state
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const resizeHandleRef = useRef<HTMLDivElement>(null);

  // Handle resize
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const newWidth = Math.min(
        Math.max(e.clientX, SIDEBAR_MIN_WIDTH),
        SIDEBAR_MAX_WIDTH
      );
      setSidebarWidth(newWidth);
      // Emit event during drag for smooth updates
      eventBus.emit('shell:sidebar:resize', { width: newWidth });
    };

    const handleMouseUp = () => {
      if (isResizing) {
        setIsResizing(false);
        localStorage.setItem('naap_sidebar_width', sidebarWidth.toString());
        // Emit event for other components to update
        eventBus.emit('shell:sidebar:resize', { width: sidebarWidth });
      }
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, sidebarWidth, eventBus]);

  // Listen for plugin preference/install/uninstall changes to refresh the sidebar
  useEffect(() => {
    const unsubscribePlugin = eventBus.on('plugin:preferences:changed', () => {
      refreshPlugins();
    });
    const unsubscribeInstalled = eventBus.on('plugin:installed', () => {
      refreshPlugins();
    });
    const unsubscribeUninstalled = eventBus.on('plugin:uninstalled', () => {
      refreshPlugins();
    });
    const unsubscribeTeam = eventBus.on('team:change', () => {
      refreshPlugins();
    });
    return () => {
      unsubscribePlugin();
      unsubscribeInstalled();
      unsubscribeUninstalled();
      unsubscribeTeam();
    };
  }, [eventBus, refreshPlugins]);

  // Collapsible section states - persist to localStorage
  const [mainExpanded, setMainExpanded] = useState(true);
  const [networkExpanded, setNetworkExpanded] = useState(true);
  const [moreExpanded, setMoreExpanded] = useState(false);

  // Load collapsed states from localStorage
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('naap_sidebar_sections');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setMainExpanded(parsed.main ?? true);
          setNetworkExpanded(parsed.network ?? true);
          setMoreExpanded(parsed.more ?? false);
        } catch {}
      }
    }
  }, []);

  // Save collapsed states
  const saveSectionState = (section: string, expanded: boolean) => {
    if (typeof window !== 'undefined') {
      const current = localStorage.getItem('naap_sidebar_sections');
      const parsed = current ? JSON.parse(current) : {};
      parsed[section] = expanded;
      localStorage.setItem('naap_sidebar_sections', JSON.stringify(parsed));
    }
  };

  const toggleMainExpanded = () => {
    const next = !mainExpanded;
    setMainExpanded(next);
    saveSectionState('main', next);
  };

  const toggleNetworkExpanded = () => {
    const next = !networkExpanded;
    setNetworkExpanded(next);
    saveSectionState('network', next);
  };

  const toggleMoreExpanded = () => {
    const next = !moreExpanded;
    setMoreExpanded(next);
    saveSectionState('more', next);
  };

  // Memoize plugin lists
  const { mainPlugins, networkPlugins } = useMemo(() => {
    const seenPlugins = new Set<string>();
    const uniquePlugins = (plugins || []).filter(p => {
      if (!p?.enabled) return false;
      // Billing lives under Settings → AgentBook → Billing, not the main nav.
      if (normalizePluginName(p.name).includes('billing')) return false;
      // Skip plugins the user hasn't installed (and aren't core).
      // The API returns all globally-enabled plugins with `installed: false`
      // for ones the user hasn't explicitly added — these should not appear
      // in the sidebar. The settings page already filters by `installed`.
      if (p.installed === false && !p.isCore) return false;
      // Skip headless plugins (no routes) — they are background providers, not nav items
      if (!p.routes || p.routes.length === 0) return false;
      const normalized = normalizePluginName(p.name);
      if (seenPlugins.has(normalized)) return false;
      seenPlugins.add(normalized);
      return true;
    });

    const main = uniquePlugins
      .filter(p => getPluginNavSection(p) === 'main')
      .sort((a, b) => a.order - b.order)
      .map(plugin => ({
        name: plugin.displayName,
        href: plugin.routes?.[0]?.replace('/*', '') || `/plugins/${plugin.name}`,
        icon: resolveIcon(plugin.icon),
      }));

    const network = uniquePlugins
      .filter(p => getPluginNavSection(p) === 'network')
      .sort((a, b) => a.order - b.order)
      .map(plugin => ({
        name: plugin.displayName,
        href: plugin.routes?.[0]?.replace('/*', '') || `/plugins/${plugin.name}`,
        icon: resolveIcon(plugin.icon),
      }));

    return { mainPlugins: main, networkPlugins: network };
  }, [plugins, version]);

  // Static network items are loaded from shell config rather than hardcoded.
  // To add items, register them via shell configuration or create plugins.
  const staticNetworkItems: NavItem[] = [];

  // Static main items for native (non-plugin) AgentBook pages that aren't in
  // the plugin registry. Ordered by mental model: payables → payroll →
  // personal → advisor. The mobile PWA is intentionally NOT a nav item — it's
  // reached by installing the app (start_url /app), not from the desktop menu.
  const staticMainItems: NavItem[] = [
    { name: 'Bills', href: '/agentbook/expenses/bills', icon: Receipt },
    { name: 'Payroll', href: '/payroll', icon: Banknote },
    { name: 'Personal finance', href: '/personal', icon: Wallet },
    { name: 'Accountant', href: '/accountant', icon: UserCheck },
  ];

  // Routes that should use exact matching only
  const exactMatchRoutes = new Set([
    '/agentbook',
    '/settings',
    '/teams',
    '/marketplace',
    '/feedback',
    '/releases',
    '/treasury',
    '/governance',
  ]);

  const isActive = (href: string) => {
    if (href === '/') return pathname === '/';

    if (exactMatchRoutes.has(href)) {
      return pathname === href;
    }

    return pathname === href || pathname.startsWith(href + '/');
  };

  // Calculate actual width. On mobile the drawer always shows full content
  // (a collapsed 52px rail as a full-screen overlay makes no sense) —
  // desktop's collapse/resize state is left untouched either way.
  const actualWidth = isMobile ? sidebarWidth : (isSidebarOpen ? sidebarWidth : SIDEBAR_COLLAPSED_WIDTH);
  const effectiveOpen = isMobile ? true : isSidebarOpen;

  return (
    <>
      {/* QA-P5-001: backdrop — only on mobile, only while the drawer is open.
          Closes the drawer on click so it never traps the user. */}
      {isMobile && isMobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50"
          onClick={closeMobileMenu}
          aria-hidden="true"
        />
      )}
      <aside
        ref={sidebarRef}
        style={{ width: actualWidth }}
        aria-hidden={isMobile && !isMobileMenuOpen}
        className={`fixed left-0 top-0 h-screen bg-background flex flex-col ${
          isResizing ? 'select-none' : ''
        } ${
          isMobile
            ? `z-50 shadow-2xl transition-transform duration-200 ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full pointer-events-none'}`
            : 'z-40 transition-all duration-200'
        }`}
      >
      {/* Workspace Identity — Linear-style unified control */}
      <div className="shrink-0 px-3 pt-3 pb-1 space-y-1">
        <div className="flex items-center justify-between">
          <WorkspaceSwitcher isOpen={effectiveOpen} />
          <button
            onClick={isMobile ? closeMobileMenu : toggleSidebar}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shrink-0"
            title={isMobile ? 'Close' : (isSidebarOpen ? 'Collapse' : 'Expand')}
            aria-label={isMobile ? 'Close menu' : (isSidebarOpen ? 'Collapse sidebar' : 'Expand sidebar')}
          >
            {isMobile ? <X size={14} /> : (isSidebarOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />)}
          </button>
        </div>

        {/* Search trigger — compact row */}
        {effectiveOpen && (
          <button
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors duration-100 group"
            title="Search (⌘K)"
          >
            <Search size={14} className="shrink-0" />
            <span className="text-[13px]">Search...</span>
            <kbd className="ml-auto hidden lg:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium bg-background/50 border border-border/50 rounded opacity-50 group-hover:opacity-80 transition-opacity">
              <Command size={9} />K
            </kbd>
          </button>
        )}
        {!effectiveOpen && (
          <button
            className="w-full flex items-center justify-center py-1.5 rounded-md text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors duration-100"
            title="Search (⌘K)"
            aria-label="Search"
          >
            <Search size={16} />
          </button>
        )}
      </div>

      {/* Scrollable Navigation */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden scrollbar-thin scrollbar-thumb-muted/50 scrollbar-track-transparent px-2 py-2">
        {/* Main Section */}
        <nav className="mb-2">
          <SectionHeader
            title="Main"
            expanded={mainExpanded}
            onToggle={toggleMainExpanded}
            isOpen={effectiveOpen}
          />
          {mainExpanded && (
            <div className="space-y-0.5 mt-1">
              {isLoading ? (
                <div className="py-2 px-3">
                  <div className="h-4 w-20 bg-muted/50 animate-pulse rounded" />
                </div>
              ) : (
                <>
                  {mainPlugins.map(item => (
                    <NavLink
                      key={item.href}
                      item={item}
                      isActive={isActive(item.href)}
                      isOpen={effectiveOpen}
                    />
                  ))}
                  {staticMainItems.map(item => (
                    <NavLink
                      key={item.href}
                      item={item}
                      isActive={isActive(item.href)}
                      isOpen={effectiveOpen}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </nav>

        {/* Network Section */}
        <nav className="mb-2">
          <SectionHeader
            title="Network"
            expanded={networkExpanded}
            onToggle={toggleNetworkExpanded}
            isOpen={effectiveOpen}
          />
          {networkExpanded && (
            <div className="space-y-0.5 mt-1">
              {networkPlugins.map(item => (
                <NavLink
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                  isOpen={effectiveOpen}
                />
              ))}
              {staticNetworkItems.map(item => (
                <NavLink
                  key={item.href}
                  item={item}
                  isActive={isActive(item.href)}
                  isOpen={effectiveOpen}
                />
              ))}
            </div>
          )}
        </nav>

        {/* More Section (Collapsible) */}
        <nav className="mb-2">
          <SectionHeader
            title="More"
            expanded={moreExpanded}
            onToggle={toggleMoreExpanded}
            isOpen={effectiveOpen}
            icon={MoreHorizontal}
          />
          {moreExpanded && (
            <div className="space-y-0.5 mt-1">
              <NavLink
                item={{ name: 'Feedback', href: '/feedback', icon: MessageSquare }}
                isActive={isActive('/feedback')}
                isOpen={effectiveOpen}
              />
              <NavLink
                item={{ name: 'Teams', href: '/teams', icon: Users }}
                isActive={isActive('/teams')}
                isOpen={effectiveOpen}
              />
              <NavLink
                item={{ name: 'Docs', href: '/docs', icon: BookOpen }}
                isActive={isActive('/docs')}
                isOpen={effectiveOpen}
              />
            </div>
          )}
        </nav>
      </div>

      {/* Bottom Section - Fixed (only role-gated items) */}
      {(isAdmin || isSalesRep) && (
        <div className="shrink-0 p-2 border-t border-border/50">
          {isSalesRep && (
            <NavLink
              item={{ name: 'Sales Rep', href: '/sales-rep', icon: Banknote }}
              isActive={isActive('/sales-rep')}
              isOpen={effectiveOpen}
            />
          )}
          {isAdmin && (
            <NavLink
              item={{ name: 'Admin', href: '/admin/users', icon: Shield }}
              isActive={isActive('/admin')}
              isOpen={effectiveOpen}
            />
          )}
        </div>
      )}

      {/* Resize Handle - only on desktop; drag-to-resize doesn't apply to a touch overlay */}
      {!isMobile && isSidebarOpen && (
        <div
          ref={resizeHandleRef}
          onMouseDown={handleMouseDown}
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize group hover:w-1.5 transition-all ${
            isResizing ? 'bg-primary w-1.5' : 'bg-transparent hover:bg-primary/50'
          }`}
        >
          {/* Grip indicator on hover */}
          <div className={`absolute top-1/2 -translate-y-1/2 right-0 -mr-1.5 p-0.5 rounded bg-muted border border-border/50 opacity-0 group-hover:opacity-100 transition-opacity ${
            isResizing ? 'opacity-100' : ''
          }`}>
            <GripVertical size={12} className="text-muted-foreground" />
          </div>
        </div>
      )}
      </aside>
    </>
  );
}

function SectionHeader({
  title,
  expanded,
  onToggle,
  isOpen,
  icon: Icon,
}: {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  isOpen: boolean;
  icon?: React.ComponentType<{ size?: number }>;
}) {
  if (!isOpen) {
    return (
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-center py-2 text-muted-foreground/60 hover:text-muted-foreground transition-all"
        title={`${title} (${expanded ? 'collapse' : 'expand'})`}
        aria-label={`${title} (${expanded ? 'collapse' : 'expand'})`}
      >
        {Icon ? <Icon size={14} /> : (
          <div className="w-5 h-[2px] bg-current rounded-full opacity-50" />
        )}
      </button>
    );
  }

  return (
    <button
      onClick={onToggle}
      className="w-full flex items-center justify-between px-2 py-1 text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wider hover:text-muted-foreground transition-colors duration-100 group"
    >
      <span className="flex items-center gap-2">
        {Icon && <Icon size={12} />}
        {title}
      </span>
      <span className="opacity-0 group-hover:opacity-100 transition-opacity">
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </span>
    </button>
  );
}

function NavLink({
  item,
  isActive,
  isOpen,
}: {
  item: NavItem;
  isActive: boolean;
  isOpen: boolean;
}) {
  const Icon = item.icon;

  return (
    <Link
      href={item.href}
      className={`relative flex items-center gap-2.5 px-2 py-1.5 rounded-md transition-colors duration-100 ${
        isActive
          ? 'bg-muted/80 text-foreground'
          : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
      }`}
      title={!isOpen ? item.name : undefined}
    >
      <span className="shrink-0"><Icon size={16} /></span>
      {isOpen && <span className="text-[13px] font-medium truncate">{item.name}</span>}
    </Link>
  );
}
