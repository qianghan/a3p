/**
 * Business-type → plugin visibility gate.
 *
 * Some plugins are only relevant to tenants with a specific `businessType`
 * (e.g. AgentBook Startup only matters to startups; scholarship/career/
 * housing only matter to students). This gate hides those plugins for
 * tenants whose configured business type doesn't match, so users aren't
 * shown plugins irrelevant to them.
 *
 * Mirrors the shape of `addon-gate.ts` exactly:
 * - DEFAULT-OPEN: a plugin absent from the map is always shown.
 * - IDENTITY SHORT-CIRCUIT: when the map is empty, returns identity with
 *   zero DB queries.
 * - FAIL-CLOSED: a null/unresolvable tenant owns no business type, so
 *   business-type-gated plugins are hidden until the tenant configures one.
 *
 * Scope: this is a visibility filter for the plugin list / sidebar only —
 * it does not add backend access control to the gated plugins' own API
 * routes, matching addon-gate's existing scope.
 */

import { prisma } from '@/lib/db';
import { normalizePluginName } from '@/lib/plugins/normalize';
import type { GateablePlugin } from '@/lib/plugins/addon-gate';

export const PLUGIN_RELEVANT_BUSINESS_TYPES: Record<string, string[]> = {
  agentbookscholarship: ['student'],
  agentbookcareer: ['student'],
  agentbookhousing: ['student'],
  agentbookstartup: ['startup'],
};

export function filterByBusinessType<T extends GateablePlugin>(
  plugins: T[],
  relevantMap: Record<string, string[]>,
  businessType: string | null,
): T[] {
  return plugins.filter((p) => {
    const relevantTypes = relevantMap[normalizePluginName(p.name)];
    return !relevantTypes || (businessType !== null && relevantTypes.includes(businessType));
  });
}

export async function makeBusinessTypeGate(
  tenantId: string | null,
): Promise<<T extends GateablePlugin>(plugins: T[]) => T[]> {
  if (Object.keys(PLUGIN_RELEVANT_BUSINESS_TYPES).length === 0) {
    return (plugins) => plugins;
  }
  const config = tenantId
    ? await prisma.abTenantConfig.findUnique({
        where: { userId: tenantId },
        select: { businessType: true },
      })
    : null;
  const businessType = config?.businessType ?? null;
  return (plugins) => filterByBusinessType(plugins, PLUGIN_RELEVANT_BUSINESS_TYPES, businessType);
}
