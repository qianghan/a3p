import { describe, it, expect } from 'vitest';
import { splitPayrollEntry, type StubTotals } from '../payroll-ledger';

const stub = (gross: number, fed: number, fica: number, net: number): StubTotals => ({
  grossCents: gross, federalTaxCents: fed, stateTaxCents: 0, ficaCents: fica, otherDeductCents: 0, netCents: net,
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
    expect(r).toEqual({ grossCents: 0, netCents: 0, withheldCents: 0 });
  });
});
