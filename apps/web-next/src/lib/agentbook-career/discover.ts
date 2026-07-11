/**
 * Grounded job / co-op discovery — the Scholarship discovery pattern applied
 * to student jobs and co-op placements. Runs a Google Search-grounded
 * generation via the shared groundedSearch helper (Vercel AI Gateway, native
 * Gemini fallback): real searches, source-cited postings, dropped-if-not-
 * grounded (hallucination guard). Localized + work-authorization-aware from
 * the student's profile — critically, for an international student it must NOT
 * surface roles they can't legally take (only on-campus / CPT / OPT-eligible).
 */

import { groundedSearch, extractGroundedCandidates } from '@/lib/agentbook-student/grounded-search';
import { countryNameFor } from '@/lib/agentbook-student/jurisdiction';
import { filterLiveCandidates } from '@/lib/agentbook-student/link-check';
import { parseDeadline, isDeadlinePassed } from '@/lib/agentbook-student/deadline';

export interface JobCandidate {
  title: string;
  employer: string | null;
  location: string | null;
  compText: string | null; // free-text pay as found — verify at source
  deadlineText: string | null; // application deadline if the posting states one — most won't
  summary: string;
  sourceUrl: string;
  sourceLabel: string;
}

export interface CareerSearchContext {
  jurisdiction: string; // us | ca | uk | au
  region: string;
  school?: string | null;
  program?: string | null;
  level?: string | null;
  visaStatus?: string | null; // international | domestic
  homeCountry?: string | null;
}

export async function discoverJobs(
  ctx: CareerSearchContext,
  freeText?: string,
): Promise<{ candidates: JobCandidate[]; note: string }> {
  const country = countryNameFor(ctx.jurisdiction);
  const isIntl = ctx.visaStatus === 'international';
  const who = [
    ctx.level && `${ctx.level} student`,
    ctx.program && `in ${ctx.program}`,
    ctx.school && `at ${ctx.school}`,
    // Country is always named, whether or not a state/province is set —
    // see the identical fix in agentbook-scholarship/discover.ts.
    ctx.region ? `near ${ctx.region}, ${country}` : `in ${country}`,
    isIntl && `an international student${ctx.homeCountry ? ` from ${ctx.homeCountry}` : ''}`,
  ].filter(Boolean).join(', ') || `a student in ${country}`;

  const prompt = [
    `Find real, currently-open student jobs, internships, and co-op placements for ${who}.`,
    freeText ? `Focus: ${freeText}.` : '',
    'Prefer the student\'s own campus career/co-op board and local employers over generic national listings.',
    isIntl
      ? 'The student is an international student on a visa — ONLY include roles they can legally hold (on-campus positions, or roles compatible with CPT/OPT). Exclude anything requiring citizenship, permanent residency, or security clearance. Note work-authorization caveats in the summary.'
      : '',
    'For each: exact role title, employer, location, pay if stated, application deadline if stated, a one-line summary, and the source URL.',
    'Return ONLY a JSON array (no prose/markdown fence):',
    '[{"title":"","employer":null,"location":null,"compText":null,"deadlineText":null,"summary":"","sourceUrl":"","sourceLabel":""}]',
    'Every object MUST have a real sourceUrl you actually found. If unsure a posting is real/current, omit it.',
  ].filter(Boolean).join('\n');

  const result = await groundedSearch(prompt);
  if (!result) return { candidates: [], note: 'Search is temporarily unavailable.' };

  const grounded = extractGroundedCandidates<JobCandidate>(result.text, result.groundedHosts, 12);
  // Same two quality gates as scholarship discovery: drop dead source links,
  // and drop postings whose stated application deadline has already passed.
  const live = await filterLiveCandidates(grounded, (c) => c.sourceUrl);
  const now = new Date();
  const candidates = live.filter((c) => !isDeadlinePassed(parseDeadline(c.deadlineText), now));

  const note = candidates.length === 0
    ? "No matching roles found right now. Try a broader search, or paste a posting you've found and I'll help you tailor and track your application."
    : isIntl
      ? 'Confirm work-authorization (on-campus / CPT / OPT) with your international student office before applying. AgentBook never applies for you — you submit on the employer\'s site.'
      : 'Starting points — confirm details and apply on each employer\'s own site. AgentBook helps you prepare; you submit.';
  return { candidates, note };
}
