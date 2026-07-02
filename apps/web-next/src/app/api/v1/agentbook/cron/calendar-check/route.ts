/**
 * Calendar Check Cron — Checks deadlines and fires alerts.
 * Vercel cron: "0 * * * *" (every hour)
 *
 * Also seeds AbCalendarEvent rows per tenant from the jurisdiction packs'
 * static deadline tables (@agentbook/jurisdictions) — nothing else in the
 * codebase ever wrote to this table, so it was always empty and every field
 * this route read/wrote (alertSent, title, leadTimeDays as a scalar) had
 * already drifted from the AbCalendarEvent schema (status, titleKey,
 * leadTimeDays: Int[]) — every run threw a PrismaClientValidationError,
 * caught below and reported as a generic 500, so no alert has ever fired.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db, Prisma } from '@naap/database';
import { reportError } from '@/lib/logger';
import { createNotification } from '@/lib/notifications';
import { usPack, caPack, ukPack, auPack, type JurisdictionPack } from '@agentbook/jurisdictions';

const PACKS: Record<string, JurisdictionPack> = { us: usPack, ca: caPack, uk: ukPack, au: auPack };
const SEED_SOURCE = 'calendar-deadlines-seed';
const DEFAULT_LEAD_DAYS = [7, 3, 1, 0];

const ABBREVIATIONS: Record<string, string> = {
  irs: 'IRS', vat: 'VAT', bas: 'BAS', rrsp: 'RRSP', gst: 'GST', hst: 'HST',
  t4a: 'T4A', t1: 'T1', payg: 'PAYG', tpar: 'TPAR', sa: 'SA', se: 'SE', q1: 'Q1',
  q2: 'Q2', q3: 'Q3', q4: 'Q4',
};

function humanizeTitleKey(titleKey: string): string {
  return titleKey
    .replace(/^calendar\./, '')
    .split('_')
    .map((word) => ABBREVIATIONS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function severityForUrgency(urgency: string): 'info' | 'success' | 'warning' | 'urgent' {
  if (urgency === 'critical') return 'urgent';
  if (urgency === 'important') return 'warning';
  return 'info';
}

/** Materialize this tenant's jurisdiction deadlines (current + next year) as
 * AbCalendarEvent rows, skipping ones already seeded. */
async function seedDeadlinesForTenant(tenantId: string, jurisdiction: string, region: string, now: Date) {
  const pack = PACKS[jurisdiction] ?? PACKS.us;
  const currentYear = now.getUTCFullYear();

  const existing = await db.abCalendarEvent.findMany({
    where: { tenantId, sourceSkill: SEED_SOURCE },
    select: { titleKey: true, date: true },
  });
  const existingKeys = new Set(existing.map((e) => `${e.titleKey}|${e.date.toISOString().slice(0, 10)}`));

  const toCreate: Prisma.AbCalendarEventCreateManyInput[] = [];
  for (const year of [currentYear, currentYear + 1]) {
    for (const deadline of pack.calendarDeadlines.getDeadlines(year, region)) {
      const key = `${deadline.titleKey}|${deadline.date}`;
      if (existingKeys.has(key)) continue;
      const dateObj = new Date(`${deadline.date}T00:00:00.000Z`);
      if (dateObj < now) continue;
      toCreate.push({
        tenantId,
        eventType: 'tax_deadline',
        titleKey: deadline.titleKey,
        date: dateObj,
        leadTimeDays: DEFAULT_LEAD_DAYS,
        urgency: deadline.urgency,
        actionUrl: deadline.actionUrl ?? null,
        actionLabelKey: deadline.actionLabelKey ?? null,
        recurrence: deadline.recurrence,
        sourceSkill: SEED_SOURCE,
        status: 'upcoming',
      });
    }
  }
  if (toCreate.length) await db.abCalendarEvent.createMany({ data: toCreate });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const now = new Date();
    let alertsFired = 0;

    const tenantConfigs = await db.abTenantConfig.findMany({
      select: { userId: true, jurisdiction: true, region: true },
    });
    for (const cfg of tenantConfigs) {
      try {
        await seedDeadlinesForTenant(cfg.userId, cfg.jurisdiction, cfg.region, now);
      } catch (err) {
        reportError(`cron/calendar-check seed failed for tenant ${cfg.userId}`, err, { source: 'cron/calendar-check' });
      }
    }

    // Find all calendar events that need alerting:
    // - Event date is within the lead-time window
    // - Alert has not already been sent
    const upcomingEvents = await db.abCalendarEvent.findMany({
      where: {
        status: 'upcoming',
        date: {
          gte: now,
          lte: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000), // Next 7 days
        },
      },
      orderBy: { date: 'asc' },
    });

    for (const event of upcomingEvents) {
      const hoursUntil = (event.date.getTime() - now.getTime()) / (1000 * 60 * 60);
      const leadDays = event.leadTimeDays.length ? event.leadTimeDays : [2]; // Default 2 days lead
      const leadHours = Math.max(...leadDays) * 24;

      // Only fire alert if we're within the lead time window
      if (hoursUntil > leadHours) continue;

      // Mark as alerted
      await db.abCalendarEvent.update({
        where: { id: event.id },
        data: { status: 'alerted' },
      });

      const title = humanizeTitleKey(event.titleKey);

      // Create event for proactive engine to pick up and deliver via Telegram
      await db.abEvent.create({
        data: {
          tenantId: event.tenantId,
          eventType: 'proactive.calendar_alert',
          actor: 'system',
          action: {
            calendarEventId: event.id,
            title,
            date: event.date.toISOString(),
            eventType: event.eventType,
            hoursUntil: Math.round(hoursUntil),
          },
        },
      });

      if (event.eventType === 'tax_deadline') {
        try {
          await createNotification({
            category: 'tax_deadline',
            severity: severityForUrgency(event.urgency),
            title,
            body: `Due ${event.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}.`,
            ctaLabel: event.actionLabelKey ? 'Take action' : 'View calendar',
            ctaUrl: event.actionUrl ?? '/agentbook/tax',
            createdByType: 'system',
            createdBy: 'calendar-check-cron',
            audienceType: 'single',
            audienceFilter: { tenantId: event.tenantId },
          });
        } catch (err) {
          reportError(`cron/calendar-check notification failed for event ${event.id}`, err, { source: 'cron/calendar-check' });
        }
      }

      alertsFired++;
    }

    return NextResponse.json({
      success: true,
      alertsFired,
      eventsChecked: upcomingEvents.length,
      tenantsSeeded: tenantConfigs.length,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    void reportError('cron/calendar-check failed', err, { source: 'cron/calendar-check' });
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
