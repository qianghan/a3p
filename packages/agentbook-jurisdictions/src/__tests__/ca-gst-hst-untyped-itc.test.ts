import { describe, it, expect } from 'vitest';
import { computeGstHstReturn } from '../ca/gst-hst-return.js';

/**
 * Launch finding F3: an untyped row put its full tax paid on line 108, so PST
 * (never recoverable), QST (a Revenu Québec ITR) and the 50% meals rule were
 * all skipped — an ITC over-claim on a return users file.
 */
const base = { periodStart: '2026-01-01', periodEnd: '2026-03-31', sales: [], gstRegistered: true };
const untyped = (taxPaidCents: number, isMeal = false) => ({ taxPaidCents, taxCode: null, grossCents: 0, isMeal });

describe('GST/HST line 108 for untyped purchases', () => {
  it('BC: only the GST share (5 of 12 points) of an untyped row is claimed', () => {
    const r = computeGstHstReturn({ ...base, region: 'BC', purchases: [untyped(1200)] });
    expect(r.line108ItcCents).toBe(500);
  });

  it('ON (HST): the whole HST is claimed', () => {
    const r = computeGstHstReturn({ ...base, region: 'ON', purchases: [untyped(1300)] });
    expect(r.line108ItcCents).toBe(1300);
  });

  it('untyped meals are claimed at 50%', () => {
    const r = computeGstHstReturn({ ...base, region: 'ON', purchases: [untyped(1300, true)] });
    expect(r.line108ItcCents).toBe(650);
  });

  it('QC: GST goes to line 108, QST to the ITR only when QST-registered', () => {
    const paid = 14975; // 5% GST + 9.975% QST on $1,000
    const reg = computeGstHstReturn({ ...base, region: 'QC', qstRegistered: true, purchases: [untyped(paid)] });
    expect(reg.line108ItcCents).toBe(5000);
    expect(reg.qstItrCents).toBe(9975);
    const unreg = computeGstHstReturn({ ...base, region: 'QC', qstRegistered: false, purchases: [untyped(paid)] });
    expect(unreg.line108ItcCents).toBe(5000);
    expect(unreg.qstItrCents).toBe(0);
  });
});
