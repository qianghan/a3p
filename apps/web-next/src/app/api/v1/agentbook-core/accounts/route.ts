/**
 * Chart of accounts — list + create.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { resolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const accounts = await db.abAccount.findMany({
      where: { tenantId, isActive: true },
      orderBy: { code: 'asc' },
    });
    return NextResponse.json({ success: true, data: accounts });
  } catch (err) {
    console.error('[agentbook-core/accounts GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface CreateAccountBody {
  code?: string;
  name?: string;
  accountType?: string;
  parentId?: string;
  taxCategory?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const tenantId = await resolveAgentbookTenant(request);
    const body = (await request.json().catch(() => ({}))) as CreateAccountBody;
    const { code, name, accountType, parentId, taxCategory } = body;
    if (!code || !name || !accountType) {
      return NextResponse.json(
        { success: false, error: 'code, name, and accountType are required' },
        { status: 400 },
      );
    }
    try {
      const account = await db.abAccount.create({
        data: { tenantId, code, name, accountType, parentId, taxCategory },
      });
      return NextResponse.json({ success: true, data: account }, { status: 201 });
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
        return NextResponse.json(
          { success: false, error: 'Account code already exists for this tenant' },
          { status: 409 },
        );
      }
      throw err;
    }
  } catch (err) {
    console.error('[agentbook-core/accounts POST] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
