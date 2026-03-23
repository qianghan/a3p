/**
 * Telegram Bot Webhook — Vercel serverless endpoint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Bot } from 'grammy';

// Lazy-initialize bot (cold start optimization for serverless)
let bot: Bot | null = null;

function getBot(): Bot {
  if (bot) return bot;

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  bot = new Bot(token);

  // Text messages → expense recording
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) {
      // Handle commands
      switch (text.split(' ')[0].toLowerCase()) {
        case '/start':
          await ctx.reply('👋 Welcome to AgentBook!\n\n📸 Send a receipt photo\n💬 Type an expense: "Spent $45 on lunch"\n📄 Forward a receipt email\n\n/help for more', { parse_mode: 'HTML' });
          return;
        case '/help':
          await ctx.reply('📚 <b>AgentBook Help</b>\n\n• Send a receipt photo\n• Type: "Spent $45 on lunch"\n• /balance — Cash balance\n• /tax — Tax estimate\n• /reports — Financial reports', { parse_mode: 'HTML' });
          return;
        default:
          await ctx.reply("I don't recognize that command. Type /help for options.");
          return;
      }
    }

    // Forward to expense recording API
    const tenantId = String(ctx.chat.id);
    try {
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
      const res = await fetch(`${baseUrl}/api/v1/agentbook/expense/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({
          amountCents: extractAmount(text),
          vendor: extractVendor(text),
          description: text,
          date: new Date().toISOString(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        const amt = (data.data.amountCents / 100).toFixed(2);
        await ctx.reply(`✅ Recorded: $${amt} — ${data.data.description}`, { parse_mode: 'HTML' });
      } else {
        await ctx.reply(`Could not record expense: ${data.error}`);
      }
    } catch (err) {
      await ctx.reply('Sorry, I had trouble processing that. Please try again.');
    }
  });

  // Photo messages → receipt OCR
  bot.on('message:photo', async (ctx) => {
    await ctx.reply('🧾 Reading your receipt...');
    // TODO: Wire to receipt-ocr skill via service-gateway LLM
    await ctx.reply('Receipt OCR processing will be connected in the next update. For now, please type the expense manually.');
  });

  // Document messages
  bot.on('message:document', async (ctx) => {
    await ctx.reply('📧 Document receipts will be supported soon. Please type the expense or send a photo.');
  });

  // Callback queries (inline keyboard buttons)
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery({ text: `Action: ${data}` });
    // TODO: Route callback to appropriate handler
  });

  return bot;
}

// Simple amount extraction from text
function extractAmount(text: string): number {
  const match = text.match(/\$?([\d,]+\.?\d{0,2})/);
  if (match) {
    const amount = parseFloat(match[1].replace(/,/g, ''));
    return Math.round(amount * 100);
  }
  return 0;
}

// Simple vendor extraction
function extractVendor(text: string): string | undefined {
  const atMatch = text.match(/(?:at|from|@)\s+([A-Z][A-Za-z\s&']+)/);
  return atMatch ? atMatch[1].trim() : undefined;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (expectedSecret && secret !== expectedSecret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!process.env.TELEGRAM_BOT_TOKEN) {
    return NextResponse.json({ error: 'Bot not configured' }, { status: 503 });
  }

  try {
    const b = getBot();
    const update = await request.json();
    await b.handleUpdate(update);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('Telegram webhook error:', err);
    return NextResponse.json({ ok: true }); // Always return 200 to Telegram
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'AgentBook Telegram webhook active', configured: !!process.env.TELEGRAM_BOT_TOKEN });
}
