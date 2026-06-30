import { describe, it, expect } from 'vitest';
import { parseUserAction, isSuspended, SUSPEND_SENTINEL } from '../admin-users';

describe('admin-users · parseUserAction', () => {
  it('accepts the four known actions', () => {
    for (const a of ['suspend', 'reactivate', 'grantAdmin', 'revokeAdmin']) {
      expect(parseUserAction({ action: a })).toBe(a);
    }
  });
  it('rejects unknown / missing / non-string actions', () => {
    expect(parseUserAction({ action: 'delete' })).toBeNull();
    expect(parseUserAction({})).toBeNull();
    expect(parseUserAction({ action: 5 })).toBeNull();
    expect(parseUserAction(null)).toBeNull();
    expect(parseUserAction('suspend')).toBeNull();
  });
});

describe('admin-users · isSuspended', () => {
  it('treats the far-future sentinel as suspended', () => {
    expect(isSuspended(SUSPEND_SENTINEL)).toBe(true);
    expect(isSuspended('9999-12-31T00:00:00.000Z')).toBe(true);
  });
  it('is false for null, past, and transient near-future lockouts', () => {
    expect(isSuspended(null)).toBe(false);
    expect(isSuspended(undefined)).toBe(false);
    expect(isSuspended(new Date('2020-01-01'))).toBe(false);
    expect(isSuspended(new Date('2026-07-01T00:15:00Z'))).toBe(false); // 15-min auto-lockout
  });
});
