import 'server-only';
import { prisma as db } from '@naap/database';
import { computeFilingDraftSummaryAndLetter, TaxFastTrackComputeError } from '@agentbook-core/tax-fast-track-draft-compute';
import type { CallGeminiFn } from '@agentbook-core/tax-questionnaire-core';

export type TaxFastTrackDraftFailureCode =
  | 'delta_extraction_failed'
  | 'letter_generation_failed'
  | 'pdf_render_failed'
  | 'upload_failed';

/**
 * Generates the filing-draft PDF + client-letter PDF for a completed
 * AbTaxQuestionnaireSession and persists them on its AbTaxFastTrackDraft
 * row. Safe to call again after a failure (upserts to 'pending' first) —
 * NOT safe to call concurrently with itself for the same sessionId (two
 * simultaneous calls both redo the LLM/render/upload work; wasteful but
 * not corrupting, since both end in a valid 'ready' state). Callers
 * (Task 5) guard against this at the UI level (disable the retry button
 * while a request is in flight), not here.
 */
export async function generateFilingDraft(sessionId: string, callGemini: CallGeminiFn): Promise<void> {
  const session = await db.abTaxQuestionnaireSession.findUnique({ where: { id: sessionId } });
  if (!session) {
    throw new Error(`generateFilingDraft: no session found for ${sessionId}`);
  }

  const draft = await db.abTaxFastTrackDraft.upsert({
    where: { sessionId },
    update: { status: 'pending', errorMsg: null },
    create: {
      tenantId: session.tenantId, sessionId, taxYear: session.taxYear,
      jurisdiction: session.jurisdiction, status: 'pending',
    },
    select: { id: true },
  });

  let failurePhase: TaxFastTrackDraftFailureCode = 'delta_extraction_failed';

  try {
    const { summary, letterBody } = await computeFilingDraftSummaryAndLetter(sessionId, callGemini).catch((err) => {
      if (err instanceof TaxFastTrackComputeError) {
        failurePhase = err.code;
      }
      throw err;
    });

    failurePhase = 'pdf_render_failed';
    const { renderFilingDraftPdf, renderClientLetterPdf } = await import('./tax-fast-track-pdf');
    const [draftPdfBuf, letterPdfBuf] = await Promise.all([
      renderFilingDraftPdf(summary, session.taxYear, session.jurisdiction),
      renderClientLetterPdf(letterBody, session.taxYear),
    ]);

    failurePhase = 'upload_failed';
    const { uploadBlob } = await import('./agentbook-blob');
    const namePrefix = `tax-fast-track/${session.tenantId}/${sessionId}`;
    const [draftUp, letterUp] = await Promise.all([
      uploadBlob(`${namePrefix}/draft.pdf`, draftPdfBuf, 'application/pdf'),
      uploadBlob(`${namePrefix}/letter.pdf`, letterPdfBuf, 'application/pdf'),
    ]);

    await db.abTaxFastTrackDraft.update({
      where: { id: draft.id },
      data: {
        draftPdfUrl: draftUp.url,
        letterPdfUrl: letterUp.url,
        draftSummary: summary as object,
        status: 'ready',
        errorMsg: null,
      },
    });
  } catch (err) {
    console.error(`[tax-fast-track-draft] failed phase=${failurePhase} session=${sessionId}:`, err);
    await db.abTaxFastTrackDraft.update({
      where: { id: draft.id },
      data: { status: 'failed', errorMsg: failurePhase },
    }).catch(() => {});
  }
}
