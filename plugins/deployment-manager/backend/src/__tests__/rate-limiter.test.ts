import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimiter } from '../services/RateLimiter.js';

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createLimiter(maxRequests: number, windowMs: number): RateLimiter {
    const limiter = new RateLimiter(maxRequests, windowMs);
    return limiter;
  }

  it('should allow first request with remaining = max - 1', () => {
    const limiter = createLimiter(5, 60_000);
    const result = limiter.check('user-1');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('should allow all requests within the limit', () => {
    const limiter = createLimiter(3, 60_000);
    const r1 = limiter.check('user-1');
    const r2 = limiter.check('user-1');
    const r3 = limiter.check('user-1');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('should reject requests exceeding the limit', () => {
    const limiter = createLimiter(2, 60_000);
    limiter.check('user-1');
    limiter.check('user-1');
    const result = limiter.check('user-1');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('should return positive resetInMs when rejected', () => {
    const limiter = createLimiter(1, 60_000);
    limiter.check('user-1');
    const result = limiter.check('user-1');
    expect(result.allowed).toBe(false);
    expect(result.resetInMs).toBeGreaterThan(0);
    expect(result.resetInMs).toBeLessThanOrEqual(60_000);
  });

  it('should track different keys independently', () => {
    const limiter = createLimiter(1, 60_000);
    const r1 = limiter.check('user-a');
    const r2 = limiter.check('user-b');
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);

    const r3 = limiter.check('user-a');
    expect(r3.allowed).toBe(false);

    const r4 = limiter.check('user-b');
    expect(r4.allowed).toBe(false);
  });

  it('should reset counter after window expires', () => {
    const limiter = createLimiter(2, 10_000);
    limiter.check('user-1');
    limiter.check('user-1');
    const blocked = limiter.check('user-1');
    expect(blocked.allowed).toBe(false);

    vi.advanceTimersByTime(10_001);

    const afterReset = limiter.check('user-1');
    expect(afterReset.allowed).toBe(true);
    expect(afterReset.remaining).toBe(1);
  });

  it('should return correct resetInMs relative to current time', () => {
    const limiter = createLimiter(5, 30_000);
    limiter.check('user-1');

    vi.advanceTimersByTime(10_000);

    const result = limiter.check('user-1');
    expect(result.allowed).toBe(true);
    expect(result.resetInMs).toBeLessThanOrEqual(20_000);
    expect(result.resetInMs).toBeGreaterThan(0);
  });
});
