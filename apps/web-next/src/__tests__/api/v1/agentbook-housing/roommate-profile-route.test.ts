import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const requireStudentAddon = vi.fn();
const profileUpsert = vi.fn();

vi.mock('@/lib/agentbook-student/guard', () => ({
  requireStudentAddon: (...a: unknown[]) => requireStudentAddon(...a),
}));
vi.mock('@naap/database', () => ({
  prisma: {
    abRoommateProfile: {
      upsert: (...a: unknown[]) => profileUpsert(...a),
    },
  },
}));

import { PUT } from '@/app/api/v1/agentbook-housing/roommate/profile/route';

beforeEach(() => {
  requireStudentAddon.mockReset();
  profileUpsert.mockReset();
  requireStudentAddon.mockResolvedValue({ tenantId: 'tenant-1' });
  profileUpsert.mockImplementation(async ({ create }: { create: Record<string, unknown> }) => create);
});

function putReq(body: unknown): NextRequest {
  return new NextRequest('http://x/roommate/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Previously hardcoded to us/ca only, which either silently forced UK/AU
// students into "us" or blocked them from activating a profile at all.
describe('PUT /api/v1/agentbook-housing/roommate/profile — jurisdiction support', () => {
  it.each(['us', 'ca', 'uk', 'au'])('accepts jurisdiction=%s when activating', async (jurisdiction) => {
    const res = await PUT(putReq({ active: true, consent: true, displayHandle: 'Alex', jurisdiction, area: 'Toronto' }));
    expect(res.status).toBe(200);
    const call = profileUpsert.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(call.create.jurisdiction).toBe(jurisdiction);
  });

  it('rejects an unsupported jurisdiction when activating', async () => {
    const res = await PUT(putReq({ active: true, consent: true, displayHandle: 'Alex', jurisdiction: 'mx', area: 'Toronto' }));
    expect(res.status).toBe(400);
    expect(profileUpsert).not.toHaveBeenCalled();
  });

  it('falls back to "us" for an invalid jurisdiction when not activating (inactive draft save)', async () => {
    const res = await PUT(putReq({ active: false, jurisdiction: 'mx' }));
    expect(res.status).toBe(200);
    const call = profileUpsert.mock.calls[0][0] as { create: Record<string, unknown> };
    expect(call.create.jurisdiction).toBe('us');
  });
});
