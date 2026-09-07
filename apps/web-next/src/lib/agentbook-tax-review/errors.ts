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
import { publicErrorMessage } from '@/lib/api-error';
import { NoActiveReviewError, InvalidMoneyValueError } from '@agentbook-tax/tax-review-agent';

export function reviewErrorResponse(tag: string, err: unknown): NextResponse {
  const refused = err instanceof NoActiveReviewError || err instanceof InvalidMoneyValueError;
  const status = err instanceof NoActiveReviewError ? 409 : err instanceof InvalidMoneyValueError ? 400 : 500;
  if (!refused) console.error(`[${tag}] failed:`, err);
  // A typed refusal's message is written for the caller and is the reason the
  // status is 409/400 rather than 500, so it is returned as-is. Anything else
  // reaching here is unexpected and gets the sanitizer -- these errors are
  // defined in the tax plugin, which cannot import from apps/web-next/src/lib,
  // so they cannot extend PublicError and are recognised by type here instead.
  return NextResponse.json(
    { success: false, error: refused ? (err as Error).message : publicErrorMessage(err) },
    { status },
  );
}
