/**
 * Chart-of-accounts bulk seed — upsert each row by (tenantId, code).
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface SeedAccount {
  code: string;
  name: string;
  accountType: string;
  taxCategory?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as { accounts?: SeedAccount[] };
    const { accounts } = body;
    if (!accounts || !Array.isArray(accounts)) {
      return NextResponse.json(
        { success: false, error: 'accounts array is required' },
        { status: 400 },
      );
    }
    const created = await db.$transaction(
      accounts.map((a) =>
        db.abAccount.upsert({
          where: { tenantId_code: { tenantId, code: a.code } },
          update: { name: a.name, accountType: a.accountType, taxCategory: a.taxCategory },
          create: { tenantId, code: a.code, name: a.name, accountType: a.accountType, taxCategory: a.taxCategory },
        }),
      ),
    );
    return NextResponse.json({ success: true, data: { count: created.length } }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-core/accounts/seed POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
