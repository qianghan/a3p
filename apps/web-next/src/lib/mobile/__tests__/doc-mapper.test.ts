import { describe, it, expect } from 'vitest';
import { toMobileDoc, deriveCategorySource, suggestionFromPending } from '../doc-mapper';
import { DOC_FILTER_PARAMS } from '../doc-filters';

const base = {
  id: 'e1',
  date: new Date('2026-06-05T00:00:00.000Z'),
  amountCents: 4000,
  vendor: { name: 'Shell' },
  description: 'Gas',
  categoryId: 'acc-fuel',
  categoryName: 'Fuel',
  confidence: 1,
  status: 'confirmed',
  isPersonal: false,
  receiptUrl: null,
  receiptStatus: 'pending',
  archivedAt: null,
  journalEntryId: 'je-e1',
};

describe('deriveCategorySource', () => {
  it('null category → null; human certainty (≥0.95 or null) → user; lower → ai', () => {
    expect(deriveCategorySource({ categoryId: null, confidence: 0.9 })).toBeNull();
    expect(deriveCategorySource({ categoryId: 'c', confidence: 1 })).toBe('user');
    expect(deriveCategorySource({ categoryId: 'c', confidence: 0.95 })).toBe('user');
    expect(deriveCategorySource({ categoryId: 'c', confidence: null })).toBe('user');
    expect(deriveCategorySource({ categoryId: 'c', confidence: 0.88 })).toBe('ai');
  });
});

describe('toMobileDoc', () => {
  it('maps a Prisma-shaped row onto the C1 contract', () => {
    expect(toMobileDoc(base)).toEqual({
      id: 'e1',
      date: '2026-06-05',
      amountCents: 4000,
      vendorName: 'Shell',
      description: 'Gas',
      categoryId: 'acc-fuel',
      categoryName: 'Fuel',
      categorySource: 'user',
      confidence: 1,
      status: 'confirmed',
      isPersonal: false,
      receiptUrl: null,
      receiptStatus: 'pending',
      archivedAt: null,
      suggestion: null,
      booked: true,
    });
  });

  it('booked follows journalEntryId, not status (a pending_review row can already be on the books)', () => {
    expect(toMobileDoc({ ...base, journalEntryId: 'je-1' }).booked).toBe(true);
    expect(toMobileDoc({ ...base, status: 'pending_review', journalEntryId: 'je-1' }).booked).toBe(true);
    expect(toMobileDoc({ ...base, journalEntryId: null }).booked).toBe(false);
    const { journalEntryId: _omit, ...noJournal } = base;
    expect(toMobileDoc(noJournal).booked).toBe(false);
  });

  it('prefers an explicit vendorName, serialises archivedAt, accepts ISO strings', () => {
    const doc = toMobileDoc({ ...base, vendorName: 'Shell Canada', date: '2026-06-05T00:00:00.000Z', archivedAt: '2026-06-19T09:00:00.000Z' });
    expect(doc.vendorName).toBe('Shell Canada');
    expect(doc.archivedAt).toBe('2026-06-19T09:00:00.000Z');
  });

  it('only carries a suggestion while the doc is uncategorized', () => {
    const s = suggestionFromPending({ suggestedCategoryId: 'acc-meals', suggestedCategoryName: 'Meals', confidence: 0.7 });
    expect(toMobileDoc({ ...base, categoryId: null, categoryName: null }, s).suggestion).toEqual({ categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.7 });
    expect(toMobileDoc(base, s).suggestion).toBeNull();
  });

  it('normalises unknown status / receiptStatus values', () => {
    const doc = toMobileDoc({ ...base, status: 'weird', receiptStatus: 'lost' });
    expect(doc.status).toBe('confirmed');
    expect(doc.receiptStatus).toBeNull();
    expect(toMobileDoc({ ...base, status: 'pending_review' }).status).toBe('pending_review');
  });
});

describe('DOC_FILTER_PARAMS', () => {
  it('maps every DocFilter onto /expenses params', () => {
    expect(DOC_FILTER_PARAMS).toEqual({
      'needs-review': { status: 'pending_review' },
      'no-category': { categoryId: 'none', isPersonal: 'false' },
      'no-receipt': { hasReceipt: 'false', isPersonal: 'false' },
      all: {},
      archived: { archived: 'true' },
    });
  });
});
