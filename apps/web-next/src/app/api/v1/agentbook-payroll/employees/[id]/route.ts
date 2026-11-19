/**
 * Payroll employee — masked read (GET), strict update (PUT), deactivate (DELETE).
 *
 * PR 4b (spec §5.5): every response goes through maskEmployee (last4 / flags,
 * never ciphertext); PUT is a strict zod schema (unknown keys → 400) with
 * per-jurisdiction tax-id validation; sensitive inputs are encrypted before
 * any write, and a missing key in production/preview is a 503
 * `pii_key_unconfigured` with nothing written. Every change writes an
 * AbEmployeeChange row holding field NAMES only.
 *
 * Callers audited before going strict (2026-11-19): no client sends PUT to
 * this route today — payroll page and e2e only POST /employees; mobile and
 * chat skills read employees directly.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { publicErrorMessage } from '@/lib/api-error';
import { resolveSessionUserId } from '@/lib/agentbook-session-owner';
import { encryptPii, isPiiKeyUnconfigured, PII_KEY_UNCONFIGURED } from '@/lib/agentbook-employee-pii';
import {
  employeeUpdateSchema, maskEmployee, isMaskedInput, validateTaxId, SENSITIVE_INPUT_KEYS,
} from '@/lib/agentbook-employee-profile';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

interface RouteCtx { params: Promise<{ id: string }> }

const notFound = () => NextResponse.json({ success: false, error: 'employee not found' }, { status: 404 });
const bad = (error: string, issues?: unknown) => NextResponse.json({ success: false, error, ...(issues ? { issues } : {}) }, { status: 400 });
const last4 = (s: string) => s.replace(/[^0-9A-Za-z]/g, '').slice(-4);

/** Log the failure's name/message only — never the request body or Prisma args. */
function logFailure(where: string, err: unknown) {
  const message = err instanceof Error ? `${err.name}: ${err.message.split('\n')[0]}` : 'unknown error';
  console.error(`[agentbook-payroll/employees ${where}] failed: ${message}`);
}

export async function GET(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;
    const { id } = await ctx.params;
    const employee = await db.abEmployee.findFirst({ where: { id, tenantId }, include: { sensitive: true } });
    if (!employee) return notFound();
    return NextResponse.json({ success: true, data: maskEmployee(employee) });
  } catch (err) {
    logFailure('GET', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;
    const { id } = await ctx.params;
    const existing = await db.abEmployee.findFirst({ where: { id, tenantId } });
    if (!existing) return notFound();

    const raw = await request.json().catch(() => null);
    const parsed = employeeUpdateSchema.safeParse(raw ?? {});
    if (!parsed.success) {
      // Paths and codes only — zod messages never carry the input value, but don't rely on it.
      return bad('invalid employee update', parsed.error.issues.map((i) => ({ path: i.path.join('.'), code: i.code, keys: (i as { keys?: string[] }).keys })));
    }
    const input = parsed.data;
    const jurisdiction = input.jurisdiction ?? existing.jurisdiction;

    // Plain profile fields (everything that is not a sensitive input).
    const update: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) {
      if ((SENSITIVE_INPUT_KEYS as readonly string[]).includes(k)) continue;
      if (v !== undefined) update[k] = v;
    }

    // Sensitive fields. Masked echoes from the UI are "unchanged".
    const sens: Record<string, string | null> = {};
    const changedSensitive: string[] = [];
    const taxId = input.taxId && !isMaskedInput(input.taxId) ? input.taxId : undefined;
    const bankAccount = input.bankAccount && !isMaskedInput(input.bankAccount) ? input.bankAccount : undefined;
    const member = input.superMemberNumber && !isMaskedInput(input.superMemberNumber) ? input.superMemberNumber : undefined;
    if (taxId !== undefined && !validateTaxId(jurisdiction, taxId)) return bad(`invalid tax id for jurisdiction ${jurisdiction}`);
    if (bankAccount !== undefined && !/^\d{4,17}$/.test(bankAccount.replace(/[\s-]/g, ''))) return bad('invalid bank account');

    try {
      if (taxId !== undefined) {
        const d = taxId.replace(/[\s-]/g, '');
        sens.taxIdEnc = encryptPii(d); sens.taxIdLast4 = last4(d); changedSensitive.push('taxId');
      }
      if (bankAccount !== undefined) {
        const d = bankAccount.replace(/[\s-]/g, '');
        sens.bankAccountEnc = encryptPii(d); sens.bankLast4 = last4(d); changedSensitive.push('bankAccount');
      }
      if (member !== undefined) { sens.superMemberNumberEnc = encryptPii(member.trim()); changedSensitive.push('superMemberNumber'); }
    } catch (err) {
      if (isPiiKeyUnconfigured(err)) {
        return NextResponse.json({ success: false, code: PII_KEY_UNCONFIGURED, error: 'Sensitive employee fields cannot be saved yet: encryption is not configured.' }, { status: 503 });
      }
      throw err;
    }
    for (const k of ['bankRoutingLabel', 'superFundUsi', 'superFundName'] as const) {
      if (input[k] !== undefined) { sens[k] = input[k] ?? null; changedSensitive.push(k); }
    }

    const changedPlain = Object.keys(update).filter((k) => {
      const before = (existing as Record<string, unknown>)[k];
      const a = before instanceof Date ? before.toISOString() : before;
      const b = update[k] instanceof Date ? (update[k] as Date).toISOString() : update[k];
      return a !== b;
    });
    const fields = [...changedPlain, ...changedSensitive];
    const actorId = (await resolveSessionUserId(request)) ?? 'service';

    await db.$transaction(async (tx) => {
      if (Object.keys(update).length) await tx.abEmployee.updateMany({ where: { id, tenantId }, data: update });
      if (Object.keys(sens).length) {
        await tx.abEmployeeSensitive.upsert({
          where: { employeeId: id },
          create: { tenantId, employeeId: id, ...sens },
          update: sens,
        });
      }
      if (fields.length) await tx.abEmployeeChange.create({ data: { tenantId, employeeId: id, actorId, action: 'update', fields } });
    });

    const fresh = await db.abEmployee.findFirst({ where: { id, tenantId }, include: { sensitive: true } });
    if (!fresh) return notFound();
    return NextResponse.json({ success: true, data: maskEmployee(fresh) });
  } catch (err) {
    logFailure('PUT', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, ctx: RouteCtx): Promise<NextResponse> {
  try {
    const resolved = await safeResolveAgentbookTenant(request);
    if ('response' in resolved) return resolved.response;
    const { tenantId } = resolved;
    const { id } = await ctx.params;
    const existing = await db.abEmployee.findFirst({ where: { id, tenantId } });
    if (!existing) return notFound();
    await db.abEmployee.updateMany({ where: { id, tenantId }, data: { isActive: false } });
    return NextResponse.json({ success: true, data: maskEmployee({ ...existing, isActive: false }) });
  } catch (err) {
    logFailure('DELETE', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}
