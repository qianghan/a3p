import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const resolveTenant = vi.fn();
const profileFindUnique = vi.fn();
const profileCreate = vi.fn();
const profileUpsert = vi.fn();

vi.mock('@/lib/agentbook-tenant', () => ({
  safeResolveAgentbookTenant: (...a: unknown[]) => resolveTenant(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abPersonalProfile: {
      findUnique: (...a: unknown[]) => profileFindUnique(...a),
      create: (...a: unknown[]) => profileCreate(...a),
      upsert: (...a: unknown[]) => profileUpsert(...a),
    },
  },
}));

import { GET, PUT } from '@/app/api/v1/agentbook-core/personal-profile/route';

const tenant = { tenantId: 'tenant-1' };

const COMPLETE_FIELDS = {
  firstName: 'Maya',
  lastName: 'Chen',
  dateOfBirth: new Date('1990-01-01'),
  city: 'Toronto',
  state: 'ON',
  country: 'ca',
  maritalStatus: 'single',
  employmentType: 'self_employed',
};

beforeEach(() => {
  resolveTenant.mockReset();
  profileFindUnique.mockReset();
  profileCreate.mockReset();
  profileUpsert.mockReset();
  resolveTenant.mockResolvedValue(tenant);
});

function getReq(): NextRequest {
  return new NextRequest('http://x/personal-profile');
}

function putReq(body: unknown): NextRequest {
  return new NextRequest('http://x/personal-profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/v1/agentbook-core/personal-profile', () => {
  it('creates an empty row on first access and reports isComplete:false', async () => {
    profileFindUnique.mockResolvedValueOnce(null);
    profileCreate.mockResolvedValueOnce({ userId: 'tenant-1', firstName: null, lastName: null, dateOfBirth: null, city: null, state: null, country: null, maritalStatus: null, employmentType: null });
    const res = await GET(getReq());
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.isComplete).toBe(false);
    expect(profileCreate).toHaveBeenCalledWith({ data: { userId: 'tenant-1' } });
  });

  it('reports isComplete:true when all required fields are present', async () => {
    profileFindUnique.mockResolvedValueOnce({ ...COMPLETE_FIELDS });
    const res = await GET(getReq());
    const body = await res.json();
    expect(body.data.isComplete).toBe(true);
  });

  it('reports isComplete:false when even one required field is missing', async () => {
    profileFindUnique.mockResolvedValueOnce({ ...COMPLETE_FIELDS, employmentType: null });
    const res = await GET(getReq());
    const body = await res.json();
    expect(body.data.isComplete).toBe(false);
  });
});

describe('PUT /api/v1/agentbook-core/personal-profile', () => {
  it('rejects an invalid maritalStatus', async () => {
    profileFindUnique.mockResolvedValueOnce(null);
    const res = await PUT(putReq({ maritalStatus: 'engaged' }));
    expect(res.status).toBe(400);
    expect(profileUpsert).not.toHaveBeenCalled();
  });

  it('rejects a negative dependentsCount', async () => {
    profileFindUnique.mockResolvedValueOnce(null);
    const res = await PUT(putReq({ dependentsCount: -1 }));
    expect(res.status).toBe(400);
  });

  it('rejects an invalid dateOfBirth string', async () => {
    profileFindUnique.mockResolvedValueOnce(null);
    const res = await PUT(putReq({ dateOfBirth: 'not-a-date' }));
    expect(res.status).toBe(400);
  });

  it('sets completedAt when the update newly satisfies the completeness bar', async () => {
    profileFindUnique.mockResolvedValueOnce({ userId: 'tenant-1', ...COMPLETE_FIELDS, employmentType: null, completedAt: null });
    profileUpsert.mockImplementationOnce(async ({ update }) => ({ userId: 'tenant-1', ...COMPLETE_FIELDS, ...update }));

    const res = await PUT(putReq({ employmentType: 'self_employed' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    const upsertCall = profileUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(upsertCall.update.completedAt).toBeInstanceOf(Date);
    expect(body.data.isComplete).toBe(true);
  });

  it('does not touch completedAt when the profile was already complete', async () => {
    const alreadyCompletedAt = new Date('2026-01-01');
    profileFindUnique.mockResolvedValueOnce({ userId: 'tenant-1', ...COMPLETE_FIELDS, completedAt: alreadyCompletedAt });
    profileUpsert.mockImplementationOnce(async ({ update }) => ({ userId: 'tenant-1', ...COMPLETE_FIELDS, completedAt: alreadyCompletedAt, ...update }));

    await PUT(putReq({ occupation: 'Consultant' }));

    const upsertCall = profileUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(upsertCall.update.completedAt).toBeUndefined();
  });

  it('does not set completedAt when the update still leaves a required field missing', async () => {
    profileFindUnique.mockResolvedValueOnce({ userId: 'tenant-1', firstName: null, lastName: null, dateOfBirth: null, city: null, state: null, country: null, maritalStatus: null, employmentType: null, completedAt: null });
    profileUpsert.mockImplementationOnce(async ({ update }) => ({ userId: 'tenant-1', ...update }));

    const res = await PUT(putReq({ firstName: 'Maya' }));
    const body = await res.json();

    const upsertCall = profileUpsert.mock.calls[0][0] as { update: Record<string, unknown> };
    expect(upsertCall.update.completedAt).toBeUndefined();
    expect(body.data.isComplete).toBe(false);
  });
});
