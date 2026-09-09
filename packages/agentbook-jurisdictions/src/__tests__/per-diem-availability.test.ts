import { describe, expect, it } from 'vitest';
import { perDiemAvailability } from '../per-diem-availability.js';

/**
 * "AU: no per-diem" sat on the launch scorecard as a missing table. It is the
 * opposite of that. A per-diem is a substantiation shortcut — deduct a daily
 * meal amount without keeping receipts — and whether one exists for you is a
 * question about who your revenue authority excuses from record-keeping.
 *
 * The ATO's reasonable amounts excuse an EMPLOYEE who received a bona fide
 * travel allowance. A sole trader does not pay themselves an allowance, so
 * the exception never reaches them. Shipping an AU table would have invited
 * them to claim meals without the tax invoices the ATO requires, and handed
 * them an audit problem the product created.
 *
 * So these tests pin the refusal and, more importantly, what it tells the
 * user to do instead.
 */

describe('per-diem is available in the US and nowhere else', () => {
  it('is available for a US tenant, with nothing to explain', () => {
    expect(perDiemAvailability('us')).toEqual({ available: true, message: null });
  });

  it.each(['au', 'ca', 'uk'])('is not available for %s', (j) => {
    const r = perDiemAvailability(j);
    expect(r.available).toBe(false);
    expect(r.message).toBeTruthy();
  });

  it('refuses an unknown jurisdiction rather than assuming it works like the US', () => {
    // A wrong "yes" here is a deduction the user cannot substantiate.
    for (const j of ['de', '', null, undefined, 'zz']) {
      expect(perDiemAvailability(j).available).toBe(false);
      expect(perDiemAvailability(j).message).toBeTruthy();
    }
  });

  it('is case- and whitespace-insensitive', () => {
    for (const j of ['US', ' us ', 'Us']) expect(perDiemAvailability(j).available).toBe(true);
    expect(perDiemAvailability(' AU ').available).toBe(false);
  });
});

describe('the refusal says why, and what to do instead', () => {
  it('AU: names the employee-allowance condition and the travel diary', () => {
    // "Coming in a future release" was worse than useless: it promised a
    // feature that cannot exist and told the user nothing actionable.
    const m = perDiemAvailability('au').message!;
    expect(m).toMatch(/employee/i);
    expect(m).toMatch(/allowance/i);
    expect(m).toMatch(/travel diary/i);
    expect(m).toMatch(/six or more consecutive nights/i);
    expect(m).not.toMatch(/future release|coming soon|not yet|yet\b/i);
  });

  it('CA: names the 50% limit rather than implying meals are fully deductible', () => {
    const m = perDiemAvailability('ca').message!;
    expect(m).toMatch(/50%/);
    expect(m).toMatch(/transport employees|moving or medical/i);
  });

  it('UK: distinguishes benchmark scale rates from simplified expenses', () => {
    const m = perDiemAvailability('uk').message!;
    expect(m).toMatch(/benchmark scale rates/i);
    expect(m).toMatch(/simplified.expenses/i);
  });

  it('never tells a non-US user the feature is on its way', () => {
    for (const j of ['au', 'ca', 'uk', 'de']) {
      expect(perDiemAvailability(j).message).not.toMatch(/future release|coming soon/i);
    }
  });
});
