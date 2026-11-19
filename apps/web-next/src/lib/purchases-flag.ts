import 'server-only';
import { prisma } from '@naap/database';

/**
 * Gate for at-entry AP posting (spec §5.2, PR 3bc). Off: every new bill is
 * created the legacy way (`at_payment`, no ledger impact until paid).
 * Fail-closed like the i18n flag: a missing row or lookup error means OFF.
 *
 * Rollout (3bc.10): the FeatureFlag row is either
 *   - globally on (`enabled = true`), or
 *   - off globally with a per-tenant allowlist in `metadata.tenantIds`.
 * `metadata.excludeTenantIds` always wins (even over a global on).
 * Ops path: `agentbook/enable-purchases-at-entry.ts` (dry run by default).
 *
 * Even when flagged, at_entry applies ONLY to accrual tenants (R-AP-1);
 * cash-basis tenants always keep pay-time posting (R-AP-3).
 */
export const PURCHASES_AT_ENTRY_FLAG_KEY = 'purchases_at_entry';

interface FlagRow { enabled: boolean; metadata?: unknown }

export function flagAllowsTenant(row: FlagRow | null | undefined, tenantId: string | undefined): boolean {
  if (!row) return false;
  const meta = row.metadata && typeof row.metadata === 'object' ? (row.metadata as { tenantIds?: unknown; excludeTenantIds?: unknown }) : null;
  // Exclusion wins over both the global switch and the allowlist (e2e control persona).
  if (tenantId && Array.isArray(meta?.excludeTenantIds) && meta.excludeTenantIds.includes(tenantId)) return false;
  if (row.enabled === true) return true;
  if (!tenantId || !meta) return false;
  const ids = meta.tenantIds;
  return Array.isArray(ids) && ids.includes(tenantId);
}

export async function isPurchasesAtEntryEnabled(tenantId?: string): Promise<boolean> {
  try {
    const row = await prisma.featureFlag.findUnique({ where: { key: PURCHASES_AT_ENTRY_FLAG_KEY } });
    return flagAllowsTenant(row as FlagRow | null, tenantId);
  } catch {
    return false;
  }
}

/** Does a NEW bill for this tenant post at entry? Flag on for the tenant AND accrual basis. */
export async function purchasesAtEntryApplies(
  tenantId: string,
  cfg: { accountingBasis?: string | null } | null | undefined,
): Promise<boolean> {
  if (!cfg || cfg.accountingBasis === 'cash') return false;
  return isPurchasesAtEntryEnabled(tenantId);
}
