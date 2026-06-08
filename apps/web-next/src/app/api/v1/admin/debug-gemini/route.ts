/**
 * Diagnostic: surface why callGemini returns empty in production.
 *
 * Gates on the admin-guard (system:admin role OR ADMIN_EMAILS allowlist).
 * Returns env presence, the resolved model, and the raw upstream Gemini
 * response (status, error body if any, parsed candidate text length) so
 * we can tell whether the issue is the API key, the model name, a
 * timeout, or our response-shape parsing.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await requireAdmin(request);
  if ('response' in guard) return guard.response;

  const envKey = process.env.GEMINI_API_KEY || '';
  const envModel = process.env.GEMINI_MODEL_FAST || 'gemini-2.0-flash';

  const out: Record<string, unknown> = {
    env: {
      GEMINI_API_KEY_present: !!envKey,
      GEMINI_API_KEY_length: envKey.length,
      GEMINI_API_KEY_prefix: envKey.slice(0, 4),
      GEMINI_API_KEY_suffix: envKey.slice(-4),
      GEMINI_MODEL_FAST: envModel,
      VERCEL_REGION: process.env.VERCEL_REGION,
    },
  };

  if (!envKey) {
    out.error = 'no key in env';
    return NextResponse.json(out);
  }

  const modelsToTry = [envModel, 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const seen = new Set<string>();
  const attempts: Array<Record<string, unknown>> = [];

  for (const model of modelsToTry) {
    if (seen.has(model)) continue;
    seen.add(model);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${envKey}`;
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: 'You are a test responder.' }] },
          contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: pong' }] }],
          generationConfig: { maxOutputTokens: 32, temperature: 0.1 },
        }),
      });
      const elapsed = Date.now() - t0;
      const text = await res.text();
      let data: any = null;
      try { data = JSON.parse(text); } catch { /* keep raw */ }
      attempts.push({
        model,
        status: res.status,
        ok: res.ok,
        elapsedMs: elapsed,
        candidateText: data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null,
        promptFeedback: data?.promptFeedback ?? null,
        errorMessage: data?.error?.message ?? null,
        errorStatus: data?.error?.status ?? null,
        rawSnippet: text.slice(0, 400),
      });
      if (res.ok && data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        // Found a working model — stop probing.
        break;
      }
    } catch (err) {
      attempts.push({
        model,
        elapsedMs: Date.now() - t0,
        thrown: (err as Error).name + ': ' + (err as Error).message,
      });
    }
  }

  out.attempts = attempts;
  return NextResponse.json(out);
}
