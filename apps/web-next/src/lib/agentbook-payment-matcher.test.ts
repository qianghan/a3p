/**
 * Unit tests for the payment matcher's pure scoring functions. The
 * scorer returns 0 for "definitely not" so the orchestrator can ignore
 * those, 1 for "definitely yes", and a graded score in between.
 *
 * Thresholds the orchestrator uses (kept in one place so tests stay in sync):
 *   ≥0.85 → auto-match
 *   0.55–0.85 → queue for review
 *   <0.55 → ignore
 */

import { describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));

import {
  scoreInvoiceMatch,
  scoreExpenseMatch,
  AUTO_MATCH_THRESHOLD,
  REVIEW_THRESHOLD,
  type MatchableInvoice,
  type MatchableExpense,
  type MatchableTxn,
} from './agentbook-payment-matcher';

const today = new Date('2026-05-04T12:00:00Z');
const dayBefore = new Date('2026-05-03T12:00:00Z');
const fourDaysBefore = new Date('2026-04-30T12:00:00Z');

function txn(overrides: Partial<MatchableTxn> = {}): MatchableTxn {
  return {
    id: 'tx1',
    amountCents: -120000, // negative = inflow / credit (sender paid us)
    date: today,
    name: 'STRIPE TRANSFER',
    merchantName: 'Stripe',
    ...overrides,
  };
}

function invoice(overrides: Partial<MatchableInvoice> = {}): MatchableInvoice {
  return {
    id: 'inv1',
    amountCents: 120000,
    issuedDate: dayBefore,
    dueDate: new Date('2026-06-01T00:00:00Z'),
    status: 'sent',
    clientName: 'Stripe Inc',
    ...overrides,
  };
}

function expense(overrides: Partial<MatchableExpense> = {}): MatchableExpense {
  return {
    id: 'exp1',
    amountCents: 4500,
    date: dayBefore,
    description: 'Coffee at Blue Bottle',
    vendorName: 'Blue Bottle',
    ...overrides,
  };
}

describe('scoreInvoiceMatch', () => {
  it('returns ≥0.95 for a near-perfect match (amount + date + name all align)', () => {
    const score = scoreInvoiceMatch(txn(), invoice());
    expect(score).toBeGreaterThanOrEqual(0.95);
  });

  it('returns 0 when amount differs by more than the tolerance window', () => {
    const score = scoreInvoiceMatch(
      txn({ amountCents: -120000 }),
      invoice({ amountCents: 200000 }), // way off
    );
    expect(score).toBe(0);
  });

  it('returns 0 when date is more than 3 days off', () => {
    const score = scoreInvoiceMatch(
      txn({ date: today }),
      invoice({ issuedDate: new Date('2026-04-20T12:00:00Z') }),
    );
    expect(score).toBe(0);
  });

  it('still scores fuzzy name overlap (substring) ≥0.7', () => {
    const score = scoreInvoiceMatch(
      txn({ name: 'STRIPE TRF', merchantName: null }),
      invoice({ clientName: 'Stripe Payments LLC' }),
    );
    expect(score).toBeGreaterThanOrEqual(0.7);
  });

  it('handles missing transaction merchant — still positive on amount + date', () => {
    const score = scoreInvoiceMatch(
      txn({ name: 'WIRE INCOMING', merchantName: null }),
      invoice({ clientName: 'Acme Corp' }),
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(AUTO_MATCH_THRESHOLD);
  });

  it('disambiguates when two invoices share an amount: name match wins', () => {
    const tx = txn({ name: 'STRIPE TRANSFER 9981', merchantName: 'Stripe' });
    const stripeInv = invoice({ id: 'inv-stripe', clientName: 'Stripe Inc' });
    const acmeInv = invoice({ id: 'inv-acme', clientName: 'Acme Corp' });
    const stripeScore = scoreInvoiceMatch(tx, stripeInv);
    const acmeScore = scoreInvoiceMatch(tx, acmeInv);
    expect(stripeScore).toBeGreaterThan(acmeScore);
  });

  it('returns 0 for an already-paid invoice', () => {
    const score = scoreInvoiceMatch(txn(), invoice({ status: 'paid' }));
    expect(score).toBe(0);
  });

  it('returns 0 for an outflow transaction (debit) — invoice payments are inflows', () => {
    const score = scoreInvoiceMatch(txn({ amountCents: 120000 }), invoice());
    expect(score).toBe(0);
  });

  it('rounds to ≥AUTO_MATCH_THRESHOLD when amount matches exactly within tolerance', () => {
    // Plaid amounts can drift by sub-cent rounding; tolerance is ±0.5%
    const score = scoreInvoiceMatch(
      txn({ amountCents: -120300 }), // 0.25% off
      invoice({ amountCents: 120000 }),
    );
    expect(score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('respects the date window edge (3 days exactly)', () => {
    const score = scoreInvoiceMatch(
      txn({ date: today }),
      invoice({ issuedDate: new Date('2026-05-01T12:00:00Z') }), // 3 days before
    );
    expect(score).toBeGreaterThan(0);
  });

  it('falls outside the window at 4 days', () => {
    const score = scoreInvoiceMatch(
      txn({ date: today }),
      invoice({ issuedDate: fourDaysBefore }),
    );
    expect(score).toBe(0);
  });
});

describe('scoreExpenseMatch', () => {
  it('matches an outflow to a recent expense', () => {
    const score = scoreExpenseMatch(
      txn({ amountCents: 4500, name: 'BLUE BOTTLE COFFEE', merchantName: 'Blue Bottle' }),
      expense(),
    );
    expect(score).toBeGreaterThanOrEqual(AUTO_MATCH_THRESHOLD);
  });

  it('returns 0 for an inflow when scoring an expense', () => {
    const score = scoreExpenseMatch(
      txn({ amountCents: -4500 }),
      expense(),
    );
    expect(score).toBe(0);
  });

  it('returns 0 when amount differs >0.5% beyond min absolute tolerance', () => {
    const score = scoreExpenseMatch(
      txn({ amountCents: 10000 }),
      expense({ amountCents: 4500 }),
    );
    expect(score).toBe(0);
  });
});

describe('threshold constants', () => {
  it('exposes the 0.85 / 0.55 / <0.55 bands the spec requires', () => {
    expect(AUTO_MATCH_THRESHOLD).toBeCloseTo(0.85);
    expect(REVIEW_THRESHOLD).toBeCloseTo(0.55);
    expect(AUTO_MATCH_THRESHOLD).toBeGreaterThan(REVIEW_THRESHOLD);
  });
});
