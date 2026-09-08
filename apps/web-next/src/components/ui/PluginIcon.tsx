'use client';

/**
 * An icon named by a runtime string, without shipping the icon library.
 *
 * Two pages resolved a plugin's icon by indexing the whole of lucide-react:
 *
 *     import * as Icons from 'lucide-react';
 *     const C = (Icons as Record<string, ComponentType>)[iconName];
 *
 * A namespace import cannot be tree-shaken — the bundler has to assume any
 * export might be indexed — so both pages carried all ~1,500 icons to render
 * one. They were the two heaviest routes in the app by a wide margin:
 * /settings at 494 kB First Load JS against a 103 kB shared baseline, and
 * /admin/plugins at 405 kB. Nothing else came close to either.
 *
 * WHY NOT lucide's OWN `DynamicIcon`
 * The obvious fix is `DynamicIcon` from 'lucide-react/dynamic', which resolves
 * a name to a lazily-imported chunk. Measured, it makes the two pages much
 * cheaper — /settings 494 kB -> 351 kB, /admin/plugins 405 kB -> 260 kB — and
 * then charges the whole app for it. Its name map is ~1,500 separate dynamic
 * imports, and webpack has to record every one of them in the GLOBAL runtime
 * manifest that ships on every page: the runtime chunk went from 3 kB with 0
 * chunk-id entries to 44 kB with 1,659, pushing the shared baseline from
 * 103 kB to 126 kB. Every route in the app paid 23 kB to fix two of them.
 * Wrapping it in `next/dynamic` does not help — the manifest is emitted for
 * the imports' existence, not for whether the code is reached.
 *
 * So: a static map. Named imports tree-shake (lucide is ESM and marks itself
 * side-effect free), only the icons listed here are bundled, and nothing lands
 * in the runtime manifest. The cost is that the map is a closed set — see
 * ICONS below.
 *
 * NAME CASING
 * The registry stores PascalCase — `BrainCircuit`, `Trophy`, `Video` — because
 * that is what the namespace lookup needed, and at least one row is already
 * lowercase (`rocket`). Keying on kebab-case and routing every lookup through
 * `toKebabCase` makes both resolve. Getting this wrong would not throw; every
 * plugin icon would quietly become the placeholder, which reads as a data
 * problem rather than a code one.
 */

import {
  BarChart3, Blocks, BookOpen, Box, Brain, BrainCircuit, Briefcase, Calculator,
  Cloud, CreditCard, File, FileText, GraduationCap, Home, LifeBuoy, Mail, Map,
  MessageSquare, Phone, Receipt, Rocket, Settings, Sparkles, Trophy, Users,
  Video, type LucideIcon,
} from 'lucide-react';

/**
 * Every icon name that appears in a plugin manifest, registry seed or plugin
 * package in this repo, keyed kebab-case.
 *
 * This is deliberately a closed set rather than the whole library: the whole
 * library is the bug this file exists to fix. A name outside it renders the
 * caller's fallback, which is exactly what an unrecognised name did before.
 * `plugin-icon.test.tsx` scans the repo for icon names and fails if one is
 * missing, so adding a plugin with a new icon fails CI with the name to add
 * rather than shipping a silent placeholder.
 */
const ICONS: Record<string, LucideIcon> = {
  'bar-chart-3': BarChart3,
  blocks: Blocks,
  'book-open': BookOpen,
  box: Box,
  brain: Brain,
  'brain-circuit': BrainCircuit,
  briefcase: Briefcase,
  calculator: Calculator,
  cloud: Cloud,
  'credit-card': CreditCard,
  file: File,
  'file-text': FileText,
  'graduation-cap': GraduationCap,
  home: Home,
  'life-buoy': LifeBuoy,
  mail: Mail,
  map: Map,
  'message-square': MessageSquare,
  phone: Phone,
  receipt: Receipt,
  rocket: Rocket,
  settings: Settings,
  sparkles: Sparkles,
  trophy: Trophy,
  users: Users,
  video: Video,
};

/**
 * `BrainCircuit` → `brain-circuit`, `Trophy` → `trophy`, `BarChart3` →
 * `bar-chart-3`, `rocket` → `rocket`.
 *
 * The first replace handles an acronym run followed by a word (`XMLFile` →
 * `xml-file`); without it the whole run collapses into the next word. The
 * digit in the `[a-z0-9]` class is what splits `BarChart3`'s trailing number
 * from the word before it, matching lucide's own naming.
 */
export function toKebabCase(name: string): string {
  return name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .replace(/([a-z])([A-Z0-9])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

/** Exported so the test can assert the repo's icon names are all covered. */
export const KNOWN_ICON_NAMES = Object.keys(ICONS);

export interface PluginIconProps {
  /** Icon name as stored by the plugin registry, in either casing. */
  name?: string | null;
  size?: number;
  /** Rendered when the name is missing or outside the set above. */
  fallback?: React.ReactNode;
}

export function PluginIcon({ name, size = 20, fallback = <>📦</> }: PluginIconProps) {
  const Icon = name ? ICONS[toKebabCase(name)] : undefined;
  // A silently empty slot in a plugin list reads as a broken page, so an
  // unknown name renders the placeholder — the behaviour the bracket lookup
  // had via `IconComponent ? … : '📦'`.
  if (!Icon) return <>{fallback}</>;
  return <Icon size={size} />;
}
