/**
 * Tax slip OCR — extract data from a T4 / T5 / RRSP slip image.
 *
 * Delegates to the legacy processSlipOCR implementation; we just inject
 * a callGemini helper that reads GEMINI_API_KEY directly so it works
 * in the Vercel function context without an LLMProviderConfig row.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { processSlipOCR } from '@agentbook-tax/tax-slips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface SlipOcrBody {
  taxYear?: number;
  imageUrl?: string;
  filingId?: string;
}

async function callGemini(systemPrompt: string, userMessage: string, maxTokens = 1024): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL_VISION || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.1 },
    }),
  });
  if (!res.ok) return null;
  const data = await res.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as SlipOcrBody;
    const { taxYear, imageUrl, filingId } = body;

    if (!imageUrl) {
      return NextResponse.json({ success: false, error: 'imageUrl is required' }, { status: 400 });
    }

    const result = await processSlipOCR(
      tenantId,
      taxYear || new Date().getFullYear(),
      imageUrl,
      filingId ?? null,
      callGemini,
    );

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/tax-slips/ocr] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
