/**
 * Mirrors plugins/agentbook-startup/backend/src/discovery.ts exactly.
 *
 * Duplicated here (rather than imported cross-package via a package.json
 * subpath export) because Next.js's production webpack build on Vercel
 * could not resolve `@naap/plugin-agentbook-startup-backend/discovery` —
 * confirmed failing there even though the same import resolved fine in
 * local Vitest. If the underlying resolution issue gets fixed, this file
 * and its `discovery.test.ts` counterpart become deletable in favor of a
 * shared import — keep both files in sync until then.
 */
import { getJurisdictionPack, loadBuiltInPacks } from '@agentbook/jurisdictions';
import type { StartupProfile } from '@agentbook/jurisdictions';

// The Express backend (plugins/agentbook-startup/backend/src/server.ts) calls
// this once at process startup. Next.js has no equivalent single entrypoint
// for this module, so it's called here at import time instead — without it,
// getJurisdictionPack() always returns undefined and every jurisdiction looks
// unsupported.
loadBuiltInPacks();

export interface CatalogEntry {
  programCode: string;
  name: string;
  authority: string;
  sourceUrl: string;
}

export interface ProgramRecommendation {
  programCode: string;
  name: string;
  authority: string;
  sourceUrl: string;
  status: string;
  confidence: number;
  reasoning: string;
  estValueLowCents: number | null;
  estValueHighCents: number | null;
}

export interface RecommendationsResult {
  jurisdiction: string;
  programs: ProgramRecommendation[];
  message?: string;
}

export function computeRecommendations(
  jurisdiction: string,
  profile: StartupProfile,
  catalog: CatalogEntry[],
): RecommendationsResult {
  const pack = getJurisdictionPack(jurisdiction);
  if (!pack?.taxBenefits) {
    return {
      jurisdiction,
      programs: [],
      message: 'Startup tax benefits are not yet available for your jurisdiction.',
    };
  }

  const taxBenefits = pack.taxBenefits;
  const summaries = taxBenefits.listPrograms(profile);
  const programs = summaries.map((summary): ProgramRecommendation => {
    const assessment = taxBenefits.assessEligibility(summary.programCode, profile);
    const catalogEntry = catalog.find((c) => c.programCode === summary.programCode);
    return {
      programCode: summary.programCode,
      name: catalogEntry?.name ?? summary.name,
      authority: catalogEntry?.authority ?? summary.authority,
      sourceUrl: catalogEntry?.sourceUrl ?? '',
      status: assessment.status,
      confidence: assessment.confidence,
      reasoning: assessment.reasoning,
      estValueLowCents: assessment.estValueLowCents,
      estValueHighCents: assessment.estValueHighCents,
    };
  });

  // Story A6: never a silent empty state. Distinct from the
  // unsupported-jurisdiction message above — this profile's jurisdiction
  // IS supported, it just doesn't roughly match any tracked program yet.
  if (programs.length === 0) {
    return {
      jurisdiction,
      programs,
      message: "No tracked programs match your profile yet — as your company grows (R&D spend, incorporation, headcount), check back for new recommendations.",
    };
  }

  return { jurisdiction, programs };
}
