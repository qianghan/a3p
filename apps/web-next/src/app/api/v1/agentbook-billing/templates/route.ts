import { NextRequest, NextResponse } from 'next/server';
import { SEED_TEMPLATES } from '@/lib/billing/templates';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(request);
    return NextResponse.json({ templates: SEED_TEMPLATES });
  } catch (err) {
    if (err instanceof HttpError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}
