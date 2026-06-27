import { NextRequest, NextResponse } from 'next/server';
import { SEED_TEMPLATES } from '@/lib/billing/templates';
import { validateSession } from '@/lib/api/auth';

export const runtime = 'nodejs';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.cookies.get('naap_auth_token')?.value;
  if (!token || !(await validateSession(token))) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }
  return NextResponse.json({ templates: SEED_TEMPLATES });
}
