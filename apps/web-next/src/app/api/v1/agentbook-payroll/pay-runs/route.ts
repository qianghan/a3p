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
import { publicErrorMessage, PublicError } from '@/lib/api-error';
import { serializableTx } from '@/lib/serializable-tx';
import { isPayFrequency, payPeriodFor, toIsoDate, type PayFrequency } from '@/lib/payroll-frequency';

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
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Caller-facing conflict (text written for the caller). */
class DraftConflict extends PublicError {
  constructor(readonly httpStatus: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message, httpStatus); }
}

interface DraftGroup { frequency: PayFrequency; period: ReturnType<typeof payPeriodFor>; members: EmployeeRow[] }
interface RunRow { id: string; status: string; payFrequency?: string | null; stubs?: Array<{ employeeId: string }> }

/**
 * Runs that ARE this group's run: same tenant + period, and either the same
 * frequency or a legacy run with no frequency recorded (dedupe).
 */
async function samePeriodRuns(tx: typeof db, tenantId: string, g: DraftGroup): Promise<RunRow[]> {
  const rows = (await tx.abPayRun.findMany({
    where: { tenantId, periodStart: dateOnly(g.period.periodStart), periodEnd: dateOnly(g.period.periodEnd) },
    include: { stubs: true },
  })) as RunRow[];
  return rows.filter((r) => r.payFrequency === g.frequency || r.payFrequency == null);
}

/**
 * One group, inside a Serializable transaction: extend the existing draft
 * with any member not yet on it, or create the draft. A processed/paid run
 * for the period with no draft beside it is a 409 — never a silent skip.
 */
async function upsertGroupDraft(tx: typeof db, tenantId: string, g: DraftGroup) {
  const matches = await samePeriodRuns(tx, tenantId, g);
  const draft = matches.find((r) => r.status === 'draft');
  if (!draft && matches.length > 0) {
    throw new DraftConflict(409, 'period_already_processed', 'a pay run for this period has already been processed',
      { employeeIds: g.members.map((m) => m.id), periodStart: g.period.periodStart, periodEnd: g.period.periodEnd, payFrequency: g.frequency });
  }
  const run = draft ?? await tx.abPayRun.create({
    data: { tenantId, periodStart: dateOnly(g.period.periodStart), periodEnd: dateOnly(g.period.periodEnd), payDate: dateOnly(g.period.payDate), payFrequency: g.frequency, status: 'draft' },
  });
  const onRun = new Set((draft?.stubs ?? []).map((s) => s.employeeId));
  let addedStubs = 0;
  for (const emp of g.members) {
    if (onRun.has(emp.id)) continue;
    await tx.abPayStub.create({ data: stubData(tenantId, run.id, emp) });
    addedStubs++;
  }
  return { id: run.id, created: !draft, addedStubs };
}

async function generateDrafts(tenantId: string, body: { asOf?: string; employeeIds?: unknown }): Promise<NextResponse> {
  const asOf = body.asOf ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DAY.test(asOf) || isNaN(Date.parse(`${asOf}T00:00:00Z`)) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) {
    return NextResponse.json({ success: false, error: 'asOf must be a valid YYYY-MM-DD date' }, { status: 400 });
  }
  const ids = Array.isArray(body.employeeIds) ? body.employeeIds.filter((x): x is string => typeof x === 'string') : null;
  const employees = (await db.abEmployee.findMany({
    where: { tenantId, isActive: true, ...(ids ? { id: { in: ids } } : {}) },
  })) as EmployeeRow[];
  if (employees.length === 0) {
    return NextResponse.json({ success: false, error: 'no active employees to pay' }, { status: 400 });
  }

  // Group by the PERIOD the employee's cycle gives (anchors 14·k days apart share one draft).
  const groups = new Map<string, DraftGroup>();
  for (const emp of employees) {
    const frequency: PayFrequency = isPayFrequency(emp.payFrequency) ? emp.payFrequency : 'biweekly';
    const anchorSrc = emp.payAnchorDate ?? emp.startDate ?? emp.createdAt ?? null;
    const anchorMs = anchorSrc ? new Date(anchorSrc).getTime() : NaN;
    const anchor = Number.isFinite(anchorMs) ? toIsoDate(new Date(anchorMs)) : null;
    let period;
    try {
      period = payPeriodFor(frequency, anchor ?? asOf, asOf);
    } catch {
      return NextResponse.json({ success: false, error: `employee ${emp.id} has an invalid pay anchor date` }, { status: 400 });
    }
    const key = `${frequency}|${period.periodStart}|${period.periodEnd}`;
    const g = groups.get(key) ?? { frequency, period, members: [] };
    g.members.push(emp);
    groups.set(key, g);
  }

  try {
    // Read-only pre-check so a processed period fails the whole request before anything is written.
    const conflicts: Array<Record<string, unknown>> = [];
    for (const g of groups.values()) {
      const m = await samePeriodRuns(db, tenantId, g);
      if (m.length > 0 && !m.some((r) => r.status === 'draft')) {
        conflicts.push({ employeeIds: g.members.map((e) => e.id), periodStart: g.period.periodStart, periodEnd: g.period.periodEnd, payFrequency: g.frequency });
      }
    }
    if (conflicts.length) {
      return NextResponse.json({
        success: false, code: 'period_already_processed', error: 'a pay run for this period has already been processed',
        employeeIds: conflicts.flatMap((c) => c.employeeIds as string[]), conflicts,
      }, { status: 409 });
    }

    const out: unknown[] = [];
    for (const g of groups.values()) {
      const r = await serializableTx(db, (tx) => upsertGroupDraft(tx, tenantId, g),
        () => new DraftConflict(409, 'concurrent_update', 'the pay run changed while saving; please retry'));
      const full = await db.abPayRun.findUnique({ where: { id: r.id }, include: { stubs: true } });
      out.push({ ...full, created: r.created, addedStubs: r.addedStubs });
    }
    return NextResponse.json({ success: true, data: { asOf, runs: out } }, { status: 201 });
  } catch (err) {
    if (err instanceof DraftConflict) {
      return NextResponse.json({ success: false, code: err.code, error: publicErrorMessage(err), ...err.extra }, { status: err.httpStatus });
    }
    throw err;
  }
}
