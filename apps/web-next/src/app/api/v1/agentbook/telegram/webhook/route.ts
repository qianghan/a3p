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
    const chatId = ctx.chat.id;
    const tenantId = String(chatId);
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];

    await ctx.reply('🧾 Reading your receipt...');

    try {
      // Get file URL from Telegram
      const file = await ctx.api.getFile(bestPhoto.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;

      // Call receipt OCR via internal API
      const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';

      // For MVP: extract basic info and create expense
      // In production: this calls service-gateway LLM vision endpoint
      const ocrResult = {
        amount_cents: 0,
        vendor: null as string | null,
        date: new Date().toISOString().split('T')[0],
        confidence: 0.5,
      };

      // Store receipt and create expense
      const res = await fetch(`${baseUrl}/api/v1/agentbook/expense/expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({
          amountCents: ocrResult.amount_cents || 1, // Placeholder until LLM processes
          vendor: ocrResult.vendor,
          description: 'Receipt photo (pending OCR)',
          date: ocrResult.date,
          receiptUrl: fileUrl,
          confidence: ocrResult.confidence,
        }),
      });
      const data = await res.json();

      if (data.success) {
        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ Correct', callback_data: `confirm:${data.data.id}` },
              { text: '✏️ Edit amount', callback_data: `edit:${data.data.id}` },
            ],
            [
              { text: '📁 Set category', callback_data: `change_cat:${data.data.id}` },
              { text: '🏠 Personal', callback_data: `personal:${data.data.id}` },
            ],
          ],
        };
        await ctx.reply(
          `🧾 Receipt saved!\n📎 Photo linked to expense.\n\nPlease set the amount and category:`,
          { reply_markup: keyboard, parse_mode: 'HTML' }
        );
      } else {
        await ctx.reply('Could not save receipt. Please try again or type the expense manually.');
      }
    } catch (err) {
      console.error('Photo receipt error:', err);
      await ctx.reply('Sorry, I couldn\'t process that receipt. Try a clearer photo, or type the expense manually.');
    }
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
