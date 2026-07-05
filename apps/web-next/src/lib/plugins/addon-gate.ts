/**
 * Add-on → plugin visibility gate.
 *
 * Some plugins are only visible to a user who holds an active paid add-on
 * subscription (the "Student Success" bundle gates the three student
 * plugins; the Startup plugin can be gated the same way). The personalized-
 * plugins route otherwise gates only by `isCore` + team membership, never by
 * subscription — this is the missing primitive.
 *
 * Design properties that make this safe to add to a hot path:
 *  - DEFAULT-OPEN: a plugin with no entry in PLUGIN_REQUIRED_ADDON is always
 *    returned, so existing free plugins are provably unaffected.
 *  - IDENTITY SHORT-CIRCUIT: when the map is empty (no gated plugin exists
 *    yet), `makeAddOnGate` returns the identity function and performs NO
 *    billing query at all — zero behavior change and zero added latency
 *    until the first gated plugin ships.
 *  - FAIL-CLOSED: `activeAddOnCodes` returns an empty set on any error, and a
 *    null tenant (unauthenticated / user-not-found) is treated as owning
 *    nothing, so a gated plugin is hidden rather than leaked when entitlement
 *    can't be confirmed.
 */

import { activeAddOnCodes } from '@naap/billing';
import { normalizePluginName } from '@/lib/plugins/normalize';

/**
 * Maps a normalized plugin name → the add-on code required to see it.
 * EMPTY until the first gated plugin ships. When the student plugins land,
 * add e.g. `'agentbookscholarship': 'student_success'` here (keys are
 * normalized names — see normalizePluginName).
 */
export const PLUGIN_REQUIRED_ADDON: Record<string, string> = {
  // 'agentbookscholarship': 'student_success',
  // 'agentbookcareer': 'student_success',
  // 'agentbookhousing': 'student_success',
};

/** Minimal shape the gate needs from a plugin record. */
export interface GateablePlugin {
  name: string;
}

/**
 * Pure gating rule (no I/O) — kept separate so it's unit-testable without a
 * database: keep a plugin unless it requires an add-on the tenant doesn't
 * own. Default-open: a plugin absent from `requiredMap` always passes.
 */
export function filterByAddOn<T extends GateablePlugin>(
  plugins: T[],
  requiredMap: Record<string, string>,
  ownedCodes: Set<string>,
): T[] {
  return plugins.filter((p) => {
    const required = requiredMap[normalizePluginName(p.name)];
    return !required || ownedCodes.has(required);
  });
}

/**
 * Build a synchronous filter that hides plugins whose required add-on the
 * tenant does not hold. Pass the resolved tenant/user id, or null when there
 * is no authenticated user (→ owns nothing → gated plugins hidden).
 *
 * Returns the identity function when nothing is gated, avoiding any billing
 * query in the common case.
 */
export async function makeAddOnGate(
  tenantId: string | null,
): Promise<<T extends GateablePlugin>(plugins: T[]) => T[]> {
  // Nothing is gated anywhere → no query, no filtering.
  if (Object.keys(PLUGIN_REQUIRED_ADDON).length === 0) {
    return (plugins) => plugins;
  }
  const owned = tenantId ? await activeAddOnCodes(tenantId) : new Set<string>();
  return (plugins) => filterByAddOn(plugins, PLUGIN_REQUIRED_ADDON, owned);
}
