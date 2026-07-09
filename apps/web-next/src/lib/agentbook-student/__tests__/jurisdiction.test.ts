import { describe, it, expect } from 'vitest';
import { countryNameFor, JURISDICTION_COUNTRY_NAMES } from '../jurisdiction';

describe('countryNameFor', () => {
  it('maps every known jurisdiction to its country name', () => {
    expect(countryNameFor('us')).toBe('the United States');
    expect(countryNameFor('ca')).toBe('Canada');
    expect(countryNameFor('uk')).toBe('the United Kingdom');
    expect(countryNameFor('au')).toBe('Australia');
  });

  it('is case-insensitive', () => {
    expect(countryNameFor('CA')).toBe('Canada');
    expect(countryNameFor('Uk')).toBe('the United Kingdom');
  });

  it('falls back to the United States for null/undefined/unknown — never silently mislabels a known jurisdiction', () => {
    expect(countryNameFor(null)).toBe('the United States');
    expect(countryNameFor(undefined)).toBe('the United States');
    expect(countryNameFor('mx')).toBe('the United States');
  });

  it('covers exactly the jurisdictions the rest of the app supports (us/ca/uk/au)', () => {
    expect(Object.keys(JURISDICTION_COUNTRY_NAMES).sort()).toEqual(['au', 'ca', 'uk', 'us']);
  });
});
