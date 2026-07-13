/**
 * Personal profile — GET (auto-create on first access) + PUT (upsert).
 *
 * Distinct from AbTenantConfig (the business profile): this is per-user
 * personal context — name, DOB, address, marital status, dependents,
 * employment, self-reported income — that lets the agent brain give richer,
 * contextual answers instead of answering generically. Deliberately excludes
 * government tax ID (SSN/SIN). See personal-profile-context.ts (agentbook-core
 * backend) for how this gets summarized into the LLM system prompt.
 */

import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { prisma as db } from '@naap/database';
import { safeResolveAgentbookTenant } from '@/lib/agentbook-tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const VALID_MARITAL_STATUS = ['single', 'married_joint', 'married_separate', 'head_of_household', 'widowed'];
const VALID_EMPLOYMENT_TYPE = ['w2', 'self_employed', 'mixed', 'unemployed', 'retired'];

/** Fields that must be set for the profile to count as "complete" — drives the dashboard reminder banner. */
function isComplete(profile: {
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: Date | null;
  city: string | null;
  state: string | null;
  country: string | null;
  maritalStatus: string | null;
  employmentType: string | null;
}): boolean {
  return Boolean(
    profile.firstName &&
      profile.lastName &&
      profile.dateOfBirth &&
      profile.city &&
      profile.state &&
      profile.country &&
      profile.maritalStatus &&
      profile.employmentType,
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;

    let profile = await db.abPersonalProfile.findUnique({ where: { userId: tenantId } });
    if (!profile) {
      profile = await db.abPersonalProfile.create({ data: { userId: tenantId } });
    }

    return NextResponse.json({ success: true, data: { ...profile, isComplete: isComplete(profile) } });
  } catch (err) {
    console.error('[agentbook-core/personal-profile GET] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

interface UpdateProfileBody {
  firstName?: string | null;
  lastName?: string | null;
  dateOfBirth?: string | null; // ISO date string
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  maritalStatus?: string | null;
  dependentsCount?: number | null;
  employmentType?: string | null;
  occupation?: string | null;
  estimatedAnnualIncomeCents?: number | null;
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const __resolved = await safeResolveAgentbookTenant(request);
    if ('response' in __resolved) return __resolved.response;
    const { tenantId } = __resolved;
    const body = (await request.json().catch(() => ({}))) as UpdateProfileBody;

    const update: Record<string, unknown> = {};
    if (body.firstName !== undefined) update.firstName = body.firstName;
    if (body.lastName !== undefined) update.lastName = body.lastName;
    if (body.dateOfBirth !== undefined) {
      if (body.dateOfBirth !== null && Number.isNaN(Date.parse(body.dateOfBirth))) {
        return NextResponse.json({ success: false, error: 'dateOfBirth must be a valid ISO date' }, { status: 400 });
      }
      update.dateOfBirth = body.dateOfBirth ? new Date(body.dateOfBirth) : null;
    }
    if (body.addressLine1 !== undefined) update.addressLine1 = body.addressLine1;
    if (body.addressLine2 !== undefined) update.addressLine2 = body.addressLine2;
    if (body.city !== undefined) update.city = body.city;
    if (body.state !== undefined) update.state = body.state;
    if (body.postalCode !== undefined) update.postalCode = body.postalCode;
    if (body.country !== undefined) update.country = body.country;
    if (body.maritalStatus !== undefined) {
      if (body.maritalStatus !== null && !VALID_MARITAL_STATUS.includes(body.maritalStatus)) {
        return NextResponse.json({ success: false, error: `maritalStatus must be one of: ${VALID_MARITAL_STATUS.join(', ')}` }, { status: 400 });
      }
      update.maritalStatus = body.maritalStatus;
    }
    if (body.dependentsCount !== undefined) {
      if (body.dependentsCount !== null && (!Number.isInteger(body.dependentsCount) || body.dependentsCount < 0)) {
        return NextResponse.json({ success: false, error: 'dependentsCount must be a non-negative integer' }, { status: 400 });
      }
      update.dependentsCount = body.dependentsCount;
    }
    if (body.employmentType !== undefined) {
      if (body.employmentType !== null && !VALID_EMPLOYMENT_TYPE.includes(body.employmentType)) {
        return NextResponse.json({ success: false, error: `employmentType must be one of: ${VALID_EMPLOYMENT_TYPE.join(', ')}` }, { status: 400 });
      }
      update.employmentType = body.employmentType;
    }
    if (body.occupation !== undefined) update.occupation = body.occupation;
    if (body.estimatedAnnualIncomeCents !== undefined) {
      if (body.estimatedAnnualIncomeCents !== null && (!Number.isFinite(body.estimatedAnnualIncomeCents) || body.estimatedAnnualIncomeCents < 0)) {
        return NextResponse.json({ success: false, error: 'estimatedAnnualIncomeCents must be a non-negative number' }, { status: 400 });
      }
      update.estimatedAnnualIncomeCents = body.estimatedAnnualIncomeCents;
    }

    const existing = await db.abPersonalProfile.findUnique({ where: { userId: tenantId } });
    const merged = { ...existing, ...update };
    if (!existing?.completedAt && isComplete(merged as Parameters<typeof isComplete>[0])) {
      update.completedAt = new Date();
    }

    const profile = await db.abPersonalProfile.upsert({
      where: { userId: tenantId },
      update,
      create: { userId: tenantId, ...update },
    });

    return NextResponse.json({ success: true, data: { ...profile, isComplete: isComplete(profile) } });
  } catch (err) {
    console.error('[agentbook-core/personal-profile PUT] failed:', err);
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
