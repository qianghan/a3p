import { describe, expect, it, vi } from 'vitest';
import {
  checkRateLimit,
  normalizeClientIp,
  __forceNextSweepForTest,
  __hasRateLimitKeyForTest,
} from './rate-limit';

describe('checkRateLimit', () => {
  it('allows requests under the limit and blocks the one that exceeds it', async () => {
    const key = `test-${Date.now()}`;
    expect(await checkRateLimit(key, 2, 1000)).toBe(true);
    expect(await checkRateLimit(key, 2, 1000)).toBe(true);
    expect(await checkRateLimit(key, 2, 1000)).toBe(false);
  });

  it('tracks separate keys independently', async () => {
    const keyA = `test-a-${Date.now()}`;
    const keyB = `test-b-${Date.now()}`;
    expect(await checkRateLimit(keyA, 1, 1000)).toBe(true);
    expect(await checkRateLimit(keyA, 1, 1000)).toBe(false);
    // A different key has its own independent bucket.
    expect(await checkRateLimit(keyB, 1, 1000)).toBe(true);
  });

  it('allows requests again once the window has elapsed', async () => {
    const key = `test-window-${Date.now()}`;
    expect(await checkRateLimit(key, 1, 20)).toBe(true);
    expect(await checkRateLimit(key, 1, 20)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(await checkRateLimit(key, 1, 20)).toBe(true);
  });
});

describe('normalizeClientIp (Finding 3: raw x-forwarded-for was used verbatim as a bucket key)', () => {
  it('returns null for a missing header', () => {
    expect(normalizeClientIp(null)).toBeNull();
  });

  it('returns the header unchanged when it is a single IP', () => {
    expect(normalizeClientIp('203.0.113.5')).toBe('203.0.113.5');
  });

  it('takes only the first (client-facing) entry of a multi-hop header, trimmed', () => {
    expect(normalizeClientIp('203.0.113.5, 10.0.0.1, 10.0.0.2')).toBe('203.0.113.5');
    expect(normalizeClientIp('  203.0.113.5   ,10.0.0.1')).toBe('203.0.113.5');
  });

  it('returns null when the header is present but empty', () => {
    expect(normalizeClientIp('')).toBeNull();
    expect(normalizeClientIp('   ')).toBeNull();
  });
});

describe('stale-key eviction (Finding 3: distinct/spoofed keys accumulating forever)', () => {
  it('evicts a key whose entire history is older than the staleness TTL during a later sweep', async () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const staleKey = `stale-key-${base}`;
      // One hit, then this key is never touched again.
      expect(await checkRateLimit(staleKey, 5, 1000)).toBe(true);
      expect(__hasRateLimitKeyForTest(staleKey)).toBe(true);

      // Jump forward well past the 10-minute staleness TTL and force the
      // opportunistic sweep to actually run on the next call (real code
      // throttles sweeps to once/minute; the test-only escape hatch resets
      // that throttle so this doesn't depend on real wall-clock time).
      vi.setSystemTime(base + 11 * 60_000);
      __forceNextSweepForTest();

      // Any other call triggers the sweep as a side effect.
      const otherKey = `other-key-${base}`;
      await checkRateLimit(otherKey, 5, 1000);

      expect(__hasRateLimitKeyForTest(staleKey)).toBe(false);
      // The key that was just touched (as part of triggering the sweep)
      // must survive its own sweep pass.
      expect(__hasRateLimitKeyForTest(otherKey)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not evict a key that has had recent activity, even after a sweep runs', async () => {
    vi.useFakeTimers();
    try {
      const base = Date.now();
      const activeKey = `active-key-${base}`;
      expect(await checkRateLimit(activeKey, 5, 1000)).toBe(true);

      vi.setSystemTime(base + 30_000); // well under the 10-minute stale TTL
      __forceNextSweepForTest();
      await checkRateLimit(`trigger-${base}`, 5, 1000);

      expect(__hasRateLimitKeyForTest(activeKey)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
