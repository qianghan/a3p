import { db } from './db/client.js';
import { getFilingDraftPack } from '@agentbook/jurisdictions/filing-draft-loader';
import type { StandardTaxExtract, FilingDraftSummary } from '@agentbook/jurisdictions/interfaces';
import { usTaxBrackets } from '@agentbook/jurisdictions/us/tax-brackets';
import { caTaxBrackets } from '@agentbook/jurisdictions/ca/tax-brackets';
import { auTaxBrackets } from '@agentbook/jurisdictions/au/tax-brackets';
import type { TaxBracketProvider } from '@agentbook/jurisdictions/interfaces';
import { cleanJson, type CallGeminiFn } from './tax-questionnaire-core.js';

// Direct imports, NOT getJurisdictionPack()/loadBuiltInPacks() — see this
// plan's Global Constraints for why that loader is unsafe here.
const TAX_BRACKET_PROVIDERS: Record<string, TaxBracketProvider> = {
  us: usTaxBrackets,
  ca: caTaxBrackets,
  au: auTaxBrackets,
};

export type TaxFastTrackComputeErrorCode = 'delta_extraction_failed' | 'letter_generation_failed';

export class TaxFastTrackComputeError extends Error {
  constructor(public code: TaxFastTrackComputeErrorCode, message: string) {
    super(message);
  }
}

/**
 * LLM calls + deterministic bracket calculation for a completed fast-track
 * questionnaire session. No PDF rendering, no blob upload, no
 * AbTaxFastTrackDraft row writes — those are apps/web-next concerns (see
 * generateFilingDraft in apps/web-next/src/lib/tax-fast-track-draft.ts).
 *
 * The numeric estimate comes from the existing, unmodified
 * {us,ca}TaxBrackets.calculateTax() — the LLM's job is turning this year's
 * prose Q&A into structured deltas, never inventing a tax figure directly.
 */
export async function computeFilingDraftSummaryAndLetter(
  sessionId: string,
  callGemini: CallGeminiFn,
): Promise<{ summary: FilingDraftSummary; letterBody: string }> {
  const session = await db.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
  if (!session || session.status !== 'completed') {
    throw new Error(`computeFilingDraftSummaryAndLetter called for a non-completed session: ${sessionId}`);
  }

  let priorFiling: StandardTaxExtract | undefined;
  if (session.sourceFilingId) {
    const filing = await db.abPastTaxFiling.findUnique({ where: { id: session.sourceFilingId } }).catch(() => null);
    priorFiling = (filing?.extractedData as StandardTaxExtract | undefined) || undefined;
  }
  if (!priorFiling) {
    throw new Error(`computeFilingDraftSummaryAndLetter: session ${sessionId} has no readable prior filing`);
  }

  const pack = getFilingDraftPack(session.jurisdiction);
  const qaHistory = (session.qaHistory as { question: string; answer: string }[]) || [];

  const deltasPrompt = pack.extractDeltasPrompt({ qaHistory, priorFiling });
  const deltasRaw = await callGemini(deltasPrompt, "Extract this year's changes.", 400);
  if (!deltasRaw) throw new TaxFastTrackComputeError('delta_extraction_failed', 'callGemini returned falsy for delta extraction');
  let deltas;
  try {
    deltas = pack.parseDeltas(JSON.parse(cleanJson(deltasRaw)));
  } catch (err) {
    throw new TaxFastTrackComputeError('delta_extraction_failed', `delta parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Deterministic, no LLM call: apply the extracted income delta to last
  // year's real baseline and run it through the existing bracket
  // calculator. Degrades gracefully (all numeric fields omitted, not
  // guessed) if the prior filing lacks a usable baseline.
  const bracketProvider = TAX_BRACKET_PROVIDERS[session.jurisdiction];
  let estimatedTotalIncomeCents: number | undefined;
  let estimatedTaxableIncomeCents: number | undefined;
  let estimatedTaxPayableCents: number | undefined;
  let taxPayableDeltaVsLastYearCents: number | undefined;

  if (bracketProvider && priorFiling.taxableIncomeCents != null) {
    const deltaFactor = 1 + (deltas.incomeDeltaPercent ?? 0) / 100;
    estimatedTaxableIncomeCents = Math.round(priorFiling.taxableIncomeCents * deltaFactor);
    if (priorFiling.totalIncomeCents != null) {
      estimatedTotalIncomeCents = Math.round(priorFiling.totalIncomeCents * deltaFactor);
    }
    const calc = bracketProvider.calculateTax(estimatedTaxableIncomeCents, session.taxYear);
    estimatedTaxPayableCents = calc.taxCents;
    if (priorFiling.taxPayableCents != null) {
      taxPayableDeltaVsLastYearCents = estimatedTaxPayableCents - priorFiling.taxPayableCents;
    }
  }

  const summary: FilingDraftSummary = {
    estimatedTotalIncomeCents,
    estimatedTaxableIncomeCents,
    estimatedTaxPayableCents,
    taxPayableDeltaVsLastYearCents,
    changesFromLastYear: deltas.changesFromLastYear,
    openQuestions: deltas.openQuestions,
    caveat: 'This is an AI-generated estimate to help you and your accountant get started — not a filed return, and not tax advice.',
  };

  const letterPrompt = pack.clientLetterPrompt({ qaHistory, priorFiling, summary });
  const letterRaw = await callGemini(letterPrompt, 'Write the client letter.', 500);
  if (!letterRaw) throw new TaxFastTrackComputeError('letter_generation_failed', 'callGemini returned falsy for client letter');
  let letter;
  try {
    letter = pack.parseClientLetter(JSON.parse(cleanJson(letterRaw)));
  } catch (err) {
    throw new TaxFastTrackComputeError('letter_generation_failed', `letter parse failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { summary, letterBody: letter.letterBody };
}
