/**
 * Pay runs — list (GET) + create (POST).
 *
 * Creating a pay run computes a pay stub for every active employee using the
 * pure payroll engine (gross for the period → federal/FICA withholding → net),
 * in a single transaction. The run starts in 'draft'; /process posts it to the
 * ledger.
 *
 * PR 4c: `{ generate: 'drafts', asOf?, employeeIds? }` instead generates one
 * draft per frequency group (weekly/biweekly also split by anchor) from each
 * employee's payAnchorDate (fallback: startDate), storing payDate and
 * payFrequency. Idempotent per group+period. Stubs read the employee's
 * CURRENT rate, so a rate edit reaches the next draft only — existing runs
 * keep the stubs they were created with.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';
import { calcPay, periodGross, PERIODS_PER_YEAR } from '@/lib/payroll-engine';
import { publicErrorMessage } from '@/lib/api-error';
import { groupKey, isPayFrequency, payPeriodFor, toIsoDate, type PayFrequency } from '@/lib/payroll-frequency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const runs = await db.abPayRun.findMany({
      where: { tenantId },
      orderBy: { periodEnd: 'desc' },
      include: { stubs: true },
      take: 50,
    });
    return NextResponse.json({ success: true, data: runs });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs GET] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as { periodStart?: string; periodEnd?: string; generate?: string; asOf?: string; employeeIds?: unknown };
    if (body.generate === 'drafts') return generateDrafts(tenantId, body);
    if (!body.periodStart || !body.periodEnd) {
      return NextResponse.json({ success: false, error: 'periodStart and periodEnd are required' }, { status: 400 });
    }
    const periodStart = new Date(body.periodStart);
    const periodEnd = new Date(body.periodEnd);
    if (isNaN(periodStart.getTime()) || isNaN(periodEnd.getTime())) {
      return NextResponse.json({ success: false, error: 'invalid dates' }, { status: 400 });
    }

    const employees = await db.abEmployee.findMany({ where: { tenantId, isActive: true } });
    if (employees.length === 0) {
      return NextResponse.json({ success: false, error: 'no active employees to pay' }, { status: 400 });
    }

    const run = await db.$transaction(async (tx) => {
      const created = await tx.abPayRun.create({
        data: { tenantId, periodStart, periodEnd, status: 'draft' },
      });
      for (const emp of employees) await tx.abPayStub.create({ data: stubData(tenantId, created.id, emp) });
      return created;
    });

    const full = await db.abPayRun.findUnique({ where: { id: run.id }, include: { stubs: true } });
    return NextResponse.json({ success: true, data: full }, { status: 201 });
  } catch (err) {
    console.error('[agentbook-payroll/pay-runs POST] failed:', err);
    return NextResponse.json({ success: false, error: publicErrorMessage(err) }, { status: 500 });
  }
}

interface EmployeeRow {
  id: string; name: string; payType: string; payRateCents: number; payFrequency: string;
  jurisdiction: string; region: string; filingStatus: string; payAnchorDate?: Date | null; startDate?: Date | null; createdAt?: Date | null;
}

function stubData(tenantId: string, payRunId: string, emp: EmployeeRow) {
  const periodsPerYear = PERIODS_PER_YEAR[emp.payFrequency] ?? 26;
  // Salary → per-period split; hourly → rate treated as the period gross.
  const grossCents = emp.payType === 'salary' ? periodGross(emp.payRateCents, emp.payFrequency) : emp.payRateCents;
  const pay = calcPay({
    jurisdiction: emp.jurisdiction,
    grossCents,
    payPeriodsPerYear: periodsPerYear,
    filingStatus: emp.filingStatus,
    region: emp.region,
  });
  return {
    tenantId,
    payRunId,
    employeeId: emp.id,
    employeeName: emp.name,
    grossCents: pay.grossCents,
    federalTaxCents: pay.federalTaxCents,
    stateTaxCents: pay.stateTaxCents,
    ficaCents: pay.ficaCents,
    otherDeductCents: pay.otherDeductCents,
    netCents: pay.netCents,
    sgCents: pay.sgCents,
  };
}

const dateOnly = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

async function generateDrafts(tenantId: string, body: { asOf?: string; employeeIds?: unknown }): Promise<NextResponse> {
  const asOf = body.asOf ?? new Date().toISOString().slice(0, 10);
  const ids = Array.isArray(body.employeeIds) ? body.employeeIds.filter((x): x is string => typeof x === 'string') : null;
  const employees = (await db.abEmployee.findMany({
    where: { tenantId, isActive: true, ...(ids ? { id: { in: ids } } : {}) },
  })) as EmployeeRow[];
  if (employees.length === 0) {
    return NextResponse.json({ success: false, error: 'no active employees to pay' }, { status: 400 });
  }

  const groups = new Map<string, { frequency: PayFrequency; period: ReturnType<typeof payPeriodFor>; members: EmployeeRow[] }>();
  for (const emp of employees) {
    const frequency: PayFrequency = isPayFrequency(emp.payFrequency) ? emp.payFrequency : 'biweekly';
    const anchorSrc = emp.payAnchorDate ?? emp.startDate ?? emp.createdAt ?? null;
    const anchor = anchorSrc ? toIsoDate(anchorSrc) : null;
    let period;
    try {
      period = payPeriodFor(frequency, anchor ?? asOf, asOf);
    } catch {
      return NextResponse.json({ success: false, error: 'asOf must be a valid YYYY-MM-DD date' }, { status: 400 });
    }
    const key = `${groupKey(frequency, anchor)}|${period.periodStart}`;
    const g = groups.get(key) ?? { frequency, period, members: [] };
    g.members.push(emp);
    groups.set(key, g);
  }

  const out: unknown[] = [];
  for (const g of groups.values()) {
    const periodStart = dateOnly(g.period.periodStart);
    const periodEnd = dateOnly(g.period.periodEnd);
    const existing = await db.abPayRun.findFirst({ where: { tenantId, periodStart, periodEnd, payFrequency: g.frequency } });
    if (existing) {
      const full = await db.abPayRun.findUnique({ where: { id: existing.id }, include: { stubs: true } });
      out.push({ ...full, created: false });
      continue;
    }
    const run = await db.$transaction(async (tx) => {
      const created = await tx.abPayRun.create({
        data: { tenantId, periodStart, periodEnd, payDate: dateOnly(g.period.payDate), payFrequency: g.frequency, status: 'draft' },
      });
      for (const emp of g.members) await tx.abPayStub.create({ data: stubData(tenantId, created.id, emp) });
      return created;
    });
    const full = await db.abPayRun.findUnique({ where: { id: run.id }, include: { stubs: true } });
    out.push({ ...full, created: true });
  }
  return NextResponse.json({ success: true, data: { asOf, runs: out } }, { status: 201 });
}
