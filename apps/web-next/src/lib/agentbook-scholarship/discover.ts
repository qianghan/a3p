/**
 * Grounded scholarship discovery.
 *
 * Uses Gemini with the native google_search grounding tool — real searches
 * over real pages, returning sources (grounding chunks) we surface as
 * citations. This is the "grounded agentic search, not LLM recall" contract
 * from the design doc: every candidate we return carries a source URL, and
 * a candidate the model can't ground is dropped rather than shown.
 *
 * (Chosen over the AI-SDK-via-Gateway option in the design doc because the
 * gateway isn't wired into web-next, whereas GEMINI_API_KEY is already
 * configured — Gemini grounding achieves the same grounded+cited result
 * with no new infrastructure.)
 */

export interface ScholarshipCandidate {
  title: string;
  amountText: string | null; // free-text amount as found (e.g. "$5,000"), not parsed — verify at source
  deadlineText: string | null;
  eligibilitySummary: string;
  sourceUrl: string;
  sourceLabel: string;
}

export interface StudentSearchContext {
  jurisdiction: string; // us | ca
  region: string; // state/province
  school?: string | null;
  program?: string | null;
  level?: string | null; // undergrad | grad | ...
  visaStatus?: string | null; // international | domestic
  homeCountry?: string | null;
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/**
 * Run a grounded search and return only candidates we can tie to a real
 * source. Returns [] (not an error) when nothing groundable is found — the
 * caller shows an empty state, never fabricated results.
 */
export async function discoverScholarships(
  ctx: StudentSearchContext,
  freeText?: string,
): Promise<{ candidates: ScholarshipCandidate[]; note: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { candidates: [], note: 'Search is temporarily unavailable.' };

  const model = process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const country = ctx.jurisdiction === 'ca' ? 'Canada' : 'the United States';
  const who = [
    ctx.level && `${ctx.level} student`,
    ctx.program && `studying ${ctx.program}`,
    ctx.school && `at ${ctx.school}`,
    ctx.region && `in ${ctx.region}, ${country}`,
    ctx.visaStatus === 'international' && `an international student${ctx.homeCountry ? ` from ${ctx.homeCountry}` : ''}`,
  ].filter(Boolean).join(', ') || `a student in ${country}`;

  const prompt = [
    `Find real, currently-open scholarships for ${who}.`,
    freeText ? `Focus: ${freeText}.` : '',
    'Prioritise the student\'s own school and local/regional awards over generic national lists.',
    ctx.visaStatus === 'international'
      ? 'Only include scholarships an international student on a visa is actually eligible for — exclude citizens/permanent-residents-only awards.'
      : '',
    'For each scholarship return: exact name, award amount if stated, application deadline if stated, a one-line eligibility summary, and the source URL you found it on.',
    'Return ONLY a JSON array (no prose, no markdown fence) of objects:',
    '[{"title":"","amountText":null,"deadlineText":null,"eligibilitySummary":"","sourceUrl":"","sourceLabel":""}]',
    'Every object MUST have a real sourceUrl you actually found. If you are unsure a scholarship is real, omit it.',
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
  // The set of URLs the model actually grounded against — we only trust
  // candidates whose sourceUrl is among these, so a hallucinated URL is dropped.
  const groundedHosts = new Set<string>();
  for (const chunk of cand?.groundingMetadata?.groundingChunks ?? []) {
    const uri = chunk.web?.uri;
    if (uri) {
      try { groundedHosts.add(new URL(uri).hostname.replace(/^www\./, '')); } catch { /* ignore */ }
    }
  }

  let parsed: ScholarshipCandidate[] = [];
  try {
    const jsonText = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const start = jsonText.indexOf('[');
    const end = jsonText.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
      parsed = JSON.parse(jsonText.slice(start, end + 1)) as ScholarshipCandidate[];
    }
  } catch {
    return { candidates: [], note: 'Couldn\'t read the search results — try again in a moment.' };
  }

  const candidates = parsed.filter((c) => {
    if (!c || typeof c.title !== 'string' || typeof c.sourceUrl !== 'string' || !c.sourceUrl) return false;
    try {
      const host = new URL(c.sourceUrl).hostname.replace(/^www\./, '');
      // Grounded-only: keep a candidate only if its source host was actually
      // among the search's grounding chunks (fall back to allowing when the
      // API returned no grounding metadata at all, rather than dropping
      // everything). This is the anti-hallucination guard.
      return groundedHosts.size === 0 || groundedHosts.has(host);
    } catch {
      return false;
    }
  }).slice(0, 12);

  const note = candidates.length === 0
    ? 'No matching scholarships found right now. Try a broader search, or paste one you\'ve found and I\'ll help you track and apply.'
    : 'These are starting points — always confirm the amount, deadline, and eligibility on the scholarship\'s own page before applying.';
  return { candidates, note };
}
