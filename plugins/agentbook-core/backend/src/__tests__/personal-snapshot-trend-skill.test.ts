import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// gotcha (this session, mirrored from personal-transaction-skill.test.ts):
// never write `vi.fn(async () => [])` for a mock that later needs
// `.mockResolvedValueOnce(...)` with real data — TypeScript infers
// `never[]` and every later `.mockResolvedValueOnce` call breaks under
// `tsc --noEmit` even though `vitest run` alone won't catch it. Use a plain
// untyped `vi.fn()` and set the default via `mockImplementation` instead.
const mockAbPersonalAccountFindMany = vi.fn();
const mockAbPersonalTransactionFindMany = vi.fn();

vi.mock('../db/client.js', () => ({
  db: {
    abPersonalAccount: { findMany: (...args: any[]) => mockAbPersonalAccountFindMany(...args) },
    abPersonalTransaction: { findMany: (...args: any[]) => mockAbPersonalTransactionFindMany(...args) },
    abConversation: { create: vi.fn(async () => ({})) },
    abEvent: { create: vi.fn(async () => ({})) },
  },
}));

const mockHasAddOn = vi.fn();
vi.mock('@naap/billing', () => ({ hasAddOn: (...args: any[]) => mockHasAddOn(...args) }));

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { executeClassification } from '../server';
import { BUILT_IN_SKILLS } from '../built-in-skills.js';
import { selectSkillByPatterns, isPersonalTrendQuery } from '../skill-routing.js';

const ENDPOINT = { method: 'INTERNAL', url: '' };

function classification(extractedParams: Record<string, any> = {}, confidence = 0.9) {
  return {
    selectedSkill: { name: 'personal-snapshot', endpoint: ENDPOINT, parameters: {} },
    extractedParams,
    confidence,
    confirmBefore: false,
    memory: [], skills: [], conversation: [], tenantConfig: {},
  } as any;
}

// Fixed "now" for deterministic month-end boundaries: July 15, 2026 (local
// time) — mirrors apps/web-next/src/lib/__tests__/personal-trend.test.ts's
// convention, since this handler re-implements the same reconstruction math.
const NOW = new Date(2026, 6, 15);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  mockAbPersonalAccountFindMany.mockImplementation(async () => []);
  mockAbPersonalTransactionFindMany.mockImplementation(async () => []);
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Routing (shuffle-order verification, same discipline as
// personal-transaction-skill.test.ts / skill-routing-canonical.test.ts —
// never trust BUILT_IN_SKILLS declaration order since
// db.abSkillManifest.findMany(...) has no `orderBy`). ---------------------

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
        `Order-dependent routing for "${text}": declaration order picks "${declared}", ` +
        `a shuffled order picks "${shuffled}" — unresolved collision.`,
      );
    }
  }
  return declared;
}

describe('personal-snapshot — trend-anchored routing (PR-2)', () => {
  it('routes new trend-anchored phrases to personal-snapshot', () => {
    expect(pickSkill('how has my net worth trended over time')).toBe('personal-snapshot');
    expect(pickSkill('how does my net worth look compared to last month')).toBe('personal-snapshot');
    expect(pickSkill("what's my net worth vs last month")).toBe('personal-snapshot');
    expect(pickSkill('has my household finances changed over time')).toBe('personal-snapshot');
    expect(pickSkill('how has my savings rate changed')).toBe('personal-snapshot');
  });

  it('does not collide with query-finance on business revenue/profit trend phrasing', () => {
    expect(pickSkill('how has revenue trended over the last year')).toBe('query-finance');
    expect(pickSkill('how has my profit changed over time')).toBe('query-finance');
  });

  it('does not collide with query-past-filings on year-anchored tax phrasing', () => {
    expect(pickSkill('show my past filing from 2023')).toBe('query-past-filings');
    expect(pickSkill("what's my notice of assessment say")).toBe('query-past-filings');
  });

  it('current-state (bare anchor, no cue) phrasing still routes to personal-snapshot unaffected (regression)', () => {
    expect(pickSkill("what's my net worth")).toBe('personal-snapshot');
    expect(pickSkill("what's my savings rate")).toBe('personal-snapshot');
    expect(pickSkill("how's my personal finance looking")).toBe('personal-snapshot');
  });
});

describe('isPersonalTrendQuery — sub-classifier cue detection', () => {
  it('detects a temporal/comparison cue', () => {
    expect(isPersonalTrendQuery('how has my net worth trended over time')).toBe(true);
    expect(isPersonalTrendQuery('how does my net worth look compared to last month')).toBe(true);
    expect(isPersonalTrendQuery('how has my savings rate changed')).toBe(true);
  });

  it('does not fire on a bare current-state phrase', () => {
    expect(isPersonalTrendQuery("what's my net worth")).toBe(false);
    expect(isPersonalTrendQuery("what's my savings rate")).toBe(false);
    expect(isPersonalTrendQuery("how's my personal finance looking")).toBe(false);
  });
});

// --- Handler: gating + math ------------------------------------------------

function makeAccount(overrides: Record<string, any> = {}) {
  return {
    id: 'acc-default',
    tenantId: 'tenant-1',
    balanceCents: 0,
    isAsset: true,
    archived: false,
    createdAt: new Date(2020, 0, 1),
    ...overrides,
  };
}

function makeTxn(overrides: Record<string, any> = {}) {
  return {
    accountId: 'acc-default',
    amountCents: 0,
    date: new Date(2020, 0, 1),
    ...overrides,
  };
}

describe('personal-snapshot handler — current-state path is never gated (PR-1 regression risk)', () => {
  it('a current-state question gets the free answer and never checks hasAddOn, when NOT subscribed', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([makeAccount({ id: 'a1', isAsset: true, balanceCents: 100_000 })]);
    mockHasAddOn.mockResolvedValueOnce(false);
    const result = await executeClassification(classification(), "what's my net worth", 'tenant-1', 'api');
    expect(mockHasAddOn).not.toHaveBeenCalled();
    expect(result.responseData.message).toMatch(/\*\*Net worth: /);
    expect(result.responseData.message).not.toMatch(/Personal Insights/);
  });

  it('a current-state question gets the free answer and never checks hasAddOn, when subscribed', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([makeAccount({ id: 'a1', isAsset: true, balanceCents: 100_000 })]);
    mockHasAddOn.mockResolvedValueOnce(true);
    const result = await executeClassification(classification(), "what's my net worth", 'tenant-1', 'api');
    expect(mockHasAddOn).not.toHaveBeenCalled();
    expect(result.responseData.message).toMatch(/\*\*Net worth: /);
  });
});

describe('personal-snapshot handler — trend path gating', () => {
  it('a non-subscribed tenant asking a trend question gets the upsell message, confidence 1, and never sees real trend data', async () => {
    mockHasAddOn.mockResolvedValueOnce(false);
    const result = await executeClassification(
      classification(), 'how has my net worth trended over time', 'tenant-1', 'api',
    );
    expect(mockHasAddOn).toHaveBeenCalledWith('tenant-1', 'personal_insights');
    expect(result.responseData.message).toBe(
      "Net-worth trends are part of Personal Insights — enable it in your Personal Finance settings to see how it's changed over time.",
    );
    expect(result.responseData.confidence).toBe(1);
    expect(result.confidence).toBe(1);
    // Never leaks real data — must not have even queried accounts/transactions.
    expect(mockAbPersonalAccountFindMany).not.toHaveBeenCalled();
    expect(mockAbPersonalTransactionFindMany).not.toHaveBeenCalled();
  });

  it('a subscribed tenant asking a trend question gets a real month-over-month answer', async () => {
    mockHasAddOn.mockResolvedValueOnce(true);
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([
      makeAccount({ id: 'checking', isAsset: true, balanceCents: 110_000, createdAt: new Date(2020, 0, 1) }),
    ]);
    mockAbPersonalTransactionFindMany.mockResolvedValueOnce([
      // After June-end, before July-end: subtracted from June's point only.
      makeTxn({ accountId: 'checking', date: new Date(2026, 6, 10), amountCents: 2_000 }),
    ]);
    const result = await executeClassification(
      classification(), 'how has my net worth trended over time', 'tenant-1', 'api',
    );
    expect(mockHasAddOn).toHaveBeenCalledWith('tenant-1', 'personal_insights');
    // July (current): raw = 110000 - 0 = 110000.
    // June (prior): raw = 110000 - 2000 = 108000.
    // delta = 110000 - 108000 = 2000 (up $20).
    expect(result.responseData.message).toMatch(/\$1,080 last month/);
    expect(result.responseData.message).toMatch(/\$1,100 this month/);
    expect(result.responseData.message).toMatch(/up \$20/);
    expect(result.responseData.message).not.toMatch(/Personal Insights/);
  });

  it('critical case: a liability account with a transaction crossing the month-end boundary reconstructs raw-first, abs-second', async () => {
    mockHasAddOn.mockResolvedValueOnce(true);
    // Credit-type liability account. Current balanceCents is -5000 (owes $50).
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([
      makeAccount({ id: 'credit-1', isAsset: false, balanceCents: -5_000, createdAt: new Date(2020, 0, 1) }),
    ]);
    // A $200 outflow (more debt) posted July 10 — after June-end, before July-end.
    mockAbPersonalTransactionFindMany.mockResolvedValueOnce([
      makeTxn({ accountId: 'credit-1', date: new Date(2026, 6, 10), amountCents: -20_000 }),
    ]);
    const result = await executeClassification(
      classification(), 'how has my net worth trended over time', 'tenant-1', 'api',
    );
    // July (current): raw = -5000 - 0 = -5000; liability contribution abs(-5000) = 5000; net = -5000.
    // June (prior, boundary-crossing): raw = -5000 - (-20000) = 15000; liability contribution
    //   abs(15000) = 15000; net = -15000. (Wrong order would instead compute
    //   abs(-5000) - (-20000) = 25000 -> net -25000, a different, wrong answer.)
    expect(result.responseData.message).toMatch(/-\$150 last month/);
    expect(result.responseData.message).toMatch(/-\$50 this month/);
    expect(result.responseData.message).not.toMatch(/-\$250/); // would appear under the wrong order
  });

  it('an eligible tenant with no personal accounts yet gets the empty-state message, not the upsell', async () => {
    mockHasAddOn.mockResolvedValueOnce(true);
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([]);
    const result = await executeClassification(
      classification(), 'how has my net worth trended over time', 'tenant-1', 'api',
    );
    expect(result.responseData.message).toMatch(/Personal page/i);
    expect(result.responseData.message).not.toMatch(/Personal Insights/);
  });

  it('MCP channel: subscribed tenant trend query behaves identically with no MCP-specific code', async () => {
    mockHasAddOn.mockResolvedValueOnce(true);
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([
      makeAccount({ id: 'checking', isAsset: true, balanceCents: 110_000, createdAt: new Date(2020, 0, 1) }),
    ]);
    mockAbPersonalTransactionFindMany.mockResolvedValueOnce([
      makeTxn({ accountId: 'checking', date: new Date(2026, 6, 10), amountCents: 2_000 }),
    ]);
    const result = await executeClassification(
      classification(), 'how has my net worth trended over time', 'tenant-1', 'mcp',
    );
    expect(result.responseData.message).toMatch(/\$1,080 last month/);
    expect(result.responseData.message).toMatch(/\$1,100 this month/);
  });

  it('MCP channel: non-subscribed tenant trend query gets the same upsell, never real data', async () => {
    mockHasAddOn.mockResolvedValueOnce(false);
    const result = await executeClassification(
      classification(), 'how has my net worth trended over time', 'tenant-1', 'mcp',
    );
    expect(result.responseData.message).toMatch(/Personal Insights/);
    expect(result.responseData.confidence).toBe(1);
    expect(mockAbPersonalAccountFindMany).not.toHaveBeenCalled();
  });

  it('MCP channel: current-state question is never gated (regression) regardless of subscription', async () => {
    mockAbPersonalAccountFindMany.mockResolvedValueOnce([makeAccount({ id: 'a1', isAsset: true, balanceCents: 100_000 })]);
    mockHasAddOn.mockResolvedValueOnce(false);
    const result = await executeClassification(classification(), "what's my net worth", 'tenant-1', 'mcp');
    expect(mockHasAddOn).not.toHaveBeenCalled();
    expect(result.responseData.message).toMatch(/\*\*Net worth: /);
  });
});
