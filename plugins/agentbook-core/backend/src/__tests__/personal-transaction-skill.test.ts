import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BUILT_IN_SKILLS } from '../built-in-skills.js';
import { selectSkillByPatterns } from '../skill-routing.js';

// gotcha (this session): never write `vi.fn(async () => [])` for a mock that
// later needs `.mockResolvedValueOnce(...)` with real data — TypeScript
// infers `never[]` and every later `.mockResolvedValueOnce` call breaks
// under `tsc --noEmit` even though `vitest run` alone won't catch it. Use a
// plain untyped `vi.fn()` and set the default via `mockImplementation` in
// `beforeEach` instead.
const mockAbPersonalAccountFindMany = vi.fn();
const mockAbTenantConfigFindUnique = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abPersonalAccount: { findMany: (...args: any[]) => mockAbPersonalAccountFindMany(...args) },
    abTenantConfig: { findUnique: (...args: any[]) => mockAbTenantConfigFindUnique(...args) },
    abConversation: { create: vi.fn(async () => ({})) },
    abEvent: { create: vi.fn(async () => ({})) },
  },
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';

const ENDPOINT = { method: 'POST', url: '/api/v1/agentbook-personal/transactions' };

function classification(extractedParams: Record<string, any> = {}) {
  return {
    selectedSkill: { name: 'record-personal-transaction', endpoint: ENDPOINT, parameters: {} },
    extractedParams,
    confidence: 0.9,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: {},
  } as any;
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so queued mockResolvedValueOnce values
  // from a test whose disambiguation branch never fired don't leak into a
  // later, unrelated test — same discipline as student-chat-skills.test.ts.
  vi.resetAllMocks();
  mockAbPersonalAccountFindMany.mockImplementation(async () => []);
  mockAbTenantConfigFindUnique.mockImplementation(async () => null);
});

// --- Routing -----------------------------------------------------------

// `db.abSkillManifest.findMany(...)` (server.ts, agent-brain.ts) has no
// `orderBy`, so BUILT_IN_SKILLS's declaration order can't be trusted to
// match production row order. A `pickSkill` that just walks this array and
// returns the first match hides real collisions (two skills both match; the
// test always sees the same array-order winner, but prod's DB order might
// return the other one first). Cross-check the declaration-order winner
// against a few shuffled evaluation orders and throw if they disagree, so
// an order-dependent collision fails loudly instead of passing by luck of
// array position — mirrors the fix applied to skill-routing-canonical.test.ts.
function shuffle<T>(arr: readonly T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const SHUFFLE_SEEDS = [7, 42, 1337];

function firstMatchIn(order: readonly (typeof BUILT_IN_SKILLS)[number][], text: string, lower: string): string | null {
  for (const skill of order) {
    if (selectSkillByPatterns(skill, text, lower)) return skill.name;
  }
  return null;
}

function pickSkill(text: string): string | null {
  const lower = text.toLowerCase();
  const declared = firstMatchIn(BUILT_IN_SKILLS, text, lower);

  for (const seed of SHUFFLE_SEEDS) {
    const shuffled = firstMatchIn(shuffle(BUILT_IN_SKILLS, seed), text, lower);
    if (shuffled !== declared) {
      throw new Error(
        `Order-dependent routing for "${text}": BUILT_IN_SKILLS declaration order picks "${declared}", ` +
        `but a shuffled evaluation order picks "${shuffled}" — this collision isn't resolved by ` +
        `excludePatterns and depends on array order, which production's DB query doesn't guarantee.`,
      );
    }
  }

  return declared;
}

describe('record-personal-transaction — routing', () => {
  it('routes personal income phrasing to record-personal-transaction', () => {
    expect(pickSkill('I got paid $5,000 salary')).toBe('record-personal-transaction');
    expect(pickSkill('I got my paycheck today, $3200')).toBe('record-personal-transaction');
  });

  it('routes personal spend phrasing (explicit account) to record-personal-transaction', () => {
    expect(pickSkill('I spent $80 on groceries from checking')).toBe('record-personal-transaction');
    expect(pickSkill('spent $50 on my personal account')).toBe('record-personal-transaction');
  });

  it('routes "put $X into savings" to record-personal-transaction', () => {
    expect(pickSkill('put $50 into savings')).toBe('record-personal-transaction');
  });

  it('still routes plain business-style spend phrasing to record-expense (regression)', () => {
    expect(pickSkill('spent $45 on lunch')).toBe('record-expense');
    expect(pickSkill('paid $42 for uber')).toBe('record-expense');
    expect(pickSkill('bought $20 of office supplies')).toBe('record-expense');
  });

  it('still routes net-worth/savings-rate queries to personal-snapshot (regression)', () => {
    expect(pickSkill("what's my net worth")).toBe('personal-snapshot');
    expect(pickSkill("what's my savings rate")).toBe('personal-snapshot');
  });

  it('does not route a business-flagged phrase to record-personal-transaction', () => {
    expect(pickSkill('I spent $200 on software for the business')).toBe('record-expense');
    // Would otherwise trigger on "from my checking account" — the explicit
    // "for the business" exclude on record-personal-transaction defers to
    // record-expense instead of misfiling a business purchase as personal.
    expect(pickSkill('I spent $50 on software for the business from my checking account')).toBe('record-expense');
    expect(pickSkill('paid the client invoice for $500')).not.toBe('record-personal-transaction');
  });

  it('routes a negated business phrase to record-personal-transaction, not record-expense', () => {
    // "not a business expense" contains the substring "business expense" —
    // a naive match would wrongly treat this as business-flagged language
    // and defer to record-expense. The negation-aware check must catch this.
    expect(pickSkill('I withdrew $80 from my checking, not a business expense')).toBe('record-personal-transaction');
  });
});

/**
 * Final whole-branch review, round 2: record-payment and
 * record-invoice-payment (both "record an invoice payment" skills) had no
 * excludePatterns at all, so their bare "got paid"/"received payment"
 * triggers also fired on personal-income phrasing like "I got paid $5,000
 * salary" — and personal-snapshot's bare 'my personal' trigger fired on a
 * spend *statement* like "spent $50 on my personal account", not just a
 * query. Verify all five candidate skills directly (bypassing pickSkill's
 * array-order loop) so the fix holds regardless of DB row order, exactly
 * like the record-expense/record-personal-transaction pair above.
 */
describe('record-payment / record-invoice-payment / personal-snapshot — defer to record-personal-transaction', () => {
  const CANDIDATE_NAMES = ['record-personal-transaction', 'record-expense', 'record-payment', 'record-invoice-payment', 'personal-snapshot'] as const;
  const candidates = CANDIDATE_NAMES.map((name) => BUILT_IN_SKILLS.find((s) => s.name === name)!);

  const cases: Array<{ text: string; expected: (typeof CANDIDATE_NAMES)[number] }> = [
    { text: 'I got paid $5,000 salary', expected: 'record-personal-transaction' },
    { text: 'I got paid $250 salary, put it in my checking account', expected: 'record-personal-transaction' },
    { text: 'spent $50 on my personal account', expected: 'record-personal-transaction' },
    { text: 'I got paid for invoice INV-2026-0004', expected: 'record-invoice-payment' },
    { text: 'Acme paid the invoice', expected: 'record-invoice-payment' },
    { text: 'Client Beta LLC paid me', expected: 'record-invoice-payment' },
    { text: "how's my personal finance looking", expected: 'personal-snapshot' },
    { text: "what's my net worth", expected: 'personal-snapshot' },
    { text: 'I spent $80 on lunch', expected: 'record-expense' },
  ];

  for (const c of cases) {
    it(`"${c.text}" -> exactly ${c.expected} claims it among the 5 candidates, independent of evaluation order`, () => {
      const lower = c.text.toLowerCase();
      const matched = candidates.filter((s) => selectSkillByPatterns(s, c.text, lower)).map((s) => s.name);
      expect(matched).toEqual([c.expected]);

      for (const seed of SHUFFLE_SEEDS) {
        const shuffledMatched = shuffle(candidates, seed)
          .filter((s) => selectSkillByPatterns(s, c.text, lower))
          .map((s) => s.name)
          .sort();
        expect(shuffledMatched).toEqual([...matched].sort());
      }
    });
  }
});

// --- Handler: account resolution ----------------------------------------

describe('record-personal-transaction — account resolution', () => {
  it('zero accounts: points the user at the Personal page, confidence 1, no HTTP call', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([]);
    const result = await executeClassification(
      classification({ description: 'Groceries', amountCents: 8000 }),
      'I spent $80 on groceries from checking',
      'tenant-1', 'api',
    );
    expect(result.responseData.message).toMatch(/Personal page/i);
    expect(result.responseData.confidence).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('single account: auto-resolves without asking', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([{ id: 'acc-checking', name: 'Checking', type: 'checking' }]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-1', amountCents: -8000, description: 'Groceries' } }) });
    await executeClassification(
      classification({ description: 'Groceries', amountCents: 8000 }),
      'I spent $80 on groceries',
      'tenant-1', 'api',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('/api/v1/agentbook-personal/transactions');
    const body = JSON.parse((opts as any).body);
    expect(body.accountId).toBe('acc-checking');
    expect(body.accountRef).toBeUndefined();
  });

  it('multi-account with an explicit account reference resolves correctly', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([
      { id: 'acc-checking', name: 'Checking', type: 'checking' },
      { id: 'acc-savings', name: 'Savings', type: 'savings' },
    ]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-2', amountCents: 5000 } }) });
    await executeClassification(
      classification({ description: 'Transfer to savings', amountCents: 5000, accountRef: 'savings' }),
      'put $50 into savings',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.accountId).toBe('acc-savings');
  });

  it('multi-account with no reference and no clear match asks a clarifying question listing account names', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([
      { id: 'acc-checking', name: 'Checking', type: 'checking' },
      { id: 'acc-savings', name: 'Savings', type: 'savings' },
    ]);
    const result = await executeClassification(
      classification({ description: 'Paycheck', amountCents: 500000 }),
      'I got paid $5,000',
      'tenant-1', 'api',
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.responseData.message).toMatch(/Checking/);
    expect(result.responseData.message).toMatch(/Savings/);
    expect(result.responseData.confidence).toBe(1);
  });
});

// --- Handler: sign inference ---------------------------------------------

describe('record-personal-transaction — sign inference', () => {
  beforeEach(() => {
    mockAbPersonalAccountFindMany.mockResolvedValue([{ id: 'acc-checking', name: 'Checking', type: 'checking' }]);
  });

  it('an income phrase produces a positive amountCents', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-3', amountCents: 500000 } }) });
    await executeClassification(
      classification({ description: 'Paycheck', amountCents: 500000 }),
      'I got paid $5,000 salary',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.amountCents).toBe(500000);
  });

  it('a spend phrase produces a negative amountCents', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-4', amountCents: -8000 } }) });
    await executeClassification(
      classification({ description: 'Groceries', amountCents: 8000 }),
      'I spent $80 on groceries from checking',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.amountCents).toBe(-8000);
  });

  it('re-signs the amount even if the classifier had already guessed negative for an income phrase', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-5', amountCents: 320000 } }) });
    await executeClassification(
      classification({ description: 'Paycheck deposit', amountCents: -320000 }),
      'I got my paycheck today, deposited $3,200',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.amountCents).toBe(320000);
  });
});

// --- Handler: businessFlag extraction --------------------------------------

describe('record-personal-transaction — businessFlag extraction', () => {
  beforeEach(() => {
    mockAbPersonalAccountFindMany.mockResolvedValue([{ id: 'acc-checking', name: 'Checking', type: 'checking' }]);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ success: true, data: { id: 'txn-6' } }) });
  });

  it('sets businessFlag true only on an explicit "for the business" style phrase', async () => {
    await executeClassification(
      classification({ description: 'Software', amountCents: 5000 }),
      'I spent $50 on software for the business, paid from my personal checking',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.businessFlag).toBe(true);
  });

  it('defaults businessFlag to false otherwise', async () => {
    await executeClassification(
      classification({ description: 'Groceries', amountCents: 8000 }),
      'I spent $80 on groceries from checking',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.businessFlag).toBe(false);
  });

  it('does not flag businessFlag true on a negated business phrase ("not a business expense")', async () => {
    await executeClassification(
      classification({ description: 'Cash withdrawal', amountCents: 8000 }),
      'I withdrew $80 from my checking, not a business expense',
      'tenant-1', 'api',
    );
    const [, opts] = mockFetch.mock.calls[0];
    const body = JSON.parse((opts as any).body);
    expect(body.businessFlag).toBe(false);
  });
});

// --- Response formatting ---------------------------------------------------

describe('record-personal-transaction — response formatting', () => {
  it('formats a successful spend as a readable message, not a JSON dump', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([{ id: 'acc-checking', name: 'Checking', type: 'checking' }]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-7', amountCents: -8000, description: 'Groceries', businessFlag: false } }) });
    const result = await executeClassification(
      classification({ description: 'Groceries', amountCents: 8000 }),
      'I spent $80 on groceries from checking',
      'tenant-1', 'api',
    );
    expect(result.responseData.message).toMatch(/Recorded spending/);
    expect(result.responseData.message).toMatch(/\$80\.00/);
    expect(result.responseData.message).not.toMatch(/^\{/);
  });

  // Regression (final review of personal-finance-parity branch): the reply
  // used to call fmtCurrency(amountCents, data.currency) — but
  // AbPersonalTransaction has no `currency` column, so data.currency was
  // always undefined and every tenant saw a hardcoded USD `$`, even a CAD
  // tenant. The fix fetches the tenant's configured currency directly
  // instead of reading it off the created row.
  it('formats the reply using the tenant\'s configured currency, not a hardcoded USD', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce({ currency: 'CAD' });
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([{ id: 'acc-checking', name: 'Checking', type: 'checking' }]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-8', amountCents: -8000, description: 'Groceries', businessFlag: false } }) });
    const result = await executeClassification(
      classification({ description: 'Groceries', amountCents: 8000 }),
      'I spent $80 on groceries from checking',
      'tenant-1', 'api',
    );
    expect(result.responseData.message).toMatch(/CA\$80\.00/);
    expect(result.responseData.message).not.toMatch(/^\$80\.00/);
  });

  it('falls back to USD when the tenant has no configured currency', async () => {
    mockAbTenantConfigFindUnique.mockResolvedValueOnce(null);
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([{ id: 'acc-checking', name: 'Checking', type: 'checking' }]);
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, data: { id: 'txn-9', amountCents: 500000, description: 'Paycheck', businessFlag: false } }) });
    const result = await executeClassification(
      classification({ description: 'Paycheck', amountCents: 500000 }),
      'I got paid $5,000 salary',
      'tenant-1', 'api',
    );
    expect(result.responseData.message).toMatch(/\$5000\.00/);
  });
});
