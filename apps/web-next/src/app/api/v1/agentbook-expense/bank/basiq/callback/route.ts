/**
 * GET /api/v1/agentbook-expense/bank/basiq/callback?jobId=...&state=...
 *
 * Basiq redirects the browser here once the user finishes (or abandons)
 * the hosted Consent UI flow, carrying the resulting `jobId` (and the
 * `state` we passed through `consent-url/route.ts`) as query params.
 *
 * This route does NOT poll the job or create any `AbBankAccount` rows —
 * that stays in `status/route.ts`. Its only job is to hand `jobId` back to
 * the popup's opener (the `BankConnection.tsx` page that opened this popup)
 * via `postMessage`, then close itself, so the parent window's existing
 * poll loop can take over.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Basiq job ids are opaque alphanumeric resource identifiers. Validating
// against this allowlist before the value is ever embedded in the HTML
// response closes a reflected-XSS path: without it, a crafted `jobId` query
// param containing `</script>` could break out of the inline <script> block
// this route renders (CodeQL js/reflected-xss, confirmed during review).
const SAFE_JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const rawJobId = request.nextUrl.searchParams.get('jobId');
  const jobId = rawJobId && SAFE_JOB_ID.test(rawJobId) ? rawJobId : null;

  // Defense in depth even after the allowlist check above: escape `<` so a
  // `</script>` sequence can never terminate this tag early, matching the
  // standard safe-JSON-in-script idiom.
  const safeJobIdLiteral = JSON.stringify(jobId).replace(/</g, '\\u003c');

  const html = `<!doctype html>
<html>
  <body>
    <script>
      if (window.opener) {
        window.opener.postMessage({ basiqJobId: ${safeJobIdLiteral} }, window.location.origin);
      }
      window.close();
    </script>
  </body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
