/**
 * Product funnel analytics (P0-7).
 *
 * Lives in @naap/billing (not a separate package) because every consumer —
 * the Next.js web app and all four plugin backends — already imports
 * @naap/billing, and the funnel is the CRO's measurement layer for revenue.
 *
 * Events (visitor → signup → trial → active → card → paid → retained):
 */
import { prisma } from '@naap/database';

export const FUNNEL_EVENTS = {
  SIGNUP_COMPLETED: 'funnel.signup_completed',
  TRIAL_STARTED: 'funnel.trial_started',
  FIRST_EXPENSE: 'funnel.first_expense',
  FIRST_REPORT: 'funnel.first_report',
  CARD_ADDED: 'funnel.card_added',
  SUBSCRIPTION_ACTIVE: 'funnel.subscription_active',
  SUBSCRIPTION_CANCELLED: 'funnel.subscription_cancelled',
} as const;

export type FunnelEventName = (typeof FUNNEL_EVENTS)[keyof typeof FUNNEL_EVENTS];

/**
 * Privacy: only these property keys are ever stored. Anything else —
 * emails, names, amounts, message contents — is dropped silently.
 * Values must be string | number | boolean.
 */
const ALLOWED_PROPERTIES = new Set(['plan_code', 'channel', 'ref', 'interval']);

/** Pure: strip disallowed keys / non-primitive values. Unit-tested. */
export function scrubProperties(
  properties: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(properties ?? {})) {
    if (!ALLOWED_PROPERTIES.has(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

export interface TrackFunnelEventInput {
  tenantId?: string;
  anonymousId?: string;
  event: FunnelEventName | string;
  properties?: Record<string, unknown>;
}

/**
 * Record one funnel transition. Never throws — analytics must not break
 * product flows. Requires at least one identity (tenantId or anonymousId).
 */
export async function trackFunnelEvent(input: TrackFunnelEventInput): Promise<void> {
  try {
    if (!input.tenantId && !input.anonymousId) return;
    await prisma.abFunnelEvent.create({
      data: {
        tenantId: input.tenantId ?? null,
        anonymousId: input.anonymousId ?? null,
        event: input.event,
        properties: scrubProperties(input.properties),
      },
    });
  } catch (err) {
    console.warn('[funnel] track failed:', err);
  }
}

export interface FunnelStatRow {
  event: string;
  count: number;
  uniqueTenants: number;
}

/**
 * Conversion table for the trailing N days, ordered by first occurrence.
 * Used by the admin funnel dashboard (GET /agentbook-core/admin/funnel/stats).
 */
export async function getFunnelStats(days: number): Promise<FunnelStatRow[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = (await prisma.$queryRaw<
    Array<{ event: string; count: bigint; uniqueTenants: bigint; firstSeen: Date }>
  >`
    SELECT event,
           COUNT(*) AS count,
           COUNT(DISTINCT "tenantId") AS "uniqueTenants",
           MIN("createdAt") AS "firstSeen"
    FROM "plugin_agentbook_core"."AbFunnelEvent"
    WHERE "createdAt" >= ${since}
    GROUP BY event
    ORDER BY "firstSeen" ASC
  `).map((r) => ({
    event: r.event,
    count: Number(r.count),
    uniqueTenants: Number(r.uniqueTenants),
    firstSeen: r.firstSeen,
  }));
  return rows.map(({ event, count, uniqueTenants }) => ({ event, count, uniqueTenants }));
}
