/**
 * Grounded job / co-op discovery — the Scholarship discovery pattern applied
 * to student jobs and co-op placements. Uses Gemini's native google_search
 * grounding: real searches, source-cited postings, dropped-if-not-grounded
 * (hallucination guard). Localized + work-authorization-aware from the
 * student's profile — critically, for an international student it must NOT
 * surface roles they can't legally take (only on-campus / CPT / OPT-eligible).
 *
 * (Gemini grounding rather than the AI-SDK-via-Gateway option — the gateway
 * isn't wired into web-next; Gemini achieves the same grounded+cited result.)
 */

export interface JobCandidate {
  title: string;
  employer: string | null;
  location: string | null;
  compText: string | null; // free-text pay as found — verify at source
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
}

export interface CareerSearchContext {
  jurisdiction: string; // us | ca
  region: string;
  program?: string | null;
  level?: string | null;
  visaStatus?: string | null; // international | domestic
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

export async function discoverJobs(
  ctx: CareerSearchContext,
  freeText?: string,
): Promise<{ candidates: JobCandidate[]; note: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { candidates: [], note: 'Search is temporarily unavailable.' };

  const model = process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const country = ctx.jurisdiction === 'ca' ? 'Canada' : 'the United States';
  const isIntl = ctx.visaStatus === 'international';
  const who = [
    ctx.level && `${ctx.level} student`,
    ctx.program && `in ${ctx.program}`,
    ctx.region && `near ${ctx.region}, ${country}`,
  ].filter(Boolean).join(', ') || `a student in ${country}`;

  const prompt = [
    `Find real, currently-open student jobs, internships, and co-op placements for ${who}.`,
    freeText ? `Focus: ${freeText}.` : '',
    'Prefer the student\'s own campus career/co-op board and local employers over generic national listings.',
    isIntl
      ? 'The student is an international student on a visa — ONLY include roles they can legally hold (on-campus positions, or roles compatible with CPT/OPT). Exclude anything requiring citizenship, permanent residency, or security clearance. Note work-authorization caveats in the summary.'
      : '',
    'For each: exact role title, employer, location, pay if stated, a one-line summary, and the source URL.',
    'Return ONLY a JSON array (no prose/markdown fence):',
    '[{"title":"","employer":null,"location":null,"compText":null,"summary":"","sourceUrl":"","sourceLabel":""}]',
    'Every object MUST have a real sourceUrl you actually found. If unsure a posting is real/current, omit it.',
  ].filter(Boolean).join('\n');

  let data: {
    candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: GroundingChunk[] } }[];
  };
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
      }),
    });
    if (!res.ok) return { candidates: [], note: 'Search is temporarily unavailable.' };
    data = await res.json();
  } catch {
    return { candidates: [], note: 'Search is temporarily unavailable.' };
  }

  const cand = data.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const groundedHosts = new Set<string>();
  for (const chunk of cand?.groundingMetadata?.groundingChunks ?? []) {
    const uri = chunk.web?.uri;
    if (uri) {
      try { groundedHosts.add(new URL(uri).hostname.replace(/^www\./, '')); } catch { /* ignore */ }
    }
  }

  let parsed: JobCandidate[] = [];
  try {
    const jsonText = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = jsonText.indexOf('[');
    const end = jsonText.lastIndexOf(']');
    if (start !== -1 && end !== -1) parsed = JSON.parse(jsonText.slice(start, end + 1)) as JobCandidate[];
  } catch {
    return { candidates: [], note: "Couldn't read the search results — try again in a moment." };
  }

  const candidates = parsed.filter((c) => {
    if (!c || typeof c.title !== 'string' || typeof c.sourceUrl !== 'string' || !c.sourceUrl) return false;
    try {
      const host = new URL(c.sourceUrl).hostname.replace(/^www\./, '');
      return groundedHosts.size === 0 || groundedHosts.has(host);
    } catch {
      return false;
    }
  }).slice(0, 12);

  const note = candidates.length === 0
    ? "No matching roles found right now. Try a broader search, or paste a posting you've found and I'll help you tailor and track your application."
    : isIntl
      ? 'Confirm work-authorization (on-campus / CPT / OPT) with your international student office before applying. AgentBook never applies for you — you submit on the employer\'s site.'
      : 'Starting points — confirm details and apply on each employer\'s own site. AgentBook helps you prepare; you submit.';
  return { candidates, note };
}
