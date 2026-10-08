/**
 * "Cash today" counts cash and bank accounts only — never receivables. The
 * rule is checked against the REAL chart packs, so a pack that adds an asset
 * account forces a decision here instead of silently changing the number.
 */
import { describe, it, expect } from 'vitest';
import { usChartOfAccounts } from '@agentbook/jurisdictions/us/chart-of-accounts';
import { caChartOfAccounts } from '@agentbook/jurisdictions/ca/chart-of-accounts';
import { auChartOfAccounts } from '@agentbook/jurisdictions/au/chart-of-accounts';
import { ukChartOfAccounts } from '@agentbook/jurisdictions/uk/chart-of-accounts';
import { isCashAccount } from '@/lib/agentbook-cash-accounts';

const PACKS = { us: usChartOfAccounts, ca: caChartOfAccounts, au: auChartOfAccounts, uk: ukChartOfAccounts };
const BUSINESS_TYPES = ['freelancer', 'sole_proprietor', 'consultant', 'agency', 'ecommerce', 'sole_trader'];

const assetsOf = (pack: (typeof PACKS)[keyof typeof PACKS], businessType: string) =>
  pack.getDefaultAccounts(businessType).filter((a) => a.type === 'asset');

describe('isCashAccount over the real chart packs', () => {
  it.each(Object.entries(PACKS))('%s: cash = 1000 cash + 1200 bank + 1300 savings; A/R and everything else excluded', (_j, pack) => {
    for (const bt of BUSINESS_TYPES) {
      const assets = assetsOf(pack, bt);
      const cash = assets.filter((a) => isCashAccount({ code: a.code, accountType: a.type })).map((a) => a.code);
      expect(cash, bt).toEqual(['1000', '1200', '1300']);
      const ar = assets.find((a) => a.code === '1100');
      expect(ar?.name, bt).toBe('Accounts Receivable');
      expect(isCashAccount({ code: '1100', accountType: 'asset' })).toBe(false);
    }
  });

  it('every asset in every pack is classified on purpose (a new asset account must be decided here)', () => {
    const seen = new Map<string, string>();
    for (const pack of Object.values(PACKS)) for (const bt of BUSINESS_TYPES) for (const a of assetsOf(pack, bt)) seen.set(a.code, a.name);
    expect([...seen.keys()].sort()).toEqual(['1000', '1100', '1200', '1300', '1400']);
    // AU 1400 "Term Deposits": locked away, not cash you have today.
    expect(seen.get('1400')).toBe('Term Deposits');
    expect(isCashAccount({ code: '1400', accountType: 'asset' })).toBe(false);
  });

  it('the student chart (agentbook-chart-of-accounts STUDENT_ACCOUNTS): 1000 Cash and 1200 Checking are cash', () => {
    expect(isCashAccount({ code: '1000', accountType: 'asset' })).toBe(true);
    expect(isCashAccount({ code: '1200', accountType: 'asset' })).toBe(true);
  });

  it('only asset accounts in the documented cash/bank ranges; junk codes are not cash', () => {
    expect(isCashAccount({ code: '1050', accountType: 'asset' })).toBe(true); // user-added petty cash / PayPal
    expect(isCashAccount({ code: '1399', accountType: 'asset' })).toBe(true);
    for (const code of ['1100', '1150', '1199', '1400', '1500', '0999', '2000', '10000', '1000a', '', ' 1000']) {
      expect(isCashAccount({ code, accountType: 'asset' }), code).toBe(false);
    }
    expect(isCashAccount({ code: '1000', accountType: 'liability' })).toBe(false);
    expect(isCashAccount({ code: '1200', accountType: 'expense' })).toBe(false);
  });
});
