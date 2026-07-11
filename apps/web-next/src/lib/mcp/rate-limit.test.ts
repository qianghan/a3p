import { describe, expect, it } from 'vitest';
import { checkRateLimit } from './rate-limit';

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
