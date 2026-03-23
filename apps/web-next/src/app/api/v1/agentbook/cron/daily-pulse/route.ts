/**
 * Daily Pulse Cron — Sends morning financial summary to all active tenants.
 * Vercel cron: "0 13 * * *" (1 PM UTC, resolves to morning in US/CA timezones)
 */

import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // TODO: Query all active tenants, check timezone, send daily pulse
    // For each tenant where it's currently 8 AM local time:
    //   1. Calculate today's income/expenses/balance
    //   2. Count items needing attention
    //   3. Send via Telegram bot

    console.log('Daily pulse cron triggered at', new Date().toISOString());

    return NextResponse.json({
      success: true,
      message: 'Daily pulse processing',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Daily pulse cron error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
