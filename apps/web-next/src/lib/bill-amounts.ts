/**
 * Re-export of the shared bill-amount rules (one source for the Next readers
 * and the chat skills). See plugins/agentbook-core/backend/src/bill-amounts.ts.
 */
export {
  UNPAID_BILL_STATUSES,
  liveBillWhere,
  unpaidBillWhere,
  isUnpaid,
  outstandingCents,
  sumOutstanding,
  derivedPayableCents,
  summarizeUnpaidBills,
  type BillAmountLike,
} from '@agentbook-core/bill-amounts';
