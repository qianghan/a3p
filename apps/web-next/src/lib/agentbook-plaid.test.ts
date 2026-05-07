/**
 * Unit tests for `sanitizePlaidError`. Plaid's PlaidApi is built on axios,
 * and AxiosError.message can carry the request URL + payload (which contains
 * the access token). The sanitizer's job is to translate any error shape into
 * a string that's safe to put in an HTTP response body.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', () => ({ prisma: {} }));

import { sanitizePlaidError } from './agentbook-plaid';

describe('sanitizePlaidError', () => {
  it('returns the Plaid error_code prefixed when given an axios-shaped error', () => {
    const axiosErr = {
      response: {
        data: {
          error_code: 'ITEM_LOGIN_REQUIRED',
          error_message: 'The user must reauthenticate.',
        },
      },
      // simulate axios attaching the request payload (which would contain
      // the access token) — the sanitizer must never echo this back.
      config: {
        url: 'https://sandbox.plaid.com/transactions/sync',
        data: JSON.stringify({ access_token: 'access-sandbox-SUPER-SECRET' }),
      },
      message:
        'Request failed with status code 400 (POST https://sandbox.plaid.com/transactions/sync) — body access-sandbox-SUPER-SECRET',
    };
    const out = sanitizePlaidError(axiosErr);
    expect(out).toBe('Plaid error: ITEM_LOGIN_REQUIRED');
    expect(out).not.toContain('access-sandbox');
    expect(out).not.toContain('plaid.com');
  });

  it('returns a generic fallback for a random object with no Plaid envelope', () => {
    expect(sanitizePlaidError({ foo: 'bar' })).toBe(
      'Bank operation failed. Please try again later.',
    );
  });

  it('returns a generic fallback for an Error whose message contains an access token', () => {
    const err = new Error(
      'connect ETIMEDOUT — last url https://sandbox.plaid.com/x token=access-sandbox-LEAK',
    );
    const out = sanitizePlaidError(err);
    expect(out).toBe('Bank operation failed. Please try again later.');
    expect(out).not.toContain('access-sandbox');
  });

  it('returns the generic fallback for null / undefined / strings', () => {
    expect(sanitizePlaidError(null)).toBe('Bank operation failed. Please try again later.');
    expect(sanitizePlaidError(undefined)).toBe(
      'Bank operation failed. Please try again later.',
    );
    expect(sanitizePlaidError('access-sandbox-RAW-STRING')).toBe(
      'Bank operation failed. Please try again later.',
    );
  });

  it('handles partial axios shapes (response without data)', () => {
    expect(sanitizePlaidError({ response: {} })).toBe(
      'Bank operation failed. Please try again later.',
    );
    expect(sanitizePlaidError({ response: { data: {} } })).toBe(
      'Bank operation failed. Please try again later.',
    );
  });
});
