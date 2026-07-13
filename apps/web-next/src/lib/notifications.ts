import 'server-only';
import { prisma } from '@naap/database';
import { sendNotificationEmail } from './email';

/**
 * Notification center core — see docs/superpowers/specs/2026-07-01-admin-notifications-design.md.
 *
 * One AbNotification row per message (admin broadcast or system trigger).
 * Audience resolution happens at dispatch time, not compose time, so a
 * segment ("everyone on the Pro plan") reflects who qualifies *when it
 * sends*, not who qualified when an admin clicked "schedule."
 */

/** Categories that must always reach the user regardless of preference —
 * same treatment as a password-reset email. Everything else is opt-out-able. */
export const COMPLIANCE_LOCKED_CATEGORIES = new Set(['tax_deadline', 'invoice_due', 'expense_review']);

export const NOTIFICATION_CATEGORIES = [
  'feature',
  'reward',
  'referral_thanks',
  'tax_deadline',
  'invoice_due',
  'expense_review',
  'admin_broadcast',
  'budget_alert',
  'net_worth_update',
  'savings_warning',
] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Segment DSL for audienceType='segment'. All specified fields are AND-ed. */
export interface SegmentFilter {
  planCodes?: string[]; // OR-matched within this field
  signupAfter?: string; // ISO date
  signupBefore?: string; // ISO date
  minInvitesSent?: number;
  minInvitesPaid?: number;
  hasReward?: boolean; // rewardMonths > 0 for at least one of their referrals
}

export interface ListFilter {
  tenantIds?: string[];
  emails?: string[];
}

export interface CreateNotificationInput {
  category: NotificationCategory;
  severity?: 'info' | 'success' | 'warning' | 'urgent';
  title: string;
  body: string;
  ctaLabel?: string;
  ctaUrl?: string;
  createdByType: 'admin' | 'system';
  createdBy?: string;
  audienceType: 'all' | 'plan' | 'segment' | 'list' | 'single';
  audienceFilter?: SegmentFilter | ListFilter | { planCodes: string[] } | { tenantId: string };
  scheduledFor?: Date | null;
}

export async function createNotification(input: CreateNotificationInput) {
  const notification = await prisma.abNotification.create({
    data: {
      category: input.category,
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body,
      ctaLabel: input.ctaLabel,
      ctaUrl: input.ctaUrl,
      createdByType: input.createdByType,
      createdBy: input.createdBy,
      audienceType: input.audienceType,
      audienceFilter: (input.audienceFilter as any) ?? undefined,
      scheduledFor: input.scheduledFor ?? null,
      status: 'pending',
    },
  });

  // Immediate sends dispatch right away; scheduled sends wait for the
  // notifications-dispatch cron (PR-2) to pick them up once scheduledFor arrives.
  if (!input.scheduledFor) {
    await dispatchNotification(notification.id);
  }
  return notification;
}

/** Resolve which tenants a notification's audience spec currently matches. */
export async function resolveAudienceTenantIds(
  audienceType: string,
  audienceFilter: unknown,
): Promise<string[]> {
  if (audienceType === 'single') {
    const f = audienceFilter as { tenantId?: string } | null;
    return f?.tenantId ? [f.tenantId] : [];
  }

  if (audienceType === 'list') {
    const f = (audienceFilter as ListFilter) || {};
    const ids = new Set<string>(f.tenantIds ?? []);
    if (f.emails?.length) {
      const users = await prisma.user.findMany({ where: { email: { in: f.emails } }, select: { id: true } });
      users.forEach((u) => ids.add(u.id));
    }
    return [...ids];
  }

  if (audienceType === 'all') {
    const users = await prisma.user.findMany({ select: { id: true } });
    return users.map((u) => u.id);
  }

  if (audienceType === 'plan') {
    const f = (audienceFilter as { planCodes?: string[] }) || {};
    if (!f.planCodes?.length) return [];
    const subs = await prisma.billSubscription.findMany({
      where: { plan: { code: { in: f.planCodes } } },
      select: { accountId: true },
    });
    return subs.map((s) => s.accountId);
  }

  if (audienceType === 'segment') {
    const f = (audienceFilter as SegmentFilter) || {};
    const userWhere: Record<string, unknown> = {};
    if (f.signupAfter || f.signupBefore) {
      userWhere.createdAt = {
        ...(f.signupAfter ? { gte: new Date(f.signupAfter) } : {}),
        ...(f.signupBefore ? { lte: new Date(f.signupBefore) } : {}),
      };
    }
    let candidateIds: string[] | null = null;

    if (Object.keys(userWhere).length > 0) {
      const users = await prisma.user.findMany({ where: userWhere, select: { id: true } });
      candidateIds = users.map((u) => u.id);
    }

    if (f.planCodes?.length) {
      const subs = await prisma.billSubscription.findMany({
        where: { plan: { code: { in: f.planCodes } } },
        select: { accountId: true },
      });
      const planIds = new Set(subs.map((s) => s.accountId));
      candidateIds = candidateIds === null ? [...planIds] : candidateIds.filter((id) => planIds.has(id));
    }

    if (f.minInvitesSent != null || f.minInvitesPaid != null || f.hasReward != null) {
      const referrals = await prisma.billReferral.groupBy({
        by: ['referrerTenantId'],
        _count: { _all: true },
      });
      const paidReferrals =
        f.minInvitesPaid != null || f.hasReward != null
          ? await prisma.billReferral.findMany({ where: { status: 'paid' }, select: { referrerTenantId: true, rewardMonths: true } })
          : [];
      const sentByTenant = new Map(referrals.map((r) => [r.referrerTenantId, r._count._all]));
      const paidByTenant = new Map<string, number>();
      const rewardByTenant = new Map<string, number>();
      for (const r of paidReferrals) {
        paidByTenant.set(r.referrerTenantId, (paidByTenant.get(r.referrerTenantId) ?? 0) + 1);
        rewardByTenant.set(r.referrerTenantId, (rewardByTenant.get(r.referrerTenantId) ?? 0) + r.rewardMonths);
      }
      const allTenantIdsWithReferrals = new Set([...sentByTenant.keys(), ...paidByTenant.keys()]);
      const matching = [...allTenantIdsWithReferrals].filter((id) => {
        if (f.minInvitesSent != null && (sentByTenant.get(id) ?? 0) < f.minInvitesSent) return false;
        if (f.minInvitesPaid != null && (paidByTenant.get(id) ?? 0) < f.minInvitesPaid) return false;
        if (f.hasReward != null && ((rewardByTenant.get(id) ?? 0) > 0) !== f.hasReward) return false;
        return true;
      });
      const matchingSet = new Set(matching);
      candidateIds = candidateIds === null ? matching : candidateIds.filter((id) => matchingSet.has(id));
    }

    return candidateIds ?? [];
  }

  return [];
}

/** Effective per-channel preference for a tenant/category. Absent row = on
 * for both channels; compliance-locked categories are always on. */
export async function resolvePreference(
  tenantId: string,
  category: string,
): Promise<{ inApp: boolean; email: boolean }> {
  if (COMPLIANCE_LOCKED_CATEGORIES.has(category)) return { inApp: true, email: true };

  const pref = await prisma.abNotificationPreference.findUnique({
    where: { tenantId_category: { tenantId, category } },
  });
  if (!pref) return { inApp: true, email: true };
  return { inApp: pref.inAppEnabled, email: pref.emailEnabled };
}

/**
 * Resolve audience, fan out AbNotificationRecipient rows, send email where
 * enabled. Idempotent per (notification, tenant, channel) via the unique
 * constraint — safe to call more than once for the same notification (e.g.
 * a cron retry) without double-sending email.
 */
export async function dispatchNotification(notificationId: string): Promise<{ sent: number; skipped: number }> {
  const notification = await prisma.abNotification.findUnique({ where: { id: notificationId } });
  if (!notification || notification.status === 'sent') return { sent: 0, skipped: 0 };

  await prisma.abNotification.update({ where: { id: notificationId }, data: { status: 'dispatching' } });

  const tenantIds = await resolveAudienceTenantIds(notification.audienceType, notification.audienceFilter);
  let sent = 0;
  let skipped = 0;

  for (const tenantId of tenantIds) {
    const pref = await resolvePreference(tenantId, notification.category);

    if (pref.inApp) {
      await prisma.abNotificationRecipient.upsert({
        where: { notificationId_tenantId_channel: { notificationId, tenantId, channel: 'in_app' } },
        create: { notificationId, tenantId, channel: 'in_app', deliveredAt: new Date() },
        update: {},
      });
      sent++;
    } else {
      skipped++;
    }

    if (pref.email) {
      const existing = await prisma.abNotificationRecipient.findUnique({
        where: { notificationId_tenantId_channel: { notificationId, tenantId, channel: 'email' } },
      });
      if (!existing) {
        const user = await prisma.user.findUnique({ where: { id: tenantId }, select: { email: true } });
        let emailStatus = 'skipped_opted_out';
        if (user?.email) {
          const result = await sendNotificationEmail(user.email, {
            title: notification.title,
            body: notification.body,
            ctaLabel: notification.ctaLabel ?? undefined,
            ctaUrl: notification.ctaUrl ?? undefined,
          });
          emailStatus = result.success ? 'sent' : 'failed';
        }
        await prisma.abNotificationRecipient.create({
          data: { notificationId, tenantId, channel: 'email', deliveredAt: new Date(), emailStatus },
        });
      }
    } else {
      await prisma.abNotificationRecipient.upsert({
        where: { notificationId_tenantId_channel: { notificationId, tenantId, channel: 'email' } },
        create: { notificationId, tenantId, channel: 'email', emailStatus: 'skipped_opted_out' },
        update: {},
      });
    }
  }

  await prisma.abNotification.update({
    where: { id: notificationId },
    data: { status: 'sent', dispatchedAt: new Date() },
  });

  return { sent, skipped };
}
