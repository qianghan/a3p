/**
 * "Has this filing been reviewed, against these exact numbers?"
 *
 * A leaf module by necessity, not by taste. These three functions used to live
 * in tax-review-agent.ts, and when the CSV worksheet export started asking
 * whether a filing had passed review (#513), importing them from there closed
 * a cycle:
 *
 *     tax-export -> tax-review-agent -> tax-efiling -> tax-export
 *                                                      (validateFiling)
 *
 * Under ESM one binding in a cycle is still uninitialised when the other module
 * runs, so which import breaks depends on load order — the confirm step of the
 * tax review silently stopped calling submitFiling, and only an agentbook-core
 * test noticed, on a PR that touched neither.
 *
 * This module imports the db client and node:crypto and nothing else, so it
 * cannot participate in a cycle. tax-review-agent re-exports
 * `hasConfirmedFreshReview` so its existing callers and tests are unaffected.
 */
import { createHash } from 'node:crypto';
import { db } from './db/client.js';

/**
 * The fingerprint a confirmation is recorded against. Any later edit to the
 * forms changes it, which is what makes a stale confirmation detectable rather
 * than merely old.
 */
export function hashForms(forms: Record<string, Record<string, any>>): string {
  return createHash('sha256').update(JSON.stringify(forms)).digest('hex');
}

/**
 * "Confirmed, against these exact numbers." The one definition, shared by
 * hasConfirmedFreshReview() and getReviewState() so the submit gate and the
 * web tab can never disagree about whether a review still counts.
 */
export function isConfirmedAndFresh(
  review: { status: string; reviewedFormsHash: string | null } | null,
  forms: Record<string, Record<string, any>> | null,
): boolean {
  if (!review || review.status !== 'confirmed' || !review.reviewedFormsHash || !forms) return false;
  return hashForms(forms) === review.reviewedFormsHash;
}

export async function hasConfirmedFreshReview(tenantId: string, taxYear: number): Promise<boolean> {
  const review = await db.abTaxFilingReview.findFirst({ where: { tenantId, taxYear } });
  if (!review) return false;

  const filing = await db.abTaxFiling.findFirst({ where: { tenantId, taxYear, filingType: 'personal_return' } });
  if (!filing) return false;

  return isConfirmedAndFresh(review, (filing.forms as Record<string, Record<string, any>>) || {});
}
