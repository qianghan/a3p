// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';

import { PublicError, isPublicError, publicErrorMessage, GENERIC_MESSAGE } from '@/lib/api-error';

/**
 * Route handlers echoed `err.message` to the caller at 266 sites. A Prisma
 * error names tables, columns, host and port; a fetch failure names internal
 * hostnames. But some thrown messages ARE the product's copy, so the split
 * has to be marked at the throw, not guessed at the response.
 */

describe('publicErrorMessage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns a PublicError message unchanged — it is the product copy', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(publicErrorMessage(new PublicError('You already have an application in progress.'))).toBe(
      'You already have an application in progress.',
    );
    // ...and does not log it: nothing went wrong on our side.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('never returns the text of an internal error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const leaky = Object.assign(
      new Error(
        `Invalid \`prisma.abExpense.findMany()\` invocation: Can't reach database server at ` +
          `aws-0-us-east-1.pooler.supabase.com:5432`,
      ),
      { name: 'PrismaClientInitializationError', code: 'P1001' },
    );

    const out = publicErrorMessage(leaky);

    for (const leak of ['prisma', 'abExpense', 'pooler.supabase.com', '5432', 'P1001', "Can't reach"]) {
      expect(out, `leaked ${leak}`).not.toContain(leak);
    }
    expect(out).toContain(GENERIC_MESSAGE);
    // The detail still has to reach the server log, or the fix is a regression
    // in diagnosability.
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0][1]).toBe(leaky);
  });

  it('ties the caller message to the log line with the same reference', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = publicErrorMessage(new Error('boom'));
    const ref = /Reference: ([a-z0-9]+)/.exec(out)?.[1];
    expect(ref, out).toBeTruthy();
    expect(String(spy.mock.calls[0][0])).toContain(`ref=${ref}`);
  });

  it('gives each error its own reference', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = publicErrorMessage(new Error('a'));
    const b = publicErrorMessage(new Error('b'));
    expect(a).not.toBe(b);
  });

  it('handles the non-Error things that reach a catch block', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const thrown of ['a string', 42, null, undefined, { message: 'looks like one' }, ['x']]) {
      const out = publicErrorMessage(thrown);
      expect(out, String(thrown)).toContain(GENERIC_MESSAGE);
      expect(out, String(thrown)).not.toContain('looks like one');
    }
  });
});

describe('isPublicError', () => {
  it('recognises a subclass, which is how the domain error classes opt in', () => {
    class RepAdminError extends PublicError {}
    const e = new RepAdminError('not allowed');
    expect(isPublicError(e)).toBe(true);
    expect(e.name).toBe('RepAdminError');
    expect(e).toBeInstanceOf(Error);
  });

  it('recognises a marked error from a duplicate module copy, where instanceof fails', () => {
    // Next bundles a module more than once across route/runtime boundaries;
    // two copies of the class are not instanceof each other. A route that
    // caught such an error would otherwise drop the product's own message.
    const fromOtherBundle = Object.assign(new Error('You are already an approved partner.'), {
      isPublicApiError: true,
    });
    expect(fromOtherBundle instanceof PublicError).toBe(false);
    expect(isPublicError(fromOtherBundle)).toBe(true);
    expect(publicErrorMessage(fromOtherBundle)).toBe('You are already an approved partner.');
  });

  it('is not fooled by a plain error or an attacker-shaped payload', () => {
    expect(isPublicError(new Error('internal'))).toBe(false);
    expect(isPublicError({ isPublicApiError: 'true' })).toBe(false);
    expect(isPublicError({ isPublicApiError: 1 })).toBe(false);
    expect(isPublicError(null)).toBe(false);
    expect(isPublicError('str')).toBe(false);
  });

  it('carries an optional status for routes that map errors to codes', () => {
    expect(new PublicError('nope', 409).status).toBe(409);
    expect(new PublicError('nope').status).toBeUndefined();
  });
});
