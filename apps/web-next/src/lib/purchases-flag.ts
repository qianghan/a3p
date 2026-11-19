import 'server-only';
import { prisma } from '@naap/database';

/**
 * Gate for at-entry AP posting (spec §5.2, PR 3bc). Off: every new bill is
 * created the legacy way (`at_payment`, no ledger impact until paid).
 * Fail-closed like the i18n flag: a missing row or lookup error means OFF.
 */
export const PURCHASES_AT_ENTRY_FLAG_KEY = 'purchases_at_entry';

export async function isPurchasesAtEntryEnabled(): Promise<boolean> {
  try {
    const row = await prisma.featureFlag.findUnique({ where: { key: PURCHASES_AT_ENTRY_FLAG_KEY } });
    return row?.enabled ?? false;
  } catch {
    return false;
  }
}
