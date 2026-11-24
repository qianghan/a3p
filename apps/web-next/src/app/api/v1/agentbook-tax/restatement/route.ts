/**
 * Opt-in tax restatement of legacy gross expenses (spec §5.1, PR 2c).
 *
 *   GET  /api/v1/agentbook-tax/restatement?year=2026  → preview (read-only)
 *   POST /api/v1/agentbook-tax/restatement { year, expenseIds? } → apply (idempotent;
 *        expenseIds restricts it to those rows — another tenant's id is 404)
 *
 * `year` is the tax year: AU names the 1 Jul – 30 Jun income year by its
 * ending year, CA the calendar year. Omitted = the current tax year.
 * Everything is tenant-scoped; the work is in
 * lib/tax-restatement.ts and writes only through the expense ledger's
 * repost (ledger writer, closed-period gate).
 */
import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import {
  previewTaxRestatement,
  applyTaxRestatement,
  defaultRestatementYear,
} from '@/lib/tax-restatement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function resolveYear(tenantId: string, raw: unknown): Promise<number | NextResponse> {
  if (raw === undefined || raw === null || raw === '') {
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    return defaultRestatementYear(cfg);
  }
  const year = typeof raw === 'number' ? raw : Number(String(raw));
  const max = new Date().getUTCFullYear() + 1;
  if (!Number.isInteger(year) || year < 2000 || year > max) {
    return NextResponse.json(
      { success: false, error: { code: 'invalid_year', message: `year must be a tax year between 2000 and ${max}` } },
      { status: 400 },
    );
  }
  return year;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;
    const year = await resolveYear(tenantId, request.nextUrl.searchParams.get('year'));
    if (year instanceof NextResponse) return year;
    return NextResponse.json({ success: true, data: await previewTaxRestatement(tenantId, year) });
  } catch (err) {
    console.error('[agentbook-tax/restatement] preview failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;
    const body = (await request.json().catch(() => ({}))) as { year?: unknown; expenseIds?: unknown; cursor?: unknown };
    const year = await resolveYear(tenantId, body?.year);
    if (year instanceof NextResponse) return year;
    // Optional subset: restate only these expenses (e.g. one row, or a test
    // fixture). Every id must be this tenant's — anything else is a 404.
    let expenseIds: string[] | undefined;
    if (body?.expenseIds !== undefined) {
      if (!Array.isArray(body.expenseIds) || body.expenseIds.length === 0 || body.expenseIds.length > 500 || !body.expenseIds.every((x) => typeof x === 'string' && x.length > 0)) {
        return NextResponse.json({ success: false, error: { code: 'invalid_expense_ids', message: 'expenseIds must be a non-empty array of expense ids' } }, { status: 400 });
      }
      expenseIds = [...new Set(body.expenseIds as string[])];
      for (const id of expenseIds) {
        const own = await db.abExpense.findFirst({ where: { id, tenantId }, select: { id: true } });
        if (!own) return NextResponse.json({ success: false, error: { code: 'not_found', message: 'Expense not found' } }, { status: 404 });
      }
    }
    // N-2: continue after the last row a previous call attempted.
    const cursor = typeof body?.cursor === 'string' && body.cursor.length > 0 && body.cursor.length <= 200 ? body.cursor : undefined;
    const result = await applyTaxRestatement(tenantId, year, undefined, { expenseIds, cursor });
    if (!result.applicable) {
      return NextResponse.json(
        { success: false, error: { code: result.notApplicableReason, message: 'Restatement applies only to GST/HST-registered Australian or Canadian businesses.' }, data: result },
        { status: 422 },
      );
    }
    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    console.error('[agentbook-tax/restatement] apply failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
