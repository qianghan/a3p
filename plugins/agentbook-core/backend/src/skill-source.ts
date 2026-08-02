import { BUILT_IN_SKILLS } from './built-in-skills.js';

/**
 * The one place that decides which skills the classifier may route to.
 *
 * This logic existed before, in apps/web-next's agent/message route, and it
 * was dead: handleAgentMessage ran its own `abSkillManifest.findMany` and
 * handed THAT array to the classifier, so the route's carefully reconciled
 * array only ever reached executeStep. Two consequences, both silent:
 *
 *   1. A built-in with no AbSkillManifest row could never be routed to. That
 *      is how `set-vendor-alias` shipped, passed its unit test, deployed, and
 *      did nothing — it is the only one of the 84 built-ins without a row.
 *   2. "Code is authoritative" never applied to a single real request, so a
 *      stale row's trigger patterns still decided routing.
 *
 * The other two channels (Telegram, WhatsApp) never had the reconcile at all,
 * which is the usual shape of this bug: logic that lives in one adapter is
 * absent everywhere else. Putting it here, next to the fetch that actually
 * feeds the classifier, makes it true for every channel at once.
 */

/** Fields code owns for a global built-in. `enabled` is deliberately absent. */
const CODE_OWNED = [
  'description',
  'category',
  'triggerPatterns',
  'requirePatterns',
  'excludePatterns',
  'parameters',
  'endpoint',
  'responseTemplate',
] as const;

/**
 * Merge the skill table with the built-ins defined in code.
 *
 * Takes ALL rows, enabled and disabled. The disabled ones are not returned,
 * but they must be visible here: a name the admin switched off has been seen,
 * and appending the code definition for it would silently switch it back on.
 * That exact resurrection was #427.
 */
export function reconcileSkills<T extends Record<string, any>>(allRows: T[]): T[] {
  const byName = new Map(BUILT_IN_SKILLS.map((s) => [s.name, s as Record<string, unknown>]));

  const reconciled = allRows
    .filter((row) => row.enabled)
    .map((row) => {
      // Tenant customisations and non-built-in sources are somebody's
      // deliberate override. Code has no business clobbering them.
      if (row.tenantId !== null || row.source !== 'built_in') return row;
      const code = byName.get(row.name);
      if (!code) return row;
      const merged: Record<string, any> = { ...row };
      for (const f of CODE_OWNED) {
        if (code[f] !== undefined) merged[f] = code[f];
      }
      return merged as T;
    });

  const seen = new Set(allRows.map((s) => s.name));
  const codeOnly = BUILT_IN_SKILLS
    .filter((s) => !seen.has(s.name))
    .map((s) => {
      const c = s as Record<string, any>;
      return {
        id: `builtin-${c.name}`,
        tenantId: null,
        name: c.name,
        description: c.description,
        category: c.category,
        triggerPatterns: c.triggerPatterns ?? [],
        requirePatterns: c.requirePatterns ?? [],
        excludePatterns: c.excludePatterns ?? [],
        parameters: c.parameters ?? {},
        endpoint: c.endpoint ?? null,
        responseTemplate: c.responseTemplate ?? null,
        confirmBefore: Boolean(c.confirmBefore),
        enabled: true,
        source: 'built_in',
        createdAt: new Date(0),
        updatedAt: new Date(0),
      } as unknown as T;
    });

  return [...reconciled, ...codeOnly];
}

/** The query the router needs: every row for this tenant, in a fixed order. */
export const SKILL_QUERY = (tenantId: string) => ({
  // No `enabled: true` here — reconcileSkills needs the disabled rows to know
  // a name has been seen. It filters them out itself.
  where: { OR: [{ tenantId: null }, { tenantId }] },
  orderBy: { name: 'asc' as const },
});
