import { describe, it, expect } from 'vitest';
import { resolveOrdinalOrFuzzyCandidate } from '../candidate-resolution';

const SCHOLARSHIPS = [
  { title: 'Chen Family Award', amountText: '$2,000' },
  { title: 'TD Community Scholarship', amountText: '$1,000' },
];

const JOBS = [
  { title: 'Software Engineering Co-op', employer: 'Shopify' },
  { title: 'Data Analyst Intern', employer: 'RBC' },
];

describe('resolveOrdinalOrFuzzyCandidate', () => {
  it('returns null for an empty candidate list', () => {
    expect(resolveOrdinalOrFuzzyCandidate([], 'save the first one')).toBeNull();
  });

  it('resolves "first" to index 0', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the first one')).toBe(SCHOLARSHIPS[0]);
  });

  it('resolves "second" to index 1', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the second one')).toBe(SCHOLARSHIPS[1]);
  });

  it('resolves "#2" / "2nd" to index 1', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save #2')).toBe(SCHOLARSHIPS[1]);
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the 2nd one')).toBe(SCHOLARSHIPS[1]);
  });

  it('falls back to fuzzy title match when there is no ordinal', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save the TD one')).toBe(SCHOLARSHIPS[1]);
  });

  it('matches against extraMatchFields (e.g. employer) in addition to title', () => {
    expect(resolveOrdinalOrFuzzyCandidate(JOBS, 'save the shopify one', ['employer'])).toBe(JOBS[0]);
    expect(resolveOrdinalOrFuzzyCandidate(JOBS, 'save the rbc one', ['employer'])).toBe(JOBS[1]);
  });

  it('returns null when nothing resolves (no ordinal, no fuzzy match)', () => {
    expect(resolveOrdinalOrFuzzyCandidate(SCHOLARSHIPS, 'save that one please')).toBeNull();
  });
});
