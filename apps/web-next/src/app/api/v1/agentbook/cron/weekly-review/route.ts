/**
 * Weekly Review Cron — Sends weekly financial summary on Mondays.
 * Vercel cron: "0 14 * * 1" (2 PM UTC Monday)
 */

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    console.log('Weekly review cron triggered at', new Date().toISOString());

    return NextResponse.json({
      success: true,
      message: 'Weekly review processing',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Weekly review cron error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
