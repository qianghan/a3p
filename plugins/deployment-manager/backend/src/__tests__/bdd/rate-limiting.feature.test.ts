import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../services/RateLimiter.js';

describe('Feature: Rate Limiting', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter(3, 60_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('Given a rate limit of 3 per 60s, When a user makes 3 requests, Then all are allowed with decreasing remaining count', () => {
    // Given — limiter configured with max=3, window=60s

    // When / Then
    const r1 = limiter.check('user-1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check('user-1');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check('user-1');
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('Given a user has exhausted the rate limit, When they make another request, Then it is denied with remaining=0', () => {
    // Given
    limiter.check('user-1');
    limiter.check('user-1');
    limiter.check('user-1');

    // When
    const result = limiter.check('user-1');

    // Then
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.resetInMs).toBeGreaterThan(0);
    expect(result.resetInMs).toBeLessThanOrEqual(60_000);
  });

  it('Given two different users, When each makes requests independently, Then their rate limits are tracked separately', () => {
    // Given — user-A exhausts their limit
    limiter.check('user-A');
    limiter.check('user-A');
    limiter.check('user-A');
    const blockedA = limiter.check('user-A');
    expect(blockedA.allowed).toBe(false);

    // When — user-B makes requests
    const r1B = limiter.check('user-B');
    const r2B = limiter.check('user-B');

    // Then — user-B is unaffected
    expect(r1B.allowed).toBe(true);
    expect(r1B.remaining).toBe(2);
    expect(r2B.allowed).toBe(true);
    expect(r2B.remaining).toBe(1);
  });

  it('Given a user was rate-limited, When the time window expires, Then their requests are allowed again', () => {
    // Given — exhaust the limit
    limiter.check('user-1');
    limiter.check('user-1');
    limiter.check('user-1');
    const blocked = limiter.check('user-1');
    expect(blocked.allowed).toBe(false);

    // When — advance time past the window
    vi.advanceTimersByTime(60_001);

    // Then — requests are allowed again with fresh counts
    const r1 = limiter.check('user-1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check('user-1');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
  });
});
