'use client';

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';
import { useShell, useEvents } from '@/contexts/shell-context';
import { usePlugins, type PluginManifest } from '@/contexts/plugin-context';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { normalizePluginName } from '@/lib/plugins/normalize';
import { pluginNavGroup, NAV_GROUP_LABEL, type NavGroupId } from '@/lib/plugins/nav-groups';
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
  FileText,
  Calculator,
  Rocket,
  GraduationCap,
  Briefcase,
  Home,
  CreditCard,
  // Section header icons
  Landmark,
  Target,
  type LucideIcon,
} from 'lucide-react';

interface NavItem {
  name: string;
  href: string;
  icon: React.ComponentType<{ className?: string; size?: number }>;
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
 *
 * Every AgentBook plugin's declared icon is listed here — until this map was
 * extended, 9 of 10 plugins silently rendered the generic Box fallback
 * because their plugin.json icon names (Receipt, FileText, Calculator, ...)
 * had never been added.
 */
const ICON_MAP: Record<string, LucideIcon> = {
  Activity,
  BarChart3,
  BookOpen,
  Box,
  Briefcase,
  Calculator,
  Code,
  CreditCard,
  Cpu,
  FileText,
  Globe,
  GraduationCap,
  Home,
  LayoutDashboard,
  Package,
  Puzzle,
  Radio,
  Receipt,
  Rocket,
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

/** Section-header icon per group — mainly so the collapsed icon-only rail stays scannable across 5 sections instead of 3. */
const SECTION_ICON: Record<NavGroupId, LucideIcon> = {
  accounting: Landmark,
  personal: Wallet,
  'for-your-business': Target,
  'advisors-community': UserCheck,
  resources: MoreHorizontal,
};

const SECTION_ORDER: NavGroupId[] = ['accounting', 'personal', 'for-your-business', 'advisors-community', 'resources'];

const DEFAULT_SECTION_EXPANDED: Record<NavGroupId, boolean> = {
  accounting: true,
  personal: true,
  'for-your-business': true,
  'advisors-community': true,
  resources: false,
};

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

  // Business type drives visibility of native pages that aren't part of the
  // plugin registry (e.g. Payroll makes no sense for a student). Plugin-
  // registry items are filtered server-side by business-type-gate.ts; this
  // covers the handful of hardcoded staticMainItems below.
  const [businessType, setBusinessType] = useState<string | null>(null);
  useEffect(() => {
    fetch('/api/v1/agentbook-core/tenant-config')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { businessType?: string } } | null) => setBusinessType(json?.data?.businessType ?? null))
      .catch(() => setBusinessType(null));
  }, []);

  // Marketplace defaults to admin-only visibility (see
  // /api/v1/marketplace/visibility's own doc comment) — mirror that same
  // check here so the nav link only appears for someone who can actually use
  // the page, instead of linking everyone to a "not available yet" screen.
  const [marketplaceVisible, setMarketplaceVisible] = useState(false);
  useEffect(() => {
    fetch('/api/v1/marketplace/visibility')
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: { visible?: boolean } } | null) => setMarketplaceVisible(json?.data?.visible ?? false))
      .catch(() => setMarketplaceVisible(false));
  }, []);

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

  // Collapsible section states - persist to localStorage. One map for all
  // 5 grouped sections (Dashboard is a standalone link, not a section) —
  // replaces the old 3 separate main/network/more booleans+toggles, since
  // every section now behaves identically.
  const [sectionExpanded, setSectionExpanded] = useState<Record<NavGroupId, boolean>>(DEFAULT_SECTION_EXPANDED);

  // Load collapsed states from localStorage
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const saved = localStorage.getItem('naap_sidebar_sections');
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as Partial<Record<NavGroupId, boolean>>;
      setSectionExpanded((prev) => ({ ...prev, ...parsed }));
    } catch {}
  }, []);

  const toggleSection = (section: NavGroupId) => {
    setSectionExpanded((prev) => {
      const next = { ...prev, [section]: !prev[section] };
      if (typeof window !== 'undefined') {
        localStorage.setItem('naap_sidebar_sections', JSON.stringify(next));
      }
      return next;
    });
  };

  // Memoize plugin lists — grouped by purpose (Accounting, For your business,
  // Advisors & Community) instead of one flat "Main" list. agentbook-core is
  // pulled out separately as the standalone "Dashboard" link. Any plugin
  // whose metadata puts it in the old 'network' bucket (none do today, but
  // the underlying classification is left in place for compatibility) folds
  // into "Resources" rather than getting its own now-removed section.
  const { dashboardItem, groupedPlugins } = useMemo(() => {
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

    let dashboard: NavItem | null = null;
    const groups: Record<NavGroupId, NavItem[]> = {
      accounting: [],
      personal: [],
      'for-your-business': [],
      'advisors-community': [],
      resources: [],
    };

    const sorted = [...uniquePlugins].sort((a, b) => a.order - b.order);
    for (const plugin of sorted) {
      const normalized = normalizePluginName(plugin.name);
      const item: NavItem = {
        name: normalized === 'agentbookcore' ? 'Dashboard' : plugin.displayName,
        href: plugin.routes?.[0]?.replace('/*', '') || `/plugins/${plugin.name}`,
        icon: normalized === 'agentbookcore' ? LayoutDashboard : resolveIcon(plugin.icon),
      };
      if (normalized === 'agentbookcore') {
        dashboard = item;
        continue;
      }
      const section = getPluginNavSection(plugin) === 'network' ? 'resources' : pluginNavGroup(normalized);
      groups[section].push(item);
    }

    return { dashboardItem: dashboard, groupedPlugins: groups };
  }, [plugins, version]);

  // Native (non-plugin) pages, assigned to the same groups as their
  // conceptual peers among the plugins above.
  const nativeGroups: Record<NavGroupId, NavItem[]> = {
    accounting: [
      // Payroll doesn't apply to students (no employees to pay) — hidden once
      // a business type is configured and it isn't relevant.
      ...(businessType === 'student' ? [] : [{ name: 'Payroll', href: '/payroll', icon: Banknote }]),
    ],
    personal: [
      { name: 'Personal finance', href: '/personal', icon: Wallet },
    ],
    'for-your-business': [],
    'advisors-community': [
      { name: 'Account Access', href: '/accountant', icon: UserCheck },
    ],
    resources: [
      ...(marketplaceVisible ? [{ name: 'Marketplace', href: '/marketplace', icon: ShoppingBag }] : []),
      { name: 'Feedback', href: '/feedback', icon: MessageSquare },
      { name: 'Teams', href: '/teams', icon: Users },
      { name: 'Docs', href: '/docs', icon: BookOpen },
    ],
  };

  const sectionItems: Record<NavGroupId, NavItem[]> = {
    accounting: [...groupedPlugins.accounting, ...nativeGroups.accounting],
    personal: [...groupedPlugins.personal, ...nativeGroups.personal],
    'for-your-business': [...groupedPlugins['for-your-business'], ...nativeGroups['for-your-business']],
    'advisors-community': [...groupedPlugins['advisors-community'], ...nativeGroups['advisors-community']],
    resources: [...groupedPlugins.resources, ...nativeGroups.resources],
  };

  // Routes that should use exact matching only
  const exactMatchRoutes = new Set([
    '/agentbook',
    '/settings',
    '/teams',
    '/marketplace',
    '/feedback',
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
        {isLoading ? (
          <div className="py-2 px-3">
            <div className="h-4 w-20 bg-muted/50 animate-pulse rounded" />
          </div>
        ) : (
          <>
            {/* Dashboard — standalone, not grouped with anything */}
            {dashboardItem && (
              <nav className="mb-2 space-y-0.5">
                <NavLink
                  item={dashboardItem}
                  isActive={isActive(dashboardItem.href)}
                  isOpen={effectiveOpen}
                />
              </nav>
            )}

            {SECTION_ORDER.map((section) => {
              const items = sectionItems[section];
              // "For your business" only exists for tenants a plugin actually
              // applies to (student/startup) — an empty section here would
              // just be dead chrome, so it's omitted entirely rather than
              // shown collapsed-and-empty.
              if (items.length === 0) return null;
              const icon = SECTION_ICON[section];
              return (
                <nav key={section} className="mb-2">
                  <SectionHeader
                    title={NAV_GROUP_LABEL[section]}
                    expanded={sectionExpanded[section]}
                    onToggle={() => toggleSection(section)}
                    isOpen={effectiveOpen}
                    icon={icon}
                  />
                  {sectionExpanded[section] && (
                    <div className="space-y-0.5 mt-1">
                      {items.map(item => (
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
              );
            })}
          </>
        )}
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
