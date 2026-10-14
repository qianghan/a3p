import { describe, it, expect } from 'vitest';
import { toForm, diffForm, isDirty } from '@/app/app/docs/_lib/edit-form';
import type { MobileDoc } from '@/lib/mobile/types';

const doc: MobileDoc = {
  id: 'e1', date: '2026-10-01', amountCents: 4700, vendorName: 'Blue Bottle', description: 'Client coffee',
  categoryId: null, categoryName: null, categorySource: null, confidence: null, status: 'confirmed', isPersonal: false,
  receiptUrl: null, receiptStatus: null, archivedAt: null, suggestion: null, booked: false,
};

describe('edit form', () => {
  it('starts from the doc in the user locale', () => {
    expect(toForm(doc, 'en')).toEqual({ amount: '47.00', vendor: 'Blue Bottle', date: '2026-10-01', description: 'Client coffee', isPersonal: false });
    expect(toForm(doc, 'fr-CA').amount).toBe('47,00');
  });
  it('takes the calendar date from an ISO timestamp', () => {
    expect(toForm({ ...doc, date: '2026-10-01T00:00:00.000Z' }, 'en').date).toBe('2026-10-01');
  });
  it('is clean until something changes', () => {
    expect(isDirty(doc, toForm(doc, 'en'), 'en')).toBe(false);
    expect(isDirty(doc, { ...toForm(doc, 'en'), vendor: 'Blue Bottle Coffee' }, 'en')).toBe(true);
    expect(isDirty(doc, { ...toForm(doc, 'en'), isPersonal: true }, 'en')).toBe(true);
  });
  it('sends only changed fields', () => {
    const r = diffForm(doc, { ...toForm(doc, 'en'), amount: '52.50', isPersonal: true }, 'en');
    expect(r).toEqual({ body: { amountCents: 5250, isPersonal: true }, error: null });
  });
  it('sends nothing for an amount typed differently but equal (47 vs 47.00)', () => {
    expect(diffForm(doc, { ...toForm(doc, 'en'), amount: '47' }, 'en')).toEqual({ body: {}, error: null });
  });
  it('parses the locale decimal comma', () => {
    expect(diffForm(doc, { ...toForm(doc, 'fr-CA'), amount: '52,50' }, 'fr-CA').body).toEqual({ amountCents: 5250 });
  });
  it('rejects non-numbers and non-positive amounts', () => {
    expect(diffForm(doc, { ...toForm(doc, 'en'), amount: 'abc' }, 'en').error).toEqual({ key: 'mobile.docs.amount_invalid' });
    expect(diffForm(doc, { ...toForm(doc, 'en'), amount: '0' }, 'en').error).toEqual({ key: 'mobile.docs.amount_invalid' });
    expect(diffForm(doc, { ...toForm(doc, 'en'), amount: '-5' }, 'en').error).toEqual({ key: 'mobile.docs.amount_invalid' });
  });
  it('rejects an amount that does not fit the 32-bit cents column (the server would 500)', () => {
    expect(diffForm(doc, { ...toForm(doc, 'en'), amount: '20000000.01' }, 'en').error).toEqual({ key: 'mobile.docs.amount_invalid' });
    expect(diffForm(doc, { ...toForm(doc, 'en'), amount: '20000000.00' }, 'en').body).toEqual({ amountCents: 2_000_000_000 });
  });
  it('asks the user to re-enter an ambiguous amount instead of guessing', () => {
    const r = diffForm(doc, { ...toForm(doc, 'fr-CA'), amount: '1,500' }, 'fr-CA');
    expect(r.body).toEqual({});
    expect(r.error?.key).toBe('mobile.docs.amount_ambiguous');
    expect(r.error).toEqual({ key: 'mobile.docs.amount_ambiguous', cents: 150 }); // the page formats it in the tenant currency
  });
  it('reads full-width digits and a full-width decimal point (a zh-CN IME) like their ASCII forms', () => {
    expect(diffForm(doc, { ...toForm(doc, 'zh-CN'), amount: '１２３．４５' }, 'zh-CN')).toEqual({ body: { amountCents: 12345 }, error: null });
    expect(diffForm(doc, { ...toForm(doc, 'en'), amount: '１２.５０' }, 'en').body).toEqual({ amountCents: 1250 });
  });
  it('a cleared date is refused with the Check-this-value error, not silently reset', () => {
    expect(diffForm(doc, { ...toForm(doc, 'en'), date: '' }, 'en')).toEqual({ body: {}, error: { key: 'mobile.docs.check_value' } });
    // a doc that never had a date: empty is no change
    const undated = { ...doc, date: '' };
    expect(diffForm(undated, toForm(undated, 'en'), 'en')).toEqual({ body: {}, error: null });
  });
  it('never sends an empty vendor (it cannot clear one) and says so', () => {
    const r = diffForm(doc, { ...toForm(doc, 'en'), vendor: '   ' }, 'en');
    expect(r.body).toEqual({});
    expect(r.error).toEqual({ key: 'mobile.docs.vendor_required' });
  });
  it('an empty vendor on a doc that never had one is not a change', () => {
    const none = { ...doc, vendorName: null };
    expect(diffForm(none, toForm(none, 'en'), 'en')).toEqual({ body: {}, error: null });
  });
  it('sends date and description changes (and a cleared note)', () => {
    expect(diffForm(doc, { ...toForm(doc, 'en'), date: '2026-09-30', description: 'Team lunch' }, 'en').body)
      .toEqual({ date: '2026-09-30', description: 'Team lunch' });
    expect(diffForm(doc, { ...toForm(doc, 'en'), description: '  ' }, 'en').body).toEqual({ description: '' });
  });
  it('never carries a category: category changes go through the categorize path only', () => {
    const body = diffForm(doc, { ...toForm(doc, 'en'), amount: '1.00', vendor: 'x', date: '2026-01-01', description: 'y', isPersonal: true }, 'en').body;
    expect(Object.keys(body).sort()).toEqual(['amountCents', 'date', 'description', 'isPersonal', 'vendor']);
  });
});
