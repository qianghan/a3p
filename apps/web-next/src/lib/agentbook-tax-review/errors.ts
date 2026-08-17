/**
 * HTTP status mapping for the review agent's typed refusals.
 *
 * A request refused because there is no active review — or because the
 * amount is out of range — is a 409/400, not a 500. The caller can act on
 * it. Shared by the review Next route handlers so all of them answer the
 * same way; the Express plugin server has the same mapping in its own
 * sendReviewError().
 */

import 'server-only';
import { NextResponse } from 'next/server';
import { NoActiveReviewError, InvalidMoneyValueError } from '@agentbook-tax/tax-review-agent';

export function reviewErrorResponse(tag: string, err: unknown): NextResponse {
  const status =
    err instanceof NoActiveReviewError ? 409 : err instanceof InvalidMoneyValueError ? 400 : 500;
  if (status === 500) console.error(`[${tag}] failed:`, err);
  return NextResponse.json(
    { success: false, error: err instanceof Error ? err.message : String(err) },
    { status },
  );
}
