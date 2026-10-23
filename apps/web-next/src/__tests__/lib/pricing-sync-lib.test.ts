import { describe, it, expect } from 'vitest';
import { classifyRow, remediation, summarize, type SyncInput } from '../../../../../agentbook/pricing-sync-lib';

const want = { cents: 1900, currency: 'usd', interval: 'month' as const };
const db = { cents: 1900, currency: 'usd', interval: 'month' as const, stripePriceId: 'price_x', isActive: true };
const stripe = { cents: 1900, currency: 'usd', interval: 'month' as const, active: true };
const row = (over: Partial<SyncInput> = {}): SyncInput => ({ label: 'pro [us]', want, db, stripe, ...over });

describe('classifyRow', () => {
  it('OK when code, database and the Stripe Price all agree', () => {
    expect(classifyRow(row())).toBe('OK');
  });

  it('NOT_IN_DB when the code has a row the database lacks', () => {
    expect(classifyRow(row({ db: null, stripe: null }))).toBe('NOT_IN_DB');
  });

  it('DB_DRIFT on any of amount, currency or interval differing from the code', () => {
    expect(classifyRow(row({ db: { ...db, cents: 2900 } }))).toBe('DB_DRIFT');
    expect(classifyRow(row({ db: { ...db, currency: 'cad' } }))).toBe('DB_DRIFT');
    expect(classifyRow(row({ db: { ...db, interval: 'year' } }))).toBe('DB_DRIFT');
  });

  it('currency compare is case-insensitive (the DB stores "CAD" in places, Stripe returns "cad")', () => {
    expect(classifyRow(row({ db: { ...db, currency: 'USD' } }))).toBe('OK');
  });

  it('NO_STRIPE_PRICE when a paid, active row has no Stripe Price attached', () => {
    expect(classifyRow(row({ db: { ...db, stripePriceId: null }, stripe: null }))).toBe('NO_STRIPE_PRICE');
  });

  it('a free row needs no Stripe Price', () => {
    const free = { cents: 0, currency: 'usd', interval: 'month' as const };
    expect(classifyRow({ label: 'free [us]', want: free, db: { ...free, stripePriceId: null, isActive: true }, stripe: null })).toBe('OK');
  });

  it('STRIPE_MISSING when the attached id does not exist in Stripe', () => {
    expect(classifyRow(row({ stripe: null }))).toBe('STRIPE_MISSING');
  });

  it('STRIPE_INACTIVE when the attached Price is archived', () => {
    expect(classifyRow(row({ stripe: { ...stripe, active: false } }))).toBe('STRIPE_INACTIVE');
  });

  it('STRIPE_DRIFT when the Stripe Price amount, currency or interval differs from the database (the case a price change creates)', () => {
    expect(classifyRow(row({ stripe: { ...stripe, cents: 1500 } }))).toBe('STRIPE_DRIFT');
    expect(classifyRow(row({ stripe: { ...stripe, currency: 'cad' } }))).toBe('STRIPE_DRIFT');
    expect(classifyRow(row({ stripe: { ...stripe, interval: 'year' } }))).toBe('STRIPE_DRIFT');
  });

  it('the database is checked against the code BEFORE Stripe is checked against the database', () => {
    // Both drifted: the first thing to fix is the database (re-seed), so that is what is reported.
    expect(classifyRow(row({ db: { ...db, cents: 2900 }, stripe: { ...stripe, cents: 1500 } }))).toBe('DB_DRIFT');
  });
});

describe('remediation + summarize', () => {
  it('every non-OK status tells the operator what to do, and STRIPE_DRIFT says a new Price is required', () => {
    for (const s of ['NOT_IN_DB', 'DB_DRIFT', 'NO_STRIPE_PRICE', 'STRIPE_MISSING', 'STRIPE_INACTIVE', 'STRIPE_DRIFT'] as const) {
      expect(remediation(s).length, s).toBeGreaterThan(20);
    }
    expect(remediation('STRIPE_DRIFT')).toMatch(/new .*price/i);
    expect(remediation('OK')).toBe('');
  });

  it('summarize counts statuses and is clean only when everything is OK', () => {
    expect(summarize(['OK', 'OK']).clean).toBe(true);
    const s = summarize(['OK', 'STRIPE_DRIFT', 'STRIPE_DRIFT', 'NO_STRIPE_PRICE']);
    expect(s.clean).toBe(false);
    expect(s.counts).toEqual({ OK: 1, STRIPE_DRIFT: 2, NO_STRIPE_PRICE: 1 });
  });

  it('an empty run is NOT clean (nothing was checked)', () => {
    expect(summarize([]).clean).toBe(false);
  });
});
