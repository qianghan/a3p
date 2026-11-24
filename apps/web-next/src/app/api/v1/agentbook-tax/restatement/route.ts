/**
 * Opt-in tax restatement of legacy gross expenses (spec §5.1, PR 2c).
 *
 *   GET  /api/v1/agentbook-tax/restatement?year=2026  → preview (read-only)
 *   POST /api/v1/agentbook-tax/restatement { year }   → apply (idempotent)
 *
 * `year` is the tax year: AU names the 1 Jul – 30 Jun income year by its
 * ending year, CA the calendar year. Omitted = the current tax year.
 * Everything is tenant-scoped (no ids are accepted); the work is in
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
  restatementYearOf,
} from '@/lib/tax-restatement';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

async function resolveYear(tenantId: string, raw: unknown): Promise<number | NextResponse> {
  if (raw === undefined || raw === null || raw === '') {
    const cfg = await db.abTenantConfig.findUnique({ where: { userId: tenantId } });
    return restatementYearOf(cfg?.jurisdiction, new Date());
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
    const body = (await request.json().catch(() => ({}))) as { year?: unknown };
    const year = await resolveYear(tenantId, body?.year);
    if (year instanceof NextResponse) return year;
    const result = await applyTaxRestatement(tenantId, year);
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
