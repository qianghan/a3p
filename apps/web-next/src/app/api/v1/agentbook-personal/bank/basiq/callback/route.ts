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
export async function GET(request: NextRequest): Promise<NextResponse> {
  const jobId = request.nextUrl.searchParams.get('jobId');
  const html = `<!doctype html><script>
      if (window.opener) { window.opener.postMessage({ basiqJobId: ${JSON.stringify(jobId)} }, window.location.origin); }
      window.close();
    </script>`;
  return new NextResponse(html, { headers: { 'Content-Type': 'text/html' } });
}
