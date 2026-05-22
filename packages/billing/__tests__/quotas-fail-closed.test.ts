/**
 * Regression tests for G-022: the billing quota layer must FAIL CLOSED
 * on DB errors. Previously checkQuota returned { allowed: true } on
 * any DB error, which (combined with the domain plugins never calling
 * checkQuota at all) made the entire free-tier billing layer
 * decorative.
 *
 * Each case here mocks a different failure mode and asserts that
 * checkQuota denies the request with retryable=true so the caller
 * can return 503 (transient) instead of 402 (quota exceeded).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const findUnique = vi.fn();
const findMany = vi.fn();

vi.mock('@naap/database', () => ({
  prisma: {
    billSubscription: { findUnique: (...a: unknown[]) => findUnique(...a) },
    billPlan: {
      findFirst: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(1),
    },
    billUsageCounter: {
      findMany: (...a: unknown[]) => findMany(...a),
      upsert: vi.fn(),
    },
  },
}));

import { checkQuota } from '../src/quotas.js';
import { _resetCacheForTests } from '../src/plans.js';

beforeEach(() => {
  findUnique.mockReset();
  findMany.mockReset();
  _resetCacheForTests();
});

describe('checkQuota — fail-closed on DB error (G-022)', () => {
  it('subscription lookup throws → denies + retryable', async () => {
    findUnique.mockRejectedValue(new Error('connection refused'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await checkQuota('t1', 'ocr_scans');

    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('quota_check_unavailable');
    expect(result.retryable).toBe(true);
    err.mockRestore();
  });

  it('non-DB Error (timeout) → denies + retryable', async () => {
    findUnique.mockRejectedValue(new Error('ETIMEDOUT'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await checkQuota('t2', 'invoices_sent');

    expect(result.allowed).toBe(false);
    expect(result.retryable).toBe(true);
    err.mockRestore();
  });

  it('logs to console.error (not warn) so failures surface in monitoring', async () => {
    findUnique.mockRejectedValue(new Error('db down'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    await checkQuota('t3', 'ai_messages');

    expect(err).toHaveBeenCalled();
    const firstArg = err.mock.calls[0][0] as string;
    expect(firstArg).toContain('[billing]');
    expect(firstArg.toLowerCase()).toContain('fail');
    err.mockRestore();
  });

  it('successful path is unchanged — happy lookups still return allowed:true', async () => {
    findUnique.mockResolvedValue({
      planId: 'p',
      status: 'active',
      currentPeriodStart: new Date('2026-05-01'),
      currentPeriodEnd: new Date('2026-06-01'),
      cancelAtPeriodEnd: false,
      plan: {
        id: 'p',
        code: 'pro',
        features: { telegram_bot: true, tax_package_generation: true, multi_user_teams: false },
        quotas: { expenses_created: 1000, ocr_scans: 10, ai_messages: 5000, invoices_sent: 200, bank_connections: 3 },
      },
    });
    findMany.mockResolvedValue([{ dimension: 'ocr_scans', count: 1 }]);

    const result = await checkQuota('t4', 'ocr_scans');

    expect(result.allowed).toBe(true);
    expect(result.retryable).toBeUndefined();
    expect(result.reason).toBeUndefined();
  });
});
