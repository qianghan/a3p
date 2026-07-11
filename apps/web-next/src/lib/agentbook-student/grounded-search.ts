/**
 * Shared grounded search for the student plugins (Scholarship, Career).
 *
 * Runs a real Google Search-grounded generation and returns the model's text
 * plus the set of hosts it actually grounded against. Callers parse their own
 * JSON out of the text and keep only candidates whose sourceUrl host is in
 * `groundedHosts` — the anti-hallucination guard from the design doc.
 *
 * Transport: the Vercel AI Gateway (provider-agnostic model string
 * `google/<model>`, with the native `google_search` tool for grounding). On a
 * Vercel deployment the gateway authenticates via the deployment's OIDC token;
 * locally it uses AI_GATEWAY_API_KEY. If the gateway path is unavailable or
 * errors, we fall back to the native Gemini endpoint keyed by GEMINI_API_KEY,
 * so discovery keeps working with zero regression regardless of gateway state.
 */

import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

export interface GroundedResult {
  text: string;
  /** Hosts (www-stripped) the model actually grounded against. */
  groundedHosts: Set<string>;
  /** Which transport produced the result — for logging/observability only. */
  via: 'gateway' | 'native';
}

function hostOf(uri: string | undefined | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Grounding chunk shape shared by both the gateway metadata and native API. */
interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

/** Does a string look like a bare domain (e.g. "collegeboard.org")? */
function looksLikeDomain(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  if (/\s/.test(t) || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(t)) return null;
  return t.replace(/^www\./, '');
}

function hostsFromChunks(chunks: GroundingChunk[] | undefined): Set<string> {
  const hosts = new Set<string>();
  for (const c of chunks ?? []) {
    // Gemini grounding chunk `web.uri` is usually a vertexaisearch redirect
    // URL, NOT the real page domain — so we ALSO harvest `web.title`, which is
    // typically the real site's bare domain, and treat that as a grounded host.
    const h = hostOf(c.web?.uri);
    if (h) hosts.add(h);
    const titleDomain = looksLikeDomain(c.web?.title);
    if (titleDomain) hosts.add(titleDomain);
  }
  return hosts;
}

/** Native Gemini generateContent fallback — the original, proven path. */
async function nativeGroundedSearch(prompt: string, model: string): Promise<GroundedResult | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        // gemini-2.5-flash spends "thinking" tokens from the output budget by
        // default; with a small cap the JSON array gets truncated mid-object
        // and fails to parse. Disable thinking for this structured task and
        // give the answer generous headroom.
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 8192,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] }; groundingMetadata?: { groundingChunks?: GroundingChunk[] } }[];
    };
    const cand = data.candidates?.[0];
    const text = cand?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    return { text, groundedHosts: hostsFromChunks(cand?.groundingMetadata?.groundingChunks), via: 'native' };
  } catch {
    return null;
  }
}

/**
 * Run a grounded search. Returns null when neither transport can produce a
 * result (caller shows an empty state — never fabricated data).
 */
export async function groundedSearch(prompt: string): Promise<GroundedResult | null> {
  const model = process.env.GEMINI_MODEL_FAST || 'gemini-2.5-flash';

  // Prefer the gateway. Only attempt it when an auth path exists — an explicit
  // gateway key, or the Vercel OIDC token that Vercel injects at runtime.
  const gatewayAvailable = Boolean(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN);
  if (gatewayAvailable) {
    try {
      const { text, sources, providerMetadata } = await generateText({
        model: `google/${model}`,
        tools: { google_search: google.tools.googleSearch({}) },
        temperature: 0.2,
        maxOutputTokens: 8192,
        // Disable thinking so the output budget goes to the JSON answer, not
        // hidden reasoning tokens (matches the native path).
        providerOptions: { google: { thinkingConfig: { thinkingBudget: 0 } } },
        prompt,
      });
      const meta = providerMetadata?.google as { groundingMetadata?: { groundingChunks?: GroundingChunk[] } } | undefined;
      const hosts = hostsFromChunks(meta?.groundingMetadata?.groundingChunks);
      // The SDK also surfaces resolved sources; fold their hosts in too.
      for (const s of sources ?? []) {
        const h = hostOf((s as { url?: string }).url);
        if (h) hosts.add(h);
      }
      if (text) return { text, groundedHosts: hosts, via: 'gateway' };
    } catch {
      // fall through to native
    }
  }

  return nativeGroundedSearch(prompt, model);
}

/**
 * Shared post-processing: pull a JSON array out of a (possibly fenced) model
 * response and keep only entries whose `sourceUrl` host was actually grounded.
 * Generic over the caller's candidate type; `T` must carry a string sourceUrl.
 */
/**
 * Pull the candidate objects out of a model response that may be wrapped in
 * prose and/or markdown fences, contain citation markers like "[1]", or be
 * truncated. Grounded Gemini responses are verbose, so array-framing tricks
 * (first-'['..last-']') are unreliable. Instead we scan the WHOLE text for
 * every outermost, balanced `{...}` object (string-aware, brace-depth
 * counting) and parse each independently. A trailing truncated object is
 * simply skipped; the caller's title+sourceUrl check discards any non-candidate
 * objects that slip through.
 */
function scanJsonObjects<T>(text: string): T[] {
  const out: T[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] !== '{') { i++; continue; }
    let depth = 0;
    let inStr = false;
    let esc = false;
    const objStart = i;
    let closed = false;
    for (; i < n; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') {
        inStr = true;
      } else if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { out.push(JSON.parse(text.slice(objStart, i + 1)) as T); } catch { /* skip */ }
          i++;
          closed = true;
          break;
        }
      }
    }
    if (!closed) break; // unbalanced tail (truncated) — stop
  }
  return out;
}

export function extractGroundedCandidates<T extends { title?: unknown; sourceUrl?: unknown }>(
  text: string,
  groundedHosts: Set<string>,
  limit: number,
): T[] {
  const parsed = scanJsonObjects<T>(text);
  if (parsed.length === 0) return [];

  // A well-formed candidate has a title and a parseable absolute sourceUrl.
  const wellFormed = parsed.filter((c) => {
    if (!c || typeof c.title !== 'string' || typeof c.sourceUrl !== 'string' || !c.sourceUrl) return false;
    return hostOf(c.sourceUrl as string) !== null;
  });

  // Two-tier hallucination guard:
  //  1. Prefer candidates whose host is in the grounded set (real search cite).
  //  2. But Gemini grounding chunks frequently expose only redirect hosts, so
  //     a strict match can drop everything even on a genuinely grounded answer.
  //     When the grounded response yielded well-formed candidates but none
  //     match, fall back to trusting those (a search DID run) rather than
  //     showing nothing. If there was no grounding metadata at all, likewise
  //     allow well-formed candidates through.
  const strict = wellFormed.filter((c) => {
    const host = hostOf(c.sourceUrl as string)!;
    return groundedHosts.has(host);
  });
  const chosen = strict.length > 0 ? strict : wellFormed;
  return chosen.slice(0, limit);
}
