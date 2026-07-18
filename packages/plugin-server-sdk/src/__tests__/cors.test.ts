import { describe, expect, it } from 'vitest';
import { resolveAllowAllOrigins } from '../server';

describe('CORS origin resolution — fail-closed default', () => {
  it('does NOT allow all origins when CORS_ALLOWED_ORIGINS/corsOrigins is unset (empty)', () => {
    expect(resolveAllowAllOrigins(undefined)).toBe(false);
    expect(resolveAllowAllOrigins('')).toBe(false);
    expect(resolveAllowAllOrigins([])).toBe(false);
  });

  it('allows all origins ONLY when explicitly set to the literal string "*"', () => {
    expect(resolveAllowAllOrigins('*')).toBe(true);
    expect(resolveAllowAllOrigins(' * ')).toBe(true); // trimmed
  });

  it('does not allow all when a real origin list is configured', () => {
    expect(resolveAllowAllOrigins('https://example.com,https://foo.com')).toBe(false);
    expect(resolveAllowAllOrigins(['https://example.com'])).toBe(false);
  });
});
