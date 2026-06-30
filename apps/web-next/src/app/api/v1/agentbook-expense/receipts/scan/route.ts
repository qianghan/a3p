/**
 * Receipt scan — upload a receipt photo, store it in Vercel Blob, and OCR it
 * with Gemini Vision to extract {amount, vendor, date}. Returns the parsed
 * fields (any may be null) plus the stored receiptUrl so the mobile capture
 * screen can prefill the expense for the user to confirm.
 *
 * Accepts multipart/form-data with a `file` field.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { parseReceiptJson } from '@/lib/receipt-parse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ success: false, error: 'file is required' }, { status: 400 });
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // 1. Store the receipt (best-effort; OCR still runs if storage is off).
    let receiptUrl: string | null = null;
    try {
      const { put } = await import('@vercel/blob');
      const safeName = (file.name || 'receipt.jpg').replace(/[^a-zA-Z0-9._-]/g, '_');
      const blob = await put(`receipts/${tenantId}/${Date.now()}-${safeName}`, bytes, {
        access: 'public',
        addRandomSuffix: true,
      });
      receiptUrl = blob.url;
    } catch (err) {
      console.warn('[receipts/scan] blob store unavailable:', err);
    }

    // 2. OCR via Gemini Vision.
    let parsed = { amountCents: null as number | null, vendor: null as string | null, date: null as string | null };
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      const model = process.env.GEMINI_MODEL_VISION || 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: 'Extract the receipt total amount, vendor name, and purchase date. Respond with ONLY compact JSON: {"total": number, "vendor": string, "date": "YYYY-MM-DD"}. If a field is unreadable, use null.' }] },
            contents: [{ role: 'user', parts: [{ inlineData: { mimeType: file.type || 'image/jpeg', data: bytes.toString('base64') } }] }],
            generationConfig: { maxOutputTokens: 256, temperature: 0.1 },
          }),
        });
        if (res.ok) {
          const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
          const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) parsed = parseReceiptJson(text);
        }
      } catch (err) {
        console.warn('[receipts/scan] OCR failed:', err);
      }
    }

    return NextResponse.json({ success: true, data: { ...parsed, receiptUrl } });
  } catch (err) {
    console.error('[receipts/scan] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
