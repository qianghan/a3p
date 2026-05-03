/**
 * Internal endpoint for nightly e2e suite. Resets the dedicated e2e user
 * to a deterministic state. Token-gated; refuses to run if E2E_RESET_TOKEN
 * is unset (so production-like configs without the secret are inert).
 */
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.E2E_RESET_TOKEN;
  if (!expected) {
    return NextResponse.json({ error: 'not enabled' }, { status: 404 });
  }

  const presented = request.headers.get('x-e2e-reset-token');
  if (presented !== expected) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  try {
    // NOTE: directory is `e2e-test` (not `__test`) because Next.js excludes
    // any folder starting with `_` from the App Router. The plan/spec text
    // mentions `__test` — that path would 404. Downstream callers must use
    // /api/v1/e2e-test/reset-e2e-user instead.
    // From apps/web-next/src/app/api/v1/e2e-test/reset-e2e-user/ → repo root: 8 levels up
    // (reset-e2e-user → e2e-test → v1 → api → app → src → web-next → apps → repo-root)
    const { resetE2eUser } = await import('../../../../../../../../scripts/seed-e2e-user');
    const result = await resetE2eUser();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error('[reset-e2e-user] failed:', err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
