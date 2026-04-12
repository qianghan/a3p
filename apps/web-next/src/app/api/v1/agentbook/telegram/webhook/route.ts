/**
 * Telegram Bot Webhook — Vercel serverless endpoint.
 */
import { NextRequest, NextResponse } from 'next/server';
import { Bot } from 'grammy';

// Telegram chat ID → AgentBook user ID mapping
// In production: stored in DB. For dev: hardcoded.
const CHAT_TO_TENANT: Record<string, string> = {
  '5336658682': '2e2348b6-a64c-44ad-907e-4ac120ff06f2', // Qiang → Maya
};

function resolveTenantId(chatId: number): string {
  return CHAT_TO_TENANT[String(chatId)] || String(chatId);
}

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
    const tenantId = resolveTenantId(ctx.chat.id);
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

  // Photo messages → Blob upload → Gemini OCR → auto-record
  bot.on('message:photo', async (ctx) => {
    const tenantId = resolveTenantId(ctx.chat.id);
    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];

    await ctx.reply('🧾 Reading your receipt...');

    try {
      const file = await ctx.api.getFile(bestPhoto.file_id);
      const telegramUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const expenseApi = process.env.AGENTBOOK_EXPENSE_URL || 'http://localhost:4051';

      // 1. Upload to permanent storage
      const blobRes = await fetch(`${expenseApi}/api/v1/agentbook-expense/receipts/upload-blob`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ sourceUrl: telegramUrl }),
      });
      const blobData = await blobRes.json() as any;
      const receiptUrl = blobData.data?.permanentUrl || telegramUrl;

      // 2. Call OCR with permanent URL
      const ocrRes = await fetch(`${expenseApi}/api/v1/agentbook-expense/receipts/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ imageUrl: receiptUrl }),
      });
      const ocrData = await ocrRes.json() as any;
      const ocr = ocrData.data || {};

      if (ocr.autoRecorded && ocr.expenseId) {
        // High confidence — auto-recorded
        const amt = ((ocr.amount_cents || 0) / 100).toFixed(2);
        const keyboard = {
          inline_keyboard: [
            [
              { text: '✅ Correct', callback_data: `confirm:${ocr.expenseId}` },
              { text: '✏️ Edit', callback_data: `edit:${ocr.expenseId}` },
            ],
            [
              { text: '📁 Category', callback_data: `change_cat:${ocr.expenseId}` },
              { text: '🏠 Personal', callback_data: `personal:${ocr.expenseId}` },
            ],
          ],
        };
        await ctx.reply(
          `🧾 <b>Receipt recorded!</b>\n\n💰 <b>$${amt}</b>${ocr.vendor ? ` at ${ocr.vendor}` : ''}${ocr.date ? `\n📅 ${ocr.date}` : ''}\n🔍 Confidence: ${Math.round((ocr.confidence || 0) * 100)}%`,
          { reply_markup: keyboard, parse_mode: 'HTML' }
        );
      } else if (ocr.amount_cents > 0) {
        // Low confidence — create as pending review
        const expRes = await fetch(`${expenseApi}/api/v1/agentbook-expense/expenses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            amountCents: ocr.amount_cents,
            vendor: ocr.vendor,
            description: `Receipt: ${ocr.vendor || 'Unknown'}`,
            date: ocr.date || new Date().toISOString(),
            receiptUrl,
            confidence: ocr.confidence || 0.4,
            source: 'telegram_photo',
            status: 'pending_review',
          }),
        });
        const expData = await expRes.json() as any;
        const amt = ((ocr.amount_cents || 0) / 100).toFixed(2);
        const keyboard = {
          inline_keyboard: [
            [
              { text: `✅ Confirm $${amt}`, callback_data: `confirm:${expData.data?.id}` },
              { text: '✏️ Edit amount', callback_data: `edit:${expData.data?.id}` },
            ],
            [{ text: '❌ Reject', callback_data: `reject:${expData.data?.id}` }],
          ],
        };
        await ctx.reply(
          `🧾 <b>Receipt scanned</b> (needs review)\n\n💰 $${amt}${ocr.vendor ? ` — ${ocr.vendor}` : ''}\n🔍 Low confidence (${Math.round((ocr.confidence || 0) * 100)}%)\n\nPlease confirm or edit:`,
          { reply_markup: keyboard, parse_mode: 'HTML' }
        );
      } else {
        // OCR failed entirely
        await ctx.reply(
          '🧾 I saved the receipt photo but couldn\'t read the amount.\n\nPlease type the expense, e.g.: "Spent $45 on lunch at Starbucks"',
          { parse_mode: 'HTML' }
        );
      }
    } catch (err) {
      console.error('Photo receipt error:', err);
      await ctx.reply('Sorry, I couldn\'t process that receipt. Try a clearer photo, or type the expense manually.');
    }
  });

  // Document messages (PDF receipts/statements) → Blob upload → OCR
  bot.on('message:document', async (ctx) => {
    const tenantId = resolveTenantId(ctx.chat.id);
    const doc = ctx.message.document;
    const fileName = doc.file_name || 'document';
    const mimeType = doc.mime_type || '';

    // Only handle PDFs and images
    if (!mimeType.includes('pdf') && !mimeType.includes('image')) {
      await ctx.reply('I can process PDF receipts and images. Please send a receipt photo or PDF.');
      return;
    }

    await ctx.reply(`📄 Processing ${fileName}...`);

    try {
      const file = await ctx.api.getFile(doc.file_id);
      const telegramUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
      const expenseApi = process.env.AGENTBOOK_EXPENSE_URL || 'http://localhost:4051';

      // 1. Upload to permanent storage
      const blobRes = await fetch(`${expenseApi}/api/v1/agentbook-expense/receipts/upload-blob`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ sourceUrl: telegramUrl }),
      });
      const blobData = await blobRes.json() as any;
      const receiptUrl = blobData.data?.permanentUrl || telegramUrl;

      // 2. Call OCR
      const ocrRes = await fetch(`${expenseApi}/api/v1/agentbook-expense/receipts/ocr`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        body: JSON.stringify({ imageUrl: receiptUrl }),
      });
      const ocrData = await ocrRes.json() as any;
      const ocr = ocrData.data || {};

      if (ocr.autoRecorded && ocr.expenseId) {
        const amt = ((ocr.amount_cents || 0) / 100).toFixed(2);
        await ctx.reply(
          `📄 <b>Document processed!</b>\n\n💰 <b>$${amt}</b>${ocr.vendor ? ` — ${ocr.vendor}` : ''}\n✅ Auto-recorded to your books.`,
          { parse_mode: 'HTML' }
        );
      } else if (ocr.amount_cents > 0) {
        const expRes = await fetch(`${expenseApi}/api/v1/agentbook-expense/expenses`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({
            amountCents: ocr.amount_cents,
            vendor: ocr.vendor,
            description: `PDF: ${ocr.vendor || fileName}`,
            date: ocr.date || new Date().toISOString(),
            receiptUrl,
            confidence: ocr.confidence || 0.4,
            source: 'telegram_pdf',
            status: 'pending_review',
          }),
        });
        const expData = await expRes.json() as any;
        const amt = ((ocr.amount_cents || 0) / 100).toFixed(2);
        const keyboard = {
          inline_keyboard: [
            [
              { text: `✅ Confirm $${amt}`, callback_data: `confirm:${expData.data?.id}` },
              { text: '✏️ Edit', callback_data: `edit:${expData.data?.id}` },
            ],
          ],
        };
        await ctx.reply(
          `📄 <b>Document scanned</b>\n\n💰 $${amt}${ocr.vendor ? ` — ${ocr.vendor}` : ''}\n📎 ${fileName}\n\nPlease confirm:`,
          { reply_markup: keyboard, parse_mode: 'HTML' }
        );
      } else {
        await ctx.reply(`📄 Saved ${fileName} but couldn't extract expense data.\n\nPlease type the expense manually.`);
      }
    } catch (err) {
      console.error('Document receipt error:', err);
      await ctx.reply('Sorry, I couldn\'t process that document. Try sending it as a photo instead.');
    }
  });

  // Callback queries (inline keyboard buttons)
  bot.on('callback_query:data', async (ctx) => {
    const cbData = ctx.callbackQuery.data;
    const tenantId = ctx.chat?.id ? resolveTenantId(ctx.chat.id) : '';
    const expenseApi = process.env.AGENTBOOK_EXPENSE_URL || 'http://localhost:4051';

    try {
      const [action, expenseId] = cbData.split(':');

      if (action === 'confirm' && expenseId) {
        await fetch(`${expenseApi}/api/v1/agentbook-expense/expenses/${expenseId}/confirm`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        });
        await ctx.answerCallbackQuery({ text: '✅ Expense confirmed!' });
        await ctx.editMessageText('✅ Expense confirmed and posted to your books.');
      } else if (action === 'reject' && expenseId) {
        await fetch(`${expenseApi}/api/v1/agentbook-expense/expenses/${expenseId}/reject`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
        });
        await ctx.answerCallbackQuery({ text: '❌ Expense rejected' });
        await ctx.editMessageText('❌ Expense rejected.');
      } else if (action === 'personal' && expenseId) {
        await fetch(`${expenseApi}/api/v1/agentbook-expense/expenses/${expenseId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'x-tenant-id': tenantId },
          body: JSON.stringify({ isPersonal: true }),
        });
        await ctx.answerCallbackQuery({ text: '🏠 Marked as personal' });
        await ctx.editMessageText('🏠 Marked as personal expense (excluded from business books).');
      } else {
        await ctx.answerCallbackQuery({ text: `Action: ${cbData}` });
      }
    } catch (err) {
      console.error('Callback error:', err);
      await ctx.answerCallbackQuery({ text: 'Error processing action' });
    }
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
    // Grammy requires bot.init() before handling updates in serverless
    if (!b.isInited()) {
      await b.init();
    }
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
