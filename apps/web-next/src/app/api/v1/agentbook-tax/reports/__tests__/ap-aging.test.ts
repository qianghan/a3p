import { describe, it, expect } from 'vitest';
import { bucketFor } from '../../../../../../lib/ap-aging';

const NOW = new Date('2026-06-29T12:00:00Z');
const daysFromNow = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

describe('AP aging buckets', () => {
  it('a bill not yet due is current', () => {
    expect(bucketFor(daysFromNow(5), NOW)).toBe('current');
  });

  it('a bill due today is current (0 days overdue)', () => {
    expect(bucketFor(NOW, NOW)).toBe('current');
  });

  it('1-30 days overdue', () => {
    expect(bucketFor(daysFromNow(-1), NOW)).toBe('d1_30');
    expect(bucketFor(daysFromNow(-30), NOW)).toBe('d1_30');
  });

  it('31-60 days overdue', () => {
    expect(bucketFor(daysFromNow(-31), NOW)).toBe('d31_60');
    expect(bucketFor(daysFromNow(-60), NOW)).toBe('d31_60');
  });

  it('60+ days overdue', () => {
    expect(bucketFor(daysFromNow(-61), NOW)).toBe('d60_plus');
    expect(bucketFor(daysFromNow(-365), NOW)).toBe('d60_plus');
  });
});
