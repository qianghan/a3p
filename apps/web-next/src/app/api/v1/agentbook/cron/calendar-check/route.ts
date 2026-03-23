/**
 * Calendar Check Cron — Checks deadlines and fires alerts.
 * Vercel cron: "0 * * * *" (every hour)
 */

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // TODO: For each tenant:
    //   1. Query CalendarEngine for alertable events
    //   2. Send alerts via Telegram for events at lead time
    //   3. Mark events as 'alerted'

    console.log('Calendar check cron triggered at', new Date().toISOString());

    return NextResponse.json({
      success: true,
      message: 'Calendar check processing',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Calendar check cron error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
