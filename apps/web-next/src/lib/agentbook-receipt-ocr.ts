import 'server-only';
import { prisma as db } from '@naap/database';

/**
 * Receipt OCR and expense creation — the shared pipeline behind every channel
 * a photo can arrive on.
 *
 * This all lived inside the Telegram webhook route. Nothing in it was
 * Telegram-specific — no reply formatting, no bot context, no translation
 * calls — but living in a route file meant the only way for a second channel
 * to scan a receipt was to write the whole thing again. WhatsApp had it
 * declared out of scope for exactly that reason and shipped text-only.
 *
 * Moved verbatim, so Telegram's behaviour is unchanged: the only edits are
 * the `source` union gaining the WhatsApp values and the log prefixes losing
 * the word "telegram".
 *
 * `ingestReceipt` at the bottom is the new part. It composes the quota check,
 * the OCR, the blob persistence and the expense row into ONE call, so a
 * channel cannot pick up three of the four — most consequentially, cannot
 * scan receipts while skipping the metered quota that is supposed to bill
 * for them.
 */

function normalizeVendorName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

/**
 * The Gemini credentials, from the env or the admin-configured provider row.
 * Exported because voice transcription needs the same lookup — it lived here
 * only because receipt OCR happened to be written first.
 */
export async function getGeminiKey(): Promise<{ apiKey: string; modelVision: string } | null> {
  if (process.env.GEMINI_API_KEY) {
    return {
      apiKey: process.env.GEMINI_API_KEY,
      modelVision: process.env.GEMINI_MODEL_VISION || 'gemini-2.5-flash',
    };
  }
  try {
    const cfg = await db.abLLMProviderConfig.findFirst({
      where: { enabled: true, isDefault: true, provider: 'gemini' },
    });
    if (cfg?.apiKey) {
      return { apiKey: cfg.apiKey, modelVision: cfg.modelVision || cfg.modelStandard || 'gemini-2.5-flash' };
    }
  } catch (err) {
    console.warn('[receipt/ocr] LLM config lookup failed:', err);
  }
  return null;
}

/**
 * Which channel a receipt arrived on. Stored on the expense, so it is also
 * the audit trail for "where did this row come from".
 */
export type ReceiptSource =
  | 'telegram_photo' | 'telegram_pdf'
  | 'whatsapp_photo' | 'whatsapp_pdf';

export interface ReceiptOcrResult {
  amount_cents: number;
  vendor: string | null;
  date: string;
  currency: string;
  items: string | null;
  tax_cents: number;
  tip_cents: number;
  confidence: number;
}

/** Run Gemini Vision OCR on a receipt image or PDF URL. Returns null on failure. */
export async function ocrReceipt(fileUrl: string, hintMime?: string): Promise<ReceiptOcrResult | null> {
  const cfg = await getGeminiKey();
  if (!cfg) return null;

  let imagePart: { inlineData: { mimeType: string; data: string } } | { text: string };
  try {
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`fetch ${fileRes.status}`);
    const buf = await fileRes.arrayBuffer();
    const headerMime = fileRes.headers.get('content-type') || '';
    // Trust the explicit hint over a generic header (Telegram serves PDFs as
    // application/octet-stream, which Gemini rejects).
    let mimeType = (hintMime && hintMime !== 'application/octet-stream' ? hintMime : headerMime) || '';
    if (!mimeType || mimeType === 'application/octet-stream') {
      mimeType = fileUrl.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg';
    }
    // Gemini accepts inline PDFs up to ~20 MB; images are typically capped
    // around 4 MB before performance/quality drops noticeably. Use a single
    // 18 MB budget for both — anything larger falls back to a URL hint.
    if (buf.byteLength > 18_000_000) {
      imagePart = { text: `[File too large for inline OCR — ${(buf.byteLength / 1_000_000).toFixed(1)} MB. URL: ${fileUrl}]` };
    } else {
      imagePart = { inlineData: { mimeType, data: Buffer.from(buf).toString('base64') } };
    }
  } catch (err) {
    console.warn('[receipt/ocr] file download failed:', err);
    return null;
  }

  const systemPrompt = `You are an expert receipt and invoice scanner. The input may be a photo OR a PDF (single- or multi-page).

INSTRUCTIONS:
- For a multi-page PDF, treat the entire document as one purchase — find the GRAND TOTAL on whichever page it appears.
- The TOTAL / AMOUNT DUE is the most important field — usually the largest number, often after "Total"/"Amount Due"/"Grand Total"/"Balance Due".
- Vendor/merchant/issuer name is usually at the top of page 1. Return the CANONICAL BRAND NAME, not the raw print: "STARBUCKS #4521 PORTLAND OR" → "Starbucks", "WAL-MART STORE 0042" → "Walmart", "SHELL OIL 12-345-6789" → "Shell". Strip store numbers, location codes, and shouty caps.
- Date may be MM/DD/YYYY, YYYY-MM-DD, DD/MM/YYYY, or "Mon DD YYYY". Pick the issue/transaction date, not the due date if a separate due date exists.
- amount_cents is the GRAND TOTAL in CENTS (e.g., $45.99 = 4599, $1,234.56 = 123456).
- If you can't read the total at all, set amount_cents=0 and confidence=0.

Return ONLY valid JSON:
{"amount_cents": <int>, "vendor": "<string|null>", "date": "<YYYY-MM-DD>", "currency": "USD|CAD", "items": "<string|null>", "tax_cents": <int>, "tip_cents": <int>, "confidence": <0.0-1.0>}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${cfg.modelVision}:generateContent?key=${cfg.apiKey}`;
  let llmRes: Response;
  try {
    llmRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [imagePart, { text: 'Extract the receipt data.' }] }],
        generationConfig: { maxOutputTokens: 2048, temperature: 0.1 },
      }),
    });
  } catch (err) {
    console.warn('[receipt/ocr] Gemini fetch failed:', err);
    return null;
  }

  if (!llmRes.ok) {
    const body = await llmRes.text().catch(() => '');
    console.warn('[receipt/ocr] Gemini HTTP error:', llmRes.status, body.slice(0, 300));
    return null;
  }

  let raw: string;
  try {
    const data = await llmRes.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch {
    return null;
  }

  try {
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const json = cleaned.match(/\{[\s\S]*\}/)?.[0] || cleaned;
    const parsed = JSON.parse(json);
    return {
      amount_cents: parsed.amount_cents || 0,
      vendor: parsed.vendor || null,
      date: parsed.date || new Date().toISOString().slice(0, 10),
      currency: parsed.currency || 'USD',
      items: parsed.items || null,
      tax_cents: parsed.tax_cents || 0,
      tip_cents: parsed.tip_cents || 0,
      confidence: parsed.confidence ?? 0,
    };
  } catch (err) {
    console.warn('[receipt/ocr] Gemini parse failed:', err, raw.slice(0, 200));
    return null;
  }
}

export interface CreatedOcrExpense {
  id: string;
  categoryId: string | null;
  vendorName: string | null;
  categorySource: 'vendor_default' | 'pattern' | null;
  categoryConfidence: number | null;
}

/** Create an expense from OCR output. Returns the inserted expense id. */
export async function createOcrExpense(
  tenantId: string,
  ocr: ReceiptOcrResult,
  receiptUrl: string,
  source: ReceiptSource,
): Promise<CreatedOcrExpense> {
  let vendor: { id: string; defaultCategoryId: string | null } | null = null;
  if (ocr.vendor) {
    const normalized = normalizeVendorName(ocr.vendor);
    if (normalized) {
      vendor = await db.abVendor.upsert({
        where: { tenantId_normalizedName: { tenantId, normalizedName: normalized } },
        update: { transactionCount: { increment: 1 }, lastSeen: new Date() },
        create: { tenantId, name: ocr.vendor, normalizedName: normalized },
        select: { id: true, defaultCategoryId: true },
      });
    }
  }

  // Category inference: vendor default → vendor pattern → null (ask user).
  // Track WHERE the category came from so we can be honest with the user
  // when surfacing it ("I'm 75% sure" vs "you've put Shell here before").
  let categoryId: string | null = vendor?.defaultCategoryId ?? null;
  let categorySource: 'vendor_default' | 'pattern' | null = vendor?.defaultCategoryId ? 'vendor_default' : null;
  let categoryConfidence: number | null = vendor?.defaultCategoryId ? 0.95 : null;
  if (!categoryId && vendor) {
    const pattern = await db.abPattern.findUnique({
      where: { tenantId_vendorPattern: { tenantId, vendorPattern: normalizeVendorName(ocr.vendor || '') } },
    });
    if (pattern) {
      categoryId = pattern.categoryId;
      categorySource = 'pattern';
      categoryConfidence = pattern.confidence;
    }
  }

  const expenseDate = new Date(ocr.date);
  const safeDate = isNaN(expenseDate.getTime()) ? new Date() : expenseDate;

  // CONFIRMATION GATE: every receipt lands as a draft (status='pending_review')
  // and is NOT booked to the ledger until the user explicitly taps Confirm
  // or replies with "yes / looks good". This is the single biggest behavior
  // change between "automation that surprises you" and "accountant you trust".
  const expense = await db.$transaction(async (tx) => {
    const exp = await tx.abExpense.create({
      data: {
        tenantId,
        amountCents: ocr.amount_cents,
        taxAmountCents: ocr.tax_cents,
        tipAmountCents: ocr.tip_cents,
        vendorId: vendor?.id,
        categoryId,
        date: safeDate,
        description: ocr.items || ocr.vendor || 'Receipt',
        receiptUrl,
        currency: ocr.currency,
        confidence: ocr.confidence,
        status: 'pending_review',
        source,
        journalEntryId: null,
      },
      include: { vendor: { select: { name: true } } },
    });

    await tx.abEvent.create({
      data: {
        tenantId,
        eventType: 'expense.draft_recorded',
        actor: 'agent',
        action: {
          expense_id: exp.id,
          amountCents: ocr.amount_cents,
          vendor: ocr.vendor,
          categoryId,
          source,
          confidence: ocr.confidence,
          categorySource,
          categoryConfidence,
        },
      },
    });

    return exp;
  });

  return {
    id: expense.id,
    categoryId,
    vendorName: expense.vendor?.name || ocr.vendor,
    categorySource,
    categoryConfidence,
  };
}

export async function persistReceiptBlob(sourceUrl: string, tenantId: string, contentType: string): Promise<string> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return sourceUrl;
  try {
    const imgRes = await fetch(sourceUrl);
    if (!imgRes.ok) return sourceUrl;
    const ext = contentType.includes('pdf') ? 'pdf' : contentType.includes('png') ? 'png' : 'jpg';
    const filename = `receipts/${tenantId}/${Date.now()}.${ext}`;
    const { put } = await import('@vercel/blob');
    const blob = await put(filename, imgRes.body as never, { access: 'public', token, contentType });
    return blob.url;
  } catch (err) {
    console.warn('[receipt/blob] persist failed, using source URL:', err);
    return sourceUrl;
  }
}


/**
 * Everything that has to happen when a receipt arrives, in one call.
 *
 * Quota FIRST, and refused before any work is done: OCR costs a model call
 * and the plan meters it. A channel that scanned receipts without consulting
 * `ocr_scans` would be a free bypass of a paid feature, which is precisely
 * the kind of gap a second adapter opens when it reimplements a flow instead
 * of calling it.
 *
 * Returns a discriminated result rather than throwing, because every failure
 * here is something the user needs told in their own channel's voice — the
 * caller owns the wording, this owns the decision.
 */
export type IngestReceiptResult =
  | { ok: false; reason: 'quota'; limit: number }
  | { ok: false; reason: 'ocr_failed' }
  | { ok: false; reason: 'unreadable' }
  | { ok: true; expense: CreatedOcrExpense; ocr: ReceiptOcrResult; receiptUrl: string };

export async function ingestReceipt(opts: {
  tenantId: string;
  /** Where the file can be fetched from — already authenticated if it needs to be. */
  fileUrl: string;
  mimeType: string;
  source: ReceiptSource;
}): Promise<IngestReceiptResult> {
  const { tenantId, fileUrl, mimeType, source } = opts;

  // Fail OPEN on a billing outage, matching the Telegram path: a quota
  // service that is down should not stop someone filing their expenses.
  // Fail CLOSED on an actual over-limit answer.
  try {
    const { checkQuota, incrementUsage } = await import('@naap/billing');
    const q = await checkQuota(tenantId, 'ocr_scans');
    if (!q.allowed) return { ok: false, reason: 'quota', limit: q.limit };
    void incrementUsage(tenantId, 'ocr_scans', 1).catch(() => {});
  } catch (err) {
    console.warn('[receipt/billing] quota check failed open:', err);
  }

  const ocr = await ocrReceipt(fileUrl, mimeType);
  if (!ocr) return { ok: false, reason: 'ocr_failed' };
  // amount_cents 0 with confidence 0 is the model telling us it could not
  // read the total. Booking a zero-value expense would be a silent wrong
  // number in the ledger, which this product has shipped before.
  if (!ocr.amount_cents || ocr.amount_cents <= 0) return { ok: false, reason: 'unreadable' };

  // Persist before creating the row: the channel's own file URL is
  // short-lived (Meta expires media links, Telegram's carry the bot token),
  // so an expense pointing at one has a receipt that vanishes.
  const receiptUrl = await persistReceiptBlob(fileUrl, tenantId, mimeType);
  const expense = await createOcrExpense(tenantId, ocr, receiptUrl, source);
  return { ok: true, expense, ocr, receiptUrl };
}
