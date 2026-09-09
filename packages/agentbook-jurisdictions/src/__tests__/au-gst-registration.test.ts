import { describe, expect, it } from 'vitest';
import {
  AU_GST_THRESHOLD_CENTS,
  checkGstThreshold,
  auGstApplies,
  gstStatusOf,
} from '../au/gst-registration.js';

/**
 * AgentBook added 10% GST to every AU tenant's invoices and headed the PDF
 * "TAX INVOICE", whether or not that tenant was registered for GST. A sole
 * trader under the A$75,000 threshold who has not registered may do neither:
 * the 10% is money taken from a client with no BAS on which to remit it, and
 * only a registered business may issue a tax invoice.
 *
 * These fix the two rules in place, and — just as important — fix what
 * happens when we do NOT know the answer.
 */

const UNDER = 4_000_000;      // A$40,000
const AT = AU_GST_THRESHOLD_CENTS;
const OVER = 9_000_000;       // A$90,000

describe('an unregistered business charges no GST', () => {
  it('applies no GST once the tenant says they are not registered', () => {
    expect(auGstApplies('not_registered')).toBe(false);
  });

  it('applies GST for a registered business', () => {
    expect(auGstApplies('registered')).toBe(true);
  });

  it('leaves the unanswered case exactly as it is today', () => {
    // Not an oversight. Flipping the unanswered case to "no GST" would stop a
    // genuinely registered business collecting GST it still owes at BAS time,
    // out of its own pocket. Neither default is safe, so nothing changes
    // silently and the threshold check asks instead.
    expect(auGstApplies('unknown')).toBe(true);
  });

  it('maps the nullable column onto the tri-state', () => {
    expect(gstStatusOf(true)).toBe('registered');
    expect(gstStatusOf(false)).toBe('not_registered');
    expect(gstStatusOf(null)).toBe('unknown');
    expect(gstStatusOf(undefined)).toBe('unknown');
  });
});

describe('the A$75,000 threshold', () => {
  it('is compulsory AT the threshold, not above it', () => {
    // "reaches $75,000" — a business landing exactly on it must register.
    expect(checkGstThreshold(AT, 'unknown').overThreshold).toBe(true);
    expect(checkGstThreshold(AT - 1, 'unknown').overThreshold).toBe(false);
  });

  it('tells an over-threshold unregistered business to register, with the deadline', () => {
    const { advice } = checkGstThreshold(OVER, 'not_registered');
    expect(advice?.severity).toBe('action');
    expect(advice?.message).toMatch(/compulsory/i);
    expect(advice?.message).toMatch(/21 days/);
    expect(advice?.message).toMatch(/A\$90,000/);
  });

  it('says nothing to an over-threshold business that is already registered', () => {
    expect(checkGstThreshold(OVER, 'registered').advice).toBeNull();
  });

  it('also chases the unanswered case when over the threshold', () => {
    // 'unknown' is not 'registered', so the obligation still stands.
    expect(checkGstThreshold(OVER, 'unknown').advice?.severity).toBe('action');
  });
});

describe('the quiet case: under the threshold and never asked', () => {
  it('asks, and says what we are currently doing to their invoices', () => {
    // The whole bug in one alert. A user under the threshold is probably not
    // registered, and we have been charging their clients 10% anyway.
    const { advice } = checkGstThreshold(UNDER, 'unknown');
    expect(advice?.severity).toBe('question');
    expect(advice?.message).toMatch(/10% GST/);
    expect(advice?.message).toMatch(/should not be charging/i);
  });

  it('stops asking once the tenant has answered, either way', () => {
    expect(checkGstThreshold(UNDER, 'registered').advice).toBeNull();
    expect(checkGstThreshold(UNDER, 'not_registered').advice).toBeNull();
  });
});
