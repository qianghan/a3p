import { describe, it, expect } from 'vitest';
import { joinUrl } from '../abs-url';

describe('joinUrl', () => {
  it('joins base + path with a single slash', () => {
    expect(joinUrl('https://x.com', '/cpa-portal/abc')).toBe('https://x.com/cpa-portal/abc');
  });
  it('handles a trailing slash on base', () => {
    expect(joinUrl('https://x.com/', '/cpa-portal/abc')).toBe('https://x.com/cpa-portal/abc');
  });
  it('handles a missing leading slash on path', () => {
    expect(joinUrl('https://x.com', 'cpa-portal/abc')).toBe('https://x.com/cpa-portal/abc');
  });
  it('handles both slashes / neither slash', () => {
    expect(joinUrl('https://x.com/', 'cpa-portal/abc')).toBe('https://x.com/cpa-portal/abc');
  });
});
