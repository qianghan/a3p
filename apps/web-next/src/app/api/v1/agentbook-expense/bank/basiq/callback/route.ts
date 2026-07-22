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

export async function GET(request: NextRequest): Promise<NextResponse> {
  const jobId = request.nextUrl.searchParams.get('jobId');

  const html = `<!doctype html>
<html>
  <body>
    <script>
      if (window.opener) {
        window.opener.postMessage({ basiqJobId: ${JSON.stringify(jobId)} }, window.location.origin);
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
