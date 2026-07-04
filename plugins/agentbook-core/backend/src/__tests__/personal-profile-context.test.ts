import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindUnique = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abPersonalProfile: { findUnique: (...args: unknown[]) => mockFindUnique(...args) },
  },
}));

import { buildPersonalProfileContext } from '../personal-profile-context.js';

describe('buildPersonalProfileContext', () => {
  beforeEach(() => {
    mockFindUnique.mockReset();
  });

  it('returns empty string when no profile row exists', async () => {
    mockFindUnique.mockResolvedValueOnce(null);
    const ctx = await buildPersonalProfileContext('tenant-x');
    expect(ctx).toBe('');
  });

  it('returns empty string when the profile exists but is incomplete', async () => {
    mockFindUnique.mockResolvedValueOnce({
      firstName: 'Maya',
      lastName: null, // missing — fails the completeness bar
      dateOfBirth: new Date('1990-01-01'),
      city: 'Toronto',
      state: 'ON',
      country: 'ca',
      maritalStatus: 'single',
      employmentType: 'self_employed',
      dependentsCount: 0,
      occupation: null,
      estimatedAnnualIncomeCents: null,
    });
    const ctx = await buildPersonalProfileContext('tenant-x');
    expect(ctx).toBe('');
  });

  it('summarizes a complete profile into markdown for the LLM system prompt', async () => {
    mockFindUnique.mockResolvedValueOnce({
      firstName: 'Maya',
      lastName: 'Chen',
      dateOfBirth: new Date('1990-06-15'),
      city: 'Toronto',
      state: 'ON',
      country: 'ca',
      maritalStatus: 'married_joint',
      dependentsCount: 2,
      employmentType: 'self_employed',
      occupation: 'Consultant',
      estimatedAnnualIncomeCents: 12000000,
    });
    const ctx = await buildPersonalProfileContext('tenant-x');
    expect(ctx).toContain('## User profile');
    expect(ctx).toContain('Name: Maya Chen');
    expect(ctx).toContain('Location: Toronto, ON, ca');
    expect(ctx).toContain('Marital status: Married, filing jointly');
    expect(ctx).toContain('Dependents: 2');
    expect(ctx).toContain('Employment: Self-employed');
    expect(ctx).toContain('Occupation: Consultant');
    expect(ctx).toContain('Estimated annual income: $120,000');
    expect(mockFindUnique).toHaveBeenCalledWith({ where: { userId: 'tenant-x' } });
  });

  it('computes age correctly relative to a fixed "now"', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-04T00:00:00Z'));
    mockFindUnique.mockResolvedValueOnce({
      firstName: 'Alex',
      lastName: 'Rivera',
      dateOfBirth: new Date('1990-08-01'), // birthday hasn't happened yet this year
      city: 'Austin',
      state: 'TX',
      country: 'us',
      maritalStatus: 'single',
      dependentsCount: null,
      employmentType: 'w2',
      occupation: null,
      estimatedAnnualIncomeCents: null,
    });
    const ctx = await buildPersonalProfileContext('tenant-y');
    expect(ctx).toContain('Age: 35');
    vi.useRealTimers();
  });

  it('omits optional fields that are null without crashing', async () => {
    mockFindUnique.mockResolvedValueOnce({
      firstName: 'Jordan',
      lastName: 'Lee',
      dateOfBirth: new Date('2000-01-01'),
      city: 'Seattle',
      state: 'WA',
      country: 'us',
      maritalStatus: 'single',
      dependentsCount: null,
      employmentType: 'unemployed',
      occupation: null,
      estimatedAnnualIncomeCents: null,
    });
    const ctx = await buildPersonalProfileContext('tenant-z');
    expect(ctx).not.toContain('Dependents:');
    expect(ctx).not.toContain('Occupation:');
    expect(ctx).not.toContain('Estimated annual income:');
    expect(ctx).toContain('Employment: Not currently working');
  });
});
