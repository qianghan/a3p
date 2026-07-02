/**
 * Notifications scheduled-send cron — picks up AbNotification rows an admin
 * scheduled for a future time and dispatches them once that time arrives.
 * Vercel cron: every 10 minutes (see vercel.json).
 *
 * Immediate ("send now") notifications never touch this cron — they dispatch
 * synchronously from the admin composer's POST. This only handles the
 * scheduledFor-in-the-future case.
 */
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { dispatchNotification } from '@/lib/notifications';
import { reportError } from '@/lib/logger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const due = await db.abNotification.findMany({
      where: { status: 'pending', scheduledFor: { lte: new Date() } },
      select: { id: true },
      take: 50,
    });

    let dispatched = 0;
    for (const n of due) {
      try {
        await dispatchNotification(n.id);
        dispatched++;
      } catch (err) {
        reportError(`[notifications-dispatch] notification ${n.id}`, err);
      }
    }

    return NextResponse.json({ success: true, data: { checked: due.length, dispatched } });
  } catch (err) {
    reportError('[notifications-dispatch] cron failed', err);
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
