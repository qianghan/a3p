/**
 * PR 3bc.8 — cash-basis reports are disabled while the tenant has OPEN
 * at_entry bills: those bills already debited expense / credited 2000 on
 * billDate, so a payment-dated (cash) P&L or balance sheet would misstate them.
 * Reports fall back to accrual and return `cashBasisDisabled` for the banner.
 */
import 'server-only';
import { unpaidBillWhere } from '@/lib/bill-amounts';

export interface CashBasisDisabled {
  reason: 'open_at_entry_bills';
  openAtEntryBillCount: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function cashBasisBlock(db: any, tenantId: string): Promise<CashBasisDisabled | null> {
  const n: number = await db.abBill.count({ where: { tenantId, postingMode: 'at_entry', ...unpaidBillWhere() } });
  return n > 0 ? { reason: 'open_at_entry_bills', openAtEntryBillCount: n } : null;
}
