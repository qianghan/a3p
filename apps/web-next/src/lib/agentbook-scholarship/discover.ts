/**
 * Grounded scholarship discovery.
 *
 * Runs a Google Search-grounded generation via the shared groundedSearch
 * helper (Vercel AI Gateway, with a native Gemini fallback) — real searches
 * over real pages, returning sources we surface as citations. This is the
 * "grounded agentic search, not LLM recall" contract from the design doc:
 * every candidate we return carries a source URL, and a candidate the model
 * can't ground is dropped rather than shown.
 */

import { groundedSearch, extractGroundedCandidates } from '@/lib/agentbook-student/grounded-search';
import { countryNameFor } from '@/lib/agentbook-student/jurisdiction';

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

/**
 * Run a grounded search and return only candidates we can tie to a real
 * source. Returns [] (not an error) when nothing groundable is found — the
 * caller shows an empty state, never fabricated results.
 */
export async function discoverScholarships(
  ctx: StudentSearchContext,
  freeText?: string,
): Promise<{ candidates: ScholarshipCandidate[]; note: string }> {
  const country = countryNameFor(ctx.jurisdiction);
  const who = [
    ctx.level && `${ctx.level} student`,
    ctx.program && `studying ${ctx.program}`,
    ctx.school && `at ${ctx.school}`,
    // Country is always named, whether or not a state/province is set —
    // relying on region to carry it meant a profile with a school but no
    // region silently dropped the country from the prompt entirely.
    ctx.region ? `in ${ctx.region}, ${country}` : `in ${country}`,
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

  const result = await groundedSearch(prompt);
  if (!result) return { candidates: [], note: 'Search is temporarily unavailable.' };

  const candidates = extractGroundedCandidates<ScholarshipCandidate>(result.text, result.groundedHosts, 12);

  const note = candidates.length === 0
    ? 'No matching scholarships found right now. Try a broader search, or paste one you\'ve found and I\'ll help you track and apply.'
    : 'These are starting points — always confirm the amount, deadline, and eligibility on the scholarship\'s own page before applying.';
  return { candidates, note };
}
