/**
 * Morning Digest Cron
 *
 * Vercel Cron schedule: hourly at minute 0 ("0 * * * *").
 * Iterates active tenants and sends a forward-looking summary at 7am
 * local time. Telegram if configured, else email via Resend, else no-op.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';

const CORE_BASE = process.env.AGENTBOOK_CORE_URL || 'http://localhost:4050';

interface OverviewData {
  cashToday: number;
  projection: { days: { date: string; cents: number }[] } | null;
  nextMoments: { label: string; daysOut: number }[];
  attention: { id: string; title: string; amountCents?: number }[];
}

async function fetchOverview(tenantId: string): Promise<OverviewData | null> {
  try {
    const r = await fetch(`${CORE_BASE}/api/v1/agentbook-core/dashboard/overview`, {
      headers: { 'x-tenant-id': tenantId },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data ?? null;
  } catch {
    return null;
  }
}

async function fetchSummary(tenantId: string, overdueCount: number, overdueAmt: number, taxDaysOut: number | null): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      overdueCount: String(overdueCount),
      overdueAmountCents: String(overdueAmt),
      ...(taxDaysOut !== null ? { taxDaysOut: String(taxDaysOut) } : {}),
    });
    const r = await fetch(`${CORE_BASE}/api/v1/agentbook-core/dashboard/agent-summary?${params}`, {
      headers: { 'x-tenant-id': tenantId },
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.data?.summary || null;
  } catch {
    return null;
  }
}

function fmtMoney(cents: number): string {
  return '$' + Math.round(cents / 100).toLocaleString('en-US');
}

function composeMessage(name: string, overview: OverviewData, summary: string | null): string {
  const projectedEnd = overview.projection?.days.at(-1)?.cents ?? overview.cashToday;
  const endLabel = overview.projection?.days.at(-1)?.date
    ? new Date(overview.projection.days.at(-1)!.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
  return [
    `☀️ Good morning, ${name}. Cash ${fmtMoney(overview.cashToday)} today, projected ${fmtMoney(projectedEnd)} by ${endLabel}.`,
    summary ? `*Heads up:* ${summary}` : null,
    '/open to see the full dashboard.',
  ].filter(Boolean).join('\n');
}

async function sendTelegram(tenantId: string, message: string): Promise<boolean> {
  const bot = await db.abTelegramBot.findFirst({ where: { tenantId, enabled: true } });
  if (!bot) return false;
  const chats = Array.isArray(bot.chatIds) ? (bot.chatIds as string[]) : [];
  if (chats.length === 0) return false;
  for (const chatId of chats) {
    await fetch(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    }).catch(() => null);
  }
  return true;
}

async function sendEmail(userId: string, message: string): Promise<boolean> {
  if (!process.env.RESEND_API_KEY) return false;
  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user?.email) return false;
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'AgentBook <noreply@agentbook.app>',
      to: user.email,
      subject: 'Your AgentBook morning summary',
      text: message,
    }),
  }).catch(() => null);
  return true;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = request.headers.get('authorization');
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const tenants = await db.abTenantConfig.findMany({ where: { dailyDigestEnabled: true } });
  const now = new Date();
  let sent = 0;
  let skipped = 0;
  let errors = 0;

  for (const tenant of tenants) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tenant.timezone || 'America/New_York' });
      const localHour = parseInt(fmt.format(now), 10);
      if (localHour !== 7) { skipped++; continue; }

      const overview = await fetchOverview(tenant.userId);
      if (!overview) { errors++; continue; }

      const overdueItems = overview.attention.filter(a => a.id.startsWith('overdue:'));
      const overdueAmt = overdueItems.reduce((s, a) => s + (a.amountCents || 0), 0);
      const taxMoment = overview.nextMoments.find(m => m.label.startsWith('📋'));
      const taxDaysOut = taxMoment ? taxMoment.daysOut : null;

      const summary = await fetchSummary(tenant.userId, overdueItems.length, overdueAmt, taxDaysOut);
      const user = await db.user.findUnique({ where: { id: tenant.userId } });
      const name = user?.displayName || 'there';

      const message = composeMessage(name, overview, summary);
      const tgSent = await sendTelegram(tenant.userId, message);
      if (!tgSent) await sendEmail(tenant.userId, message);
      sent++;
    } catch (err) {
      console.error('[morning-digest] tenant error', tenant.userId, err);
      errors++;
    }
  }

  return NextResponse.json({ ok: true, sent, skipped, errors, timestamp: new Date().toISOString() });
}
