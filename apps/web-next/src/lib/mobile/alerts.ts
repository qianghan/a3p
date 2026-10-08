/**
 * Mobile alert helpers. `missingReceiptWhere` is the ONE server definition of
 * a "missing receipt", used by GET /agentbook-core/mobile/home AND
 * GET /agentbook-expense/advisor/proactive-alerts AND the cron/proactive-alerts
 * Telegram/push nag, so every surface agrees.
 *
 * Type-only Prisma import: safe for client bundles that import rankAlerts.
 */
import type { Prisma } from '@naap/database';
import type { AlertSeverity, MobileAlert } from './types';

export const MISSING_RECEIPT_WINDOW_DAYS = 90;
/** proactive-alerts' long-standing threshold: business expenses OVER $25 (strictly greater). */
export const MISSING_RECEIPT_MIN_CENTS = 2500;
export const MAX_ALERTS = 5;
const DAY_MS = 86_400_000;

export function missingReceiptWhere(tenantId: string, now: Date = new Date()): Prisma.AbExpenseWhereInput {
  return {
    tenantId,
    isPersonal: false,
    status: 'confirmed',
    deletedAt: null,
    archivedAt: null,
    receiptUrl: null,
    amountCents: { gt: MISSING_RECEIPT_MIN_CENTS },
    date: { gte: new Date(now.getTime() - MISSING_RECEIPT_WINDOW_DAYS * DAY_MS) },
    // receiptStatus is nullable. `{ not: 'skipped' }` alone compiles to
    // `receiptStatus <> 'skipped'`, which is never true for NULL in Postgres,
    // and would silently drop every legacy row.
    OR: [{ receiptStatus: null }, { receiptStatus: { not: 'skipped' } }],
  };
}

const SEVERITY_ORDER: Record<AlertSeverity, number> = { critical: 0, warn: 1, info: 2 };

/** Principle 4: no alert or button sends a phone user to a desktop page. */
export function isMobileRoute(route: string): boolean {
  return route === '/app' || route.startsWith('/app/');
}

/** critical > warn > info, stable within a severity, max 5; non-mobile targets dropped. */
export function rankAlerts(candidates: MobileAlert[]): MobileAlert[] {
  return candidates
    .filter((a) => !a.target || isMobileRoute(a.target.route))
    .map((alert, index) => ({ alert, index }))
    .sort((x, y) => SEVERITY_ORDER[x.alert.severity] - SEVERITY_ORDER[y.alert.severity] || x.index - y.index)
    .slice(0, MAX_ALERTS)
    .map(({ alert }) => alert);
}
