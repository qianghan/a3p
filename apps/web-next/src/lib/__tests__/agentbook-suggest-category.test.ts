// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@naap/database', async () => ({ prisma: (await import('@/__tests__/helpers/mem-db')).memDb }));
const llm = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock('@/lib/agentbook-auto-categorize', () => ({ classifyExpenseWithGemini: llm.classify }));

import { memDb } from '@/__tests__/helpers/mem-db';
import { fullSeed } from '@/__tests__/helpers/mobile-fixtures';
import { suggestCategory, rememberVendorCategory, MIN_AI_CONFIDENCE } from '../agentbook-suggest-category';

const seed = () => {
  const s = fullSeed();
  s.abPattern = [
    { id: 'p-cafe', tenantId: 't1', vendorPattern: 'cafe', categoryId: 'acc-meals', confidence: 0.8, source: 'user_corrected', usageCount: 1 },
    { id: 'p-x', tenantId: 't2', vendorPattern: 'shell', categoryId: 'b-meals', confidence: 0.9, source: 'user_corrected', usageCount: 1 },
  ];
  return s;
};

beforeEach(() => {
  memDb.reset(seed());
  llm.classify.mockReset();
});

describe('suggestCategory — order: vendor default → learned pattern → AI → nothing', () => {
  it('uses the vendor default first (0.95), with the account name for display', async () => {
    const r = await suggestCategory('t1', { vendor: 'Shell' });
    expect(r).toEqual({ categoryId: 'acc-fuel', categoryName: 'Fuel', confidence: 0.95, source: 'vendor' });
    expect(llm.classify).not.toHaveBeenCalled();
  });

  it('matches vendors on the normalised name, not the typed spelling', async () => {
    expect((await suggestCategory('t1', { vendor: '  SHELL!! ' }))?.categoryId).toBe('acc-fuel');
  });

  it('falls back to a learned pattern with its own confidence when the vendor has no default', async () => {
    const r = await suggestCategory('t1', { vendor: 'Cafe' });
    expect(r).toMatchObject({ categoryId: 'acc-meals', confidence: 0.8, source: 'pattern' });
    expect(llm.classify).not.toHaveBeenCalled();
  });

  it("never reads another tenant's vendor or pattern", async () => {
    // t2 has a 'shell' pattern → b-meals; t1's own vendor default (acc-fuel) must win, and t2's account never leaks.
    expect((await suggestCategory('t1', { vendor: 'Shell' }))?.categoryId).toBe('acc-fuel');
    expect(await suggestCategory('t2', { vendor: 'Shell' })).toMatchObject({ categoryId: 'b-meals', source: 'pattern' });
  });

  it('ignores a remembered category that is gone, inactive, not an expense account, or the suspense account', async () => {
    const s = seed();
    s.abVendor = [
      { id: 'v1', tenantId: 't1', name: 'A', normalizedName: 'a', defaultCategoryId: 'missing' },
      { id: 'v2', tenantId: 't1', name: 'B', normalizedName: 'b', defaultCategoryId: 'acc-cash' }, // asset
      { id: 'v3', tenantId: 't1', name: 'C', normalizedName: 'c', defaultCategoryId: 'acc-susp' }, // 6999 suspense
      { id: 'v4', tenantId: 't1', name: 'D', normalizedName: 'd', defaultCategoryId: 'b-meals' }, // other tenant
    ];
    s.abPattern = [];
    memDb.reset(s);
    for (const v of ['A', 'B', 'C', 'D']) expect(await suggestCategory('t1', { vendor: v })).toBeNull();
    memDb.table('abAccount').rows.find((a) => a.id === 'acc-fuel')!.isActive = false;
    expect(await suggestCategory('t1', { vendor: 'Shell' })).toBeNull();
  });

  it('asks the AI only when memory has nothing, and only with something to classify', async () => {
    llm.classify.mockResolvedValue({ categoryName: 'Meals', confidence: 0.9, reason: 'restaurant' });
    expect(await suggestCategory('t1', { vendor: 'Brand New Bistro', amountCents: 4200 })).toEqual(
      { categoryId: 'acc-meals', categoryName: 'Meals', confidence: 0.9, source: 'ai' },
    );
    expect(llm.classify).toHaveBeenCalledTimes(1);
    llm.classify.mockClear();
    expect(await suggestCategory('t1', {})).toBeNull();
    expect(await suggestCategory('t1', { vendor: '   ', description: '' })).toBeNull();
    expect(llm.classify).not.toHaveBeenCalled();
  });

  it('only offers the tenant\'s live expense categories to the AI, never suspense or other tenants', async () => {
    llm.classify.mockResolvedValue(null);
    await suggestCategory('t1', { vendor: 'Mystery' });
    const cats = (llm.classify.mock.calls[0][1] as Array<{ id: string }>).map((c) => c.id).sort();
    expect(cats).toEqual(['acc-fuel', 'acc-meals']);
  });

  it(`drops an AI answer below ${MIN_AI_CONFIDENCE}, an unknown name, or a null answer`, async () => {
    llm.classify.mockResolvedValueOnce({ categoryName: 'Meals', confidence: MIN_AI_CONFIDENCE - 0.01, reason: '' });
    expect(await suggestCategory('t1', { vendor: 'Mystery' })).toBeNull();
    llm.classify.mockResolvedValueOnce({ categoryName: 'Invented', confidence: 0.99, reason: '' });
    expect(await suggestCategory('t1', { vendor: 'Mystery' })).toBeNull();
    llm.classify.mockResolvedValueOnce({ categoryName: null, confidence: 0.9, reason: '' });
    expect(await suggestCategory('t1', { vendor: 'Mystery' })).toBeNull();
    llm.classify.mockResolvedValueOnce(null);
    expect(await suggestCategory('t1', { vendor: 'Mystery' })).toBeNull();
  });

  it('a throwing AI call degrades to no suggestion instead of failing the entry form', async () => {
    llm.classify.mockRejectedValue(new Error('network'));
    expect(await suggestCategory('t1', { vendor: 'Mystery' })).toBeNull();
  });
});

describe('rememberVendorCategory — what a human choice teaches', () => {
  it('creates the pattern at 0.95 and sets the vendor default, so the next entry is prefilled', async () => {
    await rememberVendorCategory('t1', 'Cafe', 'acc-fuel', 'user');
    const p = memDb.table('abPattern').rows.find((r) => r.tenantId === 't1' && r.vendorPattern === 'cafe')!;
    expect(p).toMatchObject({ categoryId: 'acc-fuel', confidence: 0.95, source: 'user' });
    expect(memDb.table('abVendor').rows.find((v) => v.id === 'v-cafe')!.defaultCategoryId).toBe('acc-fuel');
    expect(await suggestCategory('t1', { vendor: 'Cafe' })).toMatchObject({ categoryId: 'acc-fuel', source: 'vendor' });
  });

  it('a correction replaces the old memory (no stale default overriding the user)', async () => {
    await rememberVendorCategory('t1', 'Shell', 'acc-meals', 'user_corrected');
    expect((await suggestCategory('t1', { vendor: 'Shell' }))?.categoryId).toBe('acc-meals');
  });

  it('creates the vendor when it is new, and ignores a blank vendor', async () => {
    await rememberVendorCategory('t1', 'Totally New Co', 'acc-meals', 'user');
    expect(memDb.table('abVendor').rows.some((v) => v.tenantId === 't1' && v.normalizedName === 'totallynewco' && v.defaultCategoryId === 'acc-meals')).toBe(true);
    const before = memDb.table('abPattern').rows.length;
    await rememberVendorCategory('t1', '  ', 'acc-meals', 'user');
    expect(memDb.table('abPattern').rows.length).toBe(before);
  });

  it('rejects a category that is not the tenant\'s live expense account, writing nothing', async () => {
    const before = memDb.table('abPattern').writes.length;
    expect(await rememberVendorCategory('t1', 'Cafe', 'b-meals', 'user')).toBe(false);
    expect(await rememberVendorCategory('t1', 'Cafe', 'acc-susp', 'user')).toBe(false);
    expect(memDb.table('abPattern').writes.length).toBe(before);
  });

  it('is best-effort: a database failure never throws into the caller', async () => {
    const t = memDb.table('abPattern');
    const orig = t.upsert;
    t.upsert = (async () => { throw new Error('boom'); }) as typeof t.upsert;
    await expect(rememberVendorCategory('t1', 'Cafe', 'acc-fuel', 'user')).resolves.toBe(false);
    t.upsert = orig;
  });
});
