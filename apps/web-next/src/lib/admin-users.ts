/**
 * Pure helpers for admin user management.
 *
 * Suspension reuses `User.lockedUntil` (which login already enforces via
 * isAccountLocked). To distinguish an admin suspension from a transient
 * failed-login lockout, admin suspends set a far-future sentinel (year 9999).
 */

export const SUSPEND_SENTINEL = new Date('9999-12-31T00:00:00.000Z');

export type UserAction = 'suspend' | 'reactivate' | 'grantAdmin' | 'revokeAdmin';

const ACTIONS: readonly UserAction[] = ['suspend', 'reactivate', 'grantAdmin', 'revokeAdmin'];

/** Validate a PATCH body's `action`. Returns the action or null. */
export function parseUserAction(body: unknown): UserAction | null {
  if (typeof body !== 'object' || body === null) return null;
  const a = (body as Record<string, unknown>).action;
  return typeof a === 'string' && (ACTIONS as readonly string[]).includes(a) ? (a as UserAction) : null;
}

/** True only for an admin suspension (far-future sentinel), not a transient lockout. */
export function isSuspended(lockedUntil: Date | string | null | undefined): boolean {
  if (!lockedUntil) return false;
  return new Date(lockedUntil).getUTCFullYear() >= 9999;
}
