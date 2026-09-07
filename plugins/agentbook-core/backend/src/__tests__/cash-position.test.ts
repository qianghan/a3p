import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * "What is my cash balance?" was answered with another question on web and MCP:
 * "for a specific bank account, or across all your accounts?" — reproduced on
 * all three regional tenants. The most basic question a bookkeeper gets.
 *
 * Not a prompt problem. query-finance has no endpoint and had no handler in the
 * shared brain path, so the message fell to the LLM, which reasonably asked for
 * clarification. The TELEGRAM webhook meanwhile had a working implementation —
 * so the same question answered correctly there and evasively everywhere else.
 * That asymmetry is the defect being fixed.
 */

const accountFindMany = vi.fn();
vi.mock('../db/client.js', () => ({
  db: { abAccount: { findMany: (...a: unknown[]) => accountFindMany(...a) } },
}));

const acct = (name: string, ...lines: [number, number][]) => ({
  name,
  journalLines: lines.map(([debitCents, creditCents]) => ({ debitCents, creditCents })),
});

beforeEach(() => vi.clearAllMocks());

describe('getCashPosition', () => {
  it('totals every asset account, debits less credits', async () => {
    accountFindMany.mockResolvedValue([
      acct('Cash', [500_00, 0], [0, 120_00]),
      acct('Checking', [1_000_00, 0]),
    ]);
    const { getCashPosition } = await import('../cash-position');
    const pos = await getCashPosition('t1');
    expect(pos.totalCents).toBe(500_00 - 120_00 + 1_000_00);
  });

  it('reads only active asset accounts, scoped to the tenant', async () => {
    accountFindMany.mockResolvedValue([]);
    const { getCashPosition } = await import('../cash-position');
    await getCashPosition('t-42');
    expect(accountFindMany.mock.calls[0][0].where).toEqual({
      tenantId: 't-42', accountType: 'asset', isActive: true,
    });
  });

  it('drops zero-balance accounts from the breakdown but keeps them in the total', async () => {
    // A freshly seeded chart is mostly zeros; listing them is noise.
    accountFindMany.mockResolvedValue([
      acct('Cash', [300_00, 0]), acct('Undeposited Funds'), acct('Petty Cash', [50_00, 50_00]),
    ]);
    const { getCashPosition } = await import('../cash-position');
    const pos = await getCashPosition('t1');
    expect(pos.totalCents).toBe(300_00);
    expect(pos.accounts.map((a) => a.name)).toEqual(['Cash']);
  });

  it('orders the breakdown by size, so the answer leads with what matters', async () => {
    accountFindMany.mockResolvedValue([
      acct('Petty Cash', [20_00, 0]), acct('Checking', [900_00, 0]), acct('Savings', [400_00, 0]),
    ]);
    const { getCashPosition } = await import('../cash-position');
    const pos = await getCashPosition('t1');
    expect(pos.accounts.map((a) => a.name)).toEqual(['Checking', 'Savings', 'Petty Cash']);
  });

  it('reports a negative position rather than hiding it', async () => {
    // An overdrawn account is exactly when someone asks this question.
    accountFindMany.mockResolvedValue([acct('Checking', [0, 250_00])]);
    const { getCashPosition } = await import('../cash-position');
    expect((await getCashPosition('t1')).totalCents).toBe(-250_00);
  });

  it('returns a zero position for a tenant with no accounts, not a crash', async () => {
    accountFindMany.mockResolvedValue([]);
    const { getCashPosition } = await import('../cash-position');
    expect(await getCashPosition('t1')).toEqual({ totalCents: 0, accounts: [] });
  });
});

describe('isCashBalanceQuestion', () => {
  it.each([
    'what is my cash balance?',
    "What's my cash balance",
    'how much cash do i have',
    'how much money do I have?',
    "what's in the bank",
    'bank balance please',
    'cash on hand',
    '我的现金余额是多少',
    '现在账上还有多少现金',
  ])('yes: %s', (t) => expect(isCashBalanceQuestion(t)).toBe(true));

  it.each([
    'how much did I spend on travel last month?',
    'who owes me money?',
    'invoice Acme $500',
    'what is my tax estimate',
    '这个月我花了多少钱？',
    '',
  ])('no: %s', (t) => expect(isCashBalanceQuestion(t)).toBe(false));
});

// imported after the mock so the module picks it up
import { isCashBalanceQuestion } from '../cash-position';

describe('both surfaces use it', () => {
  /**
   * The asymmetry is the defect, so the fix is only real if BOTH callers go
   * through the shared computation. A helper one surface ignores is how this
   * bug existed in the first place — and the shape of #444, #451 and #453.
   */
  const read = async (rel: string) => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    return readFileSync(join(__dirname, rel), 'utf8');
  };

  it('the shared brain path answers cash balance itself', async () => {
    const src = await read('../server.ts');
    // The GUARD, not just the import. Asserting the identifier appears
    // somewhere passes even when the branch is disabled — which is exactly
    // what a mutation run showed.
    expect(
      src,
      'the query-finance cash branch is not wired into the shared path',
    ).toMatch(/=== 'query-finance'\s*&&\s*isCashBalanceQuestion\(/);
    expect(src).toMatch(/await getCashPosition\(tenantId\)/);
  });

  it('the Telegram webhook no longer keeps its own copy', async () => {
    const src = await read('../../../../../apps/web-next/src/app/api/v1/agentbook/telegram/webhook/route.ts');
    expect(src).toContain('getCashPosition');
    expect(
      src,
      'Telegram is recomputing the ledger sum locally again — that is the asymmetry this fixed',
    ).not.toMatch(/accountType: 'asset', isActive: true/);
  });
});
