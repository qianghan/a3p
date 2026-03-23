/**
 * Telegram Bot Webhook — Vercel serverless endpoint.
 *
 * Receives all Telegram messages and routes them through
 * the AgentBook agent framework.
 *
 * Setup: Register this URL with Telegram Bot API:
 * https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-app.vercel.app/api/v1/agentbook/telegram/webhook
 */

import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify webhook secret
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const update = await request.json();

    // TODO: Initialize bot with agent framework handlers
    // For now, log the update
    console.log('Telegram update received:', JSON.stringify(update).substring(0, 200));

    // The actual bot processing will be wired up when the framework
    // integration is complete. This route is the serverless entry point.

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Telegram webhook error:', err);
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}

// Telegram only sends POST
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'AgentBook Telegram webhook active' });
}
