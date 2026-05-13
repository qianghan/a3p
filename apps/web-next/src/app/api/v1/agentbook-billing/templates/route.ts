import { NextRequest, NextResponse } from 'next/server';
import { SEED_TEMPLATES } from '@/lib/billing/templates';
import { requireAdmin, HttpError } from '@/lib/billing/admin-auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await requireAdmin(request);
  } catch (err) {
    const e = err as HttpError;
    return NextResponse.json({ error: e.message }, { status: e.status });
  }
  return NextResponse.json({ templates: SEED_TEMPLATES });
}
