import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Receives Basiq's post-consent redirect for the personal-finance (AU) bank
 * connect flow: `?jobId=...&state=<tenantId>`. Mirrors the business-side
 * `agentbook-expense/bank/basiq/callback` route (AU-1 Task 2, Step 1b)
 * exactly.
 *
 * This route's only job is to hand `jobId` back to the popup's opener via
 * `postMessage`, then close itself — the actual job polling + account
 * creation stays in `status/route.ts`, which the frontend polls once it
 * receives this message. Not gated by `requirePersonalInsightsAddon`: it
 * never touches the database or calls Basiq, it only relays a query param
 * that arrived via a browser redirect.
 */
// Basiq job ids are opaque alphanumeric resource identifiers. Validating
// against this allowlist before the value is ever embedded in the HTML
// response closes a reflected-XSS path: without it, a crafted `jobId` query
// param containing `</script>` could break out of the inline <script> block
// this route renders (CodeQL js/reflected-xss, confirmed on the mirrored
// business-side route during review — fixed here too since this route
// copies that exact pattern).
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rawJobId = request.nextUrl.searchParams.get('jobId');
  const jobId = rawJobId && SAFE_JOB_ID.test(rawJobId) ? rawJobId : null;
  // Defense in depth even after the allowlist check above: escape `<` so a
  // `</script>` sequence can never terminate this tag early.
  const safeJobIdLiteral = JSON.stringify(jobId).replace(/</g, '\\u003c');
  const html = `<!doctype html><script>
      if (window.opener) { window.opener.postMessage({ basiqJobId: ${safeJobIdLiteral} }, window.location.origin); }
      window.close();
    </script>`;
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html' } });
}
