import { describe, it, expect } from 'vitest';
import { splitPayrollEntry, type StubTotals } from '../payroll-ledger';

const stub = (gross: number, fed: number, fica: number, net: number, sg = 0): StubTotals => ({
  grossCents: gross, federalTaxCents: fed, stateTaxCents: 0, ficaCents: fica, otherDeductCents: 0, netCents: net, sgCents: sg,
});

describe('payroll ledger split', () => {
  it('net + withheld equals gross (balanced)', () => {
    const r = splitPayrollEntry([stub(3000_00, 400_00, 229_50, 2370_50)]);
    expect(r.grossCents).toBe(3000_00);
    expect(r.netCents + r.withheldCents).toBe(r.grossCents);
    expect(r.withheldCents).toBe(629_50);
  });

  it('sums across multiple employees', () => {
    const r = splitPayrollEntry([
      stub(3000_00, 400_00, 229_50, 2370_50),
      stub(2000_00, 200_00, 153_00, 1647_00),
    ]);
    expect(r.grossCents).toBe(5000_00);
    expect(r.netCents).toBe(2370_50 + 1647_00);
    expect(r.netCents + r.withheldCents).toBe(r.grossCents);
  });

  it('handles an empty run', () => {
    const r = splitPayrollEntry([]);
    expect(r).toEqual({ grossCents: 0, netCents: 0, withheldCents: 0, sgCents: 0 });
  });

  it('sums superannuation guarantee separately, without disturbing the net + withheld === gross invariant (AU)', () => {
    const r = splitPayrollEntry([
      stub(6000_00, 800_00, 0, 5200_00, 720_00), // AU: no fica, 12% super on $6000 gross = $720
      stub(4000_00, 500_00, 0, 3500_00, 480_00),
    ]);
    expect(r.sgCents).toBe(720_00 + 480_00);
    expect(r.netCents + r.withheldCents).toBe(r.grossCents); // sg is not part of this invariant
  });

  it('defaults sgCents to 0 when omitted from a stub (backward compatible with non-AU callers)', () => {
    const r = splitPayrollEntry([{ grossCents: 100_00, federalTaxCents: 10_00, stateTaxCents: 0, ficaCents: 5_00, otherDeductCents: 0, netCents: 85_00 }]);
    expect(r.sgCents).toBe(0);
  });
});
