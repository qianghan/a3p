/**
 * callGemini for the Tax Review Agent's Next.js route handlers.
 *
 * Production serves the tax plugin through the Next route handlers under
 * `app/api/v1/agentbook-tax/...`, not the Express plugin server — so the
 * review routes need their own LLM caller. Kept here (rather than
 * importing the Express plugin server's private copy, or pulling the
 * whole of `@agentbook-core/server` into a tax route's bundle) following
 * the existing precedent set by
 * `app/api/v1/agentbook-tax/tax-slips/ocr/route.ts`, which defines the
 * same tiny GEMINI_API_KEY-reading helper for the same reason.
 *
 * Shared by review/start and review/message so the two surfaces cannot
 * drift apart on model, timeout, or generation settings.
 */

import 'server-only';

const GEMINI_DEFAULT_TIMEOUT_MS = 20_000;

export async function callGemini(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 500,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // gemini-2.0-flash was retired by Google in mid-2026 (returns 404
  // NOT_FOUND). 2.5-flash is the current low-cost model.
  const model = process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS) || GEMINI_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        // gemini-2.5-flash consumes output tokens on internal "thinking" by
        // default — small maxOutputTokens budgets get burned before visible
        // text emerges, producing truncated replies. Disable thinking for
        // the agent's chat-grade outputs.
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.3,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      console.warn('[agentbook-tax-review/callGemini] timed out after', timeoutMs, 'ms');
      return null;
    }
    console.warn('[agentbook-tax-review/callGemini] failed:', err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
