/**
 * Shared where-fragment: an expense that still counts toward reports/returns.
 * AbExpense is soft-deleted (deletedAt set); null = live. Status is NOT
 * filtered, matching the P&L / dashboard / category-breakdown rule.
 */
export function liveExpenseWhere() {
  return { deletedAt: null } as const;
}
