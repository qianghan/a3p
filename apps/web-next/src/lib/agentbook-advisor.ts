/**
 * Shared helpers for the agentbook-expense advisor endpoints.
 * Kept thin so insights / chart / proactive-alerts / ask can all
 * reuse the same Gemini wrapper and formatting.
 */

import 'server-only';

export function formatCents(cents: number): string {
  return '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}

/**
 * Call Gemini with a system prompt + user message. Returns the
 * generated text, or null if the key isn't set or the API fails.
 */
export async function advisorGemini(
  systemPrompt: string,
  userMessage: string,
  maxTokens = 500,
): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const model = process.env.GEMINI_MODEL_FAST || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    return data.candidates?.[0]?.content?.parts?.[0]?.text || null;
  } catch {
    return null;
  }
}
