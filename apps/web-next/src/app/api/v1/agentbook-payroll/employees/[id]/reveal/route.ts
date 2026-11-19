/**
 * POST employees/[id]/reveal — return ONE decrypted sensitive field
 * (PR 4b, spec §5.5).
 *
 * Gates, in order: tenant auth → owner session (a CRON_SECRET service caller
 * is never the owner) → tenant-scoped employee (cross-tenant → 404) →
 * per-tenant rate limit → decrypt (missing key in prod/preview → 503
 * pii_key_unconfigured) → AbEmployeeChange `reveal` audit row → respond.
 * The audit row is written BEFORE the value leaves; if it fails, nothing is
 * revealed.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { isTenantOwner } from '@/lib/agentbook-session-owner';
import { checkAndIncrement } from '@/lib/agentbook-rate-limit';
import { decryptPii, isPiiKeyUnconfigured, PII_KEY_UNCONFIGURED } from '@/lib/agentbook-employee-pii';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ id: string }> }

const bodySchema = z.object({ field: z.enum(['taxId', 'bankAccount', 'superMemberNumber']) }).strict();
const COLUMN = { taxId: 'taxIdEnc', bankAccount: 'bankAccountEnc', superMemberNumber: 'superMemberNumberEnc' } as const;
export const REVEAL_RATE_LIMIT = { perMinute: 5, perDay: 50 };

export async function POST(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;
    if (!(await isTenantOwner(request, tenantId))) {
      return NextResponse.json({ success: false, error: 'only the account owner can reveal employee details' }, { status: 403 });
    }
    const { id } = await ctx.params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ success: false, error: 'field must be taxId, bankAccount or superMemberNumber' }, { status: 400 });
    const { field } = parsed.data;

    const employee = await db.abEmployee.findFirst({ where: { id, tenantId } });
    if (!employee) return NextResponse.json({ success: false, error: 'employee not found' }, { status: 404 });

    const limit = await checkAndIncrement(tenantId, 'employee-pii-reveal', REVEAL_RATE_LIMIT);
    if (!limit.allowed) {
      const retry = Math.max(1, Math.ceil((limit.retryAfterMs ?? 60_000) / 1000));
      return NextResponse.json({ success: false, error: 'too many reveal requests' }, { status: 429, headers: { 'Retry-After': String(retry) } });
    }

    const row = await db.abEmployeeSensitive.findUnique({ where: { employeeId: id } });
    const enc = row && row.tenantId === tenantId ? row[COLUMN[field]] : null;
    if (!enc) return NextResponse.json({ success: false, error: 'no value on file' }, { status: 404 });

    let value: string;
    try {
      value = decryptPii(enc);
    } catch (err) {
      if (isPiiKeyUnconfigured(err)) {
        return NextResponse.json({ success: false, code: PII_KEY_UNCONFIGURED, error: 'Encryption is not configured.' }, { status: 503 });
      }
      throw err;
    }

    await db.abEmployeeChange.create({ data: { tenantId, employeeId: id, actorId: tenantId, action: 'reveal', fields: [field] } });
    return NextResponse.json({ success: true, data: { field, value } }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}` : 'unknown error';
    console.error(`[agentbook-payroll/employees reveal] failed: ${message}`);
    return NextResponse.json({ success: false, error: 'reveal failed' }, { status: 500 });
  }
}
